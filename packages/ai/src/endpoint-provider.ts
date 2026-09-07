import { DecisionSchema } from "@jules/core";
import { logger, metrics } from "@jules/observability";
import OpenAI from "openai";
import {
  createSsrfGuardedFetch,
  validateProviderUrl,
  validateProviderUrlWithDns,
} from "./ssrf-guard.js";
import { AiDecisionResponse, BuiltContext, IAiDecisionProvider } from "./types.js";

export interface EndpointProviderConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** SDK-level retries. Default 0: the ProviderRouter owns retry policy
   *  (retrying inside the SDK would multiply against router retries). */
  maxRetries?: number;
  allowInsecureLocal?: boolean;
  trustedInternalHosts?: string[];
}

export class EndpointProvider implements IAiDecisionProvider {
  public readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly allowInsecureLocal: boolean;
  private readonly trustedInternalHosts: string[] | undefined;
  private dnsValidated = false;
  private dnsValidationPromise: Promise<void> | null = null;

  constructor(config: EndpointProviderConfig, name = "endpoint") {
    this.name = name;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxTokens = config.maxTokens ?? 2048;
    this.allowInsecureLocal = config.allowInsecureLocal ?? false;
    this.trustedInternalHosts = config.trustedInternalHosts;

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.baseUrl = baseUrl;
    const ssrfCheck = validateProviderUrl(baseUrl, {
      allowInsecureLocal: config.allowInsecureLocal,
      trustedInternalHosts: config.trustedInternalHosts,
    });

    if (!ssrfCheck.isValid) {
      throw new Error(`AI Provider URL blocked by SSRF Guard: ${ssrfCheck.reason}`);
    }

    const ssrfFetch = createSsrfGuardedFetch({
      allowInsecureLocal: config.allowInsecureLocal,
      trustedInternalHosts: config.trustedInternalHosts,
    });

    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: config.apiKey,
      timeout: this.timeoutMs,
      maxRetries: config.maxRetries ?? 0,
      fetch: ssrfFetch as unknown as typeof fetch,
    });
  }

  /**
   * Resolve the configured provider host once and confirm it does not point at
   * a private/reserved IP (DNS-rebinding protection). Fail-closed: if
   * resolution fails or the domain is ambiguous, we refuse to connect rather
   * than risk SSRF to internal services. The result is cached after the first
   * successful validation (DNS changes mid-run are out of scope for a static
   * operator-configured endpoint).
   */
  public async validateSsrSafe(_signal?: AbortSignal): Promise<void> {
    if (this.dnsValidated) return;
    if (!this.dnsValidationPromise) {
      this.dnsValidationPromise = (async () => {
        const result = await validateProviderUrlWithDns(this.baseUrl, {
          allowInsecureLocal: this.allowInsecureLocal,
          trustedInternalHosts: this.trustedInternalHosts,
        });
        if (!result.isValid) {
          throw new Error(`AI Provider DNS/SSRF validation failed: ${result.reason}`);
        }
        this.dnsValidated = true;
      })();
    }
    await this.dnsValidationPromise;
  }

  public async decide(context: BuiltContext, signal?: AbortSignal): Promise<AiDecisionResponse> {
    // SSRF DNS guard runs before the first connection attempt (fail-closed).
    await this.validateSsrSafe(signal);
    const startTime = Date.now();

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: context.systemPrompt },
            { role: "user", content: context.userPrompt },
          ],
          response_format: { type: "json_object" },
          max_tokens: this.maxTokens,
          temperature: 0.1,
        },
        { signal },
      );

      const latencyMs = Date.now() - startTime;
      metrics.recordAiLatency(latencyMs);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("AI provider returned empty response");
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch (err: unknown) {
        throw new Error(`Failed to parse AI JSON output: ${(err as Error).message}`);
      }

      const decision = DecisionSchema.parse(parsedJson);

      const usage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return {
        decision,
        provider: this.name,
        model: response.model || this.model,
        usage,
        latencyMs,
      };
    } catch (err: unknown) {
      metrics.incrementAiError(classifyAiError(err));
      logger.error("AI Decision Provider failed", err);
      throw err;
    }
  }
}

/**
 * Map an arbitrary AI provider error to one of a small, fixed set of metric
 * buckets so the `ai_errors` counter keeps bounded cardinality over long,
 * unattended runs (arbitrary `err.name` values would otherwise grow without
 * bound and inflate the Prometheus label space).
 */
interface AiErrorShape {
  name?: string;
  status?: number;
}

type ErrorRule = {
  bucket: string;
  match: (e: AiErrorShape) => boolean;
};

const AI_ERROR_RULES: ErrorRule[] = [
  {
    bucket: "timeout",
    match: (e) => includes(e.name, "Timeout") || includes(e.name, "AbortError"),
  },
  { bucket: "rate_limit", match: (e) => e.status === 429 || includes(e.name, "RateLimit") },
  { bucket: "server_error", match: (e) => e.status !== undefined && e.status >= 500 },
  { bucket: "parse", match: (e) => e.name === "SyntaxError" || includes(e.name, "JSON") },
  { bucket: "validation", match: (e) => e.name === "ZodError" || includes(e.name, "Validation") },
  { bucket: "network", match: (e) => includes(e.name, "Connection") },
];

function includes(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && haystack.includes(needle);
}

export function classifyAiError(err: unknown): string {
  const e = err as AiErrorShape;
  for (const rule of AI_ERROR_RULES) {
    if (rule.match(e)) {
      return rule.bucket;
    }
  }
  return "unknown";
}
