import { describe, expect, it } from "vitest";
import { MockAiDecisionProvider } from "@jules/ai";
import { EnvSchema } from "@jules/config";
import { MockJulesClient } from "@jules/jules-client";
import { PolicyEngine } from "@jules/policy";
import { KillSwitch } from "@jules/db";
import {
  createMockActivity,
  createMockRepositories,
  createMockSession,
  InMemoryRepositoryStore,
} from "@jules/test-utils";
import { InMemoryDistributedLock } from "../../apps/worker/src/lock.js";
import { SupervisionPipeline } from "../../apps/worker/src/pipeline.js";
import { ExecutionReconciler } from "../../apps/worker/src/reconciler.js";

class FakeSettingsRepo {
  private map = new Map<string, { value: string; category: string; isSecret: boolean }>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) {
      this.map.set(k, { value: v, category: "safety", isSecret: false });
    }
  }
  async getByKey(key: string) {
    const row = this.map.get(key);
    return row ? { key, value: row.value, category: row.category, isSecret: row.isSecret } : null;
  }
}

function setupPipeline(mode: "DRY_RUN" | "FULL_AUTO" = "FULL_AUTO") {
  const config = EnvSchema.parse({
    SUPERVISOR_MODE: mode,
    AUTO_RESPOND_ENABLED: "true",
    AUTO_PLAN_APPROVAL_ENABLED: "true",
    DATABASE_URL: "postgres://mock:mock@localhost:5432/mock",
    REDIS_URL: "redis://localhost:6379",
    JULES_API_KEY: "test-key",
  });

  const julesClient = new MockJulesClient();
  const aiProvider = new MockAiDecisionProvider();
  const policyEngine = new PolicyEngine();
  const store = new InMemoryRepositoryStore();
  const lock = new InMemoryDistributedLock();
  const repos = createMockRepositories(store);

  const pipeline = new SupervisionPipeline({
    config,
    julesClient,
    aiProvider,
    policyEngine,
    ...repos,
    workerId: "test-worker",
    lock,
  });

  return { pipeline, store, repos, julesClient, aiProvider, policyEngine, lock, config };
}

