# Durable execution Runs

Execution Runs live in `execution_runs`, separately from immutable historical
`records.kind=run` manual snapshots. Reading historical runs through the records
API always returns `source: "manual"`, including old bodies with a misleading
source field. Execution Runs always return `source: "execution"`. Creating a Run
freezes data; it never dispatches a process or creates an authorization grant.
An authorization ID here is an immutable reference, not proof of approval.

The control plane consumes the verified request identity described in
[AUTHENTICATION.md](AUTHENTICATION.md). Built Workers default to Cloudflare Access
and explicit private membership. Account access does not grant an execution
approval or backend capability. Existing standalone execution fixtures explicitly
use trusted synthetic Sites compatibility on loopback with fresh D1 state; the
authentication suites separately verify real JWT identity on the built Worker.

## HTTP contract

All responses disable caching. Writes require an exact same-origin `Origin`,
JSON media type, and at most 16,384 UTF-8 body bytes, even without Content-Length.
Unknown fields, invalid types and duplicate query keys are rejected. The server
derives both owner and actor from authenticated identity; callers cannot set them.

- `GET /api/execution?id=<id>` reads one owned Run.
- `GET /api/execution?ticketId=<id>&state=queued&limit=50` lists owned Runs.
  Each filter is optional. The default limit is 50 and the maximum is 100;
  results sort by creation timestamp and ID, descending.
- `POST /api/execution` with
  `{"action":"create","ticketId":"...","expectedRevision":1,"requestId":"...","authorizationId":"...","attempt":1}`
  creates or returns the same queued Run (201). Attempts and revisions must be
  positive safe integers. Request IDs use 1–128 ASCII letters, digits, `.`, `_`,
  `:`, or `-`; Ticket and authorization IDs have a 200-character bound.
- `POST /api/execution` with
  `{"action":"cancel","id":"...","expectedVersion":1}` cancels an owned
  active Run. A stale version or terminal Run returns 409.

No public action can assert running, waiting, failure, or success, nor submit
backend evidence. Invalid input is 400; anonymous requests are 401; origin
failures are 403; foreign/missing records are 404; conflicts are 409; oversized
requests are 413; wrong media types are 415; unavailable storage is 503.

## Domain and storage contract

The `.mts` modules are typed TypeScript shared by native Node tests and the
Worker build. They import no `cloudflare:workers`; callers inject a structural
D1-compatible `ExecutionDatabase` and trusted `RunContext`.

`createRun` atomically copies the owned Ticket's raw body and revision in an
`INSERT … SELECT` statement. Owner/request uniqueness gives identical retries
one stable ID; changing the Ticket, revision, authorization, attempt, or original
actor under that request ID conflicts. Retrying the same input still returns the
original Run after the Ticket changes or the Run terminates. A partial unique
index permits at most one active Run per owner/Ticket, including racing requests.
A new request can create a later attempt after termination.

Stored raw Ticket JSON is bounded at 80,000 Unicode code points, consistently
with SQLite `length(text)` and the service diagnostic fallback. Supplementary
Unicode characters count as one code point. HTTP request bodies remain bounded
at 16,384 UTF-8 bytes.

Immutable identity/contract columns and mutable lifecycle columns are separate.
SQL triggers block identity/contract updates and deletion. Lifecycle writes use
owner/state/version compare-and-swap, increment version, and record the actor.
Service inputs and signed receipt fields are copied before asynchronous database
or crypto work, so caller mutation cannot change the verified durable result.
SQL also enforces the graph and terminal absorption:

| State | Allowed destinations |
| --- | --- |
| queued | running, waiting, failed, cancelled |
| running | waiting, succeeded, failed, cancelled |
| waiting | queued, running, failed, cancelled |
| succeeded, failed, cancelled | none |

Apply every committed `drizzle/*.sql` migration in filename order exactly once
to fresh isolated D1 state for validation, including authorization and auth
revocation tables added after the execution Run migration. Never reapply raw
SQL to an existing schema. The Drizzle schema, journal and generated snapshots
track these tables and constraints.
Triggers are retained explicitly in the ordered SQL migration. No existing
records, jobs or subscriptions are rewritten.

## Signed backend receipt

