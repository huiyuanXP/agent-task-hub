# Remote controlled execution

Implement GitHub issues #12, #15, #13, #16 and #17, in that order. The user
authorized autonomous decisions, implementation, testing, commits and merges;
each issue is claimed as `remote` before implementation and receives a completion
comment with its logic, abstractions and Function map after merge.

## Intended outcome

An owner can create a revision-bound execution Run, explicitly authorize its
bounded operations, dispatch it to an isolated real execution backend, and use
MCP to claim, renew and report that execution without granting itself broader
permissions. Planning, manual snapshots and actual execution remain distinct.

## Architecture

Keep the Vinext Worker/D1 control plane. Domain services accept an explicit
database interface and owner/actor context; routes and MCP share these services.
Persist execution Runs separately from historical manual `records.kind=run`.
Keep immutable contract and identity columns separate from mutable lifecycle
columns. Use SQL compare-and-swap and unique keys, never read-then-write as the
only concurrency guard. Apply additive ordered migrations; preserve old data.

The execution backend is a real Node process in a hardened Docker container,
managed by a separate loopback-only Node supervisor. This is an actual bounded
execution backend, not a simulated Agent or an invented LLM integration.
The supported integration topology is a local loopback Worker and supervisor.
A hosted Worker cannot reach the supervisor through its own loopback address;
production hosting requires the separately provisioned private binding in #5.
Backend operations are registered by the administrator, identified by stable
operation IDs and fixed argv. Clients cannot supply shell, container arguments,
host paths or credentials. The Worker-to-supervisor transport is authenticated
and bound to an immutable Run and authorization; no untrusted URL parameter.
The consumer protocol is documented and usable from an actual CLI worker.
Backend evidence uses a dedicated ECDSA signing key and a verifier pinned by
server configuration. Receipts bind owner, Run, revision, attempt, authorization,
contract hash, result, artifact evidence and time; transport authentication uses
separate signing material. Missing verifier configuration refuses success.

## Existing boundaries

