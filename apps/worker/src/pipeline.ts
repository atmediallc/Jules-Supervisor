import {
  AiDecisionResponse,
  ContextBuilder,
  IAiDecisionProvider,
  RecalledMemoryDto,
} from "@jules/ai";
import { AppConfig } from "@jules/config";
import {
  BudgetUsage,
  canSubmitCorrection,
  calculateDeterministicRisk,
  Decision,
  DecisionAction,
  estimateCostUsd,
  evaluateBudgetExhaustion,
  evaluateExecutionGate,
  ExecutionGateResult,
  fingerprintDefect,
  LoopDetector,
  RiskLevel,
} from "@jules/core";
import {
  ActivityRepository,
  ApprovalRepository,
  AuditRepository,
  BudgetRepository,
  CorrectionRepository,
  DecisionRepository,
  ExecutionAttemptRepository,
  KillSwitch,
  safetyActionForState,
  SessionRepository,
} from "@jules/db";
import { IJulesClient, JulesActivity, JulesSession } from "@jules/jules-client";
import { logger, metrics } from "@jules/observability";
import { PolicyEngine } from "@jules/policy";
import { generateId, sha256 } from "@jules/shared";
import { classifyExecutionEffect, safetyInterlockError } from "./errors.js";
import { IDistributedLock } from "./lock.js";
import type { MemoryContext, MemoryContextService } from "./memory-context.js";
import type { SemanticMemoryService } from "./semantic-memory.js";

export interface PipelineDependencies {
  config: AppConfig;
  julesClient: IJulesClient;
  aiProvider: IAiDecisionProvider;
  policyEngine: PolicyEngine;
  sessionRepo: SessionRepository;
  activityRepo: ActivityRepository;
  decisionRepo: DecisionRepository;
  approvalRepo: ApprovalRepository;
  auditRepo: AuditRepository;
  budgetRepo: BudgetRepository;
  lock: IDistributedLock;
  /** H3: durable execution-attempt ledger. Required — the worker must record
   * every external mutation so a crash mid-effect can be reconciled safely. */
  executionAttemptRepo: ExecutionAttemptRepository;
  /** H5: durable correction-loop ledger. Required — the correction ceiling and
   * defect dedup set must survive restarts. */
  correctionRepo: CorrectionRepository;
  /** Stable identity for claiming execution attempts (e.g. host:pid). */
  workerId: string;
  /** P1: advisory memory retrieval (optional for backward compatibility). */
  memoryService?: MemoryContextService;
  /** Semantic memory engine (learn/reuse/inject/influence). Advisory, degraded-safe. */
  semanticMemory?: SemanticMemoryService;
  /** P1: runtime kill switch — authoritative, DB-backed, checked pre-AI and pre-mutation. */
  killSwitch?: KillSwitch;
  /** Worker is DEGRADED (e.g. queue infra unavailable): mutation-capable
   * decisions escalate to human review instead of auto-executing. */
  degradedMode?: boolean;
}

export interface ProcessActivityInput {
  session: JulesSession;
  activity: JulesActivity;
}

export interface PipelineExecutionResult {
  decisionId: string;
  action: string;
  executionGate: ExecutionGateResult;
  executed: boolean;
  requiresHumanReview: boolean;
}

export class SupervisionPipeline {
  private readonly config: AppConfig;
  private readonly julesClient: IJulesClient;
  private readonly aiProvider: IAiDecisionProvider;
  private readonly policyEngine: PolicyEngine;
  private readonly sessionRepo: SessionRepository;
  private readonly activityRepo: ActivityRepository;
  private readonly decisionRepo: DecisionRepository;
  private readonly approvalRepo: ApprovalRepository;
  private readonly auditRepo: AuditRepository;
  private readonly budgetRepo: BudgetRepository;
  private readonly executionAttemptRepo: ExecutionAttemptRepository;
  private readonly correctionRepo: CorrectionRepository;
  private readonly workerId: string;
  private readonly lock: IDistributedLock;
  private readonly contextBuilder: ContextBuilder;
  private readonly loopDetector: LoopDetector;
  private readonly memoryService: MemoryContextService | null;
  private readonly semanticMemory: SemanticMemoryService | null;
  private readonly killSwitch: KillSwitch | null;
  /** True when the worker is running DEGRADED (infra unavailable). In this
   * state mutation-capable decisions escalate to human review. */
  private degradedMode = false;
  /** In-memory defect fingerprints per session (correction-loop dedup). */
  private readonly sessionCorrectionFingerprints = new Map<string, Set<string>>();

