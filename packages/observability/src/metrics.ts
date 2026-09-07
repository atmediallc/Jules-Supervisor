export interface MetricSnapshot {
  julesApiLatencyMs: { count: number; avg: number; min: number; max: number };
  aiLatencyMs: { count: number; avg: number; min: number; max: number };
  decisionsTotal: Record<string, number>;
  riskDistribution: Record<string, number>;
  approvalsTotal: Record<string, number>;
  autoExecutionsTotal: number;
  blockedDecisionsTotal: number;
  julesErrorsTotal: Record<string, number>;
  aiErrorsTotal: Record<string, number>;
  /** P1: provider-router failover events, keyed by bounded reason. */
  aiFailoversTotal: Record<string, number>;
  /** P1: runtime kill switch interlock events (pre-AI and pre-mutation blocks). */
  safetyInterlocksTotal: number;
  /** P1: mutation-capable decisions escalated to human review in DEGRADED mode. */
  degradedEscalationsTotal: number;
  duplicateEventsPrevented: number;
  budgetExhaustionsTotal: number;
  /** P1: relational memory retrieval metrics. */
  precedentQueriesTotal: number;
  precedentsReturnedTotal: number;
  knowledgeQueriesTotal: number;
  knowledgeItemsReturnedTotal: number;
  memoryRetrievalFailuresTotal: number;
  /** Correction loop: corrections dispatched to Jules. */
  correctionsSubmittedTotal: number;
  /** Semantic memory engine metrics. */
  embeddingLatencyMs: { count: number; avg: number; min: number; max: number };
  embeddingFailuresTotal: number;
  recallQueriesTotal: number;
  recallDegradedTotal: number;
  memoriesSelectedTotal: number;
  memoryTokensInjectedTotal: number;
  admissionAcceptedTotal: number;
  admissionRejectedTotal: number;
  duplicatesMergedTotal: number;
  contradictionsDetectedTotal: number;
  qdrantFailuresTotal: number;
  consolidatedCount: number;
  staleMemoryCount: number;
}

class MetricsRegistry {
  private julesLatencies: number[] = [];
  private aiLatencies: number[] = [];
  private decisions: Record<string, number> = {};
  private risks: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  private approvals: Record<string, number> = { approved: 0, rejected: 0, edited: 0 };
  private autoExecutions = 0;
  private blockedDecisions = 0;
  private julesErrors: Record<string, number> = {};
  private aiErrors: Record<string, number> = {};
  private aiFailovers: Record<string, number> = {};
  private safetyInterlocks = 0;
  private degradedEscalations = 0;
  private duplicatesPrevented = 0;
  private budgetExhaustions = 0;
  // P1: relational memory metrics
  private precedentQueries = 0;
  private precedentsReturned = 0;
  private knowledgeQueries = 0;
  private knowledgeItemsReturned = 0;
  private memoryRetrievalFailures = 0;
  // Correction loop
  private correctionsSubmitted = 0;
  // Semantic memory engine metrics
  private embeddingLatencies: number[] = [];
  private embeddingFailures = 0;
  private recallQueries = 0;
  private recallDegraded = 0;
  private memoriesSelected = 0;
  private memoryTokensInjected = 0;
  private admissionAccepted = 0;
  private admissionRejected = 0;
  private duplicatesMerged = 0;
  private contradictionsDetected = 0;
  private qdrantFailures = 0;
  private consolidatedCount = 0;
  private staleMemory = 0;

  public recordJulesLatency(ms: number): void {
    this.julesLatencies.push(ms);
    if (this.julesLatencies.length > 500) this.julesLatencies.shift();
  }

  public recordAiLatency(ms: number): void {
    this.aiLatencies.push(ms);
    if (this.aiLatencies.length > 500) this.aiLatencies.shift();
  }

  public incrementDecision(action: string): void {
    this.decisions[action] = (this.decisions[action] || 0) + 1;
  }

  public incrementRisk(risk: "low" | "medium" | "high" | "critical"): void {
    this.risks[risk] = (this.risks[risk] || 0) + 1;
  }

