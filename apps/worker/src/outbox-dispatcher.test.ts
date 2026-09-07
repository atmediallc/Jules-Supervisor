import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfig, EnvSchema } from "@jules/config";
import {
  DecisionRepository,
  ExecutionAttemptRepository,
  KillSwitch,
  OutboxRepository,
  SessionRepository,
  SystemSettingsRepository,
} from "@jules/db";
import { MockJulesClient } from "@jules/jules-client";
import { InMemoryDistributedLock } from "./lock.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return EnvSchema.parse({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    AI_API_KEY: "test-key",
    JULES_API_KEY: "test-key",
    SETTINGS_ENCRYPTION_KEY: "test-key",
    SESSION_SECRET: "test-session-secret-32-chars-minimum",
    ...overrides,
  });
}

describe("OutboxDispatcher", () => {
  let config: AppConfig;
  let julesClient: MockJulesClient;
  let outboxRepo: OutboxRepository;
  let executionAttemptRepo: ExecutionAttemptRepository;
  let decisionRepo: DecisionRepository;
  let sessionRepo: SessionRepository;
  let killSwitch: KillSwitch;
  let lock: InMemoryDistributedLock;

  beforeEach(() => {
    config = makeConfig();
    julesClient = new MockJulesClient();
    lock = new InMemoryDistributedLock();

    // Mock repos with memory maps
    interface OutboxStoreItem {
      id: string;
      sessionId: string;
      decisionId: string;
      action: string;
      payload: string | null;
      status: string;
      claimOwner?: string;
      claimExpiry?: Date;
      fencingToken: number;
      attempts: number;
      maxAttempts: number;
      lastError?: string;
    }
    const outboxStore = new Map<string, OutboxStoreItem>();
    outboxRepo = {
      findClaimable: vi.fn(async () =>
        Array.from(outboxStore.values()).filter((i) => i.status === "PENDING"),
      ),
      claim: vi.fn(async (id: string, owner: string, leaseMs: number) => {
        const item = outboxStore.get(id);
        if (!item || item.status !== "PENDING") return null;
        item.status = "CLAIMED";
        item.claimOwner = owner;
        item.fencingToken = (item.fencingToken ?? 0) + 1;
        item.attempts = (item.attempts ?? 0) + 1;
        item.claimExpiry = new Date(Date.now() + leaseMs);
        return item;
      }),
      markExecuting: vi.fn(async (id: string, owner: string, fencingToken: number) => {
        const item = outboxStore.get(id);
        if (item && item.claimOwner === owner && item.fencingToken === fencingToken) {
          item.status = "EXECUTING";
          return true;
        }
        return false;
      }),
      markCompleted: vi.fn(async (id: string, owner: string, fencingToken: number) => {
        const item = outboxStore.get(id);
        if (item && item.claimOwner === owner && item.fencingToken === fencingToken) {
          item.status = "COMPLETED";
          return true;
        }
        return false;
      }),
      markFailed: vi.fn(async (id: string, owner: string, err: string, fencingToken: number) => {
        const item = outboxStore.get(id);
        if (item && item.claimOwner === owner && item.fencingToken === fencingToken) {
          item.status = "FAILED";
          item.lastError = err;
          return true;
        }
        return false;
      }),
      markUncertain: vi.fn(async (id: string, owner: string, err: string, fencingToken: number) => {
        const item = outboxStore.get(id);
        if (item && item.claimOwner === owner && item.fencingToken === fencingToken) {
          item.status = "UNCERTAIN";
          item.lastError = err;
          return true;
        }
        return false;
      }),
      create: vi.fn(async (input: {
        id: string;
        sessionId: string;
        decisionId: string;
        action: string;
        payload: string | null;
      }) => {
        const item: OutboxStoreItem = {
          ...input,
          status: "PENDING",
          fencingToken: 1,
          attempts: 0,
          maxAttempts: 3,
        };
        outboxStore.set(input.id, item);
        return item;
      }),
    } as unknown as OutboxRepository;

    interface AttemptStoreItem {
      id: string;
      decisionId: string;
      attemptNumber: number;
      clientToken: string | null;
      status: string;
      claimOwner?: string;
      fencingToken: number;
    }
    const attemptsStore = new Map<string, AttemptStoreItem>();
    executionAttemptRepo = {
      create: vi.fn(async (input: {
        id: string;
        decisionId: string;
        attemptNumber: number;
        clientToken?: string | null;
      }) => {
        const att: AttemptStoreItem = {
          ...input,
          clientToken: input.clientToken ?? null,
          status: "PENDING",
          fencingToken: 1,
        };
        attemptsStore.set(input.id, att);
        return att;
      }),
      claimPending: vi.fn(async (id: string, owner: string) => {
        const att = attemptsStore.get(id);
        if (!att) return null;
        att.status = "CLAIMED";
        att.claimOwner = owner;
        return att;
      }),
      markExecuting: vi.fn(async (id: string, _owner: string) => {
        const att = attemptsStore.get(id);
        if (!att) return null;
        att.status = "EXECUTING";
        return att;
      }),
      markSucceeded: vi.fn(async (id: string) => {
        const att = attemptsStore.get(id);
        if (!att) return null;
        att.status = "SUCCEEDED";
        return att;
      }),
      markFailed: vi.fn(async (id: string) => {
        const att = attemptsStore.get(id);
        if (!att) return null;
        att.status = "FAILED";
        return att;
      }),
      markUnknownEffect: vi.fn(async (id: string) => {
        const att = attemptsStore.get(id);
        if (!att) return null;
        att.status = "UNKNOWN_EFFECT";
        return att;
      }),
    } as unknown as ExecutionAttemptRepository;

    decisionRepo = {
      markExecuted: vi.fn(async () => {}),
    } as unknown as DecisionRepository;

    sessionRepo = {
      updateState: vi.fn(async () => {}),
    } as unknown as SessionRepository;

    const settingsRepo = {
      getByKey: vi.fn(async (key: string) => {
        if (key === "AUTONOMY_SAFETY_STATE") {
          return { key, value: "RUNNING" };
        }
        return null;
      }),
    } as unknown as SystemSettingsRepository;
    killSwitch = new KillSwitch(settingsRepo);
  });

  it("claims and dispatches an approved action to Jules API", async () => {
    await outboxRepo.create({
      id: "out_1",
      sessionId: "ses_test_001",
      decisionId: "dec_1",
      action: "RESPOND",
      payload: "Approved instructions for Jules",
    });

    const dispatcher = new OutboxDispatcher({
      config,
      julesClient,
      outboxRepo,
      executionAttemptRepo,
      decisionRepo,
      sessionRepo,
      killSwitch,
      workerId: "worker-1",
      lock,
    });

    const summary = await dispatcher.dispatchOnce();
    expect(summary.scanned).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    // Verify side effect in mock Jules client
    expect(julesClient.sentMessages).toHaveLength(1);
    expect(julesClient.sentMessages[0]?.sessionId).toBe("ses_test_001");
    expect(julesClient.sentMessages[0]?.request.prompt).toBe("Approved instructions for Jules");

    // Verify decision marked EXECUTED
    expect(decisionRepo.markExecuted).toHaveBeenCalledWith("dec_1", "EXECUTED");
  });

  it("prevents duplicate dispatch when two workers race to claim the same outbox record", async () => {
    await outboxRepo.create({
      id: "out_race",
      sessionId: "ses_test_001",
      decisionId: "dec_race",
      action: "APPROVE_PLAN",
      payload: null,
    });

    const dispatcher1 = new OutboxDispatcher({
      config,
      julesClient,
      outboxRepo,
      executionAttemptRepo,
      decisionRepo,
      sessionRepo,
      killSwitch,
      workerId: "worker-1",
      lock,
    });

    const dispatcher2 = new OutboxDispatcher({
      config,
      julesClient,
      outboxRepo,
      executionAttemptRepo,
      decisionRepo,
      sessionRepo,
      killSwitch,
      workerId: "worker-2",
      lock,
    });

    // Run both dispatchers concurrently
    const [res1, res2] = await Promise.all([
      dispatcher1.dispatchOnce(),
      dispatcher2.dispatchOnce(),
    ]);

    // Exactly one must succeed, the other skipped
    expect(res1.succeeded + res2.succeeded).toBe(1);
    expect(julesClient.approvedPlans).toHaveLength(1);
  });

  it("handles uncertain network responses without blind replay", async () => {
    await outboxRepo.create({
      id: "out_timeout",
      sessionId: "ses_test_001",
      decisionId: "dec_timeout",
      action: "RESPOND",
      payload: "Critical deploy instruction",
    });

    // Simulate Jules timing out
    julesClient.hooks.shouldFail = (endpoint: string) => {
      if (endpoint === "sendMessage") {
        const err = new Error("Gateway Timeout 504");
        (err as Error & { name?: string }).name = "AbortError";
        return err;
      }
      return null;
    };

    const dispatcher = new OutboxDispatcher({
      config,
      julesClient,
      outboxRepo,
      executionAttemptRepo,
      decisionRepo,
      sessionRepo,
      killSwitch,
      workerId: "worker-1",
      lock,
    });

    const summary = await dispatcher.dispatchOnce();
    expect(summary.uncertain).toBe(1);
    expect(summary.succeeded).toBe(0);

    // Verify attempt marked UNKNOWN_EFFECT and outbox marked UNCERTAIN
    expect(executionAttemptRepo.markUnknownEffect).toHaveBeenCalled();
    expect(outboxRepo.markUncertain).toHaveBeenCalled();
    expect(decisionRepo.markExecuted).toHaveBeenCalledWith("dec_timeout", "UNKNOWN_EFFECT", expect.any(String));
  });

  it("refuses outbox dispatch when kill switch is PAUSED (fail-closed)", async () => {
    await outboxRepo.create({
      id: "out_paused",
      sessionId: "ses_test_001",
      decisionId: "dec_paused",
      action: "RESPOND",
      payload: "Do not execute while paused",
    });

    const pausedSettingsRepo = {
      getByKey: vi.fn(async (key: string) => {
        if (key === "AUTONOMY_SAFETY_STATE") {
          return { key, value: "PAUSED" };
        }
        return null;
      }),
    } as unknown as SystemSettingsRepository;
    const pausedKillSwitch = new KillSwitch(pausedSettingsRepo);

    const dispatcher = new OutboxDispatcher({
      config,
      julesClient,
      outboxRepo,
      executionAttemptRepo,
      decisionRepo,
      sessionRepo,
      killSwitch: pausedKillSwitch,
      workerId: "worker-1",
      lock,
    });

    const summary = await dispatcher.dispatchOnce();
    expect(summary.scanned).toBe(0);
    expect(summary.dispatched).toBe(0);
    expect(julesClient.sentMessages).toHaveLength(0);
  });
});