`transitionRun` accepts success only with `RunContext.evidenceTrust`, supplied by
trusted backend code, containing a pinned public P-256 ECDSA `CryptoKey` and
its `keyId`. Missing configuration rejects success. This is separate from
transport authentication, and HTTP never accepts a key or evidence trust.

The exported `ExecutionEvidence` contains `claims` and a lowercase hex
`signature`. `EvidenceClaims` has the following exact fields, in wire order:

```
version: 1
keyId: string
owner: string
runId: string
ticketId: string
ticketRevision: positive safe integer
attempt: positive safe integer
authorizationId: string
contractSha256: lowercase SHA-256 of UTF-8 frozen raw ticketBody
status: "succeeded"
backendId: string
exitCode: 0
artifacts: [{ path: relative safe path, sha256: lowercase SHA-256, bytes: nonnegative safe integer }]
stdoutSha256: lowercase SHA-256
stderrSha256: lowercase SHA-256
startedAt: UTC ISO timestamp
endedAt: UTC ISO timestamp
```

Use `receiptSigningPayload(claims)` for UTF-8 JSON serialization in the listed
order; artifact fields serialize as `path`, `sha256`, `bytes`. Sign using WebCrypto
`{name: "ECDSA", hash: "SHA-256"}` with a dedicated P-256 private key. The
signature is raw 64-byte `r || s`, represented by 128 lowercase hex characters,
not DER. `verifyRunEvidence` checks the schema, signature, key ID and exact
owner/Run/Ticket/revision/attempt/authorization/contract binding. Start must be no
earlier than Run creation, end must follow start, and end cannot be more than
60 seconds in the future. Evidence is bounded at 16,000 serialized characters;
there can be at most 32 artifacts with safe relative paths of at most 256
characters. stdout/stderr and artifacts are content hashes, not arbitrary logs.

A backend holding the dedicated signing key attests actual exit/output evidence.
Signing does not substitute for collecting those outputs; never issue receipts
from UI, planning text, or consumer self-report. The cryptographic verifier is
implemented now; unconfigured Run creation/cancellation cannot imply execution.

## Function map

| Function | Responsibility |
| --- | --- |
| `createRun(db, context, input): Promise<Run>` | Validate exact input, freeze owned revision atomically, enforce idempotency and active uniqueness |
| `getRun(db, owner, id): Promise<Run>` | Owner-scoped lookup with indistinguishable absent/foreign errors |
| `listRuns(db, owner, filters = {}): Promise<Run[]>` | Bounded owner-scoped state/Ticket listing |
| `transitionRun(db, context, input): Promise<Run>` | Enforce state graph, backend success evidence, atomic version update |
| `isExecutionEvidence(value): value is LegacyExecutionEvidence` | Validate the exact bounded legacy v1 receipt shape |
| `receiptSigningPayload(claims): Uint8Array` | Produce the versioned canonical bytes for backend signing |
| `sha256(value): Promise<string>` | Hash the exact UTF-8 frozen contract |
| `verifyRunEvidence(run, evidence, trust?): Promise<boolean>` | Validate key, claims, binding, time and real ECDSA signature |
| `handleExecutionRequest(db, context, request): Promise<Response>` | Authenticate supplied context, enforce HTTP boundary, expose create/read/cancel and map errors |
| `ExecutionError(code, message, status)` | Typed expected domain/HTTP errors |
| `exactObject`, `boundedId`, `positiveInteger`, `invalid` | Shared strict input guards and typed validation failure |
| route `GET` / `POST` | Obtain verified request identity and D1, delegate with server-derived owner/actor |

## Verification

Node >=22.13 is required. Preserve the existing lockfile and install with
`npm run install:ci`. Run `npm run test:execution`, `npm run lint`,
`npx --no-install tsc --noEmit`, and `npm run build`, then
`npm run test:execution:api`.

The storage tests use real native SQLite and separate database connections.
The HTTP tests exercise the handler against those databases. The API command
loads the actual built ES modules in Miniflare's native workerd runtime, applies
all migrations to isolated temporary D1, and sends HTTP requests to a dynamically assigned loopback
port. These fixtures explicitly enable synthetic Sites compatibility. It verifies authentication, owner scoping, revision/idempotency,
initial identical and distinct-request creation races, concurrent retries,
schema/media/body limits, cancellation, next attempts, legacy
immutability and manual display. The runtime and its database are removed after
validation. Rebuild first so the API command tests current code, then keep
that artifact stable while the suite runs. This harness intentionally bypasses Wrangler's development proxy,
which was observed to emit a restart 503 between rejected large requests;
the same workerd application returns the required 413 directly.

