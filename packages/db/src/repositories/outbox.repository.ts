import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { Database } from "../client.js";
import { outbox } from "../schema.js";

export type OutboxRecord = typeof outbox.$inferSelect;

export interface CreateOutboxInput {
  id: string;
  sessionId: string;
  decisionId: string;
  action: string;
  payload?: string | null;
  maxAttempts?: number;
}

/**
 * Durable Outbox Repository (R02 / R03).
 *
 * Guarantees atomic dispatch persistence with approvals. Workers claim
 * records with monotonic fencing tokens and lease deadlines, preventing
 * split-brain duplicate external dispatches.
 */
export class OutboxRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateOutboxInput): Promise<OutboxRecord> {
    const inserted = await this.db
      .insert(outbox)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        decisionId: input.decisionId,
        action: input.action,
        payload: input.payload ?? null,
        status: "PENDING",
        fencingToken: 1,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning();
    return inserted[0]!;
  }

  async findClaimable(limit = 10): Promise<OutboxRecord[]> {
    const now = new Date();
    return this.db
      .select()
      .from(outbox)
      .where(
        or(
          eq(outbox.status, "PENDING"),
          and(
            inArray(outbox.status, ["CLAIMED", "EXECUTING"]),
            lt(outbox.claimExpiry, now),
            sql`${outbox.attempts} < ${outbox.maxAttempts}`,
          ),
        ),
      )
      .limit(limit);
  }

  async claim(
    id: string,
    owner: string,
    leaseMs: number,
  ): Promise<OutboxRecord | null> {
    const now = new Date();
    const expiry = new Date(now.getTime() + leaseMs);

    const updated = await this.db
      .update(outbox)
      .set({
        status: "CLAIMED",
        claimOwner: owner,
        claimExpiry: expiry,
        fencingToken: sql`${outbox.fencingToken} + 1`,
        attempts: sql`${outbox.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(outbox.id, id),
          or(
            eq(outbox.status, "PENDING"),
            and(
              inArray(outbox.status, ["CLAIMED", "EXECUTING"]),
              lt(outbox.claimExpiry, now),
            ),
          ),
        ),
      )
      .returning();

    return updated[0] ?? null;
  }

  async markExecuting(
    id: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(outbox)
      .set({
        status: "EXECUTING",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outbox.id, id),
          eq(outbox.claimOwner, owner),
          eq(outbox.fencingToken, fencingToken),
          eq(outbox.status, "CLAIMED"),
        ),
      )
      .returning();

    return updated.length > 0;
  }

  async markCompleted(
    id: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(outbox)
      .set({
        status: "COMPLETED",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outbox.id, id),
          eq(outbox.claimOwner, owner),
          eq(outbox.fencingToken, fencingToken),
          inArray(outbox.status, ["CLAIMED", "EXECUTING"]),
        ),
      )
      .returning();

    return updated.length > 0;
  }

  async markFailed(
    id: string,
    owner: string,
    error: string,
    fencingToken: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(outbox)
      .set({
        status: "FAILED",
        lastError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outbox.id, id),
          eq(outbox.claimOwner, owner),
          eq(outbox.fencingToken, fencingToken),
          inArray(outbox.status, ["CLAIMED", "EXECUTING"]),
        ),
      )
      .returning();

    return updated.length > 0;
  }

  async markUncertain(
    id: string,
    owner: string,
    error: string,
    fencingToken: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(outbox)
      .set({
        status: "UNCERTAIN",
        lastError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outbox.id, id),
          eq(outbox.claimOwner, owner),
          eq(outbox.fencingToken, fencingToken),
          inArray(outbox.status, ["CLAIMED", "EXECUTING"]),
        ),
      )
      .returning();

    return updated.length > 0;
  }

  async findById(id: string): Promise<OutboxRecord | null> {
    const rows = await this.db
      .select()
      .from(outbox)
      .where(eq(outbox.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByDecisionId(decisionId: string): Promise<OutboxRecord | null> {
    const rows = await this.db
      .select()
      .from(outbox)
      .where(eq(outbox.decisionId, decisionId))
      .limit(1);
    return rows[0] ?? null;
  }
}