  public incrementApproval(status: "approved" | "rejected" | "edited"): void {
    this.approvals[status] = (this.approvals[status] || 0) + 1;
  }

  public incrementAutoExecution(): void {
    this.autoExecutions++;
  }

  public incrementBlocked(): void {
    this.blockedDecisions++;
  }

  public incrementJulesError(code: string | number): void {
    const key = String(code);
    this.julesErrors[key] = (this.julesErrors[key] || 0) + 1;
  }

  public incrementAiError(errorType: string): void {
    this.aiErrors[errorType] = (this.aiErrors[errorType] || 0) + 1;
  }

  /**
   * Record a provider-router failover event. `reason` MUST come from a small
   * fixed set to keep label cardinality bounded over long runs.
   */
  public incrementAiFailover(reason: string): void {
    this.aiFailovers[reason] = (this.aiFailovers[reason] || 0) + 1;
  }

  public incrementDuplicatePrevented(): void {
    this.duplicatesPrevented++;
  }

  /** Record a runtime kill switch interlock (an AI call or mutation refused). */
  public incrementSafetyInterlock(): void {
    this.safetyInterlocks++;
  }

  /** Record a mutation-capable decision escalated to human review in DEGRADED mode. */
  public incrementDegradedEscalation(): void {
    this.degradedEscalations++;
  }

  public incrementBudgetExhaustion(): void {
    this.budgetExhaustions++;
  }

  // P1: memory retrieval metrics
  public incrementPrecedentQuery(): void {
    this.precedentQueries++;
  }

  public recordPrecedentsReturned(count: number): void {
    this.precedentsReturned += count;
  }

  public incrementKnowledgeQuery(): void {
    this.knowledgeQueries++;
  }

  public recordKnowledgeItemsReturned(count: number): void {
    this.knowledgeItemsReturned += count;
  }

  public incrementMemoryRetrievalFailure(): void {
    this.memoryRetrievalFailures++;
  }

  /** Record a correction instruction dispatched to Jules (correction loop). */
  public incrementCorrectionSubmitted(): void {
    this.correctionsSubmitted++;
  }

  // Semantic memory engine metrics
  public recordEmbeddingLatency(ms: number): void {
    this.embeddingLatencies.push(ms);
    if (this.embeddingLatencies.length > 500) this.embeddingLatencies.shift();
  }

  public incrementEmbeddingFailure(): void {
    this.embeddingFailures++;
  }

  public incrementRecallQuery(): void {
    this.recallQueries++;
  }

  public incrementRecallDegraded(_reason?: string): void {
    this.recallDegraded++;
  }

  public recordMemoriesSelected(count: number): void {
    this.memoriesSelected += count;
  }

  public recordMemoryTokensInjected(tokens: number): void {
    this.memoryTokensInjected += tokens;
  }

  public incrementAdmissionAccepted(): void {
    this.admissionAccepted++;
  }

  public incrementAdmissionRejected(): void {
    this.admissionRejected++;
  }

  public incrementDuplicateMerged(): void {
    this.duplicatesMerged++;
  }

  public incrementContradictionDetected(): void {
    this.contradictionsDetected++;
  }

  public incrementQdrantFailure(): void {
    this.qdrantFailures++;
  }

  public recordConsolidated(count: number): void {
    this.consolidatedCount += count;
  }

  public recordStaleMemory(count: number): void {
    this.staleMemory += count;
  }

  private summarize(data: number[]) {
    if (data.length === 0) return { count: 0, avg: 0, min: 0, max: 0 };
    const sum = data.reduce((a, b) => a + b, 0);
    return {
      count: data.length,
      avg: Math.round(sum / data.length),
      min: Math.min(...data),
      max: Math.max(...data),
    };
  }

