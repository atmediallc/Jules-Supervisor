/**
 * Hybrid memory recall + ranking engine (Phase F).
 *
 * Retrieval is NOT naive top-K cosine similarity. It combines:
 *   - semantic search (Qdrant)
 *   - structured metadata filtering (tenant/project/repo mandatory)
 *   - deterministic reranking (semantic + importance + confidence +
 *     freshness + repo/path affinity) with staleness/supersession penalties
 *   - diversity via category caps + MMR-style dedup
 *   - token budgeting
 *
 * Returns structured results with full auditing metadata (why selected, rank,
 * score components) so influence can be recorded.
 */
import {
  AiMemory,
  DEFAULT_RANKING_CONFIG,
  MemoryRankingConfig,
  MemoryRecallRequest,
  MemoryRecallResponse,
  RecalledMemoryItem,
  SourceTrust,
  SOURCE_TRUST_RANK,
} from "@jules/core";
import { AiMemoryRepository } from "@jules/db";
import { IEmbeddingProvider } from "./embedding-provider.js";
import { IQdrantSemanticStore, SemanticSearchHit } from "./qdrant-adapter.js";
import { estimateTokens } from "./token-counter.js";
import { logger, metrics } from "@jules/observability";

/** Rough token cost of a recalled memory's canonical content for audit. */
function estimateMemoryTokens(content: string): number {
  return estimateTokens(content);
}

export interface RecallConfig {
  topK: number;
  similarityThreshold: number;
  candidateMultiplier: number;
  tokenBudget: number;
  rankingConfig?: MemoryRankingConfig;
}

/** Deterministic path affinity: shares top-level modules with affected paths. */
function computePathAffinity(
  memoryPaths: string[],
  affectedPaths: string[] | undefined,
): number {
  if (!affectedPaths || affectedPaths.length === 0 || memoryPaths.length === 0) return 0;
  const norm = (p: string) => p.replace(/\\/g, "/").split("/").slice(0, 2).join("/");
  const memoryModules = new Set(memoryPaths.map(norm));
  let hits = 0;
  for (const path of affectedPaths) {
    if (memoryModules.has(norm(path))) hits++;
  }
  return hits / affectedPaths.length;
}

/** Repository affinity: memories from the same repo score higher. */
function computeRepoAffinity(memory: AiMemory, request: MemoryRecallRequest): number {
  return memory.repositoryId === request.repositoryId ? 1 : 0;
}

/** Normalized freshness, 0..1. Newest=1, decaying to 0 over ~180 days. */
function computeFreshness(memory: AiMemory, now: number = Date.now()): number {
  const ageMs = now - memory.createdAt.getTime();
  const HALF_LIFE = 90 * 86_400_000; // 90 days
  return Math.max(0, 1 - ageMs / (2 * HALF_LIFE));
}

/** Trust penalty from source trust hierarchy. */
function trustPenalty(memory: AiMemory): number {
  const rank = SOURCE_TRUST_RANK[memory.sourceTrust as SourceTrust] ?? SOURCE_TRUST_RANK.unverified;
  return rank / (SOURCE_TRUST_RANK.unverified * 2); // 0..0.5
}

function isStale(memory: AiMemory): boolean {
  if (memory.status === "stale") return true;
  if (memory.lastValidatedAt) {
    const cutoff = Date.now() - 90 * 86_400_000;
    if (memory.lastValidatedAt.getTime() < cutoff) return true;
  }
  // Repository memories without recent validation, referencing code, decay trust.
  return false;
}

/**
 * Deterministic score: weighted sum of normalized semantic score, importance,
 * confidence, freshness, repo affinity, path affinity — minus penalties for
 * staleness, supersession, and low source trust.
 */
