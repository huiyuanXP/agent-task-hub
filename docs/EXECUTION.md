# Durable execution Runs

Execution Runs live in `execution_runs`, separately from immutable historical
`records.kind=run` manual snapshots. Reading historical runs through the records
API always returns `source: "manual"`, including old bodies with a misleading
source field. Execution Runs always return `source: "execution"`. Creating a Run
freezes data; it never dispatches a process or creates an authorization grant.
An authorization ID here is an immutable reference, not proof of approval.

The control plane uses the existing trusted Sites identity. Do not expose its
identity-header API directly on an independent public host. Local integration
uses synthetic identities only on loopback with fresh database state.

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

Apply ordered additive migrations to a fresh database for validation:
`0000_lethal_shadow_king.sql`, `0001_keen_eddie_brock.sql`,
`0002_execution_runs.sql`. The Drizzle schema, journal and generated snapshot
track the new table and constraints; regenerating migrations reports no changes.
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
| `isExecutionEvidence(value): value is ExecutionEvidence` | Validate exact bounded receipt shape |
| `receiptSigningPayload(claims): Uint8Array` | Produce the versioned canonical bytes for backend signing |
| `sha256(value): Promise<string>` | Hash the exact UTF-8 frozen contract |
| `verifyRunEvidence(run, evidence, trust?): Promise<boolean>` | Validate key, claims, binding, time and real ECDSA signature |
| `handleExecutionRequest(db, context, request): Promise<Response>` | Authenticate supplied context, enforce HTTP boundary, expose create/read/cancel and map errors |
| `ExecutionError(code, message, status)` | Typed expected domain/HTTP errors |
| `exactObject`, `boundedId`, `positiveInteger`, `invalid` | Shared strict input guards and typed validation failure |
| route `GET` / `POST` | Obtain trusted Sites identity and D1, delegate with server-derived owner/actor |

## Verification

Node >=22.13 is required. Preserve the existing lockfile and install with
`npm run install:ci`. Run `npm run test:execution`, `npm run lint`,
`npx --no-install tsc --noEmit`, and `npm run build`, then
`npm run test:execution:api`.

The storage tests use real native SQLite and separate database connections.
The HTTP tests exercise the handler against those databases. The API command
loads the actual built ES modules in Miniflare's native workerd runtime, applies
all migrations to isolated temporary D1, and sends HTTP requests to loopback
port 5197. It verifies authentication, owner scoping, revision/idempotency,
initial identical and distinct-request creation races, concurrent retries,
schema/media/body limits, cancellation, next attempts, legacy
immutability and manual display. The runtime and its database are removed after
validation. Rebuild first so the API command tests current code. Port 5197 must
be free. This harness intentionally bypasses Wrangler's development proxy,
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
