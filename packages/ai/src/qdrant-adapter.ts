/**
 * Production-grade Qdrant adapter (Phase D).
 *
 * Treats Qdrant as an external, fallible system. All operations are bounded by
 * timeouts and retries, produce structured errors, feed telemetry, and degrade
 * safely. The memory engine never talks to Qdrant directly — only through this
 * adapter, which keeps vendor details isolated.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  MemoryUnavailableError,
  MemoryConfigurationError,
  MemoryIndexError,
} from "@jules/core";
import { logger, metrics } from "@jules/observability";
import { validateProviderUrl } from "./ssrf-guard.js";

export interface QdrantAdapterConfig {
  url: string;
  apiKey: string;
  collection: string;
  vectorSize: number;
  timeoutMs: number;
  maxRetries: number;
  allowInsecureLocal?: boolean;
  trustedInternalHosts?: string[];
  embeddingModel: string;
}

export interface SemanticMemoryPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface SemanticSearchHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface SemanticSearchFilter {
  tenantId?: string;
  projectId?: string;
  repositoryId?: string;
  memoryType?: string;
  status?: string;
  branch?: string;
  commitSha?: string;
}

/** Bounded sleep for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retryable Qdrant error classes (transient network/timeout/5xx). */
function isTransientError(err: unknown): boolean {
  const e = err as { status?: number; name?: string; message?: string };
  if (e.status !== undefined && e.status >= 500 && e.status < 600) return true;
  if (e.status === 429) return true;
  const name = e.name ?? "";
  if (name.includes("Timeout") || name.includes("Abort") || name.includes("ECONN")) return true;
  return false;
}

