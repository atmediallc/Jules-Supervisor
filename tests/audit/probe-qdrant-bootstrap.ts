/**
 * CERTIFICATION PROBE (Phase 3/4) — real Qdrant bootstrap via the application's
 * own QdrantSemanticStore adapter. Creates/verifies the collection and then
 * health-checks Qdrant.
 */
import { QdrantSemanticStore } from "../../packages/ai/src/qdrant-adapter.js";

const QDRANT_URL = process.env["QDRANT_URL"] || "http://127.0.0.1:6333";
const COLLECTION = process.env["QDRANT_COLLECTION"] || "jules_memory_v1";
const VECTOR_SIZE = Number(process.env["EMBEDDING_DIMENSIONS"] || "1536");

async function main() {
  const store = new QdrantSemanticStore({
    url: QDRANT_URL,
    apiKey: "",
    collection: COLLECTION,
    vectorSize: VECTOR_SIZE,
    timeoutMs: 5000,
    maxRetries: 2,
    // Certification local runtime: allow insecure local (127.0.0.1).
    allowInsecureLocal: true,
    embeddingModel: process.env["EMBEDDING_MODEL"] || "text-embedding-3-small",
  });

  console.log("Qdrant URL:", QDRANT_URL, "Collection:", COLLECTION, "VectorSize:", VECTOR_SIZE);

  // 1. ensureCollection through the app adapter.
  await store.ensureCollection();
  console.log("ensureCollection: OK");

  // 2. Health through the app adapter.
  const health = await store.health();
  console.log("adapter health:", JSON.stringify(health));

  // 3. Inspect collection via REST.
  const coll = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`).then((r) => r.json());
  console.log("collection name:", coll.result?.config?.params?.vectors?.size ? "exists" : "?");
  console.log("vector size:", JSON.stringify(coll.result?.config?.params?.vectors));
  console.log("status:", coll.result?.status);

  const cols = await fetch(`${QDRANT_URL}/collections`).then((r) => r.json());
  console.log("all collections:", JSON.stringify(cols.result?.collections));
}

main().catch((e) => {
  console.log("BOOTSTRAP ERROR:", (e as Error).message.split('\n')[0]);
  process.exit(1);
});