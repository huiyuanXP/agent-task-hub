# Remote controlled execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete five unclaimed execution issues with tested, reviewable implementations.
**Architecture:** Worker/D1 domain services own durable contracts and decisions. A separate hardened Docker supervisor owns actual execution. HTTP and MCP delegate to domain services.
**Tech Stack:** TypeScript, Vinext, Cloudflare D1, Node >=22.13.0, native node:test, Docker.
**Spec:** `docs/superpowers/specs/2026-10-04-remote-execution.md`

## Global Constraints

- Node >=22.13.0; preserve application `package-lock.json` and installed versions.
- No production records, credentials, Site reconnection or public deployment.
- Trusted Sites ingress is the existing identity boundary; all access is owner scoped.
- All test and supervisor listeners bind loopback; each test owns a fresh database.
- No placeholders, unfinished branches or new Tickets standing in for acceptance.
- One implementation task at a time; root owns GitHub claims, PRs, merges and completion comments.
- Each task implements the full acceptance section of its issue in the spec.

## Review Focus

- Same request ID with changed payload conflicts rather than reusing another contract.
- Ticket edits racing creation/approval/dispatch fail through atomic SQL guards.
- A public client cannot forge lifecycle completion or expand authorized operations.
- Filesystem symlinks, traversal, sensitive inputs and retained artifacts cannot cross workspaces.
- Crash, timeout, repeat dispatch and expired leases cannot start a second execution or report false success.

### Task 1: Revision-bound durable Run model (#12)

Completed and merged in PR #30.

**Files:** Create `lib/execution/types.mts`, `lib/execution/runs.mts`, `lib/execution/errors.mts`, `app/api/execution/route.ts`, additive `drizzle/0002_execution_runs.sql`, `tests/execution/runs.test.mjs`, `tests/execution/sqlite.mjs`, `docs/EXECUTION.md`. Modify `db/schema.ts` and package scripts with `test:execution`. Keep existing records and MCP unchanged except explicitly marking manual source if necessary.

**Interfaces:** `createRun(db, context, input)`, `getRun(db, owner, id)`, `listRuns(db, owner, filters)`, `transitionRun(db, context, input)` use exported typed argument/result interfaces. `context` has server-derived owner/actor. `input` has ticketId, expectedRevision, requestId, authorizationId, attempt; services cannot import `cloudflare:workers`. The HTTP route authenticates, checks same-origin writes, limits body size, and exposes create/read/cancel only. Backend transitions are domain methods unavailable as arbitrary public route actions.

- [x] Write real SQLite tests asserting frozen old body after Ticket update; stale revision 409; foreign owner 404; identical retries same ID; changed retry 409; concurrent create one ID; active Ticket uniqueness; positive attempts and bounded request IDs; legal/illegal transitions; terminal absorption; success requires evidence; legacy snapshot unchanged.
- [x] Run `node --experimental-strip-types --test tests/execution/runs.test.mjs` and record expected failing assertions before production implementation (provide importable throwing skeleton only if needed for RED).
- [x] Implement additive tables, unique constraints and atomic conditional writes, explicit typed error mapping, and route/domain separation. Define immutable source `execution` and legacy source `manual` at display boundaries. No authorization bypass: a queued model alone never dispatches a process.
- [x] Run `npm run test:execution`, `npm run lint`, `npx --no-install tsc --noEmit`, `npm run build`; verify migrations against a fresh local database and authenticated API create/read/foreign/revision behavior.
- [x] Document Function map and acceptance evidence; commit task files and report RED/GREEN commands plus concerns.

### Task 2: Authorization, decisions and audit (#15)

Implementation and acceptance checks complete; independent root review/merge remain pending.

**Files:** Create `lib/execution/authorization.mts`, focused authorization types/HTTP/MCP helpers, a shared Worker-safe `lib/execution/catalog.mts`, `app/api/authorization/route.ts`, `components/execution/authorization-panel.tsx`, an additive authorization migration, `tests/execution/authorization.test.mjs` and real Worker/UI integration coverage. Modify `app/page.tsx` minimally to show a dedicated authorization panel, `app/mcp/route.ts` via a focused execution-tool dispatcher, `lib/execution/types.mts` with D1 batch support, `db/schema.ts` and coherent migration metadata, `docs/EXECUTION.md`. `.mts` is the established runtime-compatible domain convention. Choose the next migration number from the actual branch; never collide with another agent's additive migration.

