# Task 5 / GitHub #17 implementation report

Status: DONE. All implementation and local acceptance gates passed; independent root review and exact-head hosted CI remain root-owned.

Branch: `remote/mcp-execution`. Base: `aa43b623db818efb7be4049ff695a5da5a7b2021`.
Implementation commit: `80615b61aa1c2553f127724bf25dc56f0c5237a0`. Initial report commit: `e2b35eff2150f1c20c9f7e7051f45672a3b07509`. Latest-main integration: `9cc0b06c2cf9b3036bc958ac2f0aeff0e524fd06`. Reviewed I1 fix source: `0ad27f241d3cee113712b3dfe7f64e3ddc2f561c`. The final report-packaging commit contains no source changes; its exact HEAD is recorded in the completion message and scratch fix-wave report. No push, PR, merge, deployment, production records or provider changes were performed by this implementer. The root owns those actions and independent review.

## Delivered scope and abstractions

The application now authenticates a finite server-record-backed Run delegation before owner JWT parsing, installs a request-scoped `execution_worker` principal with `user: null`, and gates both discovery and dispatch through eight explicit worker capabilities. Owner Access verification/session revocation, planning recovery and owner MCP remain intact. Worker credentials are accepted only at exact `/mcp`, never owner APIs or the distinct signed supervisor checkpoint route. Cookie/origin/fetch conflicts and unconfigured ingress assertions fail closed. Configured machine ingress cannot upgrade the principal.

An independently authenticated owner provisions, lists and revokes delegations for an explicitly selected existing Run. There is no grant creation/approval in this flow. The credential freezes owner, worker identity, Run, Ticket/revision, attempt and authorization; it records the verified issuing actor, token hash, mode/origin/issuer/audience and allowed-account context. Secrets are generated on the client, privately persisted before writes, and represented only by SHA-256 verifiers in D1. Delegations last at most 15 minutes and never exceed the provisioning Access expiry. Revocation/logout, incompatible configuration and account removal invalidate them. Existing general Ticket/Plan query issue #11 is not duplicated.

Six-second SQL-guarded exclusive lease generations distinguish execution from historical reconciliation. Execution claim/start/renew require the current effective grant, selected registry binding, Ticket and budget. Reconciliation requires a durable historical permit and supports completion/owned stop only; it cannot start/progress/renew or extend a physical deadline. Exact retry IDs preserve binding/generation and still check current authority. Renewals run concurrently every two seconds. Progress is bounded and cannot assert lifecycle. Terminal Run states remain absorbing.

`guardedDatabase` composes existing domain mutations with before/after conditional CHECK statements inside the same D1 batch; failed authority rolls back the complete mutation. SQL evaluates current time at the actual transaction boundary, not from function-entry timestamps. Credential revocation/expiry, exact lease owner/principal/generation/mode/expiry and relevant grant/Ticket checks cover claim, action journaling, renewal, progress, start permit, receipt insertion/projection and cancellation. Temporary check rows never survive successful or failed batches.

The existing physical backend is reused. Signed receipts must now match the requested permit and Run before ingestion, closing the discovered same-owner foreign-result binding gap for both owner gateway and workers. A delegated worker cannot invoke predecessor-Run reservation recovery. Existing owner successor/predecessor recovery remains available and its actual browser/backend regression passed.

The shipped CLI separates `bootstrap`, `run` and `revoke`. Bootstrap/revoke read owner JWTs only from protected files or inherited regular descriptors; bootstrap exits. Runtime rejects owner configuration and carries only its worker credential. Private fsynced pending secrets/IDs survive response loss and process restart. An exclusive kernel flock prevents a second process from clobbering state; serialized atomic writes protect concurrent renewal/polling. Fixed-origin transport rejects redirects, bounds results/errors and supports protected HTTPS-only machine ingress without treating it as owner authority. Runtime performs actual MCP negotiation, claim/start/renew/report/complete, historical reclaim and signal-triggered stop verification.