Task 1 acceptance evidence: the initial storage run produced 48 expected failures
with an importable throwing skeleton; the separate HTTP boundary run produced
six expected failures. The final native suite covers 59 behaviors, including a
supplementary-Unicode storage boundary case and all 36 state edges, real ECDSA
verification, two SQLite connections, contract/schema
limits, immutable SQL guards and caller mutation across asynchronous boundaries.
The isolated built Worker/D1 API suite passed the scenarios listed above; lint,
TypeScript, build and migration regeneration also passed. Signed test receipts
use explicitly synthetic backend identities; these tests establish verification
of trusted receipts, not an assertion that model creation executed a process.

Build output includes informational tooling messages: Wrangler detects the
required session proxy, and Vinext reports that static analysis cannot classify
some dynamic routes. The build succeeds; lint and TypeScript report no application
diagnostics. Proxy settings and locked dependencies are preserved.

## Owner authorization (#15)

The dedicated **执行授权** panel on the Ticket board selects the actual
owner-scoped server catalog for a specific Ticket revision. Planning fields such
as `allowedActions` and free-text `budget` remain prose. They never create grants.
The panel requests a separate pending authorization, then offers explicit owner
approval, rejection and revocation. It shows the same effective status and audit
entries returned by MCP. Preparing or approving never starts a process.

The default catalog contains `ticket.validate.v1`; optional administrator configuration
can supply up to 32 registered definitions, with one selected operation per Run.
`lib/execution/catalog.mts` is shared Worker-safe code that produces the actual
fixed Node argv consumed by the supervisor. The pinned image is
`node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`.
The command reads `input/ticket.json`, verifies its exact UTF-8 byte length and
SHA-256, requires an object JSON Ticket and writes the declared bounded
`output/result.json`. The artifact includes the verified input hash and a
bounded title. Its definition hash covers operation identity/label, actual argv,
image digest, exact input path/hash/size, declared artifact paths/limits and the
execution policy. Approval never accepts client argv, image, policy or a hash
invented by a client. Registry drift changes the catalog hash and invalidates
an old grant without changing its stored descriptor.

The policy has no network and no credentials. Ceilings are timeout 30,000 ms,
memory 256 MiB, CPU 1, pids 64, total input 16 MiB and writable work tmpfs 64 MiB.
The existing Ticket storage bound remains 80,000 Unicode code points.
`{timeoutMs,memoryMb,cpus,pids}` must contain only finite positive numbers within
the ceilings; all except CPU are safe integers. An approved budget may be
reduced by a consumer, never enlarged. Exactly one operation binding
`{operationId,definitionHash}` is supported per Run; approval cannot alter it.

`prepareExecution` (also exported as `requestAuthorization`) generates both
identities and writes the frozen queued Run plus pending grant in one real D1
batch transaction. The conditional Run insert checks the owned Ticket's exact
revision and raw body and active uniqueness. The grant insert selects that
newly inserted Run; a grant/audit failure rolls back the whole batch. A failed
request leaves no new Run or grant. Identical owner/request retries return the
original pair even after Ticket changes; changes to revision, operation binding,
budget, expiry, attempt or original actor return `REQUEST_CONFLICT`. JSON field
ordering is normalized before identity is calculated. Owner/request collisions
with older model-only Runs also conflict, never attach a grant to that Run.

`execution_authorizations` retains immutable Run/Ticket binding, scope,
budget, descriptor and expiry. SQL CAS controls pending→approved/rejected/revoked
and approved→revoked. A trigger appends the decision audit in the same transaction
as each request/decision, with stable decision ID, actor, owner, kind, grant,
Run, time and normalized scope/budget. Audit update/delete and grant contract
mutation/deletion are blocked by SQL triggers. Owner-wide unique decision IDs
are idempotent for identical authorization/outcome/actor input. Opposing outcomes,
changed actors, reused IDs on another grant and new IDs attempting a repeated
state transition conflict. Audit failure leaves the decision unapplied.

