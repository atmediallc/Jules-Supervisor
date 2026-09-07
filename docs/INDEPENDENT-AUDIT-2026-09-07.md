# Independent repository audit — 2026-09-07

## Executive verdict: HOLD

The repository is measurably safer, but is **not certified for autonomous production use**. This audit repaired bounded defects in secret serialization, execution recovery, pagination, cancellation, memory isolation, settings validation, browser mutation protection, and approval error handling. The unit suite increased from **940 tests / 44 files to 1,000 tests / 48 files**, all passing. Lint, TypeScript checks, and the production build pass.

Important release blockers remain: the live Jules wire contract, incomplete approved-action dispatch, incomplete crash recovery/ownership guarantees, process-local configuration, and incomplete egress protection. Completing those flows requires coordinated architectural decisions. No architecture rewrite was attempted, consistent with the repository engineering constraint. Existing audit PASS claims were not treated as evidence.

## Baseline and scope

| Item | Observed baseline |
| --- | --- |
| Repository | `G:\proyectos\Jules-Supervisor\main` — Jules Supervisor, not TraderAdd |
| Branch / HEAD | `main` / `ec9de0ebc62db888a62c67929751966ef47983ab` |
| Working tree on entry | 28 staged files; no unstaged or untracked files reported |
| Existing work | Dashboard/theme/i18n components, theme tests, Qdrant adapter, metrics, probe, and tracked Playwright authentication state |
| Runtime | Windows PowerShell; Node `24.16.0`; pnpm `11.25.0` |
| Installed toolchain | TypeScript `5.9.3`, Turbo `2.10.12`, Vitest `3.2.7` |
| Installed application libraries | Next.js `15.5.24`, React `19.2.8`, Drizzle `0.45.2`, BullMQ `6.3.3` |
| Declared deployment | Docker Node 22; PostgreSQL 16; Redis 7; Qdrant `v1.19.0` |
| Configuration | Strict TypeScript with unchecked-index checking; pnpm workspace; Turbo build dependency graph; ESLint zero-warning gate; Prettier; Playwright |

All application/package manifests, core configuration, CI/container definitions, API surfaces, worker lifecycle, execution/policy boundaries, persistence repositories, AI routing/memory boundaries, representative UI flows, and their relevant tests were inspected. This is a risk-based repository review, not a claim that every source line or deployment behavior was proven correct. No live provider mutations, migrations, schema changes, package upgrades, or environment-file edits were performed. The initial general test invocation was interrupted after integration connectivity failures; see validation limitations below.

HEAD remained unchanged. The index later included audit edits as well as the pre-existing changes; this audit issued no `git add`, commit, reset, checkout, or history-rewrite command. Preserve the combined staged work when reviewing. The prior Playwright authentication artifact was not overwritten.

## Actual architecture and ownership

| Layer | Responsibility and boundaries |
| --- | --- |
| `apps/web` | Next.js App Router; NextAuth single configured operator with JWT sessions; protected dashboard and route handlers. Some server components read repositories directly. API handlers and server actions own writes; the browser owns presentation. There is no demonstrated multi-user RBAC model. |
| `apps/worker` | Polls Jules sessions/activities; invokes `SupervisionPipeline`; obtains a session lock; persists session/activity/decision records; evaluates policy and safety; creates review requests or dispatches external actions. A timer reconciles stale attempts. |
| `packages/core`, `packages/policy` | Decision schemas, execution modes, budgets, loop/correction checks, deterministic risk and hard policy vetoes. Rules run after validated model output. Regex risk checks are defense in depth, not semantic proof that an arbitrary patch is safe. |
| `packages/db` | PostgreSQL/Drizzle is the canonical store. Six journaled SQL migrations cover sessions, decisions, approvals, budgets, settings, memory, attempts, and corrections. Unique decision keys and SQL-side budget increments protect specific invariants. |
| `packages/jules-client` | HTTP transport and local schemas; mock client used heavily by tests. The schemas are not faithful to the live API in several important places. |
| `packages/ai` | Provider factory/router, structured decision validation, context redaction/budgeting, circuit breakers, relational/semantic memory, embedding and Qdrant adapters. Vector hits are rechecked against PostgreSQL. |
| `packages/config`, `shared`, `observability` | Environment/DB override parsing, cryptography/redaction/path helpers, Pino structured logging and metrics. Configuration and several metrics are process-local. |
| `packages/test-utils` | In-memory repository doubles and a local mock completion server; useful for deterministic failure tests but not evidence of PostgreSQL concurrency or Jules compatibility. |