  public getSnapshot(): MetricSnapshot {
    return {
      julesApiLatencyMs: this.summarize(this.julesLatencies),
      aiLatencyMs: this.summarize(this.aiLatencies),
      decisionsTotal: { ...this.decisions },
      riskDistribution: { ...this.risks },
      approvalsTotal: { ...this.approvals },
      autoExecutionsTotal: this.autoExecutions,
      blockedDecisionsTotal: this.blockedDecisions,
      julesErrorsTotal: { ...this.julesErrors },
      aiErrorsTotal: { ...this.aiErrors },
      aiFailoversTotal: { ...this.aiFailovers },
      safetyInterlocksTotal: this.safetyInterlocks,
      degradedEscalationsTotal: this.degradedEscalations,
      duplicateEventsPrevented: this.duplicatesPrevented,
      budgetExhaustionsTotal: this.budgetExhaustions,
      precedentQueriesTotal: this.precedentQueries,
      precedentsReturnedTotal: this.precedentsReturned,
      knowledgeQueriesTotal: this.knowledgeQueries,
      knowledgeItemsReturnedTotal: this.knowledgeItemsReturned,
      memoryRetrievalFailuresTotal: this.memoryRetrievalFailures,
      correctionsSubmittedTotal: this.correctionsSubmitted,
      embeddingLatencyMs: this.summarize(this.embeddingLatencies),
      embeddingFailuresTotal: this.embeddingFailures,
      recallQueriesTotal: this.recallQueries,
      recallDegradedTotal: this.recallDegraded,
      memoriesSelectedTotal: this.memoriesSelected,
      memoryTokensInjectedTotal: this.memoryTokensInjected,
      admissionAcceptedTotal: this.admissionAccepted,
      admissionRejectedTotal: this.admissionRejected,
      duplicatesMergedTotal: this.duplicatesMerged,
      contradictionsDetectedTotal: this.contradictionsDetected,
      qdrantFailuresTotal: this.qdrantFailures,
      consolidatedCount: this.consolidatedCount,
      staleMemoryCount: this.staleMemory,
    };
  }