`AuthorizationContext.grantAuthority = "owner"` is a server-only capability,
derived by authenticated owner HTTP/MCP adapters. A worker name or future lease
never supplies it. Approve/reject/revoke require this capability. Context clock
and administrator registry injection are trusted service inputs unavailable in
request schemas. Domain methods copy caller inputs before asynchronous work.

Effective statuses are `pending`, `approved`, `rejected`, `revoked`, `expired`,
`stale_revision` and `stale_definition`. For pending/approved grants, missing or
changed Ticket revision takes precedence, followed by expiry and definition
drift; rejected/revoked decisions remain visible as recorded. Expiry is
exclusive: `now >= expiresAt` denies starts/renewals. New requests choose a
latest-start time within 24 hours. Dispatch persists an execution
hard deadline no later than grant expiry or start plus approved timeout.
Lease expiry is a separate credential boundary. Live `assertAuthorization`
checks owner, exact Run/scope, reduced budget and nonterminal Run, and denies all
ineffective grants. Its returned snapshot is a preflight check; dispatch also applies atomic SQL guards at its permit boundary.

Historical signed results that actually ended before the persisted execution
deadline can later be reconciled by a fresh authorized owner/lease. They are
checked against that original permit and deadline, never treated as a new start
or rejected solely because delivery occurs after latest-start expiry. Expired
leases cannot write results. Revocation prevents new permits/renewals and
atomically records cancellation intent for already permitted work. It does not prove instantaneous physical cancellation.

An unusable pending/approved/rejected/revoked grant can leave its queued Run
occupying the active Ticket slot. The panel exposes the existing version-CAS
**取消 Run，允许重新申请** action, preserving the immutable old grant/audit and
freeing the logical slot for a fresh revision-bound request. A terminal Run
cannot exercise its recorded grant. Cancelling a queued model starts no process;
physical execution cancellation requires a distinct signed backend stop confirmation.
The panel persists preparation and decision request IDs in session storage before
writes, so response loss and reloads retain retry identity. **重新设置申请**
discards an unsent/failed local request after checking the server state; it cannot
modify an existing grant. Local request copies are not authority.

### Authorization HTTP and MCP

`GET /api/authorization?ticketId=<id>&expectedRevision=<revision>` returns the
owned catalog, real descriptor hashes and ceilings. `GET /api/authorization?id=<id>`
returns `{authorization}` with immutable contract, effective status and audit.
Duplicate/unknown query fields and ambiguous query combinations fail validation.
All responses disable caching; POST uses the shared strict bounded JSON reader
and requires the exact same Origin.

POST actions are:

- `prepare`: `{action,ticketId,expectedRevision,requestId,attempt,scope,budget,expiresAt}`;
  returns `{run,authorization}` with status 201.
- `decide`: `{action,authorizationId,decisionId,outcome:"approved"|"rejected"}`;
  returns `{authorization}`.
- `revoke`: `{action,authorizationId,decisionId}`; returns `{authorization}`.

MCP tools `get_operation_catalog`, `prepare_execution`, `get_authorization`,
`decide_authorization` and `revoke_authorization` call the same domain functions
through a focused dispatcher. Published JSON schemas and runtime validators reject
unknown/missing fields, malformed JSON values and invented grant authority.
Domain errors retain their code/status in JSON-RPC error data. Browser MCP calls
with an Origin must match the endpoint origin; programmatic MCP callers can omit
Origin. Existing planning tools/events remain intact.

