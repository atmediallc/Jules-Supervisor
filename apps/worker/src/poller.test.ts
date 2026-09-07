import { describe, expect, it, vi } from "vitest";
import { MockAiDecisionProvider } from "@jules/ai";
import { EnvSchema } from "@jules/config";
import {
  JulesActivity,
  JulesSession,
  MockJulesClient,
  SendMessageRequest,
} from "@jules/jules-client";
import { PolicyEngine } from "@jules/policy";
import { createMockRepositories, InMemoryRepositoryStore } from "@jules/test-utils";
import { InMemoryDistributedLock } from "./lock.js";
import { SupervisionPipeline } from "./pipeline.js";
import { SessionWatcher } from "./poller.js";

/**
 * A MockJulesClient whose `sendMessage` records the external mutation but does
 * NOT flip the session state to IN_PROGRESS. In a real deployment, the worker
 * auto-responding to a session awaiting user input does not move the session
 * out of AWAITING_USER_INPUT (the human still owes a reply), so multiple
 * accumulated AGENT_MESSAGE activities must all be reconciled. The stock mock
 * flips state as a simulation artifact that would break catch-up.
 */
class StableMockJulesClient extends MockJulesClient {
  public override async sendMessage(
    sessionId: string,
    request: SendMessageRequest,
  ): Promise<JulesActivity> {
    const err = this.hooks.shouldFail?.("sendMessage");
    if (err) throw err;
    this.hooks.onSendMessage?.(sessionId, request);
    this.sentMessages.push({ sessionId, request });

    const newActivity: JulesActivity = {
      id: `act_mock_${Date.now()}`,
      sessionId,
      type: "USER_MESSAGE",
      content: request.message,
      createTime: new Date().toISOString(),
    };
    const acts = this.activities.get(sessionId) || [];
    acts.push(newActivity);
    this.activities.set(sessionId, acts);
    return newActivity;
  }
}

function setupWatcher(mode: "DRY_RUN" | "ASSISTED" | "AUTO_RESPOND" | "FULL_AUTO" = "FULL_AUTO") {
  const config = EnvSchema.parse({
    SUPERVISOR_MODE: mode,
    AUTO_RESPOND_ENABLED: mode === "AUTO_RESPOND" || mode === "FULL_AUTO" ? "true" : "false",
    AUTO_PLAN_APPROVAL_ENABLED: mode === "FULL_AUTO" ? "true" : "false",
    RECONCILIATION_PAGE_SIZE: "100",
  });

  const julesClient = new StableMockJulesClient();
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

  return {
    config,
    store,
    julesClient,
    pipeline,
    checkpointRepo: repos.checkpointRepo,
  };
}

function seedSession(
  julesClient: MockJulesClient,
  sessionId: string,
  activityContents: string[],
): void {
  // Remove default seeded data so counts are deterministic for this session.
  julesClient.sessions.clear();
  julesClient.activities.clear();

  const session: JulesSession = {
    id: sessionId,
    name: `sessions/${sessionId}`,
    title: "Reconciliation fixture",
    repository: "owner/repo",
    branch: "main",
    prompt: "Reconcile multiple activities",
    state: "AWAITING_USER_INPUT",
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    metadata: {},
  };
  julesClient.sessions.set(sessionId, session);

  julesClient.activities.set(
    sessionId,
    activityContents.map((content, i) => ({
      id: `act_${String.fromCharCode(97 + i)}_${sessionId}`,
      sessionId,
      type: "AGENT_MESSAGE",
      content,
      createTime: new Date(Date.now() - (activityContents.length - i) * 1000).toISOString(),
    })),
  );
}

