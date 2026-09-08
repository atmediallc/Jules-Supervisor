# Live Integration Test Results (2026-09-08)

15 test files · 66 tests · 0 failures

## Environment
- PostgreSQL 16 (port 5439)
- Redis 7 (port 6389)
- Qdrant 1.19 (port 6333)
- Node 24.16.0
- qdrant-js 1.19.0

## Test Files

| File | Tests | Duration | Coverage |
|---|---|---|---|
| [redis-bullmq-lock-real.test.ts](./redis-bullmq-lock-real.test.ts) | 6 | 2.0s | Redis lock TTL + adversarial ownership, BullMQ lifecycle |
| [live-outbox-fencing.test.ts](./live-outbox-fencing.test.ts) | 6 | 4.1s | Outbox + execution_attempts CAS fencing, stale row recovery |
| [postgres-real.test.ts](./postgres-real.test.ts) | 9 | 4.4s | Schema, audit/approval, concurrent double-submit, transactions |
| [live-redis-lock.test.ts](./live-redis-lock.test.ts) | 4 | 5.7s | Lock renewal, external delete, stale release |
| [p1-memory-real.test.ts](./p1-memory-real.test.ts) | 7 | 5.6s | Memory/knowledge repo + JOIN scoping + dedup + supersession |
| [pipeline-real-services.test.ts](./pipeline-real-services.test.ts) | 2 | 2.3s | Full DRY_RUN pipeline + ASSISTED queue |
| **live-two-worker.test.ts** (new) | 3 | 2.3s | Stale-owner CAS reject, concurrent claim race, Redis lock |
| **live-runtime-config.test.ts** (new) | 3 | 1.6s | Cross-process config reload + per-worker status |
| **live-budget.test.ts** (new) | 2 | 4.5s | Atomic 20x concurrent +0.1 increments → 2.0 |
| **live-ssrf.test.ts** (new) | 7 | 0.07s | Real hostnames: public allowed, loopback/metadata blocked |
| **live-encryption.test.ts** (new) | 2 | 0.5s | Settings at-rest round trip |
| **live-security.test.ts** (new) | 7 | 0.007s | Rate limiter policy + IP extraction + CSRF policy |
| **live-poller.test.ts** (new) | 3 | 3.3s | 20-session checkpoint batch + concurrent reads + MockJules |
| **live-qdrant.test.ts** (new) | 3 | 29.9s | Vector round-trip + canonical recheck + unavailable degradation |
| [live-approval-atomicity.test.ts](./live-approval-atomicity.test.ts) | 2 | 2.5s | Approval + outbox atomicity (Case A rollback, Case C success) |

## Findings & Code Changes Required

### 1. Qdrant adapter: `wait: true` + Node 24 hangs the `createPayloadIndex` call
- `packages/ai/src/qdrant-adapter.ts` was changed to:
  - Default `maxRetries` to 3 (was undefined → 0 retries).
  - Use a `formatQdrantError(err)` helper that returns a human-readable string
    for non-`Error` throwables (the qdrant-js client sometimes throws
    `null`/`undefined`).
  - Make `ensurePayloadIndexes` omit `wait: true` (best-effort optimisation;
    data plane does not require it).
  - Wrap `ensurePayloadIndexes` in try/catch inside `ensureCollection` so a
    payload-index failure does not abort the collection-creation step.
- Vector IDs MUST be UUIDs (Qdrant 1.19 rejects arbitrary strings).

### 2. Settings-at-rest: secrets are stored as PLAINTEXT
- The comment "encrypted at rest" in `apps/web/src/app/api/settings/route.ts`
  is NOT honored by the actual code. `SystemSettingsRepository.upsert` writes
  the `value` field verbatim.
- `live-encryption.test.ts` documents this behaviour so any future change to
  encryption can be cross-checked against the new expected ciphertext format.

### 3. SSRF guard: `localhost` is in the DEFAULT trusted-internal list
- Default `trustedInternalHosts` is `["localhost", "127.0.0.1", "omniroute"]`.
- For test isolation / production lockdown, pass `trustedInternalHosts: []`
  and `allowInsecureLocal: false`.

### 4. Rate limiter: in-memory per-process
- `apps/web/src/lib/rate-limit.ts` is documented as in-memory single-instance.
- Multi-instance / serverless deployments need a shared store (Redis token
  bucket) — known limitation, not a bug.

## Re-running

```bash
# Start services (project root)
docker compose up -d postgres redis qdrant

# Run live integration tests
npx vitest run tests/integration/
```

## Known Latency Notes
- `live-qdrant.test.ts` takes ~30s because each `createPayloadIndex` call
  incurs a full round-trip to Qdrant. Timeouts set to 60s.
- `live-budget.test.ts` uses 20 concurrent increments to validate atomicity;
  the underlying `session_budgets` is updated via SQL arithmetic, so no lost
  updates occur.
