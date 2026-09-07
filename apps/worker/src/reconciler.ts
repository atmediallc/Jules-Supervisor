import { AppConfig } from "@jules/config";
import {
  DecisionRepository,
  ExecutionAttemptRepository,
  KillSwitch,
  safetyActionForState,
} from "@jules/db";
import { IJulesClient } from "@jules/jules-client";
import { logger, metrics } from "@jules/observability";

export interface ExecutionReconcilerDeps {
  config: AppConfig;
  julesClient: IJulesClient;
  executionAttemptRepo: ExecutionAttemptRepository;
  decisionRepo: DecisionRepository;
  /** Stable identity for claiming attempts (e.g. host:pid). */
  workerId: string;
  killSwitch?: KillSwitch;
}

export interface ReconcileResult {
  scanned: number;
  recovered: number;
  reDriven: number;
  succeeded: number;
  escalated: number;
}

/**
 * H3 durable-execution reconciler.
 *
 * Recovers attempts stranded by a worker that dispatched an external effect
 * (approvePlan / sendMessage) and then died before recording the outcome. Each
 * recovery records NEEDS_RECONCILIATION for operator verification. Jules does
 * not document a clientToken deduplication contract, so even replaying the
 * same token can duplicate an effect. Never infer remote failure from a local
 * lease expiry, and never issue another mutation during recovery.
 */
export class ExecutionReconciler {
  private readonly config: AppConfig;
  private readonly executionAttemptRepo: ExecutionAttemptRepository;
  private readonly decisionRepo: DecisionRepository;
  private readonly workerId: string;
  private readonly killSwitch: KillSwitch | null;

  constructor(deps: ExecutionReconcilerDeps) {
    this.config = deps.config;
    this.executionAttemptRepo = deps.executionAttemptRepo;
    this.decisionRepo = deps.decisionRepo;
    this.workerId = deps.workerId;
    this.killSwitch = deps.killSwitch ?? null;
  }

  /** Run one reconciliation pass (idempotent, safe to call on a timer). */
  public async reconcileOnce(): Promise<ReconcileResult> {
    const leaseMs = this.config.EXECUTION_ATTEMPT_LEASE_MS;
    const stale = await this.executionAttemptRepo.findStaleAttempts(leaseMs);

    const result: ReconcileResult = {
      scanned: stale.length,
      recovered: 0,
      reDriven: 0,
      succeeded: 0,
      escalated: 0,
    };

    for (const attempt of stale) {
      // Atomically reclaim. If null, another reconciler already claimed it.
      const claimed = await this.executionAttemptRepo.recoverStale(
        attempt.id,
        this.workerId,
        leaseMs,
      );
      if (!claimed) continue;
      result.recovered += 1;

      // Safety gate: never (re)apply an external effect when not RUNNING.
      if (this.killSwitch) {
        const rec = await this.killSwitch.getState();
        if (!this.killSwitch.isRunning(rec)) {
          const guard = safetyActionForState(rec);
          logger.warn("Reconciler refused re-drive (safety interlock)", {
            attemptId: claimed.id,
            decisionId: claimed.decisionId,
            safetyState: rec.state,
            reason: guard.reason,
          });
          metrics.incrementSafetyInterlock();
          await this.executionAttemptRepo.markNeedsReconciliation(
            claimed.id,
            `safety interlock (${rec.state})`,
          );
          result.escalated += 1;
          continue;
        }
      }

      const decision = await this.decisionRepo.findById(claimed.decisionId);
      if (!decision) {
        await this.executionAttemptRepo.markFailed(claimed.id, "PERMANENT", "decision no longer exists");
        result.escalated += 1;
        continue;
      }

      await this.executionAttemptRepo.markNeedsReconciliation(
        claimed.id,
        "External outcome is unverified; Jules mutation idempotency is not guaranteed. Verify remotely before retrying.",
      );
      result.escalated += 1;
    }

    if (result.recovered > 0) {
      logger.info("Execution reconciler pass complete", { ...result });
    }
    return result;
  }
}