Migration `0007_worker_delegations.sql` and matching schema/snapshot/journal add credential, lease, action and transient-check tables. Previous SQL/snapshot identities are unchanged. Both approved lockfiles are unchanged. Docs explain admission limits, operation/authority separation, CLI recovery, hosted ingress prerequisite and the difference between logical cancellation and verified physical stop. CI retains ordinary-user parent preparation and auth/planning/browser checks, with Docker/proc suites under the privileged execution step.

## Function map

| Module / function | Responsibility |
| --- | --- |
| `worker-types.mts` | Explicit issuer, verified principal, persisted credential/lease and request contracts |
| `worker-auth.mts::workerConfiguration/workerTransport/isWorkerAuthorization` | Reserved token namespace, current authentication config, exact route and ingress policy |
| `workers.mts::provisionWorker/listWorkers/revokeWorker` | Owned finite issuance, immutable retry/audit, public listing and explicit revocation |
| `workers.mts::authenticateWorker/assertWorkerCurrent` | Secret verifier, server-derived principal, current membership/configuration/revocation |
| `worker-guard.mts::credentialGuard/leaseGuard/combine` | Exact mutation-boundary authority predicates using SQL current time |
| `worker-guard.mts::guardedDatabase/checkGuard` | Atomic composition with existing D1 services and complete rollback |
| `leases.mts::executeGuard/claimExecution` | Approved selected binding, exclusive monotonically increasing generation and claim replay |
| `leases.mts::authority/begin/finish` | Exact token/action scope and bounded stable-ID action journal |
| `leases.mts::renewExecution/reportExecution` | Atomic idempotent expiry update and non-authoritative bounded progress |
| `leases.mts::startExecution/completeExecution/cancelExecution` | Guard existing dispatch, trusted historical results and owned physical cancellation |
| `leases.mts::getExecutionRun` | Single frozen Run plus public permit deadline/stop metadata |
| `worker-mcp.mts::workerTools/dispatchWorkerTool` | Complete schemas, fixed capability gate and sanitized failures |
| `mcp.mts::dispatchExecutionTool` | Existing owner execution/catalog/grants plus owned Run selection |
| `backend-http.mts::reconcilePermit` | Exact requested permit/Run binding before trusted receipt ingestion |
| `backend-http.mts::reconcileBackend/reconcileTicketReservation` | Worker Run scope and preserved owner-only predecessor reservation recovery |
| `authentication.ts`, `auth-context.ts` | Dedicated opaque-credential branch and discriminated request principal |
| `/api/execution/workers` | Verified owner-only bootstrap/list/revoke adapter |
| `/mcp::POST` | Principal-first dispatch, version negotiation, bounded request and complete response envelopes |
| `consumer-state.mjs::openConsumerState` | Safe files/directories, lifetime flock, serialized fsynced pending state |
| `consumer-transport.mjs::endpoint/ingressHeaders/connection` | Fixed origin, protected ingress, bounded MCP transport, stable request retries |
| `consumer.mjs::bootstrap/ownerToken` | Persist generated secret/IDs before issuance, protected owner input, provision-and-exit |
| `consumer.mjs::runtime` | Actual query/claim/start/renew/report/complete, generation recovery and observed shutdown |
| `consumer.mjs::revoke/main` | Owner-only stable-ID revocation and strict command separation |
| `fixtures/consumer.mjs`, `fixtures/race.mjs` | Fresh actual Worker/D1, ephemeral verified Access, real optional supervisor/Docker; selected durable mutation-boundary race injection |

## Observed RED and corrective GREEN

All paths below are local ignored `test-results/` artifacts; no secrets or fixture databases are committed. Commands use Node24 strip-types. Initial RED commands were executed before implementing their production behavior.