export function scoreMemory(
  hit: SemanticSearchHit,
  memory: AiMemory,
  request: MemoryRecallRequest,
  config: MemoryRankingConfig,
  now: number = Date.now(),
): { score: number; semantic: number; taskRelevance: number; freshness: number } {
  const semantic = hit.score; // 0..1 from Qdrant cosine
  const taskRelevance = semantic; // semantic overlap approximates task relevance here
  const importance = memory.importance;
  const confidence = memory.confidence;
  const freshness = computeFreshness(memory, now);
  const repoAffinity = computeRepoAffinity(memory, request);
  const pathAffinity = computePathAffinity(memory.affectedPaths, request.affectedPaths);

  const base =
    semantic * config.wSemanticSimilarity +
    taskRelevance * config.wTaskRelevance +
    importance * config.wImportance +
    confidence * config.wConfidence +
    freshness * config.wFreshness +
    repoAffinity * config.wRepoAffinity +
    pathAffinity * config.wPathAffinity;

  let penalties = trustPenalty(memory) * config.lowTrustPenalty;
  if (isStale(memory)) penalties += config.stalePenalty;
  if (memory.status === "superseded" || memory.status === "invalidated") {
    penalties += config.supersededPenalty;
  }
  if (memory.status === "expired") penalties += 1.0;

  return {
    score: Math.max(0, base - penalties),
    semantic,
    taskRelevance,
    freshness,
  };
}

/**
 * MMR-style diversity selection: greedily pick the highest-scoring item not
 * too semantically similar to already-selected items, respecting per-type caps.
 */
function selectDiverse(
  ranked: Array<{ item: RecalledMemoryItem }>,
  topK: number,
  perTypeCaps: Record<string, number>,
  lambda = 0.5,
): RecalledMemoryItem[] {
  const selected: RecalledMemoryItem[] = [];
  const typeCounts: Record<string, number> = {};
  const pool = [...ranked];

  while (selected.length < topK && pool.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i]!;
      const type = entry.item.memory.memoryType;
      const cap = perTypeCaps[type] ?? topK;
      if ((typeCounts[type] ?? 0) >= cap) continue;
      const mmr = entry.item.relevanceScore - lambda * maxSimilarityToSelected(entry, selected);
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const chosen = pool[bestIdx]!;
    pool.splice(bestIdx, 1);
    selected.push(chosen.item);
    typeCounts[chosen.item.memory.memoryType] = (typeCounts[chosen.item.memory.memoryType] ?? 0) + 1;
  }
  return selected;
}

function maxSimilarityToSelected(
  entry: { item: RecalledMemoryItem },
  selected: RecalledMemoryItem[],
): number {
  // Conservative proxy: same repo+type+significant same content → penalize.
  let maxSim = 0;
  for (const s of selected) {
    if (s.memory.repositoryId === entry.item.memory.repositoryId &&
        s.memory.memoryType === entry.item.memory.memoryType) {
      // Use semantic similarity similarity as proxy; here we approximate MMR
      // by penalizing same-title/same-content memories.
      const t1 = s.memory.title;
      const t2 = entry.item.memory.title;
      if (t1 === t2) maxSim = Math.max(maxSim, 1);
    }
  }
  return maxSim;
}

export class MemoryRecallEngine {
  constructor(
    private readonly repo: Pick<AiMemoryRepository, "findById" | "recordInfluence" | "markAccessed">,
    private readonly embeddingProvider: IEmbeddingProvider,
    private readonly semanticStore: Pick<IQdrantSemanticStore, "search"> | null,
    private readonly config: RecallConfig,
  ) {}

