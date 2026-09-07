import { eq, and, lt, desc, inArray } from "drizzle-orm";
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
 * Durable execution-attempt ledger (H3).
 *
 * A worker may apply an external effect and die before recording success.
 * The reconciler reclaims stranded attempts ("stale" = past their lease) for
 * operator verification, never automatic replay. clientToken is correlation
 * metadata; Jules does not document server-side deduplication by that token.
 *
 * All claim/recover transitions are atomic UPDATE ... WHERE status=... guards so
 * concurrent reconcilers cannot claim the same attempt twice.
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
      .set({ status: "CLAIMED", claimOwner: owner, claimExpiry: expiry, startedAt: now })
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
        startedAt: now,
        errorCategory: null,
        errorMessage: null,
      })
      .where(
        and(
          eq(executionAttempts.id, id),
          lt(executionAttempts.claimExpiry, now),
          inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
        ),
      )
      .returning();
    return updated[0] ?? null;
  }

  /** Transition a claimed attempt into EXECUTING (before dispatch). */
  async markExecuting(id: string, owner: string) {
    const updated = await this.db
      .update(executionAttempts)
      .set({ status: "EXECUTING" })
      .where(and(eq(executionAttempts.id, id), eq(executionAttempts.claimOwner, owner)))
      .returning();
    return updated[0] ?? null;
  }

  /** Confirm the external effect applied successfully. */
  async markSucceeded(id: string, externalResult?: string | null) {
    await this.db
      .update(executionAttempts)
      .set({
        status: "SUCCEEDED",
        completedAt: new Date(),
        externalResult: externalResult ?? null,
        errorCategory: null,
        errorMessage: null,
      })
      .where(
        and(
          eq(executionAttempts.id, id),
          inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
        ),
      );
  }

  /**
   * Mark the effect as FAILED. `category` is TRANSIENT (safe to retry) or
   * PERMANENT (do not retry; escalate to human).
   */
  async markFailed(id: string, category: "TRANSIENT" | "PERMANENT", message?: string | null) {
    await this.db
      .update(executionAttempts)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        errorCategory: category,
        errorMessage: message ?? null,
      })
      .where(
        and(
          eq(executionAttempts.id, id),
          inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
        ),
      );
  }

  /**
   * The external call returned without a definitive result (timeout, ambiguous
   * response, connection dropped mid-flight). The effect MAY or MAY NOT have
   * applied. Never auto-retry to a fresh token; escalate to human, or reconcile
   * against live external state with the same token.
   */
  async markUnknownEffect(id: string, category: "AMBIGUOUS", message?: string | null) {
    await this.db
      .update(executionAttempts)
      .set({
        status: "UNKNOWN_EFFECT",
        completedAt: new Date(),
        errorCategory: category,
        errorMessage: message ?? null,
      })
      .where(
        and(
          eq(executionAttempts.id, id),
          inArray(executionAttempts.status, ["CLAIMED", "EXECUTING"]),
        ),
      );
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

  /** Stale (past lease) CLAIMED/EXECUTING attempts that need reconciliation. */
  async findStaleAttempts(
    _leaseMs?: number,
    statuses: ExecutionAttemptStatusValue[] = ["CLAIMED", "EXECUTING"],
  ) {
    const now = new Date();
    return this.db
      .select()
      .from(executionAttempts)
      .where(and(lt(executionAttempts.claimExpiry, now), inArray(executionAttempts.status, statuses)));
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
