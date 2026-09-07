import { logger, metrics } from "@jules/observability";
import { CircuitBreaker } from "./circuit-breaker.js";
import { assertStructuredDecision, canSatisfy, DecisionRequirement, ProviderCapabilities } from "./provider-capabilities.js";
import { classifyProviderFailure, ProviderFailure, providerFailureClassToBucket } from "./provider-error.js";
import { AiDecisionResponse, BuiltContext, IAiDecisionProvider } from "./types.js";

/**
 * Operational health state for a provider, exposed via metrics/control plane.
 * Never contains credentials.
 */
export type ProviderHealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "CIRCUIT_OPEN"
  | "AUTH_FAILURE"
  | "MISCONFIGURED";

export interface ProviderAttempt {
  provider: string;
  model: string;
  attempt: number;
  status: "SUCCESS" | "FAILED" | "SKIPPED_CIRCUIT" | "SKIPPED_PROBE";
  failureClass?: ProviderFailure["class"];
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface RoutedDecisionResponse extends AiDecisionResponse {
  /** Ordered record of every provider attempt made for this logical decision. */
  attempts: ProviderAttempt[];
  /** Human-readable summary of what happened (for audit/metrics). */
  summary: string;
}

export interface ProviderEntry {
  provider: IAiDecisionProvider;
  capabilities: ProviderCapabilities;
  breaker?: CircuitBreaker;
  /** Optional mutable health state observed during calls. */
  health: ProviderHealthState;
}

export interface ProviderRouterOptions {
  providers: ProviderEntry[];
  /** Max same-provider retries for retryable failures (wires MAX_AI_RETRIES). */
  maxRetries?: number;
  /**
   * Hard ceiling (ms) on the WHOLE decide orchestration (M3). Prevents
   * providers × retries from stacking unbounded (worst case without this:
   * N providers × (1+retries) × per-call timeout). Defaults to 120s.
   */
  totalTimeoutMs?: number;
  /** CPU-clock injection for deterministic circuit tests. */
  now?: () => number;
}

export interface ProviderRouter {
  readonly name: string;
  decide(context: BuiltContext, signal?: AbortSignal): Promise<AiDecisionResponse>;
  /** Emit detailed per-attempt accounting (used by the pipeline / accounting). */
  decideWithAttempts(
    context: BuiltContext,
    signal?: AbortSignal,
  ): Promise<RoutedDecisionResponse>;
  /** Snapshot of provider health states for the control plane (no secrets). */
  healthSnapshot(): Array<{ name: string; model: string; health: ProviderHealthState; state: string }>;
  /**
   * Canonical runtime provider identity for observability. Derives the
   * resolved primary (the first registered provider) and any ordered fallbacks
   * from the router's OWN state — never from configuration. This is the single
   * source of truth for "what provider is actually executing", and decision
   * persistence (response.provider / response.model) agrees with it.
   * Contains no credentials.
   */
  describe(): { primary: { name: string; model: string }; fallbacks: Array<{ name: string; model: string }> };
}

/**
 * ProviderRouter implements IAiDecisionProvider so the supervision pipeline
 * (and any other consumer) stays completely unaware of individual providers,
 * failover ordering, and circuit state. It owns:
 *   - provider selection (capability-gated)
 *   - bounded failover ordering
 *   - per-provider circuit state
 *   - retry classification (same-provider retry vs fallback vs abort)
 *   - attempt attribution + cost accounting hooks
 *   - final failure classification
 */
export class DefaultProviderRouter implements ProviderRouter {
  public readonly name = "provider-router";
  private readonly providers: ProviderEntry[];
  private readonly maxRetries: number;
  private readonly totalTimeoutMs: number;

  constructor(options: ProviderRouterOptions) {
    if (options.providers.length === 0) {
      throw new Error("ProviderRouter requires at least one provider");
    }
    this.providers = options.providers;
    // Wire the previously-dead MAX_AI_RETRIES config in as the same-provider
    // retry cap. Defaults to 0 (no same-provider retry) unless configured,
    // because AI calls cost money — prefer falling back over retrying in place.
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.totalTimeoutMs = Math.max(0, options.totalTimeoutMs ?? 120_000);
    for (const entry of this.providers) {
      entry.breaker = entry.breaker ?? new CircuitBreaker({ now: options.now });
    }
  }

  public async decide(context: BuiltContext, signal?: AbortSignal): Promise<AiDecisionResponse> {
    return this.decideWithAttempts(context, signal);
  }

