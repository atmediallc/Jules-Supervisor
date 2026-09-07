import { eq, and, lt, desc, inArray, or, sql } from "drizzle-orm";
import { Database } from "../client.js";
import { executionAttempts, ExecutionAttemptStatus } from "../schema.js";

export type ExecutionAttemptStatusValue = (typeof ExecutionAttemptStatus)[number];

export interface CreateExecutionAttemptInput {
  id: string;
  decisionId: string;
  attemptNumber: number;
  clientToken?: string | null;
}

/**
 * Durable execution-attempt ledger (H3 / R03).
 *
 * A worker may apply an external effect and die before recording success.
 * The reconciler reclaims stranded attempts ("stale" = past their lease) for
 * operator verification, never automatic replay. clientToken is correlation
 * metadata; Jules does not document server-side deduplication by that token.
 *
 * All claim/recover transitions are atomic UPDATE ... WHERE status=... guards so
 * concurrent reconcilers cannot claim the same attempt twice.
 * Fencing tokens and claim owner checks prevent stale workers from overwriting
 * state after losing their lease.
 */
export class ExecutionAttemptRepository {
  constructor(private readonly db: Database) {}

  /** Insert a fresh PENDING attempt for a decision. */
  async create(input: CreateExecutionAttemptInput) {
    const inserted = await this.db
      .insert(executionAttempts)
      .values({
        id: input.id,
        decisionId: input.decisionId,
        attemptNumber: input.attemptNumber,
        status: "PENDING",
        fencingToken: 1,
        clientToken: input.clientToken ?? null,
      })
      .returning();
    return inserted[0];
  }

  /** Atomically claim a PENDING attempt for this worker. Returns null if gone. */
  async claimPending(id: string, owner: string, leaseMs: number) {
    const now = new Date();
    const expiry = new Date(now.getTime() + leaseMs);
    const updated = await this.db
      .update(executionAttempts)
      .set({
        status: "CLAIMED",
        claimOwner: owner,
        claimExpiry: expiry,
        fencingToken: sql`${executionAttempts.fencingToken} + 1`,
        startedAt: now,
      })
      .where(and(eq(executionAttempts.id, id), eq(executionAttempts.status, "PENDING")))
      .returning();
    return updated[0] ?? null;
  }

  /**
   * Atomically re-claim an attempt that is stuck in CLAIMED/EXECUTING past its
   * lease expiry. Only succeeds for attempts whose claim has lapsed, so two
   * reconcilers cannot both recover the same attempt.
   */
  async recoverStale(id: string, owner: string, leaseMs: number) {
    const now = new Date();
    const expiry = new Date(now.getTime() + leaseMs);
    const updated = await this.db
      .update(executionAttempts)
      .set({
        status: "CLAIMED",
        claimOwner: owner,
        claimExpiry: expiry,
        fencingToken: sql`${executionAttempts.fencingToken} + 1`,
        startedAt: now,
        errorCategory: null,
        errorMessage: null,
      })
      .where(
        and(
          eq(executionAttempts.id, id),
          or(
            and(
              inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
              lt(executionAttempts.claimExpiry, now),
            ),
            eq(executionAttempts.status, "PENDING"),
          ),
        ),
      )
      .returning();
    return updated[0] ?? null;
  }

  /** Transition a claimed attempt into EXECUTING (before dispatch). */
  async markExecuting(id: string, owner: string, fencingToken?: number) {
    const conditions = [
      eq(executionAttempts.id, id),
      eq(executionAttempts.claimOwner, owner),
      eq(executionAttempts.status, "CLAIMED"),
    ];
    if (fencingToken !== undefined) {
      conditions.push(eq(executionAttempts.fencingToken, fencingToken));
    }
    const updated = await this.db
      .update(executionAttempts)
      .set({ status: "EXECUTING" })
      .where(and(...conditions))
      .returning();
    return updated[0] ?? null;
  }