**Interfaces:** `prepareExecution`, `requestAuthorization`, `decideAuthorization`, `revokeAuthorization`, `getAuthorization`, `assertAuthorization` accept explicit db and server-derived context. `prepareExecution` atomically mints/reserves Run and authorization IDs and writes the revision-bound queued Run plus pending grant; request retries are payload-sensitive. Scope is an array of `{operationId,definitionHash}` bindings; definitionHash freezes fixed argv, image digest, exact input hashes, artifacts and policy. Budget is structured `{timeoutMs,memoryMb,cpus,pids}` with finite positive server ceilings. Bind authorization to exact Ticket revision and Run ID. `assertAuthorization` is the single service consumed by all later dispatch/lease paths. Audit table contains decision ID, actor, owner, kind, authorization ID, Run ID, time and normalized scope/budget; mutable prose cannot alter it.

**Catalog and clocks:** Provide an owner-scoped Ticket/revision catalog endpoint/tool and actual fixed Node operation descriptor now, so the panel selects a real operation and uses its server-derived hash. Initially one operation per Run; ceilings timeout30000ms, memory256MiB, CPU1, pids64, input16MiB, worktmpfs64MiB, no network/credentials. Exact input manifest includes frozen Ticket bytes at a fixed path. Scope cannot be widened at approval. Effective status distinguishes pending/approved/rejected/revoked/expired/stale revision/stale definition, consistently in UI and MCP. Expiry is exclusive (`now >= expires` invalid) and latest-start authority; later dispatch persists its own bounded hard deadline. Owner grant decisions are distinct from future worker lease capabilities. Preserve D1 transaction atomicity and audit immutability under races; a failed preparation leaves neither orphan Run nor usable grant.

- [x] Write and observe failing tests for atomic Run/grant preparation including rollback and retry; unapproved requests; valid approval; conflicting/duplicate decisions; foreign owner; revoke; expiry boundary; changed Ticket; changed operation definition; enlarged operations/budget; audit linkage and atomic approval races.
- [x] Implement atomic request/approve/reject/revoke service and consistent HTTP/MCP operations. Display the same effective status and decisions in UI. Browser writes require same Origin; API/MCP arguments validate real JSON at runtime.
- [x] Run execution suite, lint, typecheck/build and a loopback browser/API approval/revocation flow with isolated synthetic data.
- [x] Document operation scope, grant limits, effective expiry, invalidation rules and Function map; commit and report.

### Task 3: Hardened isolated workspaces (#13)

**Files:** Create `runner/workspaces.mjs`, `runner/docker.mjs`, `runner/policy.mjs`, `tests/execution/workspaces.test.mjs`, `tests/execution/docker.test.mjs`, `docs/RUNNER.md`. Keep Node-only modules out of Worker imports.

**Interfaces:** `createWorkspace(root, run, policy)`, `importInputs(workspace, sourceRoot, paths)`, `cleanupWorkspace(workspace)`, `recoverWorkspaces(root)` and container lifecycle functions own their resources and reject forged ownership. Policy is normalized before use; client text cannot provide Docker options. Use server ceilings of timeout 30000 ms, memory 256 MiB, CPU 1, pids 64 initially; budget/grant may only reduce them. Empty network and credential scope are deliberate supported policy, not unfinished placeholders.

- [ ] Write failing tests for per-attempt isolation, traversal, absolute paths, symlinks, special files, sensitive-file exclusion, forged cleanup, repeated cleanup, metadata recovery and bounded log retention.
- [ ] Implement durable ownership metadata and safe bounded input import into owned read-only input volumes; put executable work in a size-limited writable tmpfs. Docker root read-only, network none, drop ALL capabilities, no-new-privileges, UID 1000, resource ceilings. A plain unbounded writable Docker volume is insufficient: enforce workspace bytes with a 64 MiB tmpfs and bound imported files to 16 MiB total. Keep the container alive while the supervisor extracts declared artifacts, then clean it up. Never expose inherited proxy credentials or environment to task processes. Pin the actual pulled image digest in runner configuration/documentation.
- [ ] Explicitly blank all uppercase/lowercase HTTP/HTTPS/FTP/ALL/NO proxy defaults in container arguments; inspect effective Config.Env privately and reject unexpected authority. Set Docker log-driver none and retain only bounded own streams. Arm an independent detached watchdog before starting the container with a persisted deadline and no restart policy.
- [ ] Execute actual container tests for denied host/sibling access, denied network and root writes, safe workspace output, input/workspace byte limits, Docker default synthetic-secret suppression, supervisor SIGKILL with watchdog timeout, and cleanup/recovery; no mock-only isolation verdicts.
- [ ] Run execution suite and relevant checks, document lifecycle, retained evidence and actual Docker evidence; commit and report.

### Task 4: Real bounded execution backend (#16)

**Files:** Create `runner/server.mjs`, `runner/registry.mjs`, `runner/executor.mjs`, `runner/client.mjs`, `lib/execution/dispatch.ts`, `app/api/execution/dispatch/route.ts`, `tests/execution/runner.test.mjs`, `tests/execution/dispatch.test.mjs`. Modify Worker env types/config declarations and docs for newly scoped runner bindings; never include secret values.