| Function | Responsibility |
| --- | --- |
| `operationDescriptor(body, definition)` | Derive actual argv, manifest, artifacts, bounded policy and exact definition hash |
| `getOperationCatalog(db, context, input)` | Owner/revision-scoped real catalog; never grants execution |
| `snapshotContext(context)` | Freeze trusted owner/actor, clock and administrator registry |
| `validateBudget`, `validateScope`, `validatePrepare`, `snapshotPrepare` | Runtime shape/limit checks and canonical input snapshots |
| `prepareExecution` / `requestAuthorization` | Atomically reserve Run plus pending grant and request audit, with payload-sensitive retries |
| `decideAuthorization(db, context, input)` | Owner-only approve/reject using state CAS and atomic immutable audit |
| `revokeAuthorization(db, context, input)` | Owner-only revocation with stable decision identity |
| `getAuthorization(db, context, id)` | Owned grant, effective status and immutable decisions |
| `assertAuthorization(db, context, input)` | Single live grant preflight for future dispatch/lease consumers |
| `handleAuthorizationRequest` | Strict shared HTTP read/catalog/prepare/decision/revoke boundary |
| `dispatchExecutionTool` | Shared MCP execution-tool dispatcher, leaving planning behavior intact |
| `AuthorizationPanel` | Catalog selection, explicit owner decisions, status/audit, reload-safe retries and logical Run cancellation |

Migration `0003_minor_gorgon.sql` is additive; Drizzle schema/journal/snapshot
are coherent. Native SQLite batch adaptation runs synchronously inside its
transaction so overlapping async callers cannot interleave nested transactions.

Task 2 acceptance uses real native SQLite for request/decision races across two
connections, Run+grant/audit rollback, immutable storage, exclusive expiry,
registry/revision invalidation, scope/budget enforcement and caller snapshots.
The real catalog argv is executed with native Node, verifying the retained JSON
artifact and rejecting changed input. HTTP/MCP tests exercise shared services
against that storage. `node --experimental-strip-types tests/execution/authorization-worker.mjs`
loads the built Worker with fresh D1 and static assets on a dynamically assigned loopback port, checks
concurrent atomic preparation and shared owner decisions, then drives
configured or Playwright-managed Chromium through
pending/approve/revoke/reload/cancel/fresh-request/reject. It blocks all browser
requests outside the loopback origin. The harness awaits `worker.ready` before
HTTP and removes its synthetic database/runtime on completion.

The browser test always runs; missing tooling or a missing Chromium executable
fails with setup instructions before any Worker/D1 state is created. By default
it loads `import("playwright")` and uses Playwright's installed Chromium. To keep
application dependencies and the lockfile unchanged, prefer the separately
locked browser package (`npm ci --prefix tests/browser`) and set
`EXECUTION_PLAYWRIGHT_MODULE=./tests/browser/node_modules/playwright/index.mjs`.
An optional external tooling directory also works:

```bash
execution_tools=$(mktemp -d "${TMPDIR:-/tmp}/execution-browser-tools.XXXXXX")
npm install --prefix "$execution_tools" --package-lock=false --no-save --no-audit --no-fund playwright@1.58.2
PLAYWRIGHT_BROWSERS_PATH="$execution_tools/browsers" "$execution_tools/node_modules/.bin/playwright" install chromium
EXECUTION_PLAYWRIGHT_MODULE="$execution_tools/node_modules/playwright/index.mjs" \
PLAYWRIGHT_BROWSERS_PATH="$execution_tools/browsers" \
node --experimental-strip-types tests/execution/authorization-worker.mjs
```

Run `npm run build` first and do not rebuild while the suite runs. Alternatively set
`EXECUTION_CHROMIUM_PATH` to an installed system Chromium executable; then the
Playwright browser download is unnecessary. `EXECUTION_PLAYWRIGHT_MODULE` accepts
an explicit module file path/URL or an importable package specifier. Set optional
`EXECUTION_BROWSER_SCREENSHOT` to a desired PNG path in an existing owned output
directory to retain a screenshot; otherwise the test writes no screenshot.
Browser/module/output paths have no dependency on the session workspace layout.
Remove the tooling directory when finished; the harness automatically removes
its own fresh runtime/database on both success and failure.

## Dispatch, physical reservation and actual results (#16)

The configured execution panel displays actual supervisor health, starts only
approved Runs, polls their durable result and downloads verified retained bytes.
401/403 clears private Run/grant/connection/result state through the existing
session generation boundary; stale async responses cannot repopulate a new
account. A503 remains a distinct temporary/unconfigured condition.

- `GET /api/execution/dispatch` reads authenticated actual backend health.
- `POST /api/execution/dispatch` with `{action:"start",runId}` atomically reserves
  the permit and returns202 with stable backend identity; it does not claim success.