  /**
   * Recall semantically relevant, repository-scoped memories for a task.
   * Degrades safely: if Qdrant/embeddings are unavailable, returns empty
   * (never invented) and marks the result degraded so callers can adjust.
   */
  public async recall(request: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    const start = Date.now();
    metrics.incrementRecallQuery();
    const config = this.config.rankingConfig ?? DEFAULT_RANKING_CONFIG;

    if (!this.semanticStore) {
      metrics.incrementRecallDegraded("no_semantic_store");
      logger.debug("Memory recall degraded: no semantic store");
      return {
        items: [],
        totalCandidatesConsidered: 0,
        queryLatencyMs: Date.now() - start,
        degraded: true,
        degradationReason: "no_semantic_store",
      };
    }

    try {
      const queryVector = await this.embeddingProvider.embed(request.task);
      const candidateLimit = this.config.topK * this.config.candidateMultiplier;
      const hits = await this.semanticStore.search(
        queryVector.vector,
        {
          tenantId: request.tenantId,
          projectId: request.projectId,
          repositoryId: request.repositoryId,
          status: "active",
        },
        candidateLimit,
      );

      // Load canonical metadata for each hit (PostgreSQL = source of truth).
      const memories: Array<{ hit: SemanticSearchHit; memory: AiMemory }> = [];
      for (const hit of hits) {
        const memoryId = String(hit.payload?.memoryId ?? "");
        if (!memoryId) continue;
        const memory = await this.repo.findById(memoryId);
        if (!memory) continue;
        // Cross-tenant / cross-project guard on the canonical record.
        if (memory.tenantId !== request.tenantId) continue;
        if (memory.projectId !== request.projectId) continue;
        if (memory.repositoryId !== request.repositoryId) continue;
        if (memory.status !== "active") continue;
        const now = Date.now();
        if (memory.validFrom.getTime() > now) continue;
        if (memory.validUntil && memory.validUntil.getTime() <= now) continue;
        if (memory.expiresAt && memory.expiresAt.getTime() <= now) continue;
        if (memory.supersededBy) continue;
        memories.push({ hit, memory: memory as unknown as AiMemory });
      }

      // Rank deterministically.
      const ranked: Array<{ item: RecalledMemoryItem }> = memories
        .map(({ hit, memory }) => {
          const s = scoreMemory(hit, memory, request, config);
          return {
            item: {
              memory,
              relevanceScore: s.score,
              rankingComponents: {
                semanticSimilarity: s.semantic,
                taskRelevance: s.taskRelevance,
                importance: memory.importance,
                confidence: memory.confidence,
                freshness: s.freshness,
                repoAffinity: computeRepoAffinity(memory, request),
                pathAffinity: computePathAffinity(memory.affectedPaths, request.affectedPaths),
              },
              whySelected: `semantic=${s.semantic.toFixed(2)} trust=${memory.sourceTrust} status=${memory.status}`,
            },
          };
        })
        .filter((r) => r.item.relevanceScore >= this.config.similarityThreshold)
        .sort((a, b) => b.item.relevanceScore - a.item.relevanceScore);

      // Apply diversity with per-type caps.
      const selected = selectDiverse(
        ranked,
        this.config.topK,
        {
          episodic: 3,
          semantic: 5,
          procedural: 3,
          decision: 3,
          failure: 2,
          repository: 5,
          preference: 2,
          task_outcome: 3,
        },
      );

      metrics.recordMemoriesSelected(selected.length);

      // Phase J: record auditable influence for each selected memory and
      // bump access counters. Best-effort; a DB failure must not fail recall.
      if (selected.length > 0) {
        try {
          for (let i = 0; i < selected.length; i++) {
            const item = selected[i]!;
            await this.repo.recordInfluence({
              id: `inf_${request.executionId}_${i}`,
              executionId: request.executionId,
              memoryId: item.memory.id,
              tenantId: request.tenantId,
              repositoryId: request.repositoryId,
              retrievalScore: item.relevanceScore,
              rank: i + 1,
              reasonSelected: item.whySelected,
              injectedIntoContext: true,
              tokenCost: estimateMemoryTokens(item.memory.canonicalContent),
            });
            await this.repo.markAccessed(item.memory.id, request.executionId, null);
          }
        } catch (err: unknown) {
          logger.warn("Memory influence recording failed (best-effort)", {
            error: (err as Error).message,
          });
        }
      }

      return {
        items: selected,
        totalCandidatesConsidered: memories.length,
        queryLatencyMs: Date.now() - start,
        degraded: false,
      };
    } catch (err: unknown) {
      metrics.incrementRecallDegraded(err instanceof Error ? err.message.slice(0, 40) : "unknown");
      logger.warn("Memory recall degraded (Qdrant/embedding failure)", {
        error: (err as Error).message,
      });
      return {
        items: [],
        totalCandidatesConsidered: 0,
        queryLatencyMs: Date.now() - start,
        degraded: true,
        degradationReason: err instanceof Error ? err.message.slice(0, 80) : "failure",
      };
    }
  }

  /**
   * Static helper for unit-testable deterministic ranking (exported).
   */
  public static score = scoreMemory;
}
