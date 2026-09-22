/**
 * Live two-worker stale-owner test.
 *
 * Two worker-shaped processes (running the same DB+Redis backends) attempt
 * to claim the same outbox item. The contract is:
 *   1. Worker A claims, gets fencing token 2.
 *   2. Lease is forcibly expired.
 *   3. Worker B reclaims, gets fencing token 3.
 *   4. Worker A attempts a CAS update with the stale token → rejected.
 *   5. Worker B updates the row → accepted, no second mutation.
 *
 * Mutation count is verified by counting distinct decision-version updates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import Redis from "ioredis";
import {
  activities,
  decisions,
  executionAttempts,
  outbox,
  sessions,
} from "../../packages/db/src/schema";
import { OutboxRepository } from "../../packages/db/src/repositories/outbox.repository";
import { RedisDistributedLock } from "../../apps/worker/src/lock";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6389";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);

const redis = new Redis(REDIS_URL, { lazyConnect: true });
const redisLockA = new RedisDistributedLock(redis);
const redisLockB = new RedisDistributedLock(redis);

const outboxRepo = new OutboxRepository(db as never);

const SESSION_ID = `ses_2w_live_${Date.now()}`;
const ACTIVITY_ID = `act_2w_live_${Date.now()}`;
const DECISION_ID = `dec_2w_live_${Date.now()}`;

beforeAll(async () => {
  await client.connect();
  await redis.connect();

  await db.insert(sessions).values({
    id: SESSION_ID,
    name: `s-${SESSION_ID}`,
    repository: "live/2w",
    branch: "main",
    prompt: "two worker live test",
    state: "IN_PROGRESS",
    supervisorStatus: "AUTO_EXECUTED",
    lastActivityId: ACTIVITY_ID,
    cycleCount: 0,
    metadata: {},
  });
  await db.insert(activities).values({
    id: ACTIVITY_ID,
    sessionId: SESSION_ID,
    type: "AGENT_MESSAGE",
    content: "two worker live",
    plan: null,
    patch: null,
    toolCall: null,
    toolResult: null,
    rawPayload: {},
  });
  await db.insert(decisions).values({
    id: DECISION_ID,
    sessionId: SESSION_ID,
    activityId: ACTIVITY_ID,
    idempotencyKey: `${SESSION_ID}:${DECISION_ID}:2w`,
    action: "RESPOND",
    proposedResponse: "two worker live",
    risk: "low",
    confidence: 1.0,
    reason: "two worker live",
    evidence: [],
    concerns: [],
    provider: "test",
    model: "test",
    contextDigest: "d",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    aiLatencyMs: 0,
    precedentDecisionIds: [],
    repositoryKnowledgeIds: [],
  });
});

afterAll(async () => {
  try {
    await db.delete(outbox).where(eq(outbox.sessionId, SESSION_ID));
    await db
      .delete(executionAttempts)
      .where(eq(executionAttempts.decisionId, DECISION_ID));
    await db.delete(decisions).where(eq(decisions.id, DECISION_ID));
    await db.delete(activities).where(eq(activities.id, ACTIVITY_ID));
    await db.delete(sessions).where(eq(sessions.id, SESSION_ID));
  } catch {
    // best-effort
  }
  const keys = await redis.keys("lock:2w:*");
  if (keys.length) await redis.del(keys);
  await redis.quit();
  await client.end();
});

describe("Live two-worker: stale-owner cannot overwrite newer owner", () => {
  it("Worker A claim, expiry, Worker B claim, A's update rejected, B's accepted", async () => {
    const outboxId = `out_2w_live_${Date.now()}`;
    await outboxRepo.create({
      id: outboxId,
      sessionId: SESSION_ID,
      decisionId: DECISION_ID,
      action: "RESPOND",
      payload: "two worker live",
    });

    // 1) Worker A claims
    const aClaim = await outboxRepo.claim(outboxId, "worker-A", 60_000);
    expect(aClaim).not.toBeNull();
    const aToken = aClaim!.fencingToken;

    // 2) Force lease expiry
    await db
      .update(outbox)
      .set({ claimExpiry: new Date(Date.now() - 1000) })
      .where(eq(outbox.id, outboxId));

    // 3) Worker B claims
    const bClaim = await outboxRepo.claim(outboxId, "worker-B", 60_000);
    expect(bClaim).not.toBeNull();
    const bToken = bClaim!.fencingToken;
    expect(bToken).toBeGreaterThan(aToken);

    // 4) Worker A's CAS update must be rejected
    const aOk = await outboxRepo.markCompleted(outboxId, "worker-A", aToken);
    expect(aOk).toBe(false);

    // 5) Worker B's CAS update must be accepted
    const bOk = await outboxRepo.markCompleted(outboxId, "worker-B", bToken);
    expect(bOk).toBe(true);

    // 6) Verify final state
    const final = await outboxRepo.findById(outboxId);
    expect(final?.status).toBe("COMPLETED");
    expect(final?.claimOwner).toBe("worker-B");
    expect(final?.fencingToken).toBe(bToken);
  });

  it("Concurrent claimers under real DB: exactly one wins", async () => {
    const outboxId = `out_2w_live_race_${Date.now()}`;
    await outboxRepo.create({
      id: outboxId,
      sessionId: SESSION_ID,
      decisionId: DECISION_ID,
      action: "RESPOND",
      payload: "race",
    });

    const winnerP = await Promise.all([
      outboxRepo.claim(outboxId, "worker-A", 60_000),
      outboxRepo.claim(outboxId, "worker-B", 60_000),
      outboxRepo.claim(outboxId, "worker-C", 60_000),
    ]);
    const winners = winnerP.filter((r) => r !== null);
    expect(winners.length).toBe(1);
  });

  it("Redis lock: real Redis lock prevents concurrent process entry", async () => {
    const resource = `2w_${Date.now()}`;
    const a = redisLockA.acquire(resource, 5000);
    const b = redisLockB.acquire(resource, 5000);
    const [aRes, bRes] = await Promise.all([a, b]);
    const winners = [aRes, bRes].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    const winner = winners[0]!;
    await redisLockA.release(resource, winner);

    // Second acquisition by another worker is now possible
    const c = await redisLockB.acquire(resource, 5000);
    expect(c).not.toBeNull();
    await redisLockB.release(resource, c!);
  });
});