| RED command / log | Observed failure | Corrective GREEN |
| --- | --- | --- |
| `node --experimental-strip-types --test tests/execution/workers.test.mjs`; `task5-workers-red.log` | Missing delegation/lease feature | `task5-workers-green.log`: 9/9, also final complete execution suite |
| `node --experimental-strip-types tests/execution/worker-protocol.mjs`; `task5-protocol-red.log` | Owner bootstrap route 404 | `task5-protocol-final.log`: actual Worker/D1 protocol passed |
| `node --test tests/execution/consumer.test.mjs`; `task5-consumer-state-red.log` | Missing protected consumer journal | `task5-consumer-state-green.log`, final complete execution suite |
| `node --experimental-strip-types tests/execution/consumer-worker.mjs`; `task5-consumer-red.log` | Missing actual consumer CLI | `task5-consumer-final.log`: real lifecycle and recovery passed |
| Workers test; `task5-workers-audit-red.log` | Issuing actor/retained issuance retry contract missing | `task5-workers-green.log`: actor audit and expired retry denial |
| `node --experimental-strip-types tests/execution/worker-evidence.mjs`; `task5-evidence-red.log` | Authentically signed wrong-permit result accepted by requested owner gateway | `task5-evidence-final.log`: owner and worker rejection plus actual ingestion race rollback |
| Workers test; `task5-predecessor-red.log` | Worker attempted another Run's predecessor backend recovery | Workers GREEN: no cross-Run backend call; existing owner backend/browser GREEN |
| `node --experimental-strip-types tests/execution/consumer-descriptor.mjs`; `task5-descriptor-red.log` | Valid protected descriptor 10 rejected | `task5-descriptor-green.log`: actual bootstrap through fd10, no JWT persisted/output |
| Protocol test; `task5-discovery-red.log` | Worker advertised owner event capability | `task5-protocol-final.log`: worker-only discovery/direct allowlist |
| `node --experimental-strip-types tests/execution/consumer-drift.mjs`; `task5-consumer-drift-red.log` | Renewal denial immediately tried a new claim while prior generation remained exclusive (`LEASE_CONFLICT`) | `task5-consumer-drift-green.log`: wait actual expiry, sequential reconciliation, one start, trusted success/stop |
| `node --experimental-strip-types tests/execution/worker-envelope.mjs`; `task5-envelope-boundary-red.log` | Tool result under cap could produce full JSON-RPC envelope over consumer 1MiB cap | `task5-envelope-green.log`: complete envelope checked; boundary rejected, legitimate maximum contract roundtrips |

Additional real-boundary behavior: `task5-natural-races.log` records both natural credential expiry before claim INSERT and natural six-second lease expiry before action INSERT after successful preflight. Stored expiry values remain unchanged, delayed actual D1 batches reject, no claim/action commits and zero check rows remain. The same suite covers revocation/lease expiry/generation replacement/grant/Ticket races at claim, report, renewal and start-permit insertion. `task5-evidence-final.log` expires the lease immediately before real trusted receipt insertion, proving no receipt or Run transition commits.

## Actual consumer integration sequence

`tests/execution/consumer-worker.mjs` uses the built application Worker, fresh D1, ephemeral RS256 Access/JWKS, three distinct ephemeral P-256 backend key roles, a loopback signed Node supervisor, the pinned cached Node Docker image and actual subprocess CLI invocations.

1. Prepare/approve a synthetic selected Run as its verified owner. CLI bootstrap persists a generated delegation secret and stable IDs, provisions via owner API and exits. Runtime runs without owner credentials.
2. Drop provision, claim, start and complete responses after server effects. The same persisted IDs/secrets recover exact issuance/claim/action bindings. A real slow operation runs while renewal occurs. Exactly one physical backend identity/start is observed, and verified receipt/stop closes the permit.
3. Send SIGTERM to an active runtime. It requests cancellation with current delegated lease and only prints confirmed stop after trusted physical closure.
4. SIGKILL a runtime after an actual start. This successful-history fixture approves an upfront 45-second grant; the original permit timeout remains 30 seconds and its absolute deadline is saved. Query the signed supervisor result directly and require genuine `succeeded` plus `stop` receipts before changing the Ticket and awaiting natural grant/lease expiry. Restart the same CLI state, explicitly reclaim generation 2, reconcile historical success, assert unchanged deadline/identity and no second start.
5. Separately approve an upfront five-second grant for the slow operation. Natural hard-deadline expiry produces actual failed evidence. After natural expiry, the CLI truthfully reconciles `failed; stop confirmed` without changing the deadline or sending another start.
6. Revoke an active delegation. Runtime exits with unconfirmed stop, cannot regain owner authority and makes no fallback bootstrap. Explicit owner cancellation cleans up, and the separate revoke CLI works.
7. Lose all three bootstrap replies, end that process, then run bootstrap again against the same fsynced pending state: same secret/credential/request IDs. Lose all three claim replies and restart runtime: same secret and generation 1 recover; no extra physical process.
8. The dedicated drift fixture changes the selected operation while execution runs. Renewal is denied; runtime keeps the still-current generation until actual expiry, then obtains nonrenewable historical generations as needed. Original execution succeeds and closes with exactly one `/start`.