**Interfaces:** Supervisor consumes administrator registry with operation IDs, fixed argv, pinned image digest, immutable input hash manifest and declared artifact paths. A real catalog returns normalized descriptors and definition hashes for the authorization UI/API. `dispatchRun` atomically verifies effective authorization/Ticket revision and records a durable dispatch permit before signing the bound envelope; this permit linearizes start authority. Shared envelope schema/signature binds Run ID, attempt, Ticket revision, immutable contract hash, exact operation definition hashes, grant, budget and expiry; requests have replay-safe IDs. `runner/client.mjs` handles health, dispatch, result and cancel. Server binds 127.0.0.1 and refuses missing auth, unknown operation, registry/input drift, changed replay and exceeded grant. Persist backend identity before executable work; the supervisor journal prevents duplicate spawn across retry/restart. Revocation requests cancellation, rejects new permits/renewals and is checked through authenticated control-plane checkpoints; disconnected executors remain constrained by their independent hard deadline. Local integration uses local Worker+supervisor; a hosted Worker needs the separately provisioned private service binding, not127.0.0.1.

**Recovery and evidence:** Use the Task2 shared real descriptor, deterministic owner/Run/attempt identity and durable fsynced journal, independent of lease/request IDs. Reconcile reserve/create/start/finish/evidence/cleanup boundaries without uncertain rerun; keep receipts/tombstones. Arm the Task3 watchdog before start. Quiesce all container descendants before bounded safe artifact collection while tmpfs remains alive. Sign complete versioned/purpose/audience-bound dispatch evidence using interoperable raw P-256; transport keys are separate. Start returns a stable accepted identity and result polling is asynchronous; admission concurrency and streams are bounded. Real cancellation confirmation is separate from request intent. Trusted historical receipts are checked against persisted start/deadline, not lease-delivery time.

- [ ] Write and observe RED for rejected unsigned/expired/enlarged operations, registry/input drift, differing replay payload, dispatch/revocation race, authorized real execution, spawn failure, timeout including killed supervisor, bounded output, artifact symlinks and repeated dispatch.
- [ ] Implement actual Node-in-Docker execution of registered test/command argv and safe artifact hashing; startup/health/shutdown and authenticated Worker transport. Never execute a client-provided command. Missing runner configuration produces a clear unavailable result and leaves truthful Run state.
- [ ] Run actual supervisor+Docker integration and Worker/D1 dispatch integration with synthetic local signing material; assert output and artifact hashes from the real process, failure/timeout states and zero orphan containers after shutdown.
- [ ] Run full checks and suite, update Function map, operation registration/configuration and failure handling docs; commit and report.

### Task 5: MCP execution claims, renewals and evidence (#17)

**Files:** Create `lib/execution/leases.ts`, `lib/execution/mcp.ts`, `runner/consumer.mjs`, `drizzle/0004_execution_leases.sql`, `tests/execution/leases.test.mjs`, `tests/execution/mcp.test.mjs`; modify MCP route via focused dispatcher and docs.

**Interfaces:** `claimExecution`, `renewExecution`, `reportExecution`, `completeExecution` bind owner, worker, Run, revision and token generation, with durable idempotency IDs. `get_execution_run`, `list_execution_runs`, `claim_execution_run`, `start_execution_run`, `renew_execution_run`, `report_execution_run`, `complete_execution_run` are explicit capability surfaces, reusing earlier domain and backend services. Completion checks trusted backend evidence rather than trusting caller prose. Consumer performs real connection, claim/start/renew/report/complete and controlled shutdown against MCP.

**Capability and recovery:** Owner decisions cannot be reached through lease capabilities. Never treat a worker label as authenticated identity. Response-loss claim retries recover the same secret securely without exposing tokens in lists/audit/logs. Persist CLI request IDs before writes; renew concurrently with asynchronous execution polling. Expired tokens cannot write, but a fresh authorized claimant/owner can reconcile a genuinely completed backend result without a new execution or extending its deadline. Shutdown requests owned cancellation and waits for acknowledgement/deadline; an absorbing cancelled Run never accepts late success.

- [ ] Write RED for competing claim, changed replay, stale/expired/foreign token, revoked/changed grant, renewal races, planning-as-completion rejection, forged evidence, oversized payload, terminal report and retry idempotency.
- [ ] Implement guarded SQL leases, scope checks and evidence validation, complete JSON schemas, bounded transport errors and consumer CLI. Preserve existing planning tools and protocols.
- [ ] Run full protocol suite and actual CLI+MCP+supervisor+Docker end-to-end on fresh local D1, plus existing planning regressions and browser authorization flow.
- [ ] Run full lint/typecheck/build/execution suite; record Function map, consumer integration sequence and all terminal evidence. Commit and report.