**Important wiring discrepancy:** `index.ts` starts BullMQ, but constructs `SessionWatcher` with the pipeline directly. The watcher calls `pipeline.processActivity`, not `queue.enqueueActivity`. Thus the active polling path bypasses queue durability/backpressure. `normalizer.ts` is also not the canonical ingestion boundary described in older diagrams.

### Execution state model checked

Normal decisions branch into `BLOCKED`, `DRY_RUN_COMPLETED`, `AWAITING_APPROVAL`, or `EXECUTING`. The external effect path creates `PENDING -> CLAIMED -> EXECUTING` attempts, followed by success/failure/uncertain outcome recording. After this audit, an expired `CLAIMED`/`EXECUTING` attempt is reclaimed and marked `NEEDS_RECONCILIATION` without another external mutation. Previously recorded decision success is not overwritten during that escalation. `DISABLED` now prevents polling and direct pipeline work.

Approval HTTP writes transactionally record the human verdict, decision feedback, audit event, and applicable correction count. They do not implement an approved-action dispatcher. Database transactions cannot atomically commit a Jules network side effect; that uncertainty remains explicit.

## Findings repaired or contained

Rows describe observed behavior, expected behavior, impact, root cause, remediation, and regression evidence. Paths are relative to the repository root.

| ID / severity | Component and root cause | Repair and verification |
| --- | --- | --- |
| A01 — HIGH | `apps/web/src/app/api/settings/route.ts`: secret `value` was masked while `rawValue` serialized the complete secret. Any authorized settings fetch received it, violating the response contract. | Secret `rawValue` is now `null`; non-secret editing values remain. Tests cover DB, environment, DB failure fallback, and unauthorized access. `settings-security.test.ts` passes. Intentional compatibility change: existing stored-secret reveal/copy controls cannot recover the old secret. |
| A02 — CRITICAL | `apps/worker/src/reconciler.ts`, `packages/jules-client/src/client.ts`: stale attempts were replayed, and POST requests retried on timeouts/gateway errors, assuming undocumented server deduplication. A lost response could cause duplicate autonomous effects, including recovery under a later non-executing mode. | Only GET requests retry. Recovery now escalates the existing attempt without dispatch, even with the same token. Tests cover timeouts, four HTTP failure codes, opaque/missing tokens, non-executable actions, overlapping recovery passes, repeated passes, and unavailable providers. 30 focused tests passed across client/recovery/regression suites. This is containment, not an exactly-once guarantee. |
| A03 — HIGH | `apps/worker/src/poller.ts`: only the first session page was read; `activity.id <= checkpoint` assumed lexically ordered IDs; persisted page tokens could skip new leading entries. Unseen work could be lost. | Visit all session pages; start activity listing afresh; rely on durable decision idempotency, not ID ordering. Reject repeated page tokens. Tests cover later pages, out-of-order IDs, a new lower ID, persisted checkpoints, replay and token cycles. Full-history scans increase read work; see residual risks. |
| A04 — MEDIUM | `apps/web/src/middleware.ts`: NextAuth's own CSRF checks did not cover application JSON mutations. `req.json()` can parse a simple `text/plain` request. Origin restrictions were absent. | Application writes validate Origin/Fetch Metadata and require JSON on POST/PUT/PATCH; auth endpoints retain NextAuth handling. 14 tests cover foreign/null/lookalike origins, form media types, same-origin and non-browser JSON requests. This strengthens defense in depth; cross-site exploitation depends on cookie delivery. |
| A05 — MEDIUM | `apps/web/src/lib/rate-limit.ts`: pruning did not cap the map when all 10,000 identities were still active. New spoofed identities continued allocating memory. | Refuse new identities at capacity without evicting/resetting active allowances. Saturation/expiry regression passes. Per-process rate limits and proxy trust remain deployment limitations. |
| A06 — HIGH | `packages/ai/src/memory-recall.ts`: canonical checks omitted project, validity windows, expiration, and supersession. A stale/mis-scoped vector hit could influence another project's decision or revive obsolete memory. | Recheck all those fields against PostgreSQL before ranking/influence. Nine new adversarial/valid-record cases; 17 memory-recall tests pass. Database remains authoritative. |
| A07 — MEDIUM | `packages/ai/src/provider-router.ts`: an already-aborted signal was not observed; cancellation/total timeout could continue into retries or fallback. | Check cancellation before orchestration, each call, after response, and before failure handling. Cancellation does not count as provider failure. Two new cases; 16 router tests pass. Providers must still honor their abort signal to end an in-flight call. |
| A08 — HIGH | `apps/web/src/app/api/settings/models/route.ts`: hostname-only SSRF validation, default redirect following, and asserted untrusted JSON. | Reuse DNS-aware validation, refuse redirects, validate model IDs with Zod, remove the auth cast. Six tests pass. DNS lookup/fetch are still separate; transport-level pinning is not claimed. |
| A09 — HIGH | `tests/integration/p1-memory-real.test.ts`: cleanup deleted every repository matching `p1-%`, including data owned by another run. | Unique UUID repository namespaces and exact parameterized cleanup predicates. Source-reviewed; live cleanup deliberately not rerun without an isolated database. |
| A10 — HIGH | `docker-compose.yml`: the worker received the settings encryption key but the web writer/reader did not, permitting plaintext writes or decryption failures. | Pass the same optional key to web. Source-reviewed; Docker runtime unavailable. Key generation/rotation, legacy re-encryption, and mandatory production encryption remain operator work. |
| A11 — HIGH | `apps/worker/src/pipeline.ts` and `poller.ts`: `DISABLED` only blocked the late mutation gate; observation, AI work, and persistence could still occur. | Early disabled checks stop polling and direct pipeline processing. Two behavioral regressions pass; 35 focused pipeline/poller tests passed. |
| A12 — MEDIUM | Settings API accepted any string for known configuration keys and accepted inherited object properties as catalog keys. Invalid overrides could poison worker startup. | Reuse `EnvSchema` field validation and require own catalog properties. Seven new rejection cases; 11 settings tests pass in total. Boolean permissiveness in the existing environment schema and cross-process reload are not solved here. |
| A13 — HIGH | `apps/web/src/app/(dashboard)/approvals/page.tsx`: failures were swallowed, the item removed, and success shown even after rejected/offline requests. | Require HTTP success before removing the item; preserve edits on failure; display a localized alert using an existing en/es message. No business logic moved to the browser. Three Playwright regressions added and discovered; browser execution BLOCKED. Build/type checking passed; runtime interaction is not certified. |
| A14 — LOW | `tests/integration/postgres-real.test.ts`: unused budget repository instance/import broke the zero-warning lint gate. | Removed only the unused instance/import; assertions retained. Final `pnpm lint` passes. |