The maximum-contract fixture performs actual worker get/list responses and shipped transport parsing for exactly 80,000-codepoint supplementary Unicode, escaped JSON and whitespace-heavy valid Ticket bodies. With a maximum 128-character JSON-RPC id, full Unicode responses are 641,475 bytes (get) / 641,451 bytes (list); escaped and whitespace cases are smaller. Both text and structured forms retain identical complete bodies. Owner limit=1 succeeds; oversized multi-Run responses and the precise outer-envelope boundary return bounded `BODY_TOO_LARGE`. No cap was raised.

## Regression and latest-source verification

Commands with every result exit 0 unless explicitly listed in retained failures:

| Command | Result / evidence |
| --- | --- |
| `npm run build` | Latest envelope change built: `task5-build-envelope.log` |
| `npm run lint`; `npx tsc --noEmit` | Latest source clean: `task5-lint-head.log`, `task5-tsc-head.log` |
| `npm run test:execution` | 165/165 passed, 455.8 seconds; `task5-execution-final.log` |
| `npm run test:execution:protocol` | Latest complete protocol, D1 races, descriptor and envelope: `task5-protocol-head.log` |
| `node --experimental-strip-types tests/execution/worker-protocol.mjs` | Actual protocol: `task5-protocol-final.log` |
| `node --experimental-strip-types tests/execution/worker-races.mjs` | Actual D1 races and natural clock expiry: `task5-natural-races.log` |
| `node --experimental-strip-types tests/execution/worker-evidence.mjs` | Actual signed foreign receipt/ingestion race: `task5-evidence-final.log` |
| `node --experimental-strip-types tests/execution/consumer-worker.mjs` | Complete real CLI lifecycle/recovery/stop: `task5-consumer-final.log` |
| `node --experimental-strip-types tests/execution/consumer-drift.mjs` | Real concurrent renewal denial/reconciliation: `task5-consumer-drift-green.log` |
| `node --experimental-strip-types tests/execution/consumer-descriptor.mjs` | Real inherited owner fd10: `task5-descriptor-green.log` |
| `node --experimental-strip-types tests/execution/worker-envelope.mjs` | Latest full-envelope boundary and max contract: `task5-envelope-green.log` |
| `npm run test:unit` | 11/11: `task5-unit.log` |
| `npm run test:auth` | 149/149: `task5-auth.log` |
| `node --experimental-strip-types tests/auth/worker-api.mjs` | Verified owner/session/API/CSRF/provider failures: `task5-auth-api.log` |
| `npm run test:planning:revisions` | Actual revision/recovery behavior: `task5-planning-revisions.log` |
| `npm run test:planning:recovery`; `npm run test:planning:lifecycle` | 4/4 and 6/6: `task5-planning-recovery.log`, `task5-planning-lifecycle.log` |
| `npm run test:execution:configuration` | Invalid execution registry preserves planning: `task5-execution-configuration.log` |
| `TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser-policy` | 11/11: `task5-browser-policy.log` |
| `TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:auth:browser` | Owner expiry/logout/session UI and strict network gates: `task5-auth-browser.log` |
| `TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:planning:browser` | Recovery UI and network gates: `task5-planning-browser.log` |
| `EXECUTION_PLAYWRIGHT_MODULE=./tests/browser/node_modules/playwright/index.mjs EXECUTION_CHROMIUM_PATH=/usr/bin/chromium node --experimental-strip-types tests/execution/authorization-worker.mjs` | Actual approval UI: `task5-authorization-browser.log` |
| `TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:backend:integration` | Owner backend, physical predecessor recovery, real artifacts/cancellation: `task5-backend-browser.log` |
| `npm run test:execution:api` | Actual execution API/migration 0007: `task5-execution-api.log` |
| `TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:integration` | Full isolated dev/preview API/MCP/browser: `task5-integration.log` |