describe("SessionWatcher reconciliation", () => {
  it("DISABLED performs no external observation", async () => {
    const { config, julesClient, pipeline } = setupWatcher("DRY_RUN");
    const list = vi.spyOn(julesClient, "listSessions");
    const watcher = new SessionWatcher({ ...config, SUPERVISOR_MODE: "DISABLED" }, julesClient, pipeline);
    await watcher.syncActiveSessions();
    expect(list).not.toHaveBeenCalled();
  });
  it("reconciles ALL accumulated activities (not just the last) after downtime", async () => {
    const { config, store, julesClient, pipeline, checkpointRepo } = setupWatcher("FULL_AUTO");
    seedSession(julesClient, "ses_recon_001", ["A", "B", "C"]);
    const watcher = new SessionWatcher(config, julesClient, pipeline, checkpointRepo);

    // The worker was offline while A, B and C all arrived. A single sync must
    // catch up on every one of them, not merely the most recent.
    await watcher.syncActiveSessions();

    const decisions = await store.listDecisions();
    expect(decisions.length).toBe(3);
    // In FULL_AUTO every decision auto-executes an external message.
    expect(julesClient.sentMessages.length).toBe(3);
    // Each activity produced its own decision row (distinct idempotency keys).
    const keys = new Set(decisions.map((d) => d.idempotencyKey));
    expect(keys.size).toBe(3);

    // The per-session cursor advanced to the last activity.
    const cp = await checkpointRepo.getBySession("ses_recon_001");
    expect(cp?.lastActivityId).toBeTruthy();
  });

  it("RECONCILIATION_REPLAY_IDEMPOTENT: re-running sync does not double-execute", async () => {
    const { config, store, julesClient, pipeline } = setupWatcher("FULL_AUTO");
    seedSession(julesClient, "ses_recon_002", ["A", "B", "C"]);

    // Watcher WITHOUT a checkpoint cursor: both sync passes re-feed every
    // activity through the pipeline, so the pipeline's deterministic
    // idempotency key must prevent duplicate external mutations.
    const watcher = new SessionWatcher(config, julesClient, pipeline);

    await watcher.syncActiveSessions();
    const decisionsAfterFirst = await store.listDecisions();
    expect(decisionsAfterFirst.length).toBe(3);
    expect(julesClient.sentMessages.length).toBe(3);

    // Replay the same reconciliation pass.
    await watcher.syncActiveSessions();

    const decisionsAfterReplay = await store.listDecisions();
    expect(decisionsAfterReplay.length).toBe(3); // no new decisions created
    expect(julesClient.sentMessages.length).toBe(3); // no duplicate external mutations
    expect(julesClient.approvedPlans.length).toBe(0);
  });

  it("deduplicates persisted decisions when a checkpoint exists", async () => {
    const { config, store, julesClient, pipeline, checkpointRepo } = setupWatcher("FULL_AUTO");
    seedSession(julesClient, "ses_recon_003", ["A", "B", "C"]);

    // A real prior run persists a decision, not just an advisory checkpoint.
    await pipeline.processActivity({
      session: julesClient.sessions.get("ses_recon_003")!,
      activity: julesClient.activities.get("ses_recon_003")![0]!,
    });
    await checkpointRepo.upsert("ses_recon_003", { lastActivityId: "act_a_ses_recon_003" });

    const watcher = new SessionWatcher(config, julesClient, pipeline, checkpointRepo);
    await watcher.syncActiveSessions();

    const decisions = await store.listDecisions();
    // A is deduplicated by its decision; only B and C add new effects.
    expect(decisions.length).toBe(3);
    expect(julesClient.sentMessages.length).toBe(3);
  });

  it("processes out-of-order IDs and a new lower ID after a checkpoint", async () => {
    const { config, store, julesClient, pipeline, checkpointRepo } = setupWatcher("DRY_RUN");
    seedSession(julesClient, "opaque", ["A", "B"]);
    const activities = julesClient.activities.get("opaque")!;
    activities[0]!.id = "z-id";
    activities[1]!.id = "b-id";
    const watcher = new SessionWatcher(config, julesClient, pipeline, checkpointRepo);
    await watcher.syncActiveSessions();
    expect((await store.listDecisions()).length).toBe(2);
    activities.unshift({ ...activities[0]!, id: "a-new-id", content: "New question" });
    await watcher.syncActiveSessions();
    expect((await store.listDecisions()).length).toBe(3);
  });

  it("visits later session pages and starts activity listing without a stale token", async () => {
    const { config, store, julesClient, pipeline, checkpointRepo } = setupWatcher("DRY_RUN");
    seedSession(julesClient, "page-two", ["Question"]);
    const session = julesClient.sessions.get("page-two")!;
    const listSessions = vi
      .spyOn(julesClient, "listSessions")
      .mockResolvedValueOnce({ sessions: [], nextPageToken: "second" })
      .mockResolvedValueOnce({ sessions: [session] });
    const listActivities = vi.spyOn(julesClient, "listActivities");
    await checkpointRepo.upsert(session.id, { lastActivityId: "z", nextPageToken: "expired" });
    const watcher = new SessionWatcher(config, julesClient, pipeline, checkpointRepo);
    await watcher.syncActiveSessions();
    expect(listSessions).toHaveBeenNthCalledWith(2, { pageToken: "second" }, undefined);
    expect(listActivities).toHaveBeenCalledWith(
      session.id,
      { pageSize: 100, pageToken: undefined },
      undefined,
    );
    expect((await store.listDecisions()).length).toBe(1);
  });

  it("bounds malformed session pagination cycles", async () => {
    const { config, julesClient, pipeline } = setupWatcher("DRY_RUN");
    const list = vi
      .spyOn(julesClient, "listSessions")
      .mockResolvedValue({ sessions: [], nextPageToken: "repeated" });
    const watcher = new SessionWatcher(config, julesClient, pipeline);
    await expect(watcher.syncActiveSessions()).rejects.toThrow("repeated page token");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("bounds malformed activity pagination cycles", async () => {
    const { config, julesClient, pipeline } = setupWatcher("DRY_RUN");
    seedSession(julesClient, "cycle", []);
    const list = vi
      .spyOn(julesClient, "listActivities")
      .mockResolvedValue({ activities: [], nextPageToken: "repeated" });
    const watcher = new SessionWatcher(config, julesClient, pipeline);
    await watcher.syncActiveSessions();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
