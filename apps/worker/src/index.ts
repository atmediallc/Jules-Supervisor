import os from "node:os";
import { createAiProvider } from "@jules/ai";
import { getConfig, setDbOverrides } from "@jules/config";
import {
  ActivityRepository,
  ApprovalRepository,
  AuditRepository,
  BudgetRepository,
  closeDatabase,
  CorrectionRepository,
  DecisionRepository,
  ExecutionAttemptRepository,
  getDatabase,
  KillSwitch,
  AiMemoryRepository,
  RepositoryKnowledgeRepository,
  SessionRepository,
  SyncCheckpointRepository,
  SystemSettingsRepository,
} from "@jules/db";
import { JulesApiClient, MockJulesClient } from "@jules/jules-client";
import { logger } from "@jules/observability";
import { PolicyEngine } from "@jules/policy";
import { Redis } from "ioredis";
import { InMemoryDistributedLock, RedisDistributedLock } from "./lock.js";
import { MemoryContextService } from "./memory-context.js";
import { SemanticMemoryService } from "./semantic-memory.js";
import { SupervisionPipeline } from "./pipeline.js";
import { ExecutionReconciler } from "./reconciler.js";
import { SessionWatcher } from "./poller.js";
import { BullMqSupervisorQueue, DirectSupervisorQueue } from "./queue.js";
import { startHealthServer, stopHealthServer, updateHealth } from "./health.js";
import { startReadyServer, stopReadyServer } from "./ready.js";