Auth/planning/browser and broad integration passed on the implementation before the final isolated MCP full-envelope-size correction. Those broad unchanged checks were not repeated; the corrected built route has direct actual-Worker max-contract/boundary verification. Final exact-head remote CI belongs to root. Final source commit includes the already-authorized root plan update. No source changes occur after the final source verification, except documentation/report bookkeeping.

## Retained failed branches and practical limits

- The first complete execution run had 164/165 passing; unchanged `fixture cleanup preserves an uncertain owned root until a real late create is reaped` hit `Docker request deadline exceeded`. Preserved in `task5-execution-full.log`. Its isolated rerun passed (`task5-fixture-cleanup-isolated.log`). A complete isolated retry is retained as `task5-execution-final.log`; its final result is recorded above. No deadline weakening or fake cleanup success was introduced.
- An earlier 18-second-grant historical-success fixture observed `failed; stop confirmed`; it did not prove success. The precise original receipt/timing was not retained, so no more specific cause is asserted. It was replaced with an upfront approved 45-second grant plus explicit observation of genuine historical success, and a separate five-second natural-failure case. Existing permit deadlines and evidence semantics were never extended or softened.
- The drift fixture initially held a stale Miniflare D1 stub after `setOptions`; the fixture now refreshes the stub (`task5-consumer-drift-fixture.log`). Another intermediate assertion assumed exactly two generations, but a longer valid execution needed additional nonrenewable six-second reconciliation generations (`task5-consumer-drift-generations.log`). The final assertion requires one initial execute generation, monotonically sequential reconcile generations, one physical start and confirmed actual outcome.
- The first browser-policy command omitted the supplied local Chromium override and failed the browser prerequisite (`task5-browser-policy-prerequisite.log`). Corrected explicit `/usr/bin/chromium` invocation passed without changing proxy/CDP gates.
- Real D1 returns a new statement from `bind`, which exposed an initial wrapper-adapter mistake during integration; the guarded adapter retains the returned statement. Actual D1 mutation/race suites now cover this boundary.
- Finite retained limits are deliberate: 4 active credentials/Run, 32 active/owner, 256 permanent issuance records/owner, 256 leases/credential, 4096 leases/owner, 256 actions/lease. No unsafe pruning/revival path exists. Capacity fails closed and is documented.
- Runtime exit 0 means it observed a terminal outcome and confirmed physical stop, including truthful failed/cancelled outcomes. It does not mean the command succeeded. Transport/credential denial yields unconfirmed stop and exit 1; the independent backend hard deadline remains the safety boundary.
- Hosted machine ingress and private backend connectivity still require their separately authorized deployment gate. Local proof does not claim a human-only Access gateway accepts opaque worker Bearers. No deployment resources were touched.

## Named invariants and independent final audit

1. **Principal separation:** owner application grant authority, Run-scoped opaque worker authority and signed supervisor checkpoint authority cannot substitute for one another.
2. **Frozen delegation:** public server records bind owner/worker/Run/Ticket/revision/attempt/authorization; labels and guest prose confer no authority.
3. **Mutation-time authority:** current SQL time and exact current delegation/lease predicates protect the durable mutation, including natural expiry between awaits.
4. **Single physical identity:** claims/generations/retries/restarts adopt the original immutable permit; no new deadline or second execution is granted by reconciliation.
5. **Trusted completion and absorbing history:** only authentic requested-permit receipts project lifecycle/closure; foreign/forged evidence and arbitrary progress cannot establish success.
6. **Recoverable bounded secrets:** client secrets/request IDs exist durably before writes, D1 retains only verifiers, action replay cannot bypass current authority, and local concurrent writers are excluded.
7. **Bounded surfaces:** explicit tool schemas/capabilities, finite registry/journal/body/response/runtime limits; full JSON-RPC response cap includes envelope overhead.
8. **Preserved owner/planning behavior:** current Access owner verification and planning recovery remain independent, and owner-only predecessor cleanup remains available.

