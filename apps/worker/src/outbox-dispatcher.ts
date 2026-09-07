import { AppConfig } from "@jules/config";
import {
  DecisionRepository,
  ExecutionAttemptRepository,
  KillSwitch,
  OutboxRecord,
  OutboxRepository,
  SessionRepository,
} from "@jules/db";
import { IJulesClient } from "@jules/jules-client";
import { logger, metrics } from "@jules/observability";
import { generateId } from "@jules/shared";
import { classifyExecutionEffect } from "./errors.js";
import { IDistributedLock } from "./lock.js";

export interface OutboxDispatcherDependencies {
  config: AppConfig;
  julesClient: IJulesClient;
  outboxRepo: OutboxRepository;
  executionAttemptRepo: ExecutionAttemptRepository;
  decisionRepo: DecisionRepository;
  sessionRepo?: SessionRepository;
  killSwitch: KillSwitch;
  workerId: string;
  lock: IDistributedLock;
}

/**
 * Supervised Outbox Dispatcher (R02 / R03).
 *
 * Reliably claims and executes human-sanctioned actions from the durable outbox.
 * Enforces distributed lease ownership, monotonic fencing tokens, and safety interlocks.
 */
export class OutboxDispatcher {
  private readonly config: AppConfig;
  private readonly julesClient: IJulesClient;
  private readonly outboxRepo: OutboxRepository;
  private readonly executionAttemptRepo: ExecutionAttemptRepository;
  private readonly decisionRepo: DecisionRepository;
  private readonly sessionRepo?: SessionRepository;
  private readonly killSwitch: KillSwitch;
  private readonly workerId: string;
  private readonly lock: IDistributedLock;

  constructor(deps: OutboxDispatcherDependencies) {
    this.config = deps.config;
    this.julesClient = deps.julesClient;
    this.outboxRepo = deps.outboxRepo;
    this.executionAttemptRepo = deps.executionAttemptRepo;
    this.decisionRepo = deps.decisionRepo;
    this.sessionRepo = deps.sessionRepo;
    this.killSwitch = deps.killSwitch;
    this.workerId = deps.workerId;
    this.lock = deps.lock;
  }

  /**
   * Scans and processes a batch of claimable outbox items.
   */
  public async dispatchOnce(): Promise<{
    scanned: number;
    dispatched: number;
    succeeded: number;
    failed: number;
    uncertain: number;
  }> {
    const safety = await this.killSwitch.getState();
    if (safety.state !== "RUNNING") {
      logger.warn("OutboxDispatcher: autonomy is paused/locked, skipping mutation dispatch", {
        safetyState: safety.state,
        reason: safety.reason,
      });
      return { scanned: 0, dispatched: 0, succeeded: 0, failed: 0, uncertain: 0 };
    }

    const claimable = await this.outboxRepo.findClaimable(10);
    if (claimable.length === 0) {
      return { scanned: 0, dispatched: 0, succeeded: 0, failed: 0, uncertain: 0 };
    }

    let dispatched = 0;
    let succeeded = 0;
    let failed = 0;
    let uncertain = 0;

    for (const item of claimable) {
      const result = await this.processItem(item);
      if (result === "SUCCEEDED") {
        dispatched++;
        succeeded++;
      } else if (result === "FAILED") {
        dispatched++;
        failed++;
      } else if (result === "UNCERTAIN") {
        dispatched++;
        uncertain++;
      }
    }

    return {
      scanned: claimable.length,
      dispatched,
      succeeded,
      failed,
      uncertain,
    };
  }

  private async processItem(item: OutboxRecord): Promise<"SKIPPED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN"> {
    const leaseMs = this.config.EXECUTION_ATTEMPT_LEASE_MS || 60000;

    return this.lock.withLock(
      `outbox:${item.sessionId}`,
      async () => {
        // Atomically claim the outbox record using CAS
        const claimed = await this.outboxRepo.claim(item.id, this.workerId, leaseMs);
        if (!claimed) {
          return "SKIPPED";
        }

        const fencingToken = claimed.fencingToken;
        const attemptId = generateId("exec");

        // Record attempt in execution_attempts ledger
        await this.executionAttemptRepo.create({
          id: attemptId,
          decisionId: item.decisionId,
          attemptNumber: claimed.attempts,
          clientToken: item.id,
        });
        await this.executionAttemptRepo.claimPending(attemptId, this.workerId, leaseMs);
        await this.executionAttemptRepo.markExecuting(attemptId, this.workerId, fencingToken);
        await this.outboxRepo.markExecuting(item.id, this.workerId, fencingToken);
        await this.decisionRepo.markExecuted(item.decisionId, "EXECUTING");

        try {
          // Pre-execution verification: ensure session exists
          await this.julesClient.getSession(item.sessionId);

          if (item.action === "APPROVE_PLAN") {
            await this.julesClient.approvePlan(item.sessionId);
          } else {
            await this.julesClient.sendMessage(item.sessionId, {
              prompt: item.payload ?? "",
            });
          }

          // Transition to terminal success with owner & fencing verification
          await this.executionAttemptRepo.markSucceeded(attemptId, this.workerId, "Acknowledged", fencingToken);
          await this.outboxRepo.markCompleted(item.id, this.workerId, fencingToken);
          await this.decisionRepo.markExecuted(item.decisionId, "EXECUTED");
          if (this.sessionRepo) {
            await this.sessionRepo.updateState(item.sessionId, "IN_PROGRESS", "APPROVED_ACTION_EXECUTED");
          }

          logger.info("Outbox action successfully dispatched to Jules API", {
            outboxId: item.id,
            decisionId: item.decisionId,
            sessionId: item.sessionId,
            action: item.action,
            fencingToken,
          });
          metrics.incrementAutoExecution();
          return "SUCCEEDED";
        } catch (err: unknown) {
          const classification = classifyExecutionEffect(err);
          const message = (err as Error).message ?? String(err);

          logger.error(`Outbox dispatch failed: ${classification.category}`, err, {
            outboxId: item.id,
            decisionId: item.decisionId,
            attemptNumber: claimed.attempts,
          });

          if (classification.category === "AMBIGUOUS") {
            await this.executionAttemptRepo.markUnknownEffect(attemptId, "AMBIGUOUS", message, this.workerId, fencingToken);
            await this.outboxRepo.markUncertain(item.id, this.workerId, message, fencingToken);
            await this.decisionRepo.markExecuted(item.decisionId, "UNKNOWN_EFFECT", message);
            return "UNCERTAIN";
          } else {
            // Check if max attempts reached
            const isFinal = claimed.attempts >= claimed.maxAttempts || classification.category === "PERMANENT";
            if (isFinal) {
              await this.executionAttemptRepo.markFailed(attemptId, "PERMANENT", message, this.workerId, fencingToken);
              await this.outboxRepo.markFailed(item.id, this.workerId, message, fencingToken);
              await this.decisionRepo.markExecuted(item.decisionId, "EXECUTION_FAILED", message);
            } else {
              await this.executionAttemptRepo.markFailed(attemptId, "TRANSIENT", message, this.workerId, fencingToken);
              // Will be retried on next pass after claim expiry
            }
            return "FAILED";
          }
        }
      },
      leaseMs,
    );
  }
}