  constructor(deps: PipelineDependencies) {
    this.config = deps.config;
    this.julesClient = deps.julesClient;
    this.aiProvider = deps.aiProvider;
    this.policyEngine = deps.policyEngine;
    this.sessionRepo = deps.sessionRepo;
    this.activityRepo = deps.activityRepo;
    this.decisionRepo = deps.decisionRepo;
    this.approvalRepo = deps.approvalRepo;
    this.auditRepo = deps.auditRepo;
    this.budgetRepo = deps.budgetRepo;
    this.executionAttemptRepo = deps.executionAttemptRepo;
    this.correctionRepo = deps.correctionRepo;
    this.workerId = deps.workerId;
    this.lock = deps.lock;
    this.contextBuilder = new ContextBuilder({
      maxBudgetTokens: deps.config.AI_MAX_TOKENS * 2,
      // P1: advisory memory budget — ContextBuilder additionally caps it at 35% of maxBudgetTokens.
      memoryBudgetTokens: deps.config.MEMORY_ADVISORY_TOKEN_BUDGET,
    });
    this.loopDetector = new LoopDetector({ maxTotalSessionCycles: deps.config.MAX_SESSION_CYCLES });
    this.memoryService = deps.memoryService ?? null;
    this.semanticMemory = deps.semanticMemory ?? null;
    this.killSwitch = deps.killSwitch ?? null;
    this.degradedMode = deps.degradedMode ?? false;
  }

  /** Flip degraded mode at runtime (e.g. after a queue-infra fallback). */
  public setDegradedMode(enabled: boolean): void {
    this.degradedMode = enabled;
    if (enabled) {
      logger.warn("Worker entering DEGRADED mode — mutations will escalate to human review");
    }
  }