async function main() {
  // 1. Initial config from env vars
  const baseConfig = getConfig();

  // 2. Connect to DB and load admin-managed settings overrides
  const db = getDatabase(baseConfig.DATABASE_URL);
  try {
    const settingsRepo = new SystemSettingsRepository(db);
    const dbOverrides = await settingsRepo.getAsMap();
    if (Object.keys(dbOverrides).length > 0) {
      setDbOverrides(dbOverrides);
      logger.info(`Loaded ${Object.keys(dbOverrides).length} setting(s) from database`);
    }
  } catch {
    logger.warn("Could not load system_settings from DB — using env-only config");
  }

  // 3. Final config with DB overrides applied
  const config = getConfig();

  // AI Provider — created from the canonical factory so observability reflects
  // the ACTUAL resolved provider, not just the configured intent. The factory
  // may resolve to mock (e.g. when AI_API_KEY is a placeholder) even when
  // AI_PROVIDER_TYPE claims a real endpoint; we log runtime truth below.
  const aiProvider = createAiProvider(config);
  const providerInfo = aiProvider.describe();
  logger.info("Initializing Jules Supervisor Worker Daemon...", {
    mode: config.SUPERVISOR_MODE,
    configuredProvider: config.AI_PROVIDER_TYPE,
    resolvedProvider: providerInfo.primary.name,
    resolvedModel: providerInfo.primary.model,
    fallbackEnabled: providerInfo.fallbacks.length > 0,
    providerCount: 1 + providerInfo.fallbacks.length,
  });

  const sessionRepo = new SessionRepository(db);
  const activityRepo = new ActivityRepository(db);
  const decisionRepo = new DecisionRepository(db);
  const approvalRepo = new ApprovalRepository(db);
  const auditRepo = new AuditRepository(db);
  const budgetRepo = new BudgetRepository(db);
  const knowledgeRepo = new RepositoryKnowledgeRepository(db);
  // H3 / H5: durable execution-attempt and correction ledgers.
  const executionAttemptRepo = new ExecutionAttemptRepository(db);
  const correctionRepo = new CorrectionRepository(db);
  const workerId = `${os.hostname()}:${process.pid}`;

  // Initialize Jules Client (Live or Mock based on key placeholder)
  const julesClient =
    config.JULES_API_KEY === "mock-jules-key-placeholder"
      ? new MockJulesClient()
      : new JulesApiClient({
          baseUrl: config.JULES_API_BASE_URL,
          apiKey: config.JULES_API_KEY,
          timeoutMs: config.JULES_API_TIMEOUT_MS,
          rateLimitRps: config.JULES_RATE_LIMIT_RPS,
          maxRetries: 3,
        });

  // AI Provider — created above (canonical factory) so boot observability
  // reflects the resolved provider. The pipeline consumes this same instance.

  // Policy Engine
  const policyEngine = new PolicyEngine();

  // P1: Runtime kill switch — authoritative, DB-backed safety gate.
  const killSwitch = new KillSwitch(new SystemSettingsRepository(db));

  // Distributed Lock (Phase 3 — FAIL-CLOSED for mutation safety).
  //
  // Historical bug: on a Redis connect error the worker silently fell back to
  // an InMemoryDistributedLock (per-process). In a multi-worker deployment each
  // process got an independent lock → lost mutual exclusion → two workers could
  // mutate the same session. This block keeps exclusivity honest:
  //   - When a real lock is REQUIRED (REDIS_ENABLED) and Redis is up → Redis lock.
  //   - On Redis failure, if LOCK_REQUIRE_REDIS is set → refuse to start.
  //   - Otherwise → run in a DEGRADED LOCK state: polling/observation continues
  //     on the in-memory lock (non-mutating, idempotent), but the pipeline is
  //     flipped to DEGRADED mode so every external mutation escalates to a human
  //     until distributed exclusivity can be proven again. Health reports
  //     lock=degraded so an operator sees the failure.
  let lock: InMemoryDistributedLock | RedisDistributedLock;
  let lockRedisClient: Redis | null = null;
  const lockRequired = config.REDIS_ENABLED && !config.USE_IN_MEMORY_QUEUE_FALLBACK;
  let lockUnhealthy = false;
  if (lockRequired) {
    const redisClient = new Redis(config.REDIS_URL, { lazyConnect: true });
    redisClient.on("error", (err) => {
      logger.warn("Redis lock client connection error", { error: (err as Error).message });
    });
    try {
      await redisClient.connect();
      lock = new RedisDistributedLock(redisClient);
      lockRedisClient = redisClient;
      updateHealth({ lock: "ok", redis: "ok" });
    } catch (err) {
      if (config.LOCK_REQUIRE_REDIS) {
        logger.fatal(
          "Distributed lock REQUIRED but Redis unavailable — refusing to start (fail-closed).",
          { error: (err as Error).message },
        );
        redisClient.disconnect();
        throw new Error(
          `Refusing to start without a distributed lock (LOCK_REQUIRE_REDIS=true, redis ${config.REDIS_URL})`,
        );
      }
      logger.error(
        "Redis unavailable for distributed lock — entering DEGRADED LOCK mode; mutations will escalate to human review.",
        { error: (err as Error).message },
      );
      lock = new InMemoryDistributedLock();
      lockUnhealthy = true;
      updateHealth({ lock: "degraded", redis: "degraded" });
      redisClient.disconnect();
    }
  } else {
    lock = new InMemoryDistributedLock();
    lockUnhealthy = true;
    updateHealth({ lock: "disabled", redis: "disabled" });
  }

  // P1: Cross-session relational memory service (advisory evidence)
  const memoryService = new MemoryContextService(decisionRepo, knowledgeRepo, {
    maxSuccess: config.MEMORY_PRECEDENT_MAX_SUCCESS,
    maxHumanReviewed: config.MEMORY_PRECEDENT_MAX_HUMAN_REVIEWED,
    maxFailures: config.MEMORY_PRECEDENT_MAX_FAILURES,
    maxKnowledgeItems: config.MEMORY_KNOWLEDGE_MAX_ITEMS,
  });

  // Semantic memory engine (learn/reuse/recall/inject/influence). Only active
  // when AI_MEMORY_ENABLED; otherwise a null-safe no-op that degrades gracefully.
  const semanticMemory =
    config.AI_MEMORY_ENABLED && config.AI_MEMORY_RECALL_ENABLED
      ? new SemanticMemoryService(new AiMemoryRepository(db), config)
      : null;
  if (semanticMemory) {
    await semanticMemory.ensureIndex();
    logger.info("Semantic memory engine enabled", {
      recall: config.AI_MEMORY_RECALL_ENABLED,
      reflection: config.AI_MEMORY_REFLECTION_ENABLED,
      consolidation: config.AI_MEMORY_CONSOLIDATION_ENABLED,
      collection: config.QDRANT_COLLECTION,
    });
  }

  // Pipeline
  const pipeline = new SupervisionPipeline({
    config,
    julesClient,
    aiProvider,
    policyEngine,
    sessionRepo,
    activityRepo,
    decisionRepo,
    approvalRepo,
    auditRepo,
    budgetRepo,
    executionAttemptRepo,
    correctionRepo,
    workerId,
    lock,
    memoryService,
    semanticMemory: semanticMemory ?? undefined,
    killSwitch,
  });

  // Phase 3: if a distributed lock is required but unavailable, the worker must
  // not auto-mutate (mutual exclusion cannot be proven). Flip to DEGRADED mode
  // so every mutation escalates to a human until exclusivity is restored.
  if (lockUnhealthy && lockRequired) {
    logger.error(
      "Lock unhealthy — worker running degraded: autonomous mutations will escalate to human review",
    );
    pipeline.setDegradedMode(true);
  }

  // H3: durable execution reconciler — recovers stranded external effects
  // (dispatch completed but outcome never recorded) for operator verification.
  // No automatic replay: Jules does not guarantee mutation idempotency.
  const reconciler = new ExecutionReconciler({
    config,
    julesClient,
    executionAttemptRepo,
    decisionRepo,
    workerId,
    killSwitch,
  });
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  reconcileTimer = setInterval(() => {
    reconciler.reconcileOnce().catch((err) => {
      logger.warn("Execution reconciler pass failed", { error: (err as Error).message });
    });
  }, config.EXECUTION_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  // Periodic semantic memory consolidation (expire / stale / reindex /
  // promote / archive) — best-effort, interval from config.
  let consolidationTimer: ReturnType<typeof setInterval> | null = null;
  if (semanticMemory && config.AI_MEMORY_CONSOLIDATION_ENABLED) {
    consolidationTimer = setInterval(() => {
      semanticMemory.consolidateNow().catch(() => {
        logger.warn("Periodic semantic memory consolidation pass failed");
      });
    }, config.MEMORY_CONSOLIDATION_INTERVAL_MS);
    // Do not keep the process alive just for consolidation.
    consolidationTimer.unref?.();
  }

  // Log the initial runtime safety state so an operator immediately sees the
  // effective interlock state at boot (fail-closed: read errors → SAFETY_LOCKED).
  const bootSafety = await killSwitch.getState();
  logger.info("Runtime kill switch state at boot", {
    state: bootSafety.state,
    changedAt: bootSafety.changedAt,
    changedBy: bootSafety.changedBy,
    reason: bootSafety.reason,
  });

  // Queue
  //
  // If we cannot run BullMQ (Redis unavailable or explicitly configured to use
  // the in-memory queue), we degrade to the DirectSupervisorQueue and tell the
  // pipeline to run in DEGRADED mode: mutation-capable decisions escalate to
  // human review instead of auto-executing, so an unreliable worker never makes
  // un-reviewed, hard-to-recover external mutations.
  let usingDegradedQueue = false;
  const queue =
    config.REDIS_ENABLED && !config.USE_IN_MEMORY_QUEUE_FALLBACK
      ? new BullMqSupervisorQueue(config, pipeline)
      : (() => {
          usingDegradedQueue = true;
          return new DirectSupervisorQueue(pipeline);
        })();

  await queue.start().catch((err) => {
    usingDegradedQueue = true;
    logger.warn("Could not start BullMQ, using DirectSupervisorQueue fallback", {
      error: (err as Error).message,
    });
  });

  if (usingDegradedQueue) {
    pipeline.setDegradedMode(true);
  }

  // Session Watcher / Poller — reconciles every unseen activity per session
  // via a persisted sync_checkpoints cursor, catching up on all missed work
  // (not just the most recent activity) after downtime.
  const checkpointRepo = new SyncCheckpointRepository(db);
  const watcher = new SessionWatcher(config, julesClient, pipeline, checkpointRepo);
  await watcher.start();

  // Start health and ready servers
  startHealthServer();
  startReadyServer();

  // Graceful Shutdown
  //
  // Order is important for production correctness:
  //   1. Stop the poller so no NEW sessions are picked up.
  //   2. Stop the queue (drains in-flight BullMQ jobs; worker.close() waits
  //      for running jobs to complete before returning).
  //   3. Close the DB pool (closeDatabase) so no connections are leaked.
  //   4. Close the Redis lock client.
  //   5. Stop the health/ready HTTP servers.
  //
  // A bounded deadline guarantees the process never hangs on shutdown: if the
  // graceful steps exceed GRACEFUL_SHUTDOWN_TIMEOUT_MS, we force-exit.
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`, {
      timeoutMs: config.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    });

    // Arm a force-exit fallback so a wedged resource cannot hang the process.
    const forceTimer = setTimeout(() => {
      logger.error("Graceful shutdown exceeded deadline — forcing exit");
      process.exit(1);
    }, config.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 0. Stop background timers so a periodic reconcile/consolidation pass
      //    cannot run concurrently with teardown.
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (consolidationTimer) clearInterval(consolidationTimer);

      // 1. Do not pick up new work.
      await watcher.stop();

      // 2. Drain the queue (waits for in-flight jobs to finish).
      await queue.stop();

      // 3. Close DB pool.
      await closeDatabase();
      logger.info("Database pool closed");

      // 4. Close the Redis lock client (if a Redis lock was in use).
      if (lockRedisClient) {
        await lockRedisClient.quit().catch(() => {
          lockRedisClient?.disconnect();
        });
        logger.info("Redis lock client closed");
      }

      // 5. Stop HTTP servers.
      stopHealthServer();
      stopReadyServer();

      logger.info("Graceful shutdown complete");
    } catch (err: unknown) {
      logger.error("Error during graceful shutdown", err);
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal("Fatal error in Jules Supervisor Worker Daemon", err);
  process.exit(1);
});