describe("Master Logic Audit — Regression Suites", () => {
  it("REG-01: canonical decision ID is used when duplicate decision is returned by upsert", async () => {
    const { pipeline, store, repos, julesClient } = setupPipeline("FULL_AUTO");

    const session = createMockSession({ id: "ses_race_001", state: "AWAITING_USER_INPUT" });
    const activity = createMockActivity({ id: "act_race_001", sessionId: "ses_race_001" });
    julesClient.sessions.set(session.id, session);

    // Mock decisionRepo.create to simulate concurrent race where another worker
    // committed the decision first and upsert returns the existing canonical record
    repos.decisionRepo.create = async (data) => {
      const canonical = {
        ...data,
        id: "dec_canonical_existing",
        executionState: "PENDING",
        createdAt: new Date(),
      };
      store.decisions.set("dec_canonical_existing", canonical as never);
      return canonical as never;
    };

    const result = await pipeline.processActivity({ session, activity });

    expect(result?.decisionId).toBe("dec_canonical_existing");
    const attempts = Array.from(store.executionAttempts.values());
    // Concurrent conflict safely avoids duplicate execution attempts
    expect(attempts.length).toBe(0);
  });

  it("REG-02: does not auto-execute RESPOND action when proposedResponse is empty or whitespace", async () => {
    const { pipeline, aiProvider, julesClient } = setupPipeline("FULL_AUTO");

    const session = createMockSession({ id: "ses_empty_001", state: "AWAITING_USER_INPUT" });
    const activity = createMockActivity({ id: "act_empty_001", sessionId: "ses_empty_001" });
    julesClient.sessions.set(session.id, session);

    aiProvider.customDecision = {
      action: "RESPOND",
      response: "   ", // whitespace only
      risk: "low",
      confidence: 0.99,
      reason: "Empty response test",
      evidence: [],
      concerns: [],
    };

    const result = await pipeline.processActivity({ session, activity });

    expect(result?.executed).toBe(false);
    expect(julesClient.sentMessages).toHaveLength(0);
  });

  it("REG-03: KillSwitch fails closed to SAFETY_LOCKED on corrupted database state", async () => {
    const fakeRepo = new FakeSettingsRepo({
      AUTONOMY_SAFETY_STATE: "CORRUPTED_VALUE",
    });

    const killSwitch = new KillSwitch(fakeRepo as never);
    const status = await killSwitch.getState();

    expect(status.state).toBe("SAFETY_LOCKED");
    expect(status.reason).toContain("Fail-closed");
    expect(killSwitch.isRunning(status)).toBe(false);
  });

  it("REG-04: stale attempt recovery respects lease expiry and terminal status guards", async () => {
    const { repos, store } = setupPipeline();
    const id = "exec_stale_test_1";

    await repos.executionAttemptRepo.create({
      id,
      decisionId: "dec_test",
      attemptNumber: 1,
      clientToken: "token_1",
    });

    // Mark attempt SUCCEEDED
    const row = store.executionAttempts.get(id)!;
    row.status = "SUCCEEDED";
    row.claimExpiry = new Date(Date.now() - 10000);
    store.executionAttempts.set(id, row);

    // Terminal SUCCEEDED attempt cannot be recovered as stale
    const recovered = await repos.executionAttemptRepo.recoverStale(id, "worker_2", 30000);
    expect(recovered).toBeNull();

    // Terminal SUCCEEDED attempt cannot be marked failed
    await repos.executionAttemptRepo.markFailed(id, "TRANSIENT", "late error");
    expect(store.executionAttempts.get(id)!.status).toBe("SUCCEEDED");
  });

  it("REG-05: reconciler retires a stale claim for review without replaying an uncertain effect", async () => {
    const { repos, store, julesClient, config } = setupPipeline();
    const decisionId = "dec_reconcile_superseded";
    const sessionId = "ses_rec_001";
    const activityId = "act_rec_001";

    store.sessions.set(sessionId, {
      id: sessionId,
      state: "IN_PROGRESS",
      repositoryId: "repo-1",
      title: "t",
      prompt: "p",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    store.activities.set(activityId, {
      id: activityId,
      sessionId,
      repositoryId: "repo-1",
      status: "created",
      kind: "message",
      payload: {},
      createdAt: new Date(),
    } as never);

    await repos.decisionRepo.create({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `dec:${sessionId}:${activityId}`,
      action: "RESPOND",
      proposedResponse: "Recovered message",
      risk: "low",
      confidence: 0.95,
      reason: "Test",
      evidence: [],
      concerns: [],
      provider: "mock",
      model: "mock-model",
      contextDigest: "digest",
      executionState: "EXECUTING",
    });

    const oldAttemptId = "exec_old_stale";
    await repos.executionAttemptRepo.create({
      id: oldAttemptId,
      decisionId,
      attemptNumber: 1,
      clientToken: "idemp_tok_1",
    });
    const oldRow = store.executionAttempts.get(oldAttemptId)!;
    oldRow.status = "EXECUTING";
    oldRow.claimExpiry = new Date(Date.now() - 60000);
    store.executionAttempts.set(oldAttemptId, oldRow);

    const reconciler = new ExecutionReconciler({
      config,
      julesClient,
      executionAttemptRepo: repos.executionAttemptRepo,
      decisionRepo: repos.decisionRepo,
      workerId: "reconciler-test",
    });

    const report = await reconciler.reconcileOnce();
    expect(report.recovered).toBe(1);
    expect(report.succeeded).toBe(0);
    expect(report.reDriven).toBe(0);
    expect(report.escalated).toBe(1);
    expect(julesClient.sentMessages).toHaveLength(0);

    // Old attempt MUST NOT remain CLAIMED or be guessed to have failed remotely.
    const updatedOld = store.executionAttempts.get(oldAttemptId)!;
    expect(updatedOld.status).toBe("NEEDS_RECONCILIATION");
    expect(updatedOld.errorMessage).toContain("unverified");
  });
});
