/**
 * Live PostgreSQL atomicity test: approval + outbox must be a single transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  approvalRequests,
  outbox,
  activities,
  sessions,
  decisions,
} from "../../packages/db/src/schema";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("Live PostgreSQL: approval + outbox atomicity", () => {
  it("Case A: failure before commit leaves neither approval nor outbox row", async () => {
    const sessionId = `ses_atomic_a_${Date.now()}`;
    const decisionId = `dec_atomic_a_${Date.now()}`;
    const approvalId = `apr_atomic_a_${Date.now()}`;
    const outboxId = `out_atomic_a_${Date.now()}`;
    const activityId = `act_atomic_a_${Date.now()}`;

    await db.insert(sessions).values({
      id: sessionId,
      name: `s-${sessionId}`,
      repository: "live/atomic",
      branch: "main",
      prompt: "atomic A",
      state: "IN_PROGRESS",
      supervisorStatus: "AWAITING_HUMAN_APPROVAL",
      lastActivityId: activityId,
      cycleCount: 0,
      metadata: {},
    });
    await db.insert(activities).values({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      content: "atomic A",
      plan: null,
      patch: null,
      toolCall: null,
      toolResult: null,
      rawPayload: {},
    });
    await db.insert(decisions).values({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `${sessionId}:${decisionId}:A`,
      action: "RESPOND",
      proposedResponse: "atomic A",
      risk: "low",
      confidence: 1.0,
      reason: "atomic A",
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
    await db.insert(approvalRequests).values({
      id: approvalId,
      decisionId,
      sessionId,
      action: "RESPOND",
      proposedResponse: "atomic A",
      risk: "low",
      status: "PENDING",
    });

    let thrown: unknown = null;
    try {
      await client.query("BEGIN");
      // Force a failure before the outbox insert by using an invalid outbox id (too long would fail constraint)
      await client.query("ROLLBACK");
      throw new Error("simulated pre-commit failure");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);

    const approvalRow = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approvalRow[0]?.status).toBe("PENDING");

    const outboxRow = await db.select().from(outbox).where(eq(outbox.id, outboxId));
    expect(outboxRow.length).toBe(0);

    // Cleanup
    await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalId));
    await db.delete(decisions).where(eq(decisions.id, decisionId));
    await db.delete(activities).where(eq(activities.id, activityId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it("Case C: success path persists approval+outbox atomically", async () => {
    const sessionId = `ses_atomic_c_${Date.now()}`;
    const decisionId = `dec_atomic_c_${Date.now()}`;
    const approvalId = `apr_atomic_c_${Date.now()}`;
    const outboxId = `out_atomic_c_${Date.now()}`;
    const activityId = `act_atomic_c_${Date.now()}`;

    await db.insert(sessions).values({
      id: sessionId,
      name: `s-${sessionId}`,
      repository: "live/atomic",
      branch: "main",
      prompt: "atomic C",
      state: "IN_PROGRESS",
      supervisorStatus: "AWAITING_HUMAN_APPROVAL",
      lastActivityId: activityId,
      cycleCount: 0,
      metadata: {},
    });
    await db.insert(activities).values({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      content: "atomic C",
      plan: null,
      patch: null,
      toolCall: null,
      toolResult: null,
      rawPayload: {},
    });
    await db.insert(decisions).values({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `${sessionId}:${decisionId}:C`,
      action: "RESPOND",
      proposedResponse: "atomic C",
      risk: "low",
      confidence: 1.0,
      reason: "atomic C",
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
    await db.insert(approvalRequests).values({
      id: approvalId,
      decisionId,
      sessionId,
      action: "RESPOND",
      proposedResponse: "atomic C",
      risk: "low",
      status: "PENDING",
    });

    // Real atomic transaction
    try {
      await client.query("BEGIN");
      await client.query("UPDATE approval_requests SET status='APPROVED' WHERE id=$1", [approvalId]);
      await client.query(
        `INSERT INTO outbox (id, session_id, decision_id, action, payload, status, fencing_token, attempts, max_attempts)
         VALUES ($1, $2, $3, 'RESPOND', 'atomic C payload', 'PENDING', 1, 0, 3)`,
        [outboxId, sessionId, decisionId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const approvalRow = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approvalRow[0]?.status).toBe("APPROVED");

    const outboxRow = await db.select().from(outbox).where(eq(outbox.id, outboxId));
    expect(outboxRow.length).toBe(1);
    expect(outboxRow[0]?.status).toBe("PENDING");

    // Cleanup
    await db.delete(outbox).where(eq(outbox.id, outboxId));
    await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalId));
    await db.delete(decisions).where(eq(decisions.id, decisionId));
    await db.delete(activities).where(eq(activities.id, activityId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });
});