The independent post-test audit at `2026-10-05T03:44:59.290407Z` (`test-results/task5-final-audit.log`) queried the explicit local Docker socket with Docker selector environment variables removed: **0** containers bearing `ath.workspace`, **0** similarly labeled volumes. A separate `/proc` scan found **0 live** owned test/Worker/browser/consumer/supervisor/watchdog processes. Owned consumer-state, consumer-Worker, delayed-cleanup/backup and dev-preview fixture roots were absent. The D1 race suite independently checked **0** transient guard rows before disposal. Previous migration/snapshot modifications: none.

The environment retains 31 PID1-owned `workerd` zombie entries, which the audit reports separately; they do not execute or retain runtime resources and cannot be reaped with `wait` by this non-parent process. The claim is zero live owned processes/resources, not absence of every historical process-table entry. Older unrelated `/tmp/ath-*` roots from before this task were not deleted.

The initial tested source HEAD was `80615b61aa1c2553f127724bf25dc56f0c5237a0`. `git status --short` was empty after that commit; the following commit adds only this report. Lint, typecheck/build, final complete execution suite and final built-Worker protocol gate correspond to this source tree. The final completion message supplies the exact report-only HEAD. `git diff --check` is clean; no generated databases, keys, logs or lockfile changes are included.

Approved lock hashes: `package-lock.json` = `c0dff8ebb445c466cdba0b3b0e11f44a15765d14`; `tests/browser/package-lock.json` = `cfd69b5e471e8e294cb6a9fcf77e5b544655d49c`. Previous migrations/snapshots were compared with the base; only the additive 0007 pair and `_journal.json` entry are new. All fixture databases/keys live outside source and are cleaned by owned fixture shutdown. Test evidence logs remain local ignored files.

## Latest-main integration (2026-10-05)