- `GET /api/execution/dispatch?runId=<id>` polls bounded metadata and reconciles
  trusted result/fence/stop receipts into D1. If the selected Run has no permit,
  polling also reconciles the single owned terminal Run that still physically
  reserves its Ticket. Start performs the same recovery before its atomic permit
  check. This works after preparing a successor and reloading the UI; only a
  verified stop receipt releases the predecessor reservation.
- `POST` with `{action:"cancel",runId}` persists logical cancellation plus outbox
  intent, then sends the durable remote fence. A transport failure does not undo
  the successful cancellation intent or release the physical reservation.
- `POST` with `{action:"content",runId,kind:"stdout"|"stderr"}` or
  `{action:"content",runId,kind:"artifact",path:"output/declared-name"}` returns
  owner-scoped verified bytes. Missing or untrusted retained bytes are unavailable;
  arbitrary filesystem paths are never selectors.

Migration0005 adds `execution_permits` and `backend_attestations`, immutable
history triggers and cancellation outbox triggers. The permit's insert-select
linearizes current approved grant, owned current Ticket revision/body, frozen Run,
selected descriptor and resource budget. Its partial unique owner/Ticket index
keeps the physical reservation while `closed_at` is null, including after logical
terminal states. Deadline is fixed at the earlier of approval expiry and issuance
plus approved total timeout. Revocation/cancellation atomically marks cancellation
intent in the same SQL mutation/audit transaction.

`Run.evidence` remains success-only and <=16000 characters. Dispatched Runs reject
v1 downgrade. The separate immutable bounded v2 table retains all actual outcomes,
fence acknowledgements and stop proofs. Receipt verification uses the persisted
permit and configured evidence key, independent of current catalog/grant or
transport age. Success arriving before a running acknowledgement takes legal
queued/waiting→running→succeeded edges in one guarded D1 transaction. Terminal
Runs stay absorbing while late history and actual cleanup proofs remain retainable.
Only a verified bound `stop` attestation closes the physical reservation. Physical
cancellation intent remains available for already succeeded, failed or cancelled
Runs without rewriting their terminal state or evidence. The UI retains a committed
logical cancellation even if subsequent transport reconciliation returns503;
physical stop stays unconfirmed until a verified stop receipt arrives.

| Function | Responsibility |
| --- | --- |
| `normalizeRegistry`, `normalizeDefinition`, `validateResourceBudget` | Shared strict administrator normalization, deep snapshots and enforceable CPU precision |
| `selectedDescriptors` | Resolve exactly one approved definition without staling on unrelated registry changes |
| `createDispatchPermit`, `permitForRun` | Atomic start authority, stable retry binding and physical Ticket reservation |
| `requestPermitCancellation` | Persist physical stop intent for any owned Run, including absorbing terminal history |
| `checkpointPermit` | Limited persisted permit/current revocation/revision/deadline checkpoint |
| `canonical`, `signRequest`, `verifyRequest`, `signReply`, `verifyReply`, `signedFetch` | Worker/Node interoperable direction/nonce/body/status-bound transport |
| `ReplayWindow` | Bounded live nonce protection without unsafe eviction |
| `backendConfiguration`, `importSigning`, `importTrust` | Server-only keys/audiences/URLs and distinct signing material |
| `verifyAttestation`, `ingestAttestation` | Historical v2 trust, immutable receipt insertion, legal lifecycle and verified physical closure in one batch |
| `handleCheckpoint` | Independent signed service boundary before D1 lookup, no owner permission |
| `handleBackendRequest`, `reconcileBackend`, `reconcileTicketReservation` | Owner start/poll/cancel/content gateway, bounded predecessor reservation recovery and durable cancellation delivery |
| `AuthorizationPanel` | Selected operation, separate approve/start, truthful connection/result state, verified downloads and session-safe polling |

See [RUNNER.md](RUNNER.md) for provisioning, administrator registration, runtime
limits, restart behavior and the real Worker/Docker/browser acceptance command.

Optional execution registry configuration is resolved only after matching an
execution MCP tool. Malformed JSON or an invalid explicit registry produces
`CONFIGURATION_UNAVAILABLE` with status503 for that execution call; authenticated
planning create/read/claim/save tools remain independent. Verify the actual built
Worker boundary with `npm run test:execution:configuration`.