Use the current trusted Sites ingress and owner identity. Standalone public
identity (#3) and public deployment (#5) remain separate existing release gates;
these changes never enable a public host or change the production Site.
Local synthetic identities and newly created test data are permitted solely for
isolated loopback integration tests. No production records or credentials.
Unconfigured execution rejects requests explicitly and never marks a Run done.

## Required behavior

### #12 — Run model

Freeze Ticket body/revision, actor, authorization reference, stable request ID
and positive attempt. Reject stale revisions and foreign owners. Owner-scoped
request IDs are idempotent only for the same input; different input conflicts.
Concurrent creates produce one Run. A Ticket has at most one active execution
Run. States are queued/running/waiting/succeeded/failed/cancelled; valid edges are
queued→running/waiting/failed/cancelled, running→waiting/succeeded/failed/cancelled,
waiting→queued/running/failed/cancelled. Terminal states are absorbing; success
requires real verifiable evidence. A public UI/API caller cannot assert running
or success. Manual snapshots remain manual and immutable.

### #15 — Authorization

Persist requests, decisions, actors, owner, exact operation scope, hard resource
budget, expiry, Ticket revision and Run binding. Audit all decisions with stable
IDs and immutable entries. Approve/reject/revoke are owner-controlled and
idempotent for identical decision input; opposing/replayed decisions conflict.
The authorization workflow atomically reserves the Run and authorization IDs
and writes the pending request with the exact frozen Run binding. Scope includes
operation ID and an immutable definition digest covering argv, image digest,
input path/hash manifest, artifacts and execution policy. Registry drift rejects
the approved operation rather than silently changing its meaning.
Expiry, revocation or changed Ticket invalidates authorization at dispatch and
renewal; neither records text nor an MCP client can expand scope. UI and MCP use
the same domain decisions. No effective grant is created by planning output.

### #13 — Workspaces

One isolated workspace per authorized Run/attempt, deterministic ownership,
durable metadata and recoverable lifecycle. Network targets and credential
scope are empty for this backend; no credential inheritance. The container has
network=none, read-only root, dropped capabilities, no-new-privileges, non-root
UID, bounded writable workspace/tmpfs, memory, CPUs, pids and wall time.
Input import rejects traversal, links, special files and sensitive paths. Never
mount the host source, Docker socket or other Run data. Retain bounded evidence
and logs separately from cleanup; cleanup is idempotent and scoped to owned
resources. Validate with actual containers and malicious filesystem/network
operations, plus interruption/recovery and repeated cleanup.
Suppress Docker-injected proxy defaults explicitly and inspect effective
environment without logging its values. Disable the daemon log driver and bound
supervisor streams. A detached owned watchdog, armed before process start,
enforces the persisted wall deadline even if the supervisor is killed.

### #16 — Real backend

Define administrator operation registry, authenticated dispatch protocol,
startup, health and shutdown. Enforce grant, Run and actual adapter limits;
tie persisted backend process/container identity to the Run. Execute a real
registered Node operation, capture bounded stdout/stderr, exit status and
declared safe artifact hashes, and persist trusted evidence. Handle denied
operations, enlarged scope, start failure and timeout without success claims.
Dispatch retries never start a second process. Verify the actual local
supervisor+Docker execution with a synthetic contract and rollback/cleanup.
An atomic D1 dispatch permit is the start authorization linearization. Revoking
a grant prevents new permits and renewals and requests cancellation of already
permitted work. The supervisor checks authenticated control-plane checkpoints;
hard deadlines still hold during disconnection. Record requested versus actual
cancellation truthfully; do not promise instantaneous remote revocation.

### #17 — MCP consumer protocol

Distinct query/claim/start/renew/report/complete capabilities. Lease token binds
owner, Ticket revision, Run, worker and generation; atomically prevent competing
claims. Retries are idempotent and expired/stale/revoked/foreign tokens fail.
Progress and completion never change grants; only trusted backend evidence can
produce succeeded. Bound evidence sizes and validate it server-side. Supply
complete protocol tests and a working consumer CLI with connection, claim,
renewal, progress, completion and shutdown handling.

## Cross-service decisions

- Authorization is an owner decision, not a capability conveyed by a worker
  lease. Worker names are labels; possession of an unexpired generation-bound
  lease permits only its documented execution actions, never grant decisions.
  Domain methods snapshot caller inputs before asynchronous work.
- Supply an actual server catalog during authorization, rather than asking
  users to invent operation hashes. The initial backend supports one registered
  operation per Run: a fixed Node command that reads the frozen Ticket input,
  validates it and writes a declared JSON artifact. Define its real argv and
  pinned image now, in a shared Worker-safe descriptor module. Its definition
  hash covers fixed argv, image, exact input path/hash manifest, artifact paths
  and policy. The supervisor later consumes this same descriptor; client
  commands and arbitrary operation hashes are never authority. Registry
  extensibility must preserve exact descriptor validation and bounded policy.
  Task4 extends this to at most32 mirrored administrator definitions through
  one shared strict normalizer/builder, still selecting one operation per Run.
  Optional configuration absence uses the built-in; invalid explicit settings
  fail. Deep-snapshot nested definitions before awaits. Unrelated catalog
  additions/reordering do not stale a selected grant; selected changes/removal
  invalidate new starts without erasing historical permitted descriptors.
  Exact static input manifests map to separate supervisor-private source roots;
  mandatory frozen Ticket plus static files share the input ceiling. Public
  configuration/grants/receipts never contain host source roots. Hash the actual
  copied bytes, fixed argv/image/layout/policy and canonical selected descriptor.
- Grants have a latest-start expiry. A dispatch permit persists an execution
  deadline no later than that expiry or start plus approved timeout. Lease
  expiry controls caller credentials, independently of the persisted execution
  deadline. Never extend a started permit's deadline during recovery. A genuine
  signed historical result ending before its deadline can be reconciled by a
  fresh authorized lease/owner; an expired lease cannot write it.
- Backend identity is deterministic for owner/Run/attempt, independent of
  request retries and lease generations. Persist journal transitions and exact
  envelope before create/start, using atomic fsynced writes and a single-instance
  lock. Recover every crash boundary without repeating an uncertain started
  execution. Retain terminal receipts/tombstones after workspace cleanup.
- Result transport is asynchronous: start returns a durable identity, result
  is polled, and leases renew concurrently. Persist consumer request IDs before
  network writes so response loss does not mint a different execution. Shutdown
  requests cancellation and waits for confirmed stop or the hard deadline.
  Owner-scoped reads also expose actual bounded retained stdout/stderr and
  declared artifact bytes, checking hashes/lengths against the trusted receipt.
  Exact declared artifact identities replace arbitrary filesystem paths.
  Retained content survives workspace cleanup and supervisor restart; missing
  verified content is explicitly unavailable. Metadata polls remain bounded and
  lightweight, with separate content reads/downloads where appropriate.
- Use container cwd `/job`, read-only input volume `/job/input` and a dedicated
  writable 64 MiB work tmpfs `/job/output`. This preserves the catalog's fixed
  relative argv paths. Auxiliary `/tmp` and `/dev/shm` are separately bounded.
  Keep the container alive and start actual operations through Docker exec;
  obtain the exit code from the daemon's exec identity rather than guest prose.
  Freeze all container processes before collecting artifacts while tmpfs is
  alive. Docker 28.4 archives omit live tmpfs contents; capture instead uses a
  trusted local Linux host adapter with the same kernel and compatible `/proc`
  visibility. Unsupported topology fails before registered operation execution;
  the trusted inert keeper may start to establish its process identity. Pin the process
  directory `/proc/<State.Pid>` first; all subsequent process metadata, namespace
  and root access goes through that FD, never a reopened numeric PID path. Before
  reading artifact bytes, verify exact owned container ID/labels, Running+Paused
  state, full container-ID cgroup membership, stable process starttime and mount
  namespace, and the pinned output mount's tmpfs type and mount ID. Scan the
  entire `/job/output` mount through pinned directory/file handles and no-follow
  child traversal, rejecting symlinks, special files, regular files whose link
  count is not one, nested mounts, path escape and excessive entries/logical
  bytes/time. Accept declared regular artifacts only after the whole scan
  succeeds, including undeclared hard-link aliases. Normalize the exact
  `output/` artifact prefix. Hash exactly the retained bytes; no generic
  extraction or unpaused validation/copy race. The watchdog stays armed through
  capture and cleanup, and pinned handles never follow PID reuse or foreign
  containers during removal races. Actual Docker tests must establish complete
  capture and adversarial rejection; otherwise capture fails closed.
- Transport and evidence have different keys and explicit version/purpose,
  audience and key IDs. Canonical JSON and P-256 raw 64-byte signatures must
  interoperate between Node and Worker. Preserve the evidence key and key ID
  outside guest access across restarts. Evidence binds the durable dispatch
  permit and exact operation definition as well as the Run contract. Configured
  public verifier keys, never caller keys, determine trust.
  Use directional Worker and supervisor transport keypairs, plus the separate
  evidence keypair. Signed requests/replies bind fresh nonce, method/path, exact
  body/status, audience and short expiry. Checkpoints use a narrow signed internal
  route with authority derived from the persisted permit, never raw Sites owner
  headers or owner decision capability. Fixed configured URLs reject redirects;
  fresh verified authorization gates start and bounded checkpoint outage cancels
  running work without changing its hard deadline.
- Cancellation intent and physically confirmed container stop are distinct.
  Revocation prevents new dispatch permits/renewals, requests bounded in-flight
  cancellation, and cannot retroactively turn an absorbing cancelled Run into
  success. Backend results remain available for truthful reconciliation.
  Persist owner cancel/revoke's permit cancellation intent atomically with its
  SQL lifecycle/audit mutation. Supervisor fsyncs an owner/Run/attempt fence under
  the same admission lock before acknowledgement and rejects every late start.
  Fence alone does not confirm already-admitted work stopped; release the
  physical reservation only on verified durable closure plus actual stop or
  never-admitted proof covering all create/start uncertainty.
  Preserve success-only Run evidence SQL and add immutable bounded v2 result,
  fence and stop attestations. Dispatched success requires v2 exact permit and
  operation binding; reject v1 downgrade. Reconcile actual result-before-running
  acknowledgement through legal edges atomically. Retain non-success/history
  without reviving terminal Runs. Unknown start/exit/artifacts remain explicitly
  absent; success capture must meet the unchanged deadline, while later timeout
  or cleanup proofs do not imply new execution authority.
- Create an inert deterministic container, persist its concrete ID, acknowledge
  an independent watchdog armed for that ID, then start that same object.
  Never start by creating a replacement after watchdog cleanup. One unchanged
  total-container deadline covers execution, artifact collection and cleanup;
  a monotonic timer is also capped by approved duration. Keep cleanup armed until
  removal is confirmed. Near-deadline evidence loss yields failure/unavailable
  evidence; it never disarms cleanup or extends executable authority. Confirm
  paused-container force removal without resuming guest processes.
  An unresolved Docker create request may materialize a stopped object after a
  transport timeout. A single absent lookup does not confirm cleanup in that
  state; retain pending recovery until concrete identity or definite rejection
  is established. An acknowledged independent cleanup guardian is armed before
  the first Docker resource-create mutation and retains eventual cleanup after
  parent loss during setup. Bound its concurrency and polling; reclaim owned
  late objects without starting them. The expired deadline never authorizes a
  later start. Cleanup recovery never grants execution authority.
- A separate durable owner/Ticket physical execution reservation survives a
  logically terminal Run and uncertain starts. New permits remain blocked until
  trusted stop confirmation or reconciliation proves no process was started.
  A client timeout alone cannot release this reservation.

## Quality and verification

Node >=22.13.0, preserve application lockfile. Use native node:test and real
SQLite/D1 for storage tests; Docker for isolation/backend integration. Tests
must demonstrate RED before implementation, then GREEN. Run lint, typecheck,
build, complete execution tests and the applicable API/browser regressions.
Fresh database per run; loopback listeners; no shared development database.
Browser regression tooling may select a trusted absolute local Chromium through
`TEST_CHROMIUM_EXECUTABLE` when its locked browser download is blocked; validate
the prerequisite before framework allocation and preserve every proxy/origin
restriction. Default CI uses the locked Playwright browser. This is test-only
configuration, never a guest or product payload capability.
Retain every proxy-blocked origin and separately record page/context requests:
the UI's strict expected external-request check applies to application traffic,
while browser background traffic remains blocked and visible. Verify actual
forbidden page requests are recorded and cannot contact forbidden servers.
Observe worker sockets through a bounded public-CDP adapter: fixed harness-only
ephemeral loopback listener, same-port endpoint validation without redirects,
network observation before worker resume, recursive owned-context attribution,
and explicit failure/cleanup. The diagnostic port is not a browser-allowed
origin. No private browser-library internals, arbitrary caller launch flags or
application-provided claims substitute for network observation.
Verify the diagnostic listener's actual IPv4/IPv6 binding through Linux proc
network tables filtered to its generated port; endpoint advertising alone is
insufficient. Fail on wildcard/non-loopback listeners or unavailable verification.
This browser harness supports Linux with readable proc tables, matching the
execution backend and CI. Keep this verifier a focused replaceable component.
Each issue is independently reviewed and merged before claiming the next.
No placeholders, unfinished branches or new Tickets standing in for acceptance.