Integration source merge: `9cc0b06c2cf9b3036bc958ac2f0aeff0e524fd06`, parents `e2b35eff2150f1c20c9f7e7051f45672a3b07509` and `6c3b4bdfa7b7ff4c1bdfedde481aa5d0345a93b5` (#11 / PR38). Both owner query suites/CI scripts are preserved. MCP owner discovery adds all five read tools; the worker branch stays before owner dispatch and retains exactly eight tools. Actual direct calls to all five new owner tools require `AUTHORIZATION_DENIED`, not merely any error. Both owner execution and task-read registry suppliers remain lazy. Schema, migrations/metadata and lockfiles are unchanged from `e2b35ef`.

The concrete aggregate compatibility RED (`test-results/task5-integrated-envelope-red.log`) created maximum legal records through the actual owner API, then `get_ticket` failed `BODY_TOO_LARGE` under the original global 1 MiB cap. The integration keeps workers and other MCP tools at 1 MiB and gives only the five verified owner task-read tools a finite 4 MiB complete-envelope budget. `task-reads/bounds.mts` measures both JSON representations; `makePage` emits only a complete-item prefix fitting the count and byte budget, with a cursor at the last emitted row. `getTicket`/`getPlan` reserve their complete context before budgeting nested pages. Fields are never truncated and empty nonadvancing continuations are not returned. This is a measured owner-contract compatibility correction, not a worker cap increase.

The new `tests/mcp/task-envelope.mjs` covers manual API records at exactly 80,000 UTF16 units, current/source Idea and Plan context, mixed manual/execution Run pagination, and the existing planner's legal expansion by copying large Idea fields. The expanded fixture uses an approximately 180,000-unit admitted planner input, copies the maximum original Idea priority, and creates real manual frozen Run snapshots through the owner API. Its complete detail response is **3,962,547 bytes**, below 4 MiB; additional items continue by cursor. All projected fields remain exact, every expected ID appears once across pages, and small existing queries retain their shapes/order. Ordinary maximum detail/list responses measured roughly 3.84–3.85 MB. The 8192-byte envelope reserve covers the RPC id, page/result keys and bounded cursor.

Integration gates, all exit 0:

- `npm run build`: `task5-integrated-build-final.log`.
- `npm run lint`; `npx --no-install tsc --noEmit`: `task5-integrated-lint.log`, `task5-integrated-types.log`.
- `npm run test:mcp:task-reads` (includes imported Ticket/Plan and Run suites plus new aggregate-envelope suite): `task5-integrated-task-reads.log`.
- `npm run test:execution:protocol`: `task5-integrated-protocol.log`; strengthened exact hidden-tool/winner-replay assertions additionally passed in `task5-integrated-hidden-tools.log`.
- `npm run test:execution:configuration`: `task5-integrated-configuration.log`; invalid registry still preserves authenticated planning create/read/claim/save.

Retained integration fixture failures: the first new admission fixture expected HTTP200 instead of the actual HTTP201 (`task5-integrated-envelope-fixture.log`); corrected before the meaningful envelope RED. The strengthened protocol run exposed an old nondeterministic fixture assumption that the first competing claim always wins (`task5-integrated-claim-winner-fixture.log`). Exactly one claim won correctly; the fixture now replays the observed winner and uses its lease ID. No production exclusivity code changed.

Independent integration audit `task5-integrated-audit.log` at `2026-10-05T04:28:21.675058Z`: zero labeled Docker containers/volumes, zero live integration processes, zero owned consumer/planning fixture roots, and zero schema/migration/lock changes from e2b35ef. No broad unchanged native Docker/auth/browser suites were repeated for this integration; exact-head hosted CI remains root-owned. The separately reported review I1 consumer startup defect is handled in fix wave 1 below, not concealed by these integration results.

## Independent review fix wave 1 / I1

Initial review of `aa43b62..e2b35ef` identified one Important defect: immediate restart after execution-authority invalidation replaced a still-exclusive saved lease and then exited on `LEASE_CONFLICT`. The startup path now preserves the saved lease and pending action IDs when its historical permit exists and the lease remains current, disables invalid execution renewal, and uses the existing bounded trusted completion/stop loop. Reconciliation claims occur after expiry; no owner authentication, new start or new physical deadline is acquired.

Actual REDs for both selected-registry drift and grant revocation are retained as `task5-fix1-registry-red.log` and `task5-fix1-revocation-red.log`. `consumer-restart-authority.mjs` SIGKILLs the real CLI only after actual Docker execution starts with a recently renewed lease, invalidates authority, and restarts before expiry. Both GREEN cases retain the saved lease/actions, reach trusted success or cancellation plus physical stop, preserve the permit envelope/deadline, and send exactly one physical start (`task5-fix1-restart-green.log`). The new test is in the privileged CI consumer gate. The fix-wave report contains exact commits, final regression results and audit. Original failed historical branches remain documented above.

Fix source commit: `0ad27f241d3cee113712b3dfe7f64e3ddc2f561c`. The full existing actual CLI lifecycle regression passed (`task5-fix1-consumer-regression.log`), as did lint/typecheck (`task5-fix1-lint.log`, `task5-fix1-types.log`). The Worker source is unchanged from the integrated final build; the Node CLI change is exercised by both new immediate-restart cases and the complete existing consumer lifecycle.

Independent post-test audit at 2026-10-05T04:38:18.755220Z (`test-results/task5-fix1-final-audit.log`): zero labeled Docker containers/volumes, zero live owned test/consumer/supervisor/watchdog/Worker processes, and no owned fixture roots. Schema/migration/lock changes from e2b35ef: none. Approved hashes remain c0dff8ebb445c466cdba0b3b0e11f44a15765d14 and cfd69b5e471e8e294cb6a9fcf77e5b544655d49c. `git diff --check` passed.

Per the root packaging ruling, this complete evidence is permanently retained at `docs/superpowers/reports/2026-10-05-remote-mcp-execution.md`. The formerly force-tracked SDD report is removed only from the Git index; its working copy and the fix-wave report remain ignored and available for review. The implementer does not delete the SDD workspace. Final source HEAD is `0ad27f241d3cee113712b3dfe7f64e3ddc2f561c`; the subsequent packaging commit changes only report placement/content. No implementation concerns remain identified after I1, subject to the root-owned independent re-review and exact-head hosted CI.