  public async processActivity(
    input: ProcessActivityInput,
  ): Promise<PipelineExecutionResult | null> {
    if (this.config.SUPERVISOR_MODE === "DISABLED") return null;
    const { session, activity } = input;

    // We only trigger AI decision evaluation if session is awaiting user input or plan approval
    const requiresAction =
      (session.state === "AWAITING_USER_INPUT" && activity.type === "AGENT_MESSAGE") ||
      (session.state === "AWAITING_PLAN_APPROVAL" && activity.type === "PLAN_GENERATED");

    if (!requiresAction) {
      return null;
    }

    return this.lock.withLock(`session:${session.id}`, async () => {
      const log = logger.child({ sessionId: session.id, activityId: activity.id });

      // 1. Persist Session & Activity state
      await this.sessionRepo.upsert({
        id: session.id,
        name: session.name || session.id,
        repository: session.repository,
        branch: session.branch,
        prompt: session.prompt,
        state: session.state,
        lastActivityId: activity.id,
        updatedAt: new Date(),
      });

      await this.activityRepo.create({
        id: activity.id,
        sessionId: session.id,
        type: activity.type,
        content: activity.content || null,
        plan: (activity.plan ?? null) as Record<string, unknown> | null,
        patch: (activity.patch ?? null) as { diff?: string; filesChanged?: string[] } | null,
        rawPayload: activity as unknown as Record<string, unknown>,
      });

      // 2. Deterministic Idempotency Key
      const expectedAction = activity.type === "PLAN_GENERATED" ? "APPROVE_PLAN" : "RESPOND";
      const idempotencyKey = sha256(`${session.id}:${activity.id}:${expectedAction}`);

      // Check if decision was already computed
      const existingDecision = await this.decisionRepo.findByIdempotencyKey(idempotencyKey);
      if (existingDecision) {
        log.info("Activity already processed by supervisor (idempotent skip)", {
          decisionId: existingDecision.id,
          idempotencyKey,
        });
        metrics.incrementDuplicatePrevented();
        return {
          decisionId: existingDecision.id,
          action: existingDecision.action,
          executionGate: {
            action: existingDecision.action as DecisionAction,
            allowed: false,
            requiresHumanReview: false,
            blocked: false,
            reason: "Already processed idempotently",
            autoExecuted: false,
          },
          executed: existingDecision.executionState === "EXECUTED",
          requiresHumanReview: existingDecision.executionState === "AWAITING_APPROVAL",
        };
      }

      // 3. Check loop detection
      const recentActivities = await this.activityRepo.listBySession(session.id);
      const loopCheck = this.loopDetector.evaluate(
        recentActivities.map((a) => ({
          id: a.id,
          type: a.type,
          content: a.content || "",
          timestamp: a.createdAt.toISOString(),
        })),
      );

      if (loopCheck.isLoopDetected) {
        log.warn("Loop detected for session. Forcing human review.", { reason: loopCheck.reason });
      }

      // 4. Build Context (P1: retrieve advisory memory inside the lock so the
      // prompt and its provenance stay consistent even under concurrency).
      const memoryContext: MemoryContext | null = this.memoryService
        ? await this.memoryService.retrieve(session.repository, session.id)
        : null;

      // P1-semantic: recall relevant memories for this task (advisory, degraded-safe).
      let recalledMemories: RecalledMemoryDto[] = [];
      if (this.semanticMemory) {
        recalledMemories = await this.semanticMemory.recall({
          repositoryId: session.repository,
          task:
            session.prompt ||
            activity.content ||
            (activity.plan ? "evaluate plan" : "evaluate activity"),
          executionId: activity.id,
          affectedPaths: activity.patch?.filesChanged,
        });
      }

      const context = this.contextBuilder.build({
        sessionId: session.id,
        repository: session.repository,
        branch: session.branch,
        taskPrompt: session.prompt,
        currentState: session.state,
        triggeringActivity: {
          id: activity.id,
          type: activity.type,
          content: activity.content || "",
          plan: activity.plan as unknown as Record<string, unknown> | undefined,
          patch: activity.patch,
        },
        recentActivities: recentActivities.slice(-10).map((a) => ({
          id: a.id,
          type: a.type,
          content: a.content || "",
        })),
        historicalPrecedents: memoryContext?.historicalPrecedents ?? [],
        repositoryKnowledge: memoryContext?.repositoryKnowledge ?? [],
        recalledMemories,
      });

      // 5. Autonomy Budget Gate (before any AI call)
      const budgetRow = await this.budgetRepo.findBySession(session.id);
      const budgetUsage: BudgetUsage = {
        aiCalls: budgetRow?.aiCalls ?? 0,
        promptTokens: budgetRow?.promptTokens ?? 0,
        completionTokens: budgetRow?.completionTokens ?? 0,
        totalTokens: budgetRow?.totalTokens ?? 0,
        estimatedCostUsd: budgetRow?.estimatedCostUsd ?? 0,
        corrections: budgetRow?.corrections ?? 0,
      };
      const budgetCheck = evaluateBudgetExhaustion(budgetUsage, {
        maxAiCalls: this.config.BUDGET_MAX_AI_CALLS_PER_SESSION,
        maxTotalTokens: this.config.BUDGET_MAX_TOKENS_PER_SESSION,
        maxCostUsd: this.config.BUDGET_MAX_COST_USD_PER_SESSION,
        maxCorrections: this.config.BUDGET_MAX_CORRECTIONS_PER_SESSION,
      });
      const budgetExceeded = budgetCheck.exceeded;

      // 5a. Runtime kill switch gate — checked BEFORE any AI call and again
      // immediately before any external mutation (see step 11). In PAUSED /
      // SAFETY_LOCKED the AI is not invoked and decisions escalate to a human.
      let safetyBlocked = false;
      let safetyState: { state: string; reason: string | null } | null = null;
      if (this.killSwitch) {
        const rec = await this.killSwitch.getState();
        safetyState = { state: rec.state, reason: rec.reason };
        safetyBlocked = !this.killSwitch.isRunning(rec);
        if (safetyBlocked) {
          log.warn("Kill switch blocked AI invocation (pre-AI gate)", {
            safetyState: rec.state,
            reason: rec.reason,
          });
          metrics.incrementSafetyInterlock();
        }
      }

      let aiResponse: AiDecisionResponse;
      if (safetyBlocked) {
        // Kill switch not RUNNING: do NOT call the AI at all.
        const guard = safetyActionForState(
          safetyState
            ? { state: safetyState.state as never, changedAt: null, changedBy: null, reason: safetyState.reason }
            : { state: "SAFETY_LOCKED" as never, changedAt: null, changedBy: null, reason: null },
        );
        aiResponse = {
          provider: "safety-interlock",
          model: "none",
          decision: {
            action: guard.action as DecisionAction,
            response: null,
            risk: "high",
            confidence: 1.0,
            reason: guard.reason,
            evidence: [],
            concerns: ["safety-interlock"],
          } as Decision,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        };
      } else if (budgetExceeded) {
        // Budget exhausted: skip the AI call entirely and escalate to a human.
        log.warn("Autonomy budget exhausted. Escalating to human review.", {
          reasons: budgetCheck.reasons,
          budgetUsage,
        });
        aiResponse = {
          provider: "budget-guard",
          model: "none",
          decision: {
            action: "REQUEST_HUMAN" as DecisionAction,
            response: null,
            risk: "high",
            confidence: 1.0,
            reason: `Autonomy budget exhausted: ${budgetCheck.reasons.join("; ")}. Human review required before further AI calls.`,
            evidence: budgetCheck.reasons,
            concerns: ["autonomy-budget-exhausted"],
          } as Decision,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: 0,
        };
        metrics.incrementBudgetExhaustion();
      } else {
        // 6. Query AI Decision Engine
        aiResponse = await this.aiProvider.decide(context);
        // Record actual AI usage against the persistent budget (atomic upsert).
        await this.budgetRepo.incrementUsage(session.id, {
          aiCalls: 1,
          promptTokens: aiResponse.usage?.promptTokens ?? 0,
          completionTokens: aiResponse.usage?.completionTokens ?? 0,
          totalTokens: aiResponse.usage?.totalTokens ?? 0,
          estimatedCostUsd: this.estimateCost(
            aiResponse.usage?.promptTokens ?? 0,
            aiResponse.usage?.completionTokens ?? 0,
          ),
        });
      }

      let proposedDecision: Decision = aiResponse.decision;

      if (loopCheck.isLoopDetected) {
        proposedDecision = {
          ...proposedDecision,
          action: "REQUEST_HUMAN",
          risk: "high",
          reason: `Loop detected: ${loopCheck.reason}. Escalated to human operator.`,
        };
      }

      // 6. Policy & Risk Engine Evaluation
      const deterministicRisk = calculateDeterministicRisk({
        filesChanged: activity.patch?.filesChanged,
        diff: activity.patch?.diff,
        proposedMessage: proposedDecision.response || undefined,
        action: proposedDecision.action,
      });

      const policyResult = this.policyEngine.evaluate({
        decision: proposedDecision,
        sessionId: session.id,
        repository: session.repository,
        filesChanged: activity.patch?.filesChanged,
        diff: activity.patch?.diff,
      });

      // Effective risk is highest between AI, deterministic, and policy
      const rOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
      const cRisks: RiskLevel[] = [proposedDecision.risk, deterministicRisk.level, policyResult.effectiveRisk];
      let maxR: RiskLevel = "low";
      for (const r of cRisks) {
        if ((rOrder[r] ?? 0) > (rOrder[maxR] ?? 0)) maxR = r;
      }
      const effectiveRisk = maxR;

      metrics.incrementDecision(proposedDecision.action);
      metrics.incrementRisk(effectiveRisk);

      // 7. Execution Gate
      let gate = evaluateExecutionGate(
        proposedDecision.action,
        effectiveRisk,
        proposedDecision.confidence,
        {
          mode: this.config.SUPERVISOR_MODE,
          autoRespondEnabled: this.config.AUTO_RESPOND_ENABLED,
          autoPlanApprovalEnabled: this.config.AUTO_PLAN_APPROVAL_ENABLED,
          confidenceThreshold: this.config.CONFIDENCE_THRESHOLD,
        },
      );

      // Policy Engine overrides: Hard block or human review requirement must dominate softer outcomes
      if (policyResult.isHardBlocked) {
        gate = {
          ...gate,
          allowed: false,
          autoExecuted: false,
          blocked: true,
          requiresHumanReview: false,
          reason: `POLICY_HARD_BLOCK: ${policyResult.reasons.join("; ") || gate.reason}`,
        };
      } else if (policyResult.requiresHumanReview || !policyResult.allowed) {
        gate = {
          ...gate,
          allowed: false,
          autoExecuted: false,
          requiresHumanReview: true,
          reason: `POLICY_REVIEW_REQUIRED: ${policyResult.reasons.join("; ") || gate.reason}`,
        };
      }

      // 7a. Degraded-mode safety override (REQUIRED): when the worker is
      // running degraded (e.g. Redis/queue infra unavailable → in-memory
      // fallback), do NOT auto-execute irreversible external mutations.
      // Escalate mutation-capable actions to human review instead. This keeps
      // a degraded worker from making unreviewed changes it cannot reliably
      // track or recover.
      if (this.degradedMode && gate.autoExecuted) {
        log.warn("Degraded mode: escalating mutation-capable action to human review", {
          action: proposedDecision.action,
          mode: this.config.SUPERVISOR_MODE,
        });
        metrics.incrementDegradedEscalation();
        gate = {
          ...gate,
          autoExecuted: false,
          requiresHumanReview: true,
          blocked: false,
          reason: `DEGRADED_MODE: ${gate.reason}`,
        };
      }

      const hasExecutablePayload =
        proposedDecision.action === "APPROVE_PLAN" ||
        Boolean(proposedDecision.response && proposedDecision.response.trim().length > 0);

      if (gate.autoExecuted && !hasExecutablePayload) {
        log.warn("Auto-execution gated action lacks required payload; escalating to human review", {
          action: proposedDecision.action,
        });
        gate = {
          ...gate,
          autoExecuted: false,
          requiresHumanReview: true,
          reason: `Action ${proposedDecision.action} requires non-empty response to execute`,
        };
      }

      const decisionId = generateId("dec");
      const executionState = gate.autoExecuted
        ? "EXECUTING"
        : gate.requiresHumanReview
          ? "AWAITING_APPROVAL"
          : gate.blocked
            ? "BLOCKED"
            : "DRY_RUN_COMPLETED";

      // 8. Persist Decision Record (with AI usage & cost accounting)
      const savedDecision = await this.decisionRepo.create({
        id: decisionId,
        sessionId: session.id,
        activityId: activity.id,
        idempotencyKey,
        action: proposedDecision.action,
        proposedResponse: proposedDecision.response,
        risk: effectiveRisk,
        confidence: proposedDecision.confidence,
        reason: proposedDecision.reason,
        evidence: proposedDecision.evidence,
        concerns: proposedDecision.concerns,
        provider: aiResponse.provider,
        model: aiResponse.model,
        contextDigest: context.contextDigest,
        executionState,
        promptTokens: aiResponse.usage?.promptTokens ?? 0,
        completionTokens: aiResponse.usage?.completionTokens ?? 0,
        totalTokens: aiResponse.usage?.totalTokens ?? 0,
        estimatedCostUsd: this.estimateCost(
          aiResponse.usage?.promptTokens ?? 0,
          aiResponse.usage?.completionTokens ?? 0,
        ),
        aiLatencyMs: aiResponse.latencyMs ?? 0,
        // P1 provenance: which precedents/knowledge informed this decision.
        precedentDecisionIds: memoryContext?.precedentDecisionIds ?? [],
        repositoryKnowledgeIds: memoryContext?.repositoryKnowledgeIds ?? [],
      });

      const canonicalDecisionId = savedDecision.id;
      if (canonicalDecisionId !== decisionId) {
        log.info("Concurrent decision insert conflict detected; using canonical existing decision", {
          idempotencyKey,
          canonicalDecisionId,
        });
        return {
          decisionId: canonicalDecisionId,
          action: savedDecision.action as DecisionAction,
          executionGate: {
            action: savedDecision.action as DecisionAction,
            allowed: true,
            requiresHumanReview: savedDecision.executionState === "AWAITING_APPROVAL",
            blocked: savedDecision.executionState === "BLOCKED",
            reason: "Idempotent replay",
            autoExecuted: false,
          },
          executed: savedDecision.executionState === "EXECUTED",
          requiresHumanReview: savedDecision.executionState === "AWAITING_APPROVAL",
        };
      }

      // 9. Record Audit Log
      await this.auditRepo.record({
        id: generateId("aud"),
        actor: "SUPERVISOR_AI",
        actorType: "SYSTEM",
        action: `DECISION_${proposedDecision.action}`,
        targetType: "SESSION",
        targetId: session.id,
        sessionId: session.id,
        decisionId: canonicalDecisionId,
        beforeState: { sessionState: session.state, activityId: activity.id },
        afterState: {
          executionGate: gate,
          decision: proposedDecision,
          executionState,
        },
      });

      // P1-semantic: reflect over non-auto-executing decisions (reviews, blocks, dry runs).
      // For auto-execution, reflection runs after the mutation's actual observed outcome.
      if (this.semanticMemory && !gate.autoExecuted) {
        const outcome = gate.blocked ? "failure" : "partial";
        await this.semanticMemory.reflectAndAdmit({
          executionId: canonicalDecisionId,
          repositoryId: session.repository,
          task:
            session.prompt ||
            activity.content ||
            (activity.plan ? "evaluate plan" : "evaluate activity"),
          affectedPaths: activity.patch?.filesChanged,
          actions: recentActivities.slice(-4).map((a) => a.type),
          result: proposedDecision.response ?? "",
          outcome,
          toolsUsed: ["jules-api", "supervisor-ai"],
        });
      }

      // 10. Handle Human Review Queue Creation
      if (gate.requiresHumanReview) {
        await this.approvalRepo.create({
          id: generateId("appr"),
          decisionId: canonicalDecisionId,
          sessionId: session.id,
          status: "PENDING",
          action: proposedDecision.action,
          proposedResponse: proposedDecision.response,
        });

        await this.sessionRepo.updateState(session.id, session.state, "AWAITING_APPROVAL");
        log.info("Decision placed in Human Approval Queue", { decisionId: canonicalDecisionId, risk: effectiveRisk });
        return {
          decisionId: canonicalDecisionId,
          action: proposedDecision.action,
          executionGate: gate,
          executed: false,
          requiresHumanReview: true,
        };
      }

      // 11. Handle Auto-Execution (If allowed by gate and executable payload present)
      if (gate.autoExecuted && hasExecutablePayload) {
        // H3: durable execution attempt. Insert + claim the attempt BEFORE any
        // external mutation so a crash mid-effect leaves a recoverable record.
        // The clientToken is local correlation only: Jules does not document
        // deduplication. Recovery escalates uncertain effects without replay.
        let attemptId: string | null = null;
        try {
          const priorAttempts = await this.executionAttemptRepo.listByDecision(canonicalDecisionId);
          const attemptNumber = priorAttempts.length + 1;
          attemptId = generateId("exec");
          await this.executionAttemptRepo.create({
            id: attemptId,
            decisionId: canonicalDecisionId,
            attemptNumber,
            clientToken: idempotencyKey,
          });
          await this.executionAttemptRepo.claimPending(attemptId, this.workerId, this.config.EXECUTION_ATTEMPT_LEASE_MS);
          await this.executionAttemptRepo.markExecuting(attemptId, this.workerId);

          log.info("Auto-executing decision against Google Jules API...", {
            decisionId: canonicalDecisionId,
            action: proposedDecision.action,
            attemptId,
            attemptNumber,
          });

          // 11a. **Pre-mutation kill switch gate (REQUIRED)**: re-check the
          // safety state immediately before ANY external mutation. This closes
          // the window where a PAUSE/SAFETY_LOCK lands after the AI call but
          // before approvePlan/sendMessage. Refusing means no external effect.
          if (this.killSwitch) {
            const rec = await this.killSwitch.getState();
            if (!this.killSwitch.isRunning(rec)) {
              const guard = safetyActionForState(rec);
              log.warn("Kill switch refused pre-mutation execution", {
                safetyState: rec.state,
                reason: rec.reason,
                decisionId,
              });
              metrics.incrementSafetyInterlock();
              throw safetyInterlockError(rec.state, guard.reason);
            }
          }

          // Pre-execution verification: ensure session state has not changed
          const freshSession = await this.julesClient.getSession(session.id);
          if (freshSession.state !== session.state) {
            throw new Error(
              `Session state changed from ${session.state} to ${freshSession.state} before execution`,
            );
          }

          if (proposedDecision.action === "APPROVE_PLAN") {
            await this.julesClient.approvePlan(session.id, {
              approved: true,
              feedback: proposedDecision.response ?? undefined,
              clientToken: idempotencyKey,
            });
          } else if (proposedDecision.action === "RESPOND") {
            await this.julesClient.sendMessage(session.id, {
              message: proposedDecision.response ?? "",
              clientToken: idempotencyKey,
            });
          } else if (proposedDecision.action === "REQUEST_CHANGES") {
            // Correction loop re-submission: REQUEST_CHANGES dispatches a
            // targeted correction instruction to Jules. Defect fingerprinting
            // prevents sending the identical correction twice (infinite
            // same-correction loop); the correction budget ceiling is enforced
            // by the pre-AI budget gate.
            const correctionInstruction = proposedDecision.response ?? "";
            const fingerprint = fingerprintDefect(correctionInstruction);
            const durableFingerprints = await this.correctionRepo.fingerprintsForSession(
              session.id,
            );
            const fingerprints = new Set<string>(durableFingerprints);
            for (const f of this.sessionCorrectionFingerprints.get(session.id) ?? []) {
              fingerprints.add(f);
            }
            const check = canSubmitCorrection({
              correctionCount: fingerprints.size,
              maxCorrections: this.config.BUDGET_MAX_CORRECTIONS_PER_SESSION,
              priorFingerprints: fingerprints,
              instruction: correctionInstruction,
            });
            if (!check.allowed) {
              log.warn("Correction loop refused re-submission", {
                sessionId: session.id,
                decisionId,
                reason: check.reason,
              });
              throw new Error(`Correction loop terminated: ${check.reason}`);
            }
            await this.julesClient.sendMessage(session.id, {
              message: correctionInstruction,
              clientToken: idempotencyKey,
            });
            // Persist the correction against the DURABLE ledger (H5) so the
            // correction ceiling and dedup set survive worker restarts and are
            // shared across workers.
            await this.correctionRepo.record({
              id: generateId("corr"),
              sessionId: session.id,
              decisionId: canonicalDecisionId,
              fingerprint,
              instruction: correctionInstruction,
            });
            // Mirror the correction into the per-session budget counter that the
            // pre-AI budget gate reads for the ceiling, so the persisted budget
            // reflects each dispatched correction.
            await this.budgetRepo.incrementCorrections(session.id);
            this.addFingerprint(session.id, fingerprint);
            metrics.incrementCorrectionSubmitted();
          }

          // H3: the external effect resolved definitively — the attempt SUCCEEDED.
          await this.executionAttemptRepo.markSucceeded(attemptId);
          await this.decisionRepo.markExecuted(canonicalDecisionId, "EXECUTED");
          await this.sessionRepo.updateState(session.id, "IN_PROGRESS", "AUTO_EXECUTED");
          metrics.incrementAutoExecution();

          if (this.semanticMemory) {
            await this.semanticMemory.reflectAndAdmit({
              executionId: canonicalDecisionId,
              repositoryId: session.repository,
              task:
                session.prompt ||
                activity.content ||
                (activity.plan ? "evaluate plan" : "evaluate activity"),
              affectedPaths: activity.patch?.filesChanged,
              actions: recentActivities.slice(-4).map((a) => a.type),
              result: proposedDecision.response ?? "",
              outcome: "success",
              toolsUsed: ["jules-api", "supervisor-ai"],
            }).catch(() => {});
          }

          log.info("Decision successfully executed against Jules API", {
            decisionId: canonicalDecisionId,
            attemptId,
          });
          return {
            decisionId: canonicalDecisionId,
            action: proposedDecision.action,
            executionGate: gate,
            executed: true,
            requiresHumanReview: false,
          };
        } catch (err: unknown) {
          // H3: classify the failure so the durable ledger knows whether the
          // effect MAY have been applied (AMBIGUOUS), definitely was not but a
          // retry is safe (TRANSIENT), or must not be retried (PERMANENT).
          const classification = classifyExecutionEffect(err);
          const message = (err as Error).message ?? String(err);
          log.error(
            `Failed to execute decision against Jules API (${classification.category})`,
            err,
            { decisionId: canonicalDecisionId, attemptId },
          );
          if (attemptId) {
            if (classification.category === "PERMANENT") {
              await this.executionAttemptRepo.markFailed(attemptId, "PERMANENT", message);
            } else if (classification.category === "TRANSIENT") {
              await this.executionAttemptRepo.markFailed(attemptId, "TRANSIENT", message);
            } else {
              await this.executionAttemptRepo.markUnknownEffect(
                attemptId,
                "AMBIGUOUS",
                message,
              );
            }
          }
          await this.decisionRepo.markExecuted(canonicalDecisionId, "EXECUTION_FAILED", message);

          if (this.semanticMemory) {
            await this.semanticMemory.reflectAndAdmit({
              executionId: canonicalDecisionId,
              repositoryId: session.repository,
              task:
                session.prompt ||
                activity.content ||
                (activity.plan ? "evaluate plan" : "evaluate activity"),
              affectedPaths: activity.patch?.filesChanged,
              actions: recentActivities.slice(-4).map((a) => a.type),
              result: proposedDecision.response ?? "",
              outcome: "failure",
              toolsUsed: ["jules-api", "supervisor-ai"],
            }).catch(() => {});
          }

          throw err;
        }
      }

      return {
        decisionId: canonicalDecisionId,
        action: proposedDecision.action,
        executionGate: gate,
        executed: false,
        requiresHumanReview: false,
      };
    });
  }

  /**
   * Deterministic cost estimation for one AI call (config-driven rates).
   */
  private estimateCost(promptTokens: number, completionTokens: number): number {
    return estimateCostUsd(
      promptTokens,
      completionTokens,
      this.config.AI_COST_PER_1K_PROMPT_TOKENS_USD,
      this.config.AI_COST_PER_1K_COMPLETION_TOKENS_USD,
    );
  }

  /** Record a defect fingerprint for a session in the in-memory dedup cache.
   * The durable source of truth is the corrections ledger (H5); this in-memory
   * copy is a fast-path only and is rehydrated from the ledger on each check. */
  private addFingerprint(sessionId: string, fingerprint: string): void {
    let set = this.sessionCorrectionFingerprints.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionCorrectionFingerprints.set(sessionId, set);
    }
    set.add(fingerprint);
  }
}
