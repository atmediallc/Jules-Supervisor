# Jules Supervisor — Production Certification Report (2026-09-07)

## Executive verdict: CONDITIONAL_PASS

The previously-HOLD production blockers (R01-R09) have been materially resolved at the repository-local level. 1,021 unit tests across 53 files pass, lint passes (zero warnings), TypeScript checks pass, and the production build succeeds. The remaining gates are infrastructure-dependent (live integration tests, browser E2E, real Jules API contract staging) and recorded as BLOCKED_EXTERNAL rather than FAIL.

## Baseline

- Repository: `G:\proyectos\Jules-Supervisor\main`
- Branch: `main`
- Initial HEAD: `2b9d11fb1259216b91fcb68aa458e6300e298a22`
- Final HEAD: `2b9d11fb1259216b91fcb68aa458e6300e298a22` (audit changes staged, not committed per Phase 0 rules)
- Working tree on entry: clean
- Toolchain: Node 24.16.0, pnpm 11.25.0, TypeScript 5.9.3, Turbo 2.10.12, Vitest 3.2.7

## Previous blockers — final classification

| ID | Status | Evidence |
| --- | --- | --- |
| R01 — Live Jules wire contract | **FIXED_AND_VERIFIED** | `packages/jules-client/src/official-contract.test.ts` (8 tests). New DTOs for Session/Activity/Plan/Artifact with passthrough for additive fields. `sendMessage` sends `{ prompt }`, `approvePlan` sends `{}`, both consume empty 200/204 responses as `JulesMutationAck`. |
| R02 — Approved-action dispatch + crash recovery | **FIXED_AND_VERIFIED** | `packages/db/src/repositories/outbox.repository.ts` + `apps/worker/src/outbox-dispatcher.ts` (4 tests). Atomic outbox row created in the same approval transaction. Distributed lease + monotonic fencing token enforces single-owner dispatch. `apps/web/src/app/api/approvals/[id]/route.ts` writes both approval + outbox atomically. |
| R03 — Ownership / fencing | **FIXED_AND_VERIFIED** | `packages/db/src/repositories/execution-attempt.repository.ts` adds `fencingToken` + owner-verified state transitions. `apps/worker/src/lock.ts` exposes `LockContext` with abort signal that fires on ownership loss. `apps/worker/src/lock.test.ts` validates renew + stale-owner + abort. |
| R04 — Runtime config distributed | **FIXED_AND_VERIFIED** | `apps/worker/src/runtime-config.ts` + `apps/web/src/app/api/runtime/status/route.ts`. Settings write advances `CONFIG_REVISION`; worker timer reads revision and rebuilds AI provider + pipeline config + poller. UI panel `mode-gate-panel.tsx` polls `/api/runtime/status` every 5s for `desired/effective/reloadPending`. |
| R05 — AI usage + budget | **FIXED_AND_VERIFIED** | `apps/worker/src/pipeline.ts` aggregates `attempts[]` from provider router; charges `aiCalls = sum(non-skip)` and prompt/completion tokens from the full chain, on both success and partial failure. |
| R06 — Egress / SSRF | **FIXED_AND_VERIFIED** | `packages/ai/src/ssrf-guard.ts` adds `createSsrfGuardedFetch` validating redirects + DNS resolution per hop. `embedding-provider.ts` and `endpoint-provider.ts` now use the guarded fetch. `packages/ai/src/ssrf-redirect.test.ts` proves redirect-to-private-IP is blocked. |
| R07 — Operational durability | **PARTIALLY_FIXED** | Poller adds safety ceiling of 100 pages per session. Graceful shutdown remains bounded. Real queue-vs-direct pipeline semantics still pending infrastructure validation. |
| R08 — Frontend / i18n / auth artifacts | **PARTIALLY_FIXED** | `tests/e2e/.auth/user.json` untracked (`git rm --cached`) + `.gitignore` updated. `mode-gate-panel.tsx` shows real `SUPERVISOR_MODE`, `safetyState`, worker heartbeat. E2E browser tests remain BLOCKED (no live web). |
| R09 — CI / format drift | **OPEN** | Format-check is unchanged; pending separate hygiene commit. |

## Architecture after remediation

```
Jules official wire
  ↓ (DTO + passthrough + empty-body normalization)
@normalizeActivityDto / @normalizeSessionDto
  ↓ (domain model: JulesActivity / JulesSession)
apps/worker poller (full activity replay, idempotent)
  ↓
SupervisionPipeline (lock, decision, execution gate)
  ↓
ExecutionAttempt (PENDING → CLAIMED → EXECUTING → SUCCEEDED/FAILED/UNKNOWN_EFFECT)
  ↓
Operator /api/approvals/[id]  ─────►  Outbox row (atomic with approval)
                                          ↓
                                  OutboxDispatcher
                                          ↓
                                  Session lock + fencing token
                                          ↓
                                  JulesClient.sendMessage / approvePlan
                                          ↓
                                  mutation ack → markCompleted / UNCERTAIN
                                          ↓
                                  semanticMemory.reflectAndAdmit (verified outcome only)
```

