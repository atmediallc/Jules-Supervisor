/**
 * Provider-agnostic embeddings abstraction (Phase C).
 *
 * The memory engine talks to `EmbeddingProvider`, never to an AI vendor
 * directly. This keeps the memory layer independent of the request/decision
 * provider and supports future model migration and reindex.
 */
import { MemoryEmbeddingError, MemoryConfigurationError } from "@jules/core";
import { logger, metrics } from "@jules/observability";
import OpenAI from "openai";
import { createSsrfGuardedFetch, validateProviderUrl } from "./ssrf-guard.js";

export interface EmbeddingRequest {
  content: string;
  model?: string;
}

export interface EmbeddingResult {
  /** Raw vector. Length MUST equal `dimensions` at creation time. */
  vector: number[];
  /** The model that produced this embedding. */
  model: string;
  /** Number of dimensions actually returned (for validation). */
  dimensions: number;
  usage?: { promptTokens: number; totalTokens: number };
}

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
}

export interface IEmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(content: string, signal?: AbortSignal): Promise<EmbeddingResult>;
  embedBatch(contents: string[], signal?: AbortSignal): Promise<EmbeddingResult[]>;
}

/**
 * OpenAI-compatible embedding provider. Uses the existing `openai` SDK already
 * a dependency of @jules/ai. Failures surface as typed MemoryEmbeddingError and
 * are counted in metrics, so the memory engine can degrade safely.
 */
export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly dimensions: number;
  private readonly client: OpenAI;
  private readonly batchSize: number;

  constructor(private readonly config: EmbeddingProviderConfig, name = "openai-embeddings") {
    this.name = name;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.batchSize = config.batchSize;
    if (!config.apiKey) {
      throw new MemoryConfigurationError("Embedding API key is not configured");
    }

    const ssrfCheck = validateProviderUrl(config.baseUrl);
    if (!ssrfCheck.isValid) {
      throw new MemoryConfigurationError(
        `Embedding Provider URL blocked by SSRF Guard: ${ssrfCheck.reason}`,
      );
    }

    const ssrfFetch = createSsrfGuardedFetch();

    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 0, // bounded retry lives in the memory engine, not the SDK
      fetch: ssrfFetch as unknown as typeof fetch,
    });
  }

  public async embed(content: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    const results = await this.embedBatch([content], signal);
    return results[0]!;
  }

  public async embedBatch(
    contents: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult[]> {
    const start = Date.now();
    const all: EmbeddingResult[] = [];
    try {
      for (let i = 0; i < contents.length; i += this.batchSize) {
        const chunk = contents.slice(i, i + this.batchSize);
        if (signal?.aborted) {
          throw new MemoryEmbeddingError("Embedding aborted by signal");
        }
        const response = await this.client.embeddings.create(
          {
            model: this.model,
            input: chunk,
            // Explicit dimensions keep the model consistent with config.
            dimensions: this.dimensions,
          },
          { signal },
        );
        const embeddings = response.data.map((d) => {
          const vector = d.embedding;
          if (vector.length !== this.dimensions) {
            throw new MemoryEmbeddingError(
              `Embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
            );
          }
          return {
            vector,
            model: this.model,
            dimensions: vector.length,
            usage: response.usage
              ? {
                  promptTokens: response.usage.prompt_tokens,
                  totalTokens: response.usage.total_tokens,
                }
              : undefined,
          } satisfies EmbeddingResult;
        });
        all.push(...embeddings);
      }
      metrics.recordEmbeddingLatency(Date.now() - start);
      return all;
    } catch (err: unknown) {
      const aborted = signal?.aborted ?? false;
      const wrapped = new MemoryEmbeddingError(
        `Embedding failed: ${(err as Error).message}${aborted ? " (aborted)" : ""}`,
      );
      logger.warn("Embedding provider failed", { error: (err as Error).message, aborted });
      metrics.incrementEmbeddingFailure();
      throw wrapped;
    }
  }
}

/**
 * No-op embedding provider used when memory is disabled. Lets the memory
 * engine run in a reduced, non-vector mode without wiring a vendor.
 */
export class NoopEmbeddingProvider implements IEmbeddingProvider {
  public readonly name = "noop";
  public readonly model = "none";
  public readonly dimensions = 0;

  public async embed(_content: string): Promise<EmbeddingResult> {
    throw new MemoryEmbeddingError("Embeddings are disabled");
  }

  public async embedBatch(_contents: string[]): Promise<EmbeddingResult[]> {
    throw new MemoryEmbeddingError("Embeddings are disabled");
  }
}

/** Builds a provider from config; throws MemoryConfigurationError on bad config. */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): IEmbeddingProvider {
  if (!config.apiKey || config.apiKey === "mock-ai-key-placeholder") {
    return new NoopEmbeddingProvider();
  }
  return new OpenAIEmbeddingProvider(config);
}
