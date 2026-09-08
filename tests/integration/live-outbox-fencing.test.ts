/**
 * Live PostgreSQL distributed tests for the outbox + execution attempts (R02 / R03 / R09).
 *
 * Requires:
 *   DATABASE_URL=postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import {
  decisions,
  activities,
  executionAttempts,
  outbox,
  sessions,
} from "../../packages/db/src/schema";
import {
  OutboxRepository,
} from "../../packages/db/src/repositories/outbox.repository";
import {
  ExecutionAttemptRepository,
} from "../../packages/db/src/repositories/execution-attempt.repository";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);

const outboxRepo = new OutboxRepository(db as never);
const attemptRepo = new ExecutionAttemptRepository(db as never);

async function ensureSession(id: string) {
  await db
    .insert(sessions)
    .values({
      id,
      name: `sessions/${id}`,
      repository: "live/cert",
      branch: "main",
      prompt: "Live certification session",
      state: "IN_PROGRESS",
      supervisorStatus: "AUTO_EXECUTED",
      lastActivityId: "act_live_1",
      cycleCount: 0,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: { state: "IN_PROGRESS", updatedAt: new Date() },
    });
}

async function ensureActivity(id: string, sessionId: string) {
  await db
    .insert(activities)
    .values({
      id,
      sessionId,
      type: "AGENT_MESSAGE",
      content: "live test",
      plan: null,
      patch: null,
      toolCall: null,
      toolResult: null,
      rawPayload: {},
    })
    .onConflictDoNothing();
}

async function ensureDecision(id: string, sessionId: string) {
  await db
    .insert(decisions)
    .values({
      id,
      sessionId,
      activityId: "act_live_1",
      idempotencyKey: `${sessionId}:${id}:live`,
      action: "RESPOND",
      proposedResponse: "Live test response",
      risk: "low",
      confidence: 1.0,
      reason: "live test",
      evidence: [],
      concerns: [],
      provider: "test",
      model: "test",
      contextDigest: "digest",
      executionState: "DISPATCH_REQUESTED",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      aiLatencyMs: 0,
      precedentDecisionIds: [],
      repositoryKnowledgeIds: [],
    })
    .onConflictDoNothing();
}

const cleanupOutbox: string[] = [];
const cleanupAttempts: string[] = [];
const cleanupSessions: string[] = [];

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  if (cleanupOutbox.length) {
    await db.delete(outbox).where(inArray(outbox.id, cleanupOutbox));
  }
  if (cleanupAttempts.length) {
    await db
      .delete(executionAttempts)
      .where(inArray(executionAttempts.id, cleanupAttempts));
  }
  if (cleanupSessions.length) {
    await db.delete(sessions).where(inArray(sessions.id, cleanupSessions));
  }
  await client.end();
});

afterEach(async () => {
  if (cleanupOutbox.length) {
    await db.delete(outbox).where(inArray(outbox.id, cleanupOutbox));
    cleanupOutbox.length = 0;
  }
  if (cleanupAttempts.length) {
    await db
      .delete(executionAttempts)
      .where(inArray(executionAttempts.id, cleanupAttempts));
    cleanupAttempts.length = 0;
  }
  if (cleanupSessions.length) {
    await db.delete(sessions).where(inArray(sessions.id, cleanupSessions));
    cleanupSessions.length = 0;
  }
});

describe("Live PostgreSQL: outbox concurrent claim", () => {
  it("exactly one worker wins when two claim the same PENDING outbox row", async () => {
    const sessionId = `ses_live_claim_${Date.now()}`;
    const decisionId = `dec_live_claim_${Date.now()}`;
    cleanupSessions.push(sessionId);
    await ensureSession(sessionId);
    await ensureActivity("act_live_1", sessionId);
    await ensureDecision(decisionId, sessionId);

    const outboxId = `out_live_claim_${Date.now()}`;
    cleanupOutbox.push(outboxId);
    await outboxRepo.create({
      id: outboxId,
      sessionId,
      decisionId,
      action: "RESPOND",
      payload: "Live test payload",
    });

    // Synchronization barrier: two concurrent claimers
    const a = outboxRepo.claim(outboxId, "worker-A", 60000);
    const b = outboxRepo.claim(outboxId, "worker-B", 60000);
    const [aRes, bRes] = await Promise.all([a, b]);

    const winners = [aRes, bRes].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    const winner = winners[0]!;
    expect(winner.fencingToken).toBeGreaterThanOrEqual(2);
    expect(winner.claimOwner).toMatch(/worker-[AB]/);
    expect(winner.attempts).toBe(1);
  });

  it("stale owner loses, fresh owner gets the new fencing token", async () => {
    const sessionId = `ses_live_fence_${Date.now()}`;
    const decisionId = `dec_live_fence_${Date.now()}`;
    cleanupSessions.push(sessionId);
    await ensureSession(sessionId);
    await ensureActivity("act_live_1", sessionId);
    await ensureDecision(decisionId, sessionId);

    const outboxId = `out_live_fence_${Date.now()}`;
    cleanupOutbox.push(outboxId);
    await outboxRepo.create({
      id: outboxId,
      sessionId,
      decisionId,
      action: "RESPOND",
      payload: "Fencing test",
    });

    const a = await outboxRepo.claim(outboxId, "worker-A", 60000);
    expect(a).not.toBeNull();
    const originalToken = a!.fencingToken;

    // Simulate lease expiry by forcing the row past expiry
    await db
      .update(outbox)
      .set({ claimExpiry: new Date(Date.now() - 1000) })
      .where(eq(outbox.id, outboxId));

    // B reclaims
    const b = await outboxRepo.claim(outboxId, "worker-B", 60000);
    expect(b).not.toBeNull();
    expect(b!.fencingToken).toBeGreaterThan(originalToken);
    expect(b!.claimOwner).toBe("worker-B");

    // A's CAS update must be rejected now
    const ok = await outboxRepo.markCompleted(
      outboxId,
      "worker-A",
      originalToken,
    );
    expect(ok).toBe(false);

    // B's update succeeds
    const okB = await outboxRepo.markCompleted(
      outboxId,
      "worker-B",
      b!.fencingToken,
    );
    expect(okB).toBe(true);

    const final = await outboxRepo.findById(outboxId);
    expect(final?.status).toBe("COMPLETED");
  });
});

describe("Live PostgreSQL: execution_attempts fencing", () => {
  it("rejects markSucceeded from a stale fencing token", async () => {
    const sessionId = `ses_live_att_${Date.now()}`;
    const decisionId = `dec_live_att_${Date.now()}`;
    cleanupSessions.push(sessionId);
    await ensureSession(sessionId);
    await ensureActivity("act_live_1", sessionId);
    await ensureDecision(decisionId, sessionId);

    const attemptId = `exec_live_${Date.now()}`;
    cleanupAttempts.push(attemptId);
    await attemptRepo.create({
      id: attemptId,
      decisionId,
      attemptNumber: 1,
      clientToken: `tok_${attemptId}`,
    });
    const claimed = await attemptRepo.claimPending(attemptId, "worker-A", 60000);
    expect(claimed).not.toBeNull();
    const aToken = claimed!.fencingToken;

    // Stale expiry then re-claim by worker B
    await db
      .update(executionAttempts)
      .set({ claimExpiry: new Date(Date.now() - 1000) })
      .where(eq(executionAttempts.id, attemptId));
    const reclaimed = await attemptRepo.recoverStale(
      attemptId,
      "worker-B",
      60000,
    );
    expect(reclaimed).not.toBeNull();
    const bToken = reclaimed!.fencingToken;
    expect(bToken).toBeGreaterThan(aToken);

    const okA = await attemptRepo.markSucceeded(
      attemptId,
      "worker-A",
      "stale-result",
      aToken,
    );
    expect(okA).toBeNull();
    const okB = await attemptRepo.markSucceeded(
      attemptId,
      "worker-B",
      "fresh-result",
      bToken,
    );
    expect(okB).not.toBeNull();
    expect(okB!.status).toBe("SUCCEEDED");
  });

  it("findStaleAttempts discovers PENDING rows older than the lease threshold", async () => {
    const sessionId = `ses_stale_${Date.now()}`;
    const decisionId = `dec_stale_${Date.now()}`;
    cleanupSessions.push(sessionId);
    await ensureSession(sessionId);
    await ensureActivity("act_live_1", sessionId);
    await ensureDecision(decisionId, sessionId);

    const attemptId = `exec_stale_${Date.now()}`;
    cleanupAttempts.push(attemptId);
    await attemptRepo.create({
      id: attemptId,
      decisionId,
      attemptNumber: 1,
      clientToken: `tok_${attemptId}`,
    });

    // Backdate createdAt
    await db
      .update(executionAttempts)
      .set({ createdAt: new Date(Date.now() - 600_000) })
      .where(eq(executionAttempts.id, attemptId));

    const stale = await attemptRepo.findStaleAttempts(60_000);
    expect(stale.some((row) => row.id === attemptId)).toBe(true);
  });
});

describe("Live PostgreSQL: schema integrity", () => {
  it("outbox has the required concurrency-critical columns", async () => {
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='outbox'
      ORDER BY ordinal_position
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "status",
        "claim_owner",
        "claim_expiry",
        "fencing_token",
        "attempts",
        "max_attempts",
        "session_id",
        "decision_id",
      ]),
    );
  });

  it("execution_attempts has fencing_token column", async () => {
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='execution_attempts'
        AND column_name='fencing_token'
    `);
    expect(result.rows.length).toBe(1);
  });
});