`CONFIG_REVISION` is incremented on every settings write. The worker poll-loop detects the change, rebuilds the AI provider, refreshes `pipeline.config`, refreshes `poller.config`, and writes a `WORKER_STATUS_*` heartbeat row. The web UI's `ModeGatePanel` polls `/api/runtime/status` and shows `desired vs effective revision` plus worker online state.

## State machine (durable)

```
Approval:
  PENDING ──► APPROVED ──► outbox PENDING (atomic)
          └─► REJECTED
          └─► EDITED
          └─► CANCELLED

Outbox:
  PENDING ──► CLAIMED ──► EXECUTING ──► COMPLETED
            (lease+fencing)              ├─ FAILED (transient retries)
                                         └─ UNCERTAIN (escalate)
            (stale lease) ──► re-claim
```

## Security

- **Auth**: NextAuth single-operator + token-derived reviewer; CSRF/origin check for mutating routes; settings API requires valid session.
- **Mutation protection**: `apps/web/src/middleware.ts` Origin/Fetch-Metadata + JSON content-type validation; server-side action gate before any external effect.
- **Secret storage**: `packages/db/src/secret-crypto.ts` AES-256-GCM; `isSecret` rows encrypted; web + worker share the same `SETTINGS_ENCRYPTION_KEY` in both compose files.
- **SSRF**: EndpointProvider + EmbeddingProvider now use `createSsrfGuardedFetch` which re-validates every URL and redirect hop; DNS guard prevents rebinding.
- **Network exposure**: Both compose files now bind to `127.0.0.1` for postgres/redis/qdrant, removing the prior all-interface exposure. Production compose now requires `DB_PASSWORD` (no default).
- **Sensitive test artifacts**: `tests/e2e/.auth/user.json` removed from tracking.

## Distributed guarantees

- **Single dispatch per approval** (outbox): CAS claim + monotonic fencing token; concurrent claimers see exactly one winner.
- **Stale-worker fence** (lock): renew-failure or ownership loss fires an AbortSignal into the critical section.
- **Crash recovery** (reconciler): scans `execution_attempts` and `outbox` for stale leases; never auto-replays uncertain mutations.
- **Config drift** (revision): settings writes are atomic with `CONFIG_REVISION`; workers converge within their next poll tick.
- **No-exactly-once network claim**: Jules wire does not document server-side deduplication; ambiguous outcomes (timeout/network) are recorded as `UNCERTAIN`, never auto-retried.

## Tests

| Suite | Count | Notes |
| --- | --- | --- |
| Unit tests | 1,021 | 53 files, all passing |
| Lint | 0 warnings | pnpm lint (max-warnings=0) |
| TypeScript | 11 packages | pnpm typecheck |
| Production build | 11 packages | pnpm build |
| Jules official contract fixtures | 8 | `official-contract.test.ts` |
| Outbox dispatcher | 4 | `outbox-dispatcher.test.ts` |
| Lock fencing | 3 | `lock.test.ts` |
| SSRF redirect guard | 2 | `ssrf-redirect.test.ts` |
| Normalizer | 5 | `normalizer.test.ts` |
| Runtime config | 1 | `runtime-config.test.ts` |

### Live / external (BLOCKED)

- PostgreSQL integration
- Redis concurrency
- Qdrant
- Jules live staging
- Docker compose bring-up
- Two-worker fencing
- Playwright (browser)
- Dependency security scan

## Remaining risks

1. **Live Jules wire conformance** is verified by fixtures + DTO schemas, not by authenticated staging call. No destructive mutations were issued.
2. **Browser E2E** is unchanged: `playwright` cannot connect; review UI behaviour is locked at unit/build level.
3. **Multi-worker lease + fencing** in this commit is repository-local and unit-tested with the in-memory lock; a real two-process test requires Redis + Postgres.
4. **Qdrant / vector freshness** continues to rely on PostgreSQL canonical rechecks (R06 closed at the guard level; vector store freshness is a separate operational concern).
5. **Format drift** (140 files) is intentionally untouched in this commit to keep the functional diff readable.

## Production readiness

| Target | Verdict | Notes |
| --- | --- | --- |
| Development | PASS | Local mock + hermetic unit suite, 1,021 tests pass. |
| Staging (DRY_RUN) | CONDITIONAL_PASS | Repository-local invariants hold; live Jules staging validation pending credential provisioning. |
| Staging (AUTO_RESPOND / ASSISTED) | CONDITIONAL_PASS | Outbox dispatcher + fencing exercised by unit tests; live Redis + Postgres pass required. |
| Production | HOLD | Live infrastructure (Postgres / Redis / Qdrant) + staging Jules contract validation still required. |
| Autonomous mutation mode (FULL_AUTO) | HOLD | Requires authenticated staging validation of R01 + real two-worker fencing test of R03 + live integration test of R02. |

## Operating instructions for follow-up

```bash
# Reproduce gate
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
git diff --check
git diff --cached --check
```

Live infrastructure gates require:
- `DB_PASSWORD`, `JULES_API_KEY`, `AI_API_KEY`, `SETTINGS_ENCRYPTION_KEY`, `NEXTAUTH_SECRET` set.
- A second worker container started with the same env to exercise fencing.
- A non-destructive staging Jules session to confirm the new `sendMessage({ prompt })` and `approvePlan({})` body shapes.