  /** Confirm the external effect applied successfully with owner verification. */
  async markSucceeded(
    id: string,
    owner?: string,
    externalResult?: string | null,
    fencingToken?: number,
  ) {
    const conditions = [
      eq(executionAttempts.id, id),
      inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
    ];
    if (owner !== undefined) {
      conditions.push(eq(executionAttempts.claimOwner, owner));
    }
    if (fencingToken !== undefined) {
      conditions.push(eq(executionAttempts.fencingToken, fencingToken));
    }
    const updated = await this.db
      .update(executionAttempts)
      .set({
        status: "SUCCEEDED",
        completedAt: new Date(),
        externalResult: externalResult ?? null,
        errorCategory: null,
        errorMessage: null,
      })
      .where(and(...conditions))
      .returning();
    return updated[0] ?? null;
  }

  /**
   * Mark the effect as FAILED with owner verification.
   */
  async markFailed(
    id: string,
    category: "TRANSIENT" | "PERMANENT",
    message?: string | null,
    owner?: string,
    fencingToken?: number,
  ) {
    const conditions = [
      eq(executionAttempts.id, id),
      inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
    ];
    if (owner !== undefined) {
      conditions.push(eq(executionAttempts.claimOwner, owner));
    }
    if (fencingToken !== undefined) {
      conditions.push(eq(executionAttempts.fencingToken, fencingToken));
    }
    const updated = await this.db
      .update(executionAttempts)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        errorCategory: category,
        errorMessage: message ?? null,
      })
      .where(and(...conditions))
      .returning();
    return updated[0] ?? null;
  }

  /**
   * Mark ambiguous outcome with owner verification.
   */
  async markUnknownEffect(
    id: string,
    category: "AMBIGUOUS",
    message?: string | null,
    owner?: string,
    fencingToken?: number,
  ) {
    const conditions = [
      eq(executionAttempts.id, id),
      inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
    ];
    if (owner !== undefined) {
      conditions.push(eq(executionAttempts.claimOwner, owner));
    }
    if (fencingToken !== undefined) {
      conditions.push(eq(executionAttempts.fencingToken, fencingToken));
    }
    const updated = await this.db
      .update(executionAttempts)
      .set({
        status: "UNKNOWN_EFFECT",
        completedAt: new Date(),
        errorCategory: category,
        errorMessage: message ?? null,
      })
      .where(and(...conditions))
      .returning();
    return updated[0] ?? null;
  }

  /** Flag an attempt for human reconciliation (e.g. max attempts reached). */
  async markNeedsReconciliation(id: string, message?: string | null) {
    await this.db
      .update(executionAttempts)
      .set({ status: "NEEDS_RECONCILIATION", errorMessage: message ?? null })
      .where(eq(executionAttempts.id, id));
  }

  /** Attempts currently dispatched but not yet resolved (for lease tracking). */
  async listInFlight() {
    return this.db.select().from(executionAttempts).where(eq(executionAttempts.status, "EXECUTING"));
  }

  /**
   * Stale attempts that need reconciliation:
   * - CLAIMED / EXECUTING whose claimExpiry has passed
   * - PENDING created before staleThreshold (stranded worker crash before claim)
   */
  async findStaleAttempts(
    leaseMs = 60000,
    statuses: ExecutionAttemptStatusValue[] = ["CLAIMED", "EXECUTING"],
  ) {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - leaseMs);
    return this.db
      .select()
      .from(executionAttempts)
      .where(
        or(
          and(
            lt(executionAttempts.claimExpiry, now),
            inArray(executionAttempts.status, statuses),
          ),
          and(
            eq(executionAttempts.status, "PENDING"),
            lt(executionAttempts.createdAt, staleThreshold),
          ),
        ),
      );
  }

  async listByDecision(decisionId: string) {
    return this.db
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.decisionId, decisionId))
      .orderBy(desc(executionAttempts.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
