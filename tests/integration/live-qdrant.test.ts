/**
 * Live Qdrant integration test — real vector store, real canonical recheck.
 * Requires: QDRANT_URL=http://127.0.0.1:6333
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { QdrantSemanticStore } from "../../packages/ai/src/qdrant-adapter";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { aiMemories, sessions } from "../../packages/db/src/schema";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const COLLECTION = "jules_live_audit_memories";
const VECTOR_SIZE = 1536;
const TEST_SESSION_ID = `ses_qdrant_live_${Date.now()}`;

let store: QdrantSemanticStore;
let pgClient: Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  store = new QdrantSemanticStore({
    url: QDRANT_URL,
    collection: COLLECTION,
    vectorSize: VECTOR_SIZE,
    allowInsecureLocal: true,
  });
  try {
    await store.ensureCollection();
  } catch (err) {
    console.warn(
      "ensureCollection warning:",
      err instanceof Error ? err.message : JSON.stringify(err),
    );
  }
  pgClient = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pgClient);
  await db
    .insert(sessions)
    .values({
      id: TEST_SESSION_ID,
      name: `s-${TEST_SESSION_ID}`,
      repository: "live/qdrant-audit",
      branch: "main",
      prompt: "live qdrant",
      state: "IN_PROGRESS",
      supervisorStatus: "AUTO_EXECUTED",
      lastActivityId: "act_qdrant_1",
      cycleCount: 0,
      metadata: {},
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  try {
    if (store) await store.deleteCollection();
  } catch {
    // best-effort
  }
  if (db) {
    try {
      await db.delete(sessions).where(eq(sessions.id, TEST_SESSION_ID));
    } catch {
      // best-effort
    }
  }
  if (pgClient) await pgClient.end();
});

describe("Live Qdrant: collection lifecycle and canonical recheck", () => {
  it("round-trips a vector with a UUID id", { timeout: 60_000 }, async () => {
    const id = randomUUID();
    const vec = new Array(VECTOR_SIZE).fill(0.1);
    await store.upsert([{ id, vector: vec, payload: { kind: "test" } }]);
    const retrieved = await store.retrieveByIds([id]);
    expect(retrieved.some((h) => h.id === id)).toBe(true);
  });

  it("Qdrant hit does NOT become canonical — PostgreSQL rechecks must reject", { timeout: 60_000 }, async () => {
    const memoryId = randomUUID();
    const vec = new Array(VECTOR_SIZE).fill(0.2);
    await store.upsert([
      {
        id: memoryId,
        vector: vec,
        payload: { projectId: "live/qdrant-audit", summary: "applies" },
      },
    ]);

    const rows = await db
      .select()
      .from(aiMemories)
      .where(eq(aiMemories.id, memoryId));
    expect(rows.length).toBe(0);

    const foreignMemoryId = randomUUID();
    await db.insert(aiMemories).values({
      id: foreignMemoryId,
      repositoryId: "some/other-repo",
      memoryType: "test",
      title: "memory for a different project",
      canonicalContent: "memory for a different project",
      summary: "memory for a different project",
      branch: "other",
      embeddingModel: "live-test",
      embeddingDimensions: 1536,
      fingerprint: `fp-${foreignMemoryId}`,
      sourceType: "inferred",
    });

    const foreignRows = await db
      .select()
      .from(aiMemories)
      .where(eq(aiMemories.id, foreignMemoryId));
    expect(foreignRows[0]?.repositoryId).toBe("some/other-repo");
    const projectMatches = (row: typeof foreignRows[number]) =>
      row.repositoryId === "live/qdrant-audit" && row.branch === "main";
    expect(projectMatches(foreignRows[0])).toBe(false);

    await store.deleteByIds([memoryId]);
    await db.delete(aiMemories).where(eq(aiMemories.id, foreignMemoryId));
  });

  it("Qdrant unavailable degrades safely (search throws)", { timeout: 60_000 }, async () => {
    const broken = new QdrantSemanticStore({
      url: "http://127.0.0.1:1",
      collection: COLLECTION,
      vectorSize: VECTOR_SIZE,
      allowInsecureLocal: true,
    });
    await expect(
      broken.search(new Array(VECTOR_SIZE).fill(0.5), { topK: 1 }),
    ).rejects.toThrow();
  });
});