export interface IQdrantSemanticStore {
  readonly collection: string;
  ensureCollection(): Promise<void>;
  upsert(points: SemanticMemoryPoint[], signal?: AbortSignal): Promise<void>;
  deleteByIds(ids: string[], signal?: AbortSignal): Promise<void>;
  search(
    vector: number[],
    filter: SemanticSearchFilter,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SemanticSearchHit[]>;
  retrieveByIds(ids: string[], signal?: AbortSignal): Promise<SemanticSearchHit[]>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

export class QdrantSemanticStore implements IQdrantSemanticStore {
  public readonly collection: string;
  private readonly client: QdrantClient;
  private readonly vectorSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: QdrantAdapterConfig) {
    this.collection = config.collection;
    this.vectorSize = config.vectorSize;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;

    // SSRF: Qdrant URL must not point at metadata services or unsafe protocols.
    const ssrf = validateProviderUrl(config.url, {
      allowInsecureLocal: config.allowInsecureLocal ?? false,
      trustedInternalHosts: config.trustedInternalHosts,
    });
    if (!ssrf.isValid) {
      throw new MemoryConfigurationError(`Qdrant URL blocked by SSRF guard: ${ssrf.reason}`);
    }

    this.client = new QdrantClient({
      url: config.url,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      timeout: this.timeoutMs,
    });
  }

  public async ensureCollection(_signal?: AbortSignal): Promise<void> {
    await this.withRetry(async () => {
      const existing = await this.client.getCollections();
      const names = (existing.collections ?? []).map((c) => c.name ?? "");
      if (names.includes(this.collection)) {
        return;
      }
      await this.client.createCollection(this.collection, {
        vectors: {
          size: this.vectorSize,
          distance: "Cosine",
        },
      });
      await this.ensurePayloadIndexes();
      logger.info("Qdrant collection ensured", {
        collection: this.collection,
        vectorSize: this.vectorSize,
      });
    }, "ensureCollection");
  }

  private async ensurePayloadIndexes(): Promise<void> {
    const fields = [
      "tenantId",
      "projectId",
      "repositoryId",
      "memoryType",
      "status",
      "branch",
    ];
    for (const field of fields) {
      try {
        await this.client.createPayloadIndex(this.collection, {
          field_name: field,
          field_schema: "keyword",
          wait: true,
        });
      } catch {
        // Index already exists — ignore.
      }
    }
  }

  public async upsert(
    points: SemanticMemoryPoint[],
    _signal?: AbortSignal,
  ): Promise<void> {
    if (points.length === 0) return;
    await this.withRetry(async () => {
      await this.client.upsert(this.collection, {
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
        wait: true,
      });
    }, "upsert");
    metrics.recordConsolidated(points.length);
  }

  public async deleteByIds(ids: string[], _signal?: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    await this.withRetry(async () => {
      await this.client.delete(this.collection, {
        points: ids,
        wait: true,
      });
    }, "delete");
  }

  public async search(
    vector: number[],
    filter: SemanticSearchFilter,
    limit: number,
    _signal?: AbortSignal,
  ): Promise<SemanticSearchHit[]> {
    return this.withRetry(async () => {
      const must = this.buildFilterConditions(filter);
      const resp = await this.client.query(this.collection, {
        query: vector,
        limit,
        with_payload: true,
        with_vector: false,
        filter: must.length > 0 ? { must } : undefined,
      });
      const points = resp?.points ?? [];
      return points.map((hit) => ({
        id: String(hit.id),
        score: hit.score ?? 0,
        payload: (hit.payload as Record<string, unknown>) ?? {},
      }));
    }, "search");
  }

  public async retrieveByIds(
    ids: string[],
    _signal?: AbortSignal,
  ): Promise<SemanticSearchHit[]> {
    if (ids.length === 0) return [];
    return this.withRetry(async () => {
      const resp = await this.client.retrieve(this.collection, {
        ids,
        with_payload: true,
        with_vector: false,
      });
      return resp.map((point) => ({
        id: String(point.id),
        score: 0,
        payload: (point.payload as Record<string, unknown>) ?? {},
      }));
    }, "retrieve");
  }

  public async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.getCollections();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  private buildFilterConditions(filter: SemanticSearchFilter): Array<Record<string, unknown>> {
    const must: Array<Record<string, unknown>> = [];
    if (filter.tenantId !== undefined) {
      must.push({ key: "tenantId", match: { value: filter.tenantId } });
    }
    if (filter.projectId !== undefined) {
      must.push({ key: "projectId", match: { value: filter.projectId } });
    }
    if (filter.repositoryId !== undefined) {
      must.push({ key: "repositoryId", match: { value: filter.repositoryId } });
    }
    if (filter.memoryType !== undefined) {
      must.push({ key: "memoryType", match: { value: filter.memoryType } });
    }
    if (filter.status !== undefined) {
      must.push({ key: "status", match: { value: filter.status } });
    }
    if (filter.branch !== undefined) {
      must.push({ key: "branch", match: { value: filter.branch } });
    }
    if (filter.commitSha !== undefined) {
      must.push({ key: "commitSha", match: { value: filter.commitSha } });
    }
    return must;
  }

  /**
   * Bounded retry wrapper. Retries ONLY on transient failures (timeout,
   * 5xx, 429, connection), up to maxRetries, with backoff. Non-transient
   * configuration/index errors propagate as MemoryIndexError. All failures
   * increment qdrant_failures_total.
   */
  private async withRetry<T>(fn: () => Promise<T>, op: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastErr = err;
        metrics.incrementQdrantFailure();
        if (!isTransientError(err) || attempt >= this.maxRetries) {
          const aborted = (err as Error).name === "AbortError";
          logger.warn("Qdrant operation failed", { op, attempt, error: (err as Error).message });
          if (aborted) {
            throw new MemoryUnavailableError(`Qdrant ${op} aborted`);
          }
          throw new MemoryIndexError(`Qdrant ${op} failed: ${(err as Error).message}`);
        }
        await sleep(Math.min(100 * 2 ** attempt, 2000));
      }
    }
    throw new MemoryIndexError(
      `Qdrant ${op} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
}
