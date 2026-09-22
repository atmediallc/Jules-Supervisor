/**
 * Live budget concurrency test — verify that two concurrent increments
 * produce the mathematically expected total, not a lost-update.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { BudgetRepository } from "../../packages/db/src/repositories/budget.repository";
import { sessions } from "../../packages/db/src/schema";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);
const budgetRepo = new BudgetRepository(db as never);

const SESSION_ID = `ses_budget_live_${Date.now()}`;

beforeAll(async () => {
  await client.connect();
  await db.insert(sessions).values({
    id: SESSION_ID,
    name: `s-${SESSION_ID}`,
    repository: "live/budget",
    branch: "main",
    prompt: "budget live test",
    state: "IN_PROGRESS",
    supervisorStatus: "AUTO_EXECUTED",
    lastActivityId: "act_budget_1",
    cycleCount: 0,
    metadata: {},
  });
});

afterAll(async () => {
  try {
    await client.query(
      `DELETE FROM session_budgets WHERE session_id = $1`,
      [SESSION_ID],
    );
    await client.query(`DELETE FROM sessions WHERE id = $1`, [SESSION_ID]);
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live budget: concurrent increments are atomic", () => {
  it("20 concurrent +0.1 cost increments produce total = 2.0 (no lost updates)", async () => {
    const N = 20;
    const DELTA = 0.1;
    await Promise.all(
      Array.from({ length: N }, () =>
        budgetRepo.incrementUsage(SESSION_ID, {
          aiCalls: 1,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: DELTA,
        }),
      ),
    );
    const after = await budgetRepo.findBySession(SESSION_ID);
    expect(after).not.toBeNull();
    expect(after!.aiCalls).toBe(N);
    expect(after!.promptTokens).toBe(100 * N);
    expect(after!.completionTokens).toBe(50 * N);
    expect(after!.totalTokens).toBe(150 * N);
    // Floating-point: 20 * 0.1 = 2.0 in theory; allow for tiny rounding
    expect(Math.abs(after!.estimatedCostUsd - 2.0)).toBeLessThan(1e-6);
  });

  it("Increment correction counter concurrently — counter must equal N", async () => {
    const N = 10;
    // Reset via direct query
    await client.query(
      `UPDATE session_budgets SET corrections = 0 WHERE session_id = $1`,
      [SESSION_ID],
    );
    await Promise.all(
      Array.from({ length: N }, () =>
        budgetRepo.incrementCorrections(SESSION_ID),
      ),
    );
    const after = await budgetRepo.findBySession(SESSION_ID);
    expect(after!.corrections).toBe(N);
  });

  it("Hard budget cap: evaluated pre-execution, rejects actions once limit is reached", async () => {
    // Proves that while incrementUsage atomically records consumption,
    // hard caps are checked at the engine gate (evaluateBudgetExhaustion).
    const { evaluateBudgetExhaustion } = await import("@jules/core");

    const HARD_LIMITS = {
      maxAiCalls: 5,
      maxTotalTokens: 1000,
      maxCostUsd: 1.0,
      maxCorrections: 3,
    };

    // Before exhaustion
    const current = await budgetRepo.findBySession(SESSION_ID);
    const result = evaluateBudgetExhaustion(
      {
        aiCalls: current!.aiCalls,
        promptTokens: current!.promptTokens,
        completionTokens: current!.completionTokens,
        totalTokens: current!.totalTokens,
        estimatedCostUsd: current!.estimatedCostUsd,
        corrections: current!.corrections,
      },
      HARD_LIMITS,
    );

    // In the earlier test, 20 calls were made, so AI calls and cost exceed the hard limits of 5 calls / $1.0
    expect(result.exceeded).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("AI call budget exhausted"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("Cost budget exhausted"))).toBe(true);
  });
});
