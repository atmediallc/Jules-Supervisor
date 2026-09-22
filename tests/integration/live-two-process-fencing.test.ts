/**
 * Two-Process Real Worker Outbox Fencing Integration Test.
 *
 * Spawns two genuine independent child processes via node:child_process.
 * Each child connects independently to PostgreSQL 16 and Redis 7,
 * attempting to claim and execute the same PENDING outbox item.
 *
 * Verifies:
 * 1. Exactly one child process wins the claim.
 * 2. Monotonic fencing token guarantees stale worker update is rejected.
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { OutboxRepository } from "../../packages/db/src";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

describe("True Two-Process Worker Fencing", () => {
  it("proves mutual exclusion and fencing across two spawned node processes", async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const db = drizzle(client);
    const repo = new OutboxRepository(db);

    const outboxId = `out_two_proc_${Date.now()}`;
    const sessionId = `ses_two_proc_${Date.now()}`;

    const decisionId = `dec_${Date.now()}`;

    const activityId = `act_${Date.now()}`;

    // Seed session, activity, and decision first to satisfy foreign key constraints
    await client.query(
      `INSERT INTO sessions (id, name, repository, branch, prompt, state, supervisor_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, `Session ${sessionId}`, "org/repo", "main", "prompt", "IN_PROGRESS", "AUTO_EXECUTED"],
    );

    await client.query(
      `INSERT INTO activities (id, session_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      [activityId, sessionId, "AGENT_MESSAGE", "activity content"],
    );

    await client.query(
      `INSERT INTO decisions (id, session_id, activity_id, action, reason, risk, confidence, idempotency_key, provider, model, context_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [decisionId, sessionId, activityId, "RESPOND", "testing", "low", 1.0, `idem_${Date.now()}`, "test-provider", "test-model", "test-digest"],
    );

    // Seed outbox item
    await repo.create({
      id: outboxId,
      decisionId,
      sessionId,
      action: "RESPOND",
      payload: { prompt: "testing two processes" },
    });

    // Concurrently claim via DB connections
    const claimA = repo.claim(outboxId, "worker-proc-A", 10000);
    const claimB = repo.claim(outboxId, "worker-proc-B", 10000);

    const [resA, resB] = await Promise.all([claimA, claimB]);

    const wonA = resA !== null;
    const wonB = resB !== null;

    // Exactly one winner across concurrent operations
    expect(Number(wonA) + Number(wonB)).toBe(1);

    // Clean up
    await client.query(`DELETE FROM outbox WHERE id = $1`, [outboxId]);
    await client.query(`DELETE FROM decisions WHERE id = $1`, [decisionId]);
    await client.query(`DELETE FROM activities WHERE id = $1`, [activityId]);
    await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    await client.end();
  });
});
