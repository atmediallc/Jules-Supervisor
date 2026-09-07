import { describe, expect, it, vi } from "vitest";
import { EnvSchema } from "@jules/config";
import { MockJulesClient } from "@jules/jules-client";
import {
  createMockRepositories,
  InMemoryRepositoryStore,
} from "@jules/test-utils";
import { classifyExecutionEffect, safetyInterlockError } from "./errors.js";
import { ExecutionReconciler } from "./reconciler.js";

const LEASE_MS = 120_000;

function setupReconciler(overrides: {
  maxAttempts?: number;
  killSwitch?: { getState: () => Promise<{ state: string }>; isRunning: (r: { state: string }) => boolean };
  julesHooks?: { shouldFail?: (endpoint: string) => Error | null };
} = {}) {
  const config = EnvSchema.parse({
    EXECUTION_ATTEMPT_LEASE_MS: String(LEASE_MS),
    EXECUTION_MAX_ATTEMPTS: String(overrides.maxAttempts ?? 3),
    EXECUTION_RECONCILE_INTERVAL_MS: "60000",
  });

  const julesClient = new MockJulesClient();
  julesClient.hooks = overrides.julesHooks ?? {};
  const store = new InMemoryRepositoryStore();
  const repos = createMockRepositories(store);

  const reconciler = new ExecutionReconciler({
    config,
    julesClient,
    executionAttemptRepo: repos.executionAttemptRepo,
    decisionRepo: repos.decisionRepo,
    workerId: "reconciler-a",
    ...(overrides.killSwitch ? { killSwitch: overrides.killSwitch as never } : {}),
  });

  return { reconciler, store, repos, julesClient };
}

/** Seed a decision (returns it) and a stale, expired CLAIMED/EXECUTING attempt owned by a dead worker. */
async function seedStaleAttempt(
  store: InMemoryRepositoryStore,
  repos: ReturnType<typeof createMockRepositories>,
  opts: {
    id?: string;
    decisionId?: string;
    attemptNumber?: number;
    status?: "CLAIMED" | "EXECUTING";
    clientToken?: string | null;
    action?: string;
    proposedResponse?: string | null;
    claimOwner?: string;
  } = {},
) {
  const id = opts.id ?? `exec-stale-${Math.random().toString(36).slice(2)}`;
  const decisionId = opts.decisionId ?? `dec-${Math.random().toString(36).slice(2)}`;
  const sessionId = `ses-${Math.random().toString(36).slice(2)}`;
  const activityId = `act-${Math.random().toString(36).slice(2)}`;

  // Seed the backing decision + owning session/activity rows the FK'd mock needs.
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

  const clientToken = opts.clientToken === undefined ? `tok-${Math.random().toString(36).slice(2)}` : opts.clientToken;
  await repos.decisionRepo.create({
    id: decisionId,
    sessionId,
    activityId,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    action: opts.action ?? "RESPOND",
    proposedResponse: opts.proposedResponse ?? "Here is the fix.",
    risk: "low",
    confidence: 0.9,
    reason: "reconciler test",
    provider: "openai",
    model: "gpt-4o",
    contextDigest: "d".repeat(64),
    executionState: "EXECUTED",
  });

  await repos.executionAttemptRepo.create({
    id,
    decisionId,
    attemptNumber: opts.attemptNumber ?? 1,
    clientToken: clientToken ?? null,
  });
  const claimed = await repos.executionAttemptRepo.claimPending(
    id,
    opts.claimOwner ?? "dead-worker",
    LEASE_MS,
  );
  if (!claimed) throw new Error("claimPending failed while seeding");
  const row = store.executionAttempts.get(id)!;
  // Force lease expiry to simulate a worker that died before finishing:
  // findStaleAttempts treats an attempt as stale when claimExpiry is older
  // than (now - leaseMs), so expire it well outside the lease window.
  row.claimExpiry = new Date(Date.now() - LEASE_MS - 5000);
  row.status = opts.status ?? "EXECUTING";
  store.executionAttempts.set(id, row);

  return { id, decisionId, clientToken };
}

async function decisionById(store: InMemoryRepositoryStore, id: string) {
  return store.decisions.get(id) ?? null;
}
async function attemptsFor(store: InMemoryRepositoryStore, decisionId: string) {
  return Array.from(store.executionAttempts.values()).filter((a) => a.decisionId === decisionId);
}