## Remaining release blockers and remediation order

### R01 — HIGH: live Jules contract mismatch

Files: `packages/jules-client/src/client.ts`, `schemas.ts`, `apps/worker/src/normalizer.ts`.

The adapter serializes `{ message, clientToken }` for sending and `{ approved, feedback, clientToken }` for approval, then parses both responses as activities. The official API documents `{ prompt }` for sending, an empty approval request, and empty success responses for both. Activity data is also represented differently from the local required `sessionId`/`type` shape. Local mock contract tests therefore cannot certify live compatibility.

Evidence checked on the audit date: [official sendMessage](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage), [official approvePlan](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/approvePlan), [Jules types reference](https://jules.google/docs/api/reference/types/). None documents `clientToken` deduplication. No authenticated provider call was made.

Required next work: define the real transport DTO-to-domain mapping, explicitly model empty mutation acknowledgements, update callers/mocks, and add official payload fixtures plus authorized staging contract tests. This coordinated interface work was not hidden inside a safety patch.

### R02 — HIGH: approval dispatch and crash recovery are incomplete

Files: `apps/web/src/app/api/approvals/[id]/route.ts`, `apps/worker/src/pipeline.ts`, `reconciler.ts`, `packages/db/src/repositories/execution-attempt.repository.ts`.

No worker consumer of approved verdicts was found. A crash after decision insertion but before creating its approval/attempt can strand the decision: replay returns the existing decision immediately, and recovery only scans expired claimed/executing attempts. `PENDING` attempts with no lease and decisions with no attempts are outside that scan. Reproduce with failure injection after each durable write; current unit doubles do not prove these recovery invariants.

Required next work: agree on an atomic decision/outbox/approval transition and a supervised dispatcher; expose reconciliation items to operators. Do not resume an uncertain external effect without checking Jules. This requires a coordinated persistence/execution design, not an isolated retry.

### R03 — HIGH: ownership loss is not fenced

Files: `apps/worker/src/lock.ts`, `pipeline.ts`, `packages/db/src/repositories/execution-attempt.repository.ts`.

Redis renewal failures/false ownership results do not stop the critical section. Pipeline claim/mark-executing return values are ignored; some completion updates guard status without requiring the current owner. An old worker can continue after a lease is lost. Unique decision keys protect a duplicate activity, not all concurrent session effects or budgets.

Required next work: ownership-aware cancellation/fencing and conditional transition outcomes, with real Redis/PostgreSQL two-worker fault tests. Automatic replay was removed, reducing one path, but the original dispatch path still needs this design.

### R04 — HIGH: displayed settings and effective runtime can disagree

Files: `packages/config/src/env.ts`, `apps/worker/src/index.ts`, web settings/models routes, `apps/web/src/components/mode-gate-panel.tsx`.

Worker overrides load once at startup. Clearing the web process's cache neither reloads its DB overrides nor updates the worker's already-constructed config/provider. The sidebar hardcodes DRY_RUN/ENFORCED. A successful settings write is not proof that runtime safety mode/model changed. Use the dedicated DB-backed kill switch for emergency pause; verify the worker state independently.

Required next work: define a versioned effective configuration lifecycle and runtime status source, then bind UI to it. Do not duplicate configuration resolution in each route. Regression must prove save -> acknowledged runtime change across separate processes.

### R05 — HIGH: budget and semantic outcome accounting overclaim certainty

Files: `apps/worker/src/pipeline.ts`, `packages/ai/src/provider-router.ts`, `memory-reflection.ts`, `packages/db/src/repositories/budget.repository.ts`.

The pipeline increments one AI call after final success, even if routing attempted several calls; complete failures are not charged there. Budget checks examine accumulated usage before a call without reserving its maximum cost. Reflection receives `success` on transport acceptance, which does not prove the requested repository work succeeded. Router metadata exists but is not fully consumed by budget persistence.

Required next work: define per-attempt accounting/reservation and verified outcome ingestion. Test failed responses with usage, timeout/cancellation, fallback chains, concurrent reservations, and crash windows. Existing cost ceilings are not proven hard spend caps.

### R06 — HIGH: egress controls and deployment exposure need completion

Files: `packages/ai/src/embedding-provider.ts`, `endpoint-provider.ts`, `ssrf-guard.ts`, `docker-compose.yml`.

Embeddings do not use the decision provider's SSRF guard. Decision-provider DNS validation is cached and disconnected from the actual fetch resolution; redirect/pinning behavior is not consistently guarded across SDKs. Compose publishes database/cache/vector ports on all interfaces, with development defaults and no demonstrated Redis/Qdrant authentication. No externally reachable deployment was tested.

Required next work: agreed egress policy/transport enforcement, private service networking and production credential/encryption provisioning. DNS/redirect tests must prove the actual connection target. Do not treat the model-discovery fix as repository-wide SSRF certification.

### R07 — MEDIUM: operational and performance evidence is incomplete

Polling bypasses BullMQ; shutdown stops the poller's flag but does not await its current pipeline work. Web/worker metrics are not a unified runtime view. Dashboard session aggregates are limited to the first 500 rows, so large deployments can undercount. Semantic recall loads hits with per-item DB queries. Full activity replay now prioritizes correctness but increases database work; optimize only with a verified cursor/order contract and workload measurements. Repeated token cycles are bounded, but an endpoint returning endless distinct tokens is not a demonstrated bounded workload.

### R08 — MEDIUM: frontend/i18n and auth-test artifacts

Only en/es are registered; no French catalog exists in the baseline. This change introduced no translation keys and reused an existing message, retaining current en/es parity; en/es/fr parity cannot be claimed for the repository. Theme controls contain English labels and access localStorage without guarding storage exceptions. The approvals initial-fetch failure still resembles an empty queue. Stored-secret reveal/copy UX needs to be reconciled with the corrected masked API contract.

`tests/e2e/.auth/user.json` is tracked and was already staged on entry. Treat it as a sensitive session artifact; remove it from version control and review revocation through an explicit credential-management change. Its contents were not reproduced or overwritten here. Existing E2E setup hardcodes development login assumptions.

### R09 — LOW: CI/documentation/format drift

CI pins a different pnpm release from `packageManager`; README formerly claimed no provider router and mock-only dashboards despite current source. README was corrected where directly relevant. Older certification reports remain historical, not current assurances. The broad formatter reports 140 files, and the combined staged diff has three pre-existing extra EOF blank lines. No unrelated formatting sweep was performed.

## Frontend technical audit limits

The Impeccable context/detector ran against current code. Its ten findings concern existing gradients/palette/grid styling; these were reviewed as stylistic observations, not security or functional defects, and did not justify replacing the user's staged design.

| Dimension | Verified source evidence / limit |
| --- | --- |
| Accessibility | Semantic buttons and labels exist; the new failure message has `role=alert`. Theme radio keyboard behavior, contrast and touch-target adequacy require browser measurement. |
| Performance | Server-rendered data pages and explicit client boundaries exist. Bundle generation succeeded. No load/animation profiling or LCP claims. |
| Responsive behavior | Existing responsive layout classes were preserved; no viewport certification was executed. |
| Theming/hydration | Theme preference is applied after mount with an initial bootstrap script. Existing theme/i18n unit tests pass; runtime storage failure remains a risk. |
| Implementation integrity | Backend approval acknowledgement now controls removal; hardcoded runtime-status labels and false empty states remain. |

No numerical WCAG/visual health score is assigned without runtime evidence. No design replacement or new locale system was introduced.

## Validation matrix

| Gate / actual command | Result | Evidence and limits |
| --- | --- | --- |
| `pnpm test:unit` baseline | PASS | 940 tests, 44 files. |
| Focused remediation tests | PASS | Settings, middleware, rate limiter, model discovery, client retries/recovery, poller/pipeline, router and memory recall executed as described above. |
| `pnpm test:unit` after backend changes | PASS | 1,000 tests, 48 files; 15.43 s. No integration services required. Subsequent approval UI edit was covered by build/static checks; it has browser regressions pending execution. |
| `pnpm lint` | PASS | Baseline failed on an unused integration-test variable; final zero-warning lint passed. |
| `pnpm typecheck` | PASS | 19 tasks successful. Later production build also performed the web type checks including the approval change. |
| `pnpm build` | PASS | Final production build: 11 tasks successful, 54.228 s. Includes the approval UI fix. Builds do not validate live data/provider behavior. |
| `pnpm format:check` | FAIL | 140 files reported. Existing style debt was preserved; new regression files formatted. |
| `git diff --check` | PASS | Audit work had no whitespace errors before the index later included those edits. |
| `git diff --cached --check` | FAIL | Three pre-existing extra EOF blank lines: login page, dashboard layout, globals.css. No unrelated cleanup. |
| `pnpm test` initial attempt | BLOCKED | Interrupted after real-service connectivity errors (`ECONNREFUSED` to local Redis). No complete integration result. Not rerun after discovering broad test cleanup; repair is source-reviewed only. |
| PostgreSQL/Redis/Qdrant integration and migrations | NOT_RUN | No isolated live service stack established; no new migration or destructive database command was issued. |
| `pnpm exec playwright test tests/e2e/approval-failure.spec.ts --list` | PASS | Discovered 3 regression scenarios plus the existing auth dependency. Discovery is not execution. |
| Approval browser regression execution | BLOCKED | Automatic approval review rejected the isolated-server/synthetic-session launch command with `blocked by policy`; no more specific reason was returned. Temporary runner config removed. |
| Full E2E, viewport/a11y and load testing | NOT_RUN | No validated live stack; shared pre-existing auth file preserved. |
| `pnpm audit --json` | BLOCKED | Registry request returned `fetch failed`; no clean dependency-security claim or package upgrades. |
| Docker runtime validation | BLOCKED | `docker version` could not reach the Docker Desktop Linux engine named pipe. Compose execution/image validation not performed. |

## Red-team conclusions and rollout constraints

- Duplicate delivery: durable decision keys still deduplicate the same activity; recovery no longer repeats uncertain remote effects. Session-wide exclusivity after lease loss remains unproven.
- Crash between writes: decision/approval/attempt gaps remain; terminal reconciliation entries require operator attention and a future complete recovery workflow.
- Malformed input: settings values and provider model-list payloads now reject invalid shapes. Existing API payload-size limits, pagination parameter validation, and permissive environment booleans remain incomplete.
- Provider/network failure: only Jules reads retry; router cancellation prevents new attempts. An in-flight provider that ignores cancellation is still outside a hard deadline guarantee.
- Deployment/rollback: no schema or persisted payload migration was introduced. Returning secret `rawValue: null`, refusing foreign-origin mutations, and disabling automatic mutation replay are intentional safety changes. Rolling them back reintroduces the corresponding risks.
- Multi-tenancy: memory records now recheck tenant/project/repository scope. The web product is still a single-operator control plane; no tenant-isolated RBAC certification is implied.

## Production readiness

| Target | Verdict |
| --- | --- |
| Development | Suitable for local development and the hermetic unit suite; live-service setup still required for integration. |
| Staging | Conditional, isolated, observed DRY_RUN/mock evaluation only until R01–R06 and service validations are addressed. |
| Production | HOLD, especially for automatic mutation modes. Build/test success is insufficient evidence. |

## Audit diff ownership

Backend/UI fixes: settings and models routes; middleware and rate limiter; approval page error handling; worker poller/pipeline/reconciler and relevant startup comments; AI router and memory recall; Jules HTTP retries; execution-attempt safety documentation; web encryption-key wiring.

Regression coverage: four new web unit files; additions to client, router, memory, poller, pipeline, recovery and master regression suites; three new approval browser scenarios. Integration edits constrain cleanup and remove unused code. README and this report document verified behavior and release restrictions.

All other staged theme/layout/Qdrant/metrics changes belong to the entry baseline. No Prisma/Drizzle schema, migration, lockfile, environment file, or prior session artifact was changed by this audit.