  public toPrometheusFormat(): string {
    const lines: string[] = [];

    // Decisions total
    lines.push("# HELP jules_decisions_total Total number of decisions computed by action");
    lines.push("# TYPE jules_decisions_total counter");
    for (const [action, count] of Object.entries(this.decisions)) {
      lines.push(`jules_decisions_total{action="${action}"} ${count}`);
    }

    // Risk distribution
    lines.push("# HELP jules_risk_evaluations_total Total risk classifications by level");
    lines.push("# TYPE jules_risk_evaluations_total counter");
    for (const [level, count] of Object.entries(this.risks)) {
      lines.push(`jules_risk_evaluations_total{level="${level}"} ${count}`);
    }

    // Auto Executions
    lines.push("# HELP jules_auto_executions_total Total autonomous API mutations executed");
    lines.push("# TYPE jules_auto_executions_total counter");
    lines.push(`jules_auto_executions_total ${this.autoExecutions}`);

    // Policy Blocks
    lines.push("# HELP jules_policy_blocked_total Total actions blocked by policy engine");
    lines.push("# TYPE jules_policy_blocked_total counter");
    lines.push(`jules_policy_blocked_total ${this.blockedDecisions}`);

    // Duplicate events prevented
    lines.push(
      "# HELP jules_duplicates_prevented_total Total duplicate activities skipped via idempotency key",
    );
    lines.push("# TYPE jules_duplicates_prevented_total counter");
    lines.push(`jules_duplicates_prevented_total ${this.duplicatesPrevented}`);

    // Budget exhaustions
    lines.push(
      "# HELP jules_budget_exhaustions_total Total decisions escalated due to exhausted autonomy budget",
    );
    lines.push("# TYPE jules_budget_exhaustions_total counter");
    lines.push(`jules_budget_exhaustions_total ${this.budgetExhaustions}`);

    // P1: relational memory metrics
    lines.push(
      "# HELP jules_precedent_queries_total Total precedent (cross-session memory) queries executed",
    );
    lines.push("# TYPE jules_precedent_queries_total counter");
    lines.push(`jules_precedent_queries_total ${this.precedentQueries}`);

    lines.push(
      "# HELP jules_precedents_returned_total Total precedents returned to decision prompts",
    );
    lines.push("# TYPE jules_precedents_returned_total counter");
    lines.push(`jules_precedents_returned_total ${this.precedentsReturned}`);

    lines.push(
      "# HELP jules_repository_knowledge_queries_total Total repository knowledge queries executed",
    );
    lines.push("# TYPE jules_repository_knowledge_queries_total counter");
    lines.push(`jules_repository_knowledge_queries_total ${this.knowledgeQueries}`);

    lines.push(
      "# HELP jules_repository_knowledge_items_total Total knowledge items returned to decision prompts",
    );
    lines.push("# TYPE jules_repository_knowledge_items_total counter");
    lines.push(`jules_repository_knowledge_items_total ${this.knowledgeItemsReturned}`);

    lines.push(
      "# HELP jules_memory_retrieval_failures_total Total memory retrieval failures (degraded to empty memory)",
    );
    lines.push("# TYPE jules_memory_retrieval_failures_total counter");
    lines.push(`jules_memory_retrieval_failures_total ${this.memoryRetrievalFailures}`);
    lines.push(`jules_corrections_submitted_total ${this.correctionsSubmitted}`);

    // Jules Latency
    const julesSummary = this.summarize(this.julesLatencies);
    lines.push(
      "# HELP jules_api_latency_ms_avg Average Jules API response latency in milliseconds",
    );
    lines.push("# TYPE jules_api_latency_ms_avg gauge");
    lines.push(`jules_api_latency_ms_avg ${julesSummary.avg}`);

    // AI Latency
    const aiSummary = this.summarize(this.aiLatencies);
    lines.push(
      "# HELP jules_ai_latency_ms_avg Average AI decision provider latency in milliseconds",
    );
    lines.push("# TYPE jules_ai_latency_ms_avg gauge");
    lines.push(`jules_ai_latency_ms_avg ${aiSummary.avg}`);

    // AI failovers (bounded reason set)
    lines.push("# HELP jules_ai_failovers_total Total AI provider failover events by reason");
    lines.push("# TYPE jules_ai_failovers_total counter");
    for (const [reason, count] of Object.entries(this.aiFailovers)) {
      lines.push(`jules_ai_failovers_total{reason="${reason}"} ${count}`);
    }

    // Safety interlocks (kill switch blocks)
    lines.push(
      "# HELP jules_safety_interlocks_total Total AI calls or mutations refused by the runtime kill switch",
    );
    lines.push("# TYPE jules_safety_interlocks_total counter");
    lines.push(`jules_safety_interlocks_total ${this.safetyInterlocks}`);

    // Degraded-mode escalations (mutation-capable decisions → human review)
    lines.push(
      "# HELP jules_degraded_escalations_total Mutation-capable decisions escalated to human review while degraded",
    );
    lines.push("# TYPE jules_degraded_escalations_total counter");
    lines.push(`jules_degraded_escalations_total ${this.degradedEscalations}`);

    return lines.join("\n") + "\n";
  }

  public reset(): void {
    this.julesLatencies = [];
    this.aiLatencies = [];
    this.decisions = {};
    this.risks = { low: 0, medium: 0, high: 0, critical: 0 };
    this.approvals = { approved: 0, rejected: 0, edited: 0 };
    this.autoExecutions = 0;
    this.blockedDecisions = 0;
    this.julesErrors = {};
    this.aiErrors = {};
    this.aiFailovers = {};
    this.safetyInterlocks = 0;
    this.degradedEscalations = 0;
    this.duplicatesPrevented = 0;
    this.budgetExhaustions = 0;
    this.precedentQueries = 0;
    this.precedentsReturned = 0;
    this.knowledgeQueries = 0;
    this.knowledgeItemsReturned = 0;
    this.memoryRetrievalFailures = 0;
  }
}

export const metrics = new MetricsRegistry();