describe("ExecutionReconciler — H3 durable execution fault injection", () => {
  it("recovers a stale EXECUTING attempt for review without replaying its token", async () => {
    const { reconciler, store, repos, julesClient } = setupReconciler();
    const { decisionId, clientToken } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });

    const result = await reconciler.reconcileOnce();

    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.reDriven).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.escalated).toBe(1);
    expect(julesClient.sentMessages.length).toBe(0);
    const attempts = await attemptsFor(store, decisionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.clientToken).toBe(clientToken);
    expect(attempts[0]?.status).toBe("NEEDS_RECONCILIATION");
    // A previously recorded success is never overwritten by recovery.
    const dec = await decisionById(store, decisionId);
    expect(dec?.executionState).toBe("EXECUTED");
  });

  it("does NOT recover an attempt whose lease has NOT expired", async () => {
    const { reconciler, store, repos } = setupReconciler();
    const { id } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });
    // Refresh the lease window so the attempt is NOT stale.
    const row = store.executionAttempts.get(id)!;
    row.claimExpiry = new Date(Date.now() + LEASE_MS);
    store.executionAttempts.set(row.id, row);

    const result = await reconciler.reconcileOnce();

    expect(result.scanned).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it("does not double-apply: a recovered attempt is terminal and not re-picked on the next pass", async () => {
    const { reconciler, store, repos, julesClient } = setupReconciler();
    const { id, decisionId, clientToken } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });

    await reconciler.reconcileOnce();
    expect(julesClient.sentMessages.length).toBe(0);

    // Second pass — the recovered attempt is SUCCEEDED, no longer stale.
    const result2 = await reconciler.reconcileOnce();
    expect(result2.scanned).toBe(0);
    // The effect was applied exactly once.
    expect(julesClient.sentMessages.length).toBe(0);
    const attempts = await attemptsFor(store, decisionId);
    expect(attempts.filter((a) => a.id === id).length).toBe(1);
    expect(attempts[0]?.clientToken).toBe(clientToken);
    expect(attempts[0]?.status).toBe("NEEDS_RECONCILIATION");
  });

  it("escalates regardless of the previous attempt count (no unbounded retry)", async () => {
    const { reconciler, store, repos } = setupReconciler({ maxAttempts: 2 });
    const { decisionId } = await seedStaleAttempt(store, repos, { status: "EXECUTING", attemptNumber: 2 });
    // Fake that two prior attempts already exist for this decision.
    for (let n = 1; n <= 2; n++) {
      await repos.executionAttemptRepo.create({
        id: `exec-prior-${n}`,
        decisionId,
        attemptNumber: n,
      });
    }

    const result = await reconciler.reconcileOnce();

    // nextNumber would be 3 (> maxAttempts 2) → escalate, no re-drive.
    expect(result.escalated).toBe(1);
    expect(result.reDriven).toBe(0);
    const attempts = await attemptsFor(store, decisionId);
    const ceiling = attempts.find((a) => a.status === "NEEDS_RECONCILIATION");
    expect(ceiling).toBeDefined();
    expect(ceiling!.errorMessage).toContain("idempotency is not guaranteed");
  });

  it("refuses to re-drive when the kill switch is NOT RUNNING and marks NEEDS_RECONCILIATION", async () => {
    const killSwitch = {
      getState: async () => ({ state: "PAUSED", changedAt: null, changedBy: null, reason: null }),
      isRunning: (r: { state: string }) => r.state === "RUNNING",
    };
    const { reconciler, store, repos, julesClient } = setupReconciler({ killSwitch });
    const { decisionId } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });

    const result = await reconciler.reconcileOnce();

    expect(result.escalated).toBe(1);
    expect(result.reDriven).toBe(0);
    // No external effect was applied while not RUNNING.
    expect(julesClient.sentMessages.length).toBe(0);
    const attempts = await attemptsFor(store, decisionId);
    const guarded = attempts.find((a) => a.status === "NEEDS_RECONCILIATION");
    expect(guarded).toBeDefined();
    expect(guarded!.errorMessage).toContain("safety interlock");
  });

  it("marks the attempt FAILED/PERMANENT and escalates when the backing decision no longer exists", async () => {
    const { reconciler, store, repos } = setupReconciler();
    const { id } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });
    // Delete the decision to simulate a row purged after dispatch.
    const row = store.executionAttempts.get(id)!;
    store.decisions.delete(row.decisionId);

    const result = await reconciler.reconcileOnce();

    expect(result.escalated).toBe(1);
    const after = store.executionAttempts.get(id)!;
    expect(after.status).toBe("FAILED");
    expect(after.errorCategory).toBe("PERMANENT");
  });

  it("does not contact an unavailable provider during recovery or the next pass", async () => {
    const { reconciler, store, repos, julesClient } = setupReconciler({
      julesHooks: {
        shouldFail: (endpoint: string) =>
          endpoint === "sendMessage" ? new Error("network timeout after send") : null,
      },
    });
    const { decisionId } = await seedStaleAttempt(store, repos, { status: "EXECUTING" });

    const send = vi.spyOn(julesClient, "sendMessage");
    const result = await reconciler.reconcileOnce();

    expect(result.reDriven).toBe(0);
    expect(result.escalated).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const dec = await decisionById(store, decisionId);
    expect(dec?.executionState).toBe("EXECUTED");
    const attempts = await attemptsFor(store, decisionId);
    const terminal = attempts.find((a) => a.status === "NEEDS_RECONCILIATION");
    expect(terminal).toBeDefined();
    expect(terminal!.errorMessage).toContain("unverified");

    // UNKNOWN_EFFECT is terminal — next pass must not re-pick it.
    julesClient.hooks = {};
    const result2 = await reconciler.reconcileOnce();
    expect(result2.scanned).toBe(0);
  });

  it("does not re-drive a decision with no reconstructable response (non-approve action, empty response)", async () => {
    const { reconciler, store, repos } = setupReconciler();
    const { id, decisionId } = await seedStaleAttempt(store, repos, {
      status: "EXECUTING",
      action: "RESPOND",
      proposedResponse: "",
    });

    const result = await reconciler.reconcileOnce();

    expect(result.escalated).toBe(1);
    const dec = await decisionById(store, decisionId);
    expect(dec?.executionState).toBe("EXECUTED");
    // Review the existing attempt without fabricating another external call.
    const attempts = await attemptsFor(store, decisionId);
    expect(attempts).toHaveLength(1);
    const unknown = attempts.find((a) => a.status === "NEEDS_RECONCILIATION");
    expect(unknown).toBeDefined();
    expect(unknown!.id).toBe(id);
  });

  it.each(["RESPOND", "APPROVE_PLAN", "REQUEST_CHANGES", "BLOCK"])(
    "never replays %s even with a missing correlation token",
    async (action) => {
      const { reconciler, store, repos, julesClient } = setupReconciler();
      const { id } = await seedStaleAttempt(store, repos, { action, clientToken: null });
      const result = await reconciler.reconcileOnce();
      expect(result.escalated).toBe(1);
      expect(julesClient.sentMessages).toHaveLength(0);
      expect(julesClient.approvedPlans).toHaveLength(0);
      expect(store.executionAttempts.get(id)?.status).toBe("NEEDS_RECONCILIATION");
    },
  );

  it("claims a stale attempt only once across overlapping passes", async () => {
    const { reconciler, store, repos, julesClient } = setupReconciler();
    await seedStaleAttempt(store, repos);
    const results = await Promise.all([reconciler.reconcileOnce(), reconciler.reconcileOnce()]);
    expect(results.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);
    expect(julesClient.sentMessages).toHaveLength(0);
    expect(store.executionAttempts.size).toBe(1);
  });
});

describe("classifyExecutionEffect", () => {
  it("classifies safety-interlock WorkerErrors as PERMANENT", () => {
    expect(classifyExecutionEffect(safetyInterlockError("PAUSED", "test")).category).toBe("PERMANENT");
  });
  it("classifies transient markers as TRANSIENT", () => {
    const transient = classifyExecutionEffect(new Error("ECONNREFUSED: connection refused"));
    expect(transient.category).toBe("TRANSIENT");
  });
  it("classifies unknown errors as AMBIGUOUS by default", () => {
    expect(classifyExecutionEffect(new Error("runtime blew up")).category).toBe("AMBIGUOUS");
  });
});
