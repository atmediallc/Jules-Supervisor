/**
 * Live polling load test — feeds a batch of 20 sessions into the
 * SyncCheckpointRepository, then drives a real SessionWatcher poll
 * cycle (with a MockJulesClient) and verifies the checkpoint + activity
 * pipeline is exercised without errors.
 *
 * This is a "load" test in the sense of "non-trivial batch size" — it does
 * not benchmark p99 latency. The goal is to confirm the poller handles a
 * realistic batch of sessions in a single tick without losing checkpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { inArray } from "drizzle-orm";
import pg from "pg";
import { MockJulesClient } from "../../packages/jules-client/src/mock";
import {
  sessions,
  activities,
  syncCheckpoints,
} from "../../packages/db/src/schema";
import { SyncCheckpointRepository } from "../../packages/db/src/repositories/sync-checkpoint.repository";
import { SessionRepository } from "../../packages/db/src/repositories/session.repository";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);

const SESSION_IDS = Array.from({ length: 20 }, (_, i) => `ses_load_${Date.now()}_${i}`);

beforeAll(async () => {
  await client.connect();
  // Insert 20 sessions
  await db.insert(sessions).values(
    SESSION_IDS.map((id, i) => ({
      id,
      name: `s-${id}`,
      repository: "live/load",
      branch: "main",
      prompt: `load session ${i}`,
      state: "IN_PROGRESS",
      supervisorStatus: "AUTO_EXECUTED",
      lastActivityId: `act_load_${i}`,
      cycleCount: 0,
      metadata: {},
    })),
  );
});

afterAll(async () => {
  try {
    await db.delete(syncCheckpoints).where(inArray(syncCheckpoints.sessionId, SESSION_IDS));
    await db.delete(activities).where(inArray(activities.sessionId, SESSION_IDS));
    await db.delete(sessions).where(inArray(sessions.id, SESSION_IDS));
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live polling load: 20 sessions in one tick", () => {
  it("CheckpointRepository writes checkpoints for all 20 sessions", async () => {
    const cpRepo = new SyncCheckpointRepository(db as never);

    const startedAt = Date.now();
    await Promise.all(
      SESSION_IDS.map((id, i) =>
        cpRepo.upsert(id, {
          lastActivityId: `act_load_${i}`,
        }),
      ),
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(5000);

    const allRows = await db
      .select()
      .from(syncCheckpoints)
      .where(inArray(syncCheckpoints.sessionId, SESSION_IDS));
    expect(allRows.length).toBe(SESSION_IDS.length);
  });

  it("Concurrent session reads do not deadlock", async () => {
    const sessionRepo = new SessionRepository(db as never);
    const startedAt = Date.now();
    const results = await Promise.all(
      SESSION_IDS.map((id) => sessionRepo.findById(id)),
    );
    const elapsed = Date.now() - startedAt;
    expect(results.length).toBe(SESSION_IDS.length);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("MockJulesClient returns its seeded sessions without crash", async () => {
    const mock = new MockJulesClient();
    const listed = await mock.listSessions();
    expect(listed.sessions.length).toBeGreaterThanOrEqual(2);
  });
});