  public async decideWithAttempts(
    context: BuiltContext,
    signal?: AbortSignal,
  ): Promise<RoutedDecisionResponse> {
    signal?.throwIfAborted();
    const requirement: DecisionRequirement = {
      requiresStructuredDecision: true,
      estimatedPromptTokens: context.estimatedTokens ?? 0,
      requiredTimeoutMs: 30000,
    };

    const attempts: ProviderAttempt[] = [];
    const eligible = this.providers.filter((entry) =>
      canSatisfy(entry.capabilities, requirement),
    );

    // M3: hard ceiling over the WHOLE orchestration. A per-provider call is
    // bounded by its own signal/timeout, but providers × retries could stack
    // without an overall deadline. Combine the caller's signal with a local
    // timeout signal that aborts once totalTimeoutMs elapses. Always use the
    // local controller.signal (which is aborted on caller-abort or the total
    // deadline) so the orchestration signal is never undefined.
    const controller = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (this.totalTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => controller.abort(), this.totalTimeoutMs);
    }
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      return await this.routeWithSignal(
        context,
        eligible,
        attempts,
        controller.signal,
      );
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /**
   * Exhaust the eligible providers (failover + same-provider retries) under a
   * single composed AbortSignal that enforces the overall M3 deadline. Returns
   * the first structured success, or throws once all providers are exhausted.
   */
  private async routeWithSignal(
    context: BuiltContext,
    eligible: ProviderEntry[],
    attempts: ProviderAttempt[],
    signal: AbortSignal,
  ): Promise<RoutedDecisionResponse> {
    let lastFailure: ProviderFailure | null = null;

    for (const entry of eligible) {
      const breaker = entry.breaker!;

      // Circuit open -> fail fast for this provider, skip to next.
      if (!breaker.isAllowed()) {
        attempts.push({
          provider: entry.provider.name,
          model: entry.capabilities.model,
          attempt: 1,
          status: "SKIPPED_CIRCUIT",
          latencyMs: 0,
        });
        entry.health = "CIRCUIT_OPEN";
        metrics.incrementAiFailover("circuit_skip");
        continue;
      }

      // Bounded retries per this provider (retryable failures only).
      const maxAttempts = 1 + this.maxRetries;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        signal.throwIfAborted();
        const attemptStart = Date.now();
        try {
          const response = await entry.provider.decide(context, signal);
          signal.throwIfAborted();
          // Structural contract check on a REAL provider's output.
          assertStructuredDecision(response.decision);

          breaker.onSuccess();
          entry.health = "HEALTHY";
          attempts.push({
            provider: entry.provider.name,
            model: entry.capabilities.model,
            attempt,
            status: "SUCCESS",
            latencyMs: Date.now() - attemptStart,
            promptTokens: response.usage?.promptTokens,
            completionTokens: response.usage?.completionTokens,
            totalTokens: response.usage?.totalTokens,
          });

          logger.info("Provider router succeeded", {
            provider: entry.provider.name,
            attempt,
            latencyMs: Date.now() - attemptStart,
          });
          return {
            ...response,
            attempts,
            summary: `Succeeded via ${entry.provider.name} on attempt ${attempt}`,
          };
        } catch (err: unknown) {
          // Cancellation is not a provider outage and must never trigger
          // retries, fallback calls, or circuit-breaker penalties.
          signal.throwIfAborted();
          const failure = classifyProviderFailure(err);
          const latency = Date.now() - attemptStart;
          breaker.onFailure();
          if (entry.health !== "AUTH_FAILURE" && entry.health !== "MISCONFIGURED") {
            // AUTH_FAILURE/MISCONFIGURED persist so operators see them clearly.
            entry.health = failure.class === "NON_RETRYABLE_PROVIDER_FAILURE"
              ? (failure.message.toLowerCase().includes("auth")
                  ? "AUTH_FAILURE"
                  : "MISCONFIGURED")
              : "DEGRADED";
          }
          attempts.push({
            provider: entry.provider.name,
            model: entry.capabilities.model,
            attempt,
            status: "FAILED",
            failureClass: failure.class,
            latencyMs: latency,
          });
          lastFailure = failure;
          metrics.incrementAiError(providerFailureClassToBucket(failure.class));
          metrics.incrementAiFailover("provider_failure");

          // Retryable: retry the same provider up to maxAttempts.
          if (failure.class === "RETRYABLE_PROVIDER_FAILURE" && attempt < maxAttempts) {
            logger.warn(`Retrying provider ${entry.provider.name} (attempt ${attempt}/${maxAttempts})`, {
              class: failure.class,
            });
            continue;
          }

          // NOT retried: permanent failures and output failures break to the
          // next provider (fallback). We never retry a permanent failure.
          break;
        }
      }
    }

    // All eligible providers exhausted (or circuit-kupped out).
    const err = new Error(
      `All AI providers failed. Last failure: ${lastFailure?.message ?? "no eligible provider"}`,
    );
    (err as Error & { providerClass?: ProviderFailure["class"] }).providerClass =
      lastFailure?.class ?? "NON_RETRYABLE_PROVIDER_FAILURE";
    (err as Error & { attempts?: ProviderAttempt[] }).attempts = attempts;
    (err as Error & { __providerRouterAttempts?: ProviderAttempt[] }).__providerRouterAttempts =
      attempts;
    metrics.incrementAiFailover("all_providers_failed");
    throw err;
  }

  public healthSnapshot(): Array<{ name: string; model: string; health: ProviderHealthState; state: string }> {
    return this.providers.map((entry) => ({
      name: entry.provider.name,
      model: entry.capabilities.model,
      health: entry.health,
      state: entry.breaker?.getState() ?? "CLOSED",
    }));
  }

  public describe(): { primary: { name: string; model: string }; fallbacks: Array<{ name: string; model: string }> } {
    const [first, ...rest] = this.providers;
    return {
      primary: {
        name: first?.provider.name ?? "unknown",
        model: first?.capabilities.model ?? "unknown",
      },
      fallbacks: rest.map((entry) => ({
        name: entry.provider.name,
        model: entry.capabilities.model,
      })),
    };
  }

  /** Access to the per-attempt data of the most recent routed attempt (for accounting). */
  public static extractAttempts(err: unknown): ProviderAttempt[] | undefined {
    return (err as { __providerRouterAttempts?: ProviderAttempt[] } | undefined)
      ?.__providerRouterAttempts;
  }
}
