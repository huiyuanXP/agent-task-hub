# Isolated runner workspaces

This Node-only backend combines the workspace and Docker lifecycle primitives
with a loopback supervisor. The supervisor accepts authenticated durable permits,
executes only administrator-registered Node argv and signs actual result/stop
receipts. The Worker owns approval and physical Ticket reservations.
Worker code must not import `runner/`.

## Supported local environment

Use Linux, Node >=22.13, `/usr/bin/flock`, a local Docker Unix socket at
`/var/run/docker.sock`, and permission to read the owned container's process root
through host `/proc`. Docker and the supervisor must share compatible kernel/PID
visibility. Remote Docker contexts, hidden cgroup identity, host PID namespaces,
unreadable proc roots and unsupported filesystem layouts fail closed. The tested
service UID1000 matches guest UID1000; unrelated service UIDs need independently
provisioned trusted host proc access. Docker group membership alone is insufficient. No privileged
helper or extra host mount is used to compensate. Docker 28.4.0 is the tested
backend. The client negotiates a supported API between 1.41 and 1.51 using the local
socket; it never reads Docker CLI configuration or endpoint environment variables.

The exact image must already be present; execution does not pull images:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY \
  -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock version
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY \
  -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock pull \
  node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
npm run test:execution
```

Tests require actual Docker, the image, proc access and host `/dev/shm`; missing
prerequisites are failures, never skipped isolation tests. Image pulling uses the
administrator's configured registry/proxy setup. Runtime guests receive none of
that authority. Tests use temporary private state, synthetic input and an isolated
synthetic Docker client config. Never dump a real Docker config or environment.

## Layout and enforced limits

The keeper and registered operation run as UID/GID 1000 with cwd `/job`. The root
is read-only, networking is `none`, all capabilities are dropped and
`no-new-privileges` is enabled. The daemon log driver is `none`, the restart policy
is `no`, and no host path or Docker socket is mounted.

| Resource | Ceiling |
| --- | --- |
| Total container deadline, including capture | 30,000 ms |
| Memory / swap | 256 MiB memory; no additional swap |
| CPU | 1 CPU; reduced budgets must be exact 0.01 increments, minimum 0.01 |
| Processes | 64 |
| Imported read-only `/job/input` volume | 16 MiB actual verified file bytes; 1,024 files |
| Writable `/job/output` tmpfs | 64 MiB |
| Separate `/tmp` and `/dev/shm` | 8 MiB each |
| Retained stdout / stderr | 64 KiB each, with truncation flags |
| Declared retained artifacts | 1 MiB total, at most 32 registered files |
| Complete output scan | 4,096 entries, 32 nested levels, 200-character safe paths |
| State admission per configured root | 8 nonterminal workspaces; 64 retained identities |

Policy may only reduce these ceilings. Network targets and credentials are
intentionally empty. Ten uppercase/lowercase HTTP/HTTPS/FTP/ALL/NO proxy fields
are explicitly empty; effective environment inspection rejects unexpected names
without logging values. Docker API requests never inherit proxy defaults.

Input manifests use exact `input/` prefixes and SHA-256/byte counts. Directory and
file handles are pinned through Linux proc FD paths, each child opened no-follow;
parent renames cannot redirect an already pinned path. Hard links, symlinks,
special files, traversal, non-ASCII/unsupported paths and sensitive components
(such as `.env`, `.ssh`, `.git`, `.aws`, `.docker`, credential files and private-key
extensions) are rejected. Input tar names are bounded to 99 bytes. Input tar is
created only from verified retained bytes and uploaded to a stopped owned importer;
the input volume is then attached read-only to the keeper. The original source is
never mounted.

## Durable lifecycle and cleanup

`createWorkspace(root, { owner, runId, attempt, deadlineMs? }, policy)` reserves a
deterministic identity and immutable policy/deadline. Use one administrator-selected
private root, never a client-provided directory. The root must have mode 0700 and
contain no symlink. An HMAC key protects metadata; atomic file replacement and
file/directory fsync preserve durable transitions. A short root flock serializes admission; individual workspace flocks serialize
state transitions. Source and Docker I/O never hold the global admission lock.
Both independent cleanup processes remove signed, exact-owned concrete container
IDs before acquiring any supervisor state lock, then reconcile metadata. A stalled
lock owner cannot extend execution. Concurrent Docker removal conflicts are retried
within a bounded cleanup budget and only inspected absence confirms removal;
uncertain create obligations remain reserved. Kernel flocks release on death.

`importInputs(workspace, sourceRoot, manifests)` first verifies source bytes and
arms an independent setup guardian. Its identity is persisted and its acknowledgement
received before the first Docker resource creation. Each volume/container create
has a durable intent. The guardian survives supervisor SIGKILL, only removes owned
resources, and never starts or recreates them.

`startWorkspace(workspace)` creates an inert keeper, persists its concrete Docker
ID, arms/acknowledges the separate watchdog for that ID, and starts that same ID.
It verifies live proc/cgroup/namespace/mount access using the inert keeper before
any registered operation can execute. The keeper's process identity is persisted.
Recovery cannot start a replacement or extend the original deadline.

`createExecution(workspace, argv)` persists a daemon exec ID before returning it.
`startExecution(workspace, execId)` records start intent once, captures bounded
multiplexed streams and obtains the real exit code by daemon exec inspection.
Guest status files and stdout markers have no authority. Raw `createExec`,
`startExec` and `inspectExec` primitives in `docker.mjs` are available for the
supervisor journal. Interrupted execution records unavailable status and retains
bounded partial streams where the supervisor survived to persist them. SIGKILL can
lose unpersisted stream bytes; it cannot produce a successful result.

`cleanupWorkspace(workspace)` checks signed identity and exact resource labels,
force-removes owned containers without unpausing, confirms their absence, then
removes the input volume. It is idempotent; forged references and foreign resources
are rejected. A 404 after an unresolved create does **not** prove cleanup complete.
Such records remain `removal_pending`; the detached setup guardian reconciles later
owned objects with bounded polling. The volume stays until pending container creates
resolve, preventing implicit volume recreation. Lost requests that never resolve
retain capacity and a cleanup obligation, rather than permitting a duplicate run.

`recoverWorkspaces(root)` reaps every owned incomplete workspace, rearms missing
setup guardians for uncertainty, removes pre-metadata reservations containing only
validated private interrupted-write temporary files (or no files),
and returns current durable states. It performs cleanup only. A missing exact-ID
watchdog blocks execution/capture; recovery removes that runtime.

Interrupted first-write recovery holds admission serialization, pins the private
reservation directory without following links, confirms metadata is absent, and
validates every entry before deleting any. Only recognized `.tmp-<pid>-<hex>`
regular files with private ownership/mode, one link and bounded size are removable.
Unexpected entries and ownership/type anomalies preserve the reservation and fail
closed. Established-workspace temporary writes remain protected by their own lock.

## Artifact capture

`captureArtifacts(workspace, declarations)` pauses all descendants and scans the
entire dedicated live `/job/output` tmpfs, including undeclared and hidden entries.
The fixed catalog's `output/result.json` maps to `result.json` inside that mount.

Docker 28.4's archive API was tested with live tmpfs files and hard links; both
running and paused requests returned only an empty directory. It is therefore
unsuitable as artifact evidence. Capture uses trusted host file descriptors:

1. Inspect the persisted concrete ID, ownership, running/paused state and isolation.
2. Pin `/proc/<State.Pid>` itself; all subsequent process/root reads use that FD.
3. Verify exact full container-ID cgroup membership, process start ticks, separate
   mount/PID namespaces and the persisted keeper identity.
4. Pin root, `job` and `output`; validate tmpfs type, mountinfo root/mountpoint and
   mount ID. Reinspect identity before reading any artifact bytes.
5. Enumerate through pinned directory FDs with no-follow opens, checking every
   opened descendant's mount ID and device. Reject nested mounts, all links,
   regular files with link count other than one, specials and excessive logical
   bytes/entries/depth/time. Read only declared regular payloads within their caps.
6. Accept hashes of retained bytes only after the whole tree and final identity
   checks pass. Persist evidence separately from the runtime workspace.

Pinned proc directories cannot follow a reused numeric PID. Removal, unsupported
topology or deadline loss aborts capture and closes handles; a still-readable pinned
tmpfs does not extend authority. The watchdog stays armed through pause, scanning
and confirmed removal. Near-deadline missing evidence is a failure. Cleanup never
resumes guest work.

## Retention and ownership boundaries

Runtime removal preserves signed metadata, bounded stream files and validated
artifact evidence in each identity's private state directory. There is no automatic
tombstone eviction: repeated identities cannot silently execute again. At 64 retained
identities (or 8 nonterminal identities), admission refuses further work. An operator
may archive/rotate a quiescent root only while preserving the higher-level durable
replay/reservation journal. Merely deleting state and reusing identities is unsafe.
Each metadata/evidence write is capped at 2 MiB; artifact payloads are capped at
1 MiB before base64 encoding. Interrupted temporary writes are cleaned during
recovery. Keep all state, ownership keys, logs and generated artifacts outside Git.

Trusted local host/Docker administrators remain in the adapter's trust boundary.
These primitives do not authorize arbitrary argv; the supervisor binds its
mirrored registry to the immutable persisted permit and maintains replay fences
through cancellation and uncertain cleanup.

## Controlled supervisor (#16)

Provision three independent P-256 keypairs once, outside the repository. The tool
refuses an existing destination and writes mode-0600 files inside a mode-0700
directory; it prints no private values. Preserve the same files across restarts.

```sh
node --experimental-strip-types scripts/provision-execution.mjs \
  /absolute/new-private-directory http://127.0.0.1:5173 http://127.0.0.1:4210
node --experimental-strip-types runner/main.mjs \
  /absolute/new-private-directory/supervisor.json
```

`supervisor.json` is a complete runnable configuration (bounded to16 MiB to
represent all32 registered definitions), including private state
root, loopback port, fixed control-plane URL/audiences, control-plane public key,
supervisor transport private key, and separate evidence private key.
`worker.vars.json` contains matching Worker bindings. The generated `.dev.vars`
contains the same bindings in Wrangler format; use it for the local Worker
without replacing existing identity configuration. These files contain private
signing material: keep them outside Git and guest inputs. Configure owner identity
as documented in `AUTHENTICATION.md`; execution keys do not grant user access.
The automated integration below provisions its own ephemeral keys and synthetic
Access identity without any manual credential setup.

The supervisor only listens on `127.0.0.1`. A hosted Worker needs a separately
provisioned private service topology; its loopback cannot reach this host.
The Worker must set `EXECUTION_RUNNER_URL`, `EXECUTION_RUNNER_AUDIENCE`,
`EXECUTION_CHECKPOINT_AUDIENCE`, `EXECUTION_CONTROL_KEY`, `EXECUTION_RUNNER_KEY`
and `EXECUTION_EVIDENCE_KEY`. Optional `EXECUTION_REGISTRY` is public JSON,
mirrored in the supervisor's `registry`. Missing/invalid configuration returns
503 and does not fabricate a running or successful Run.

Public registry definitions contain `operationId`, `label`, exact
`node@sha256:<digest>` and `scriptVersion:1`. Without `argv` this selects the
versioned built-in Ticket validator. Administrator Node programs additionally
provide fixed `argv` beginning with `node`, `inputs` and `artifacts` arrays.
Argv is limited to64 items/32 KiB; neither clients nor Ticket prose can alter it.
Static inputs declare `{path,sha256,bytes}` beneath `input/assets/`; artifacts
declare `{path,maxBytes}` beneath `output/`. Empty artifact arrays are supported,
but the complete frozen output tree is still checked for unsafe entries.
Collections are sorted canonically; argv order is preserved. Duplicate IDs,
unknown fields, unsafe paths, ancestor conflicts and oversized inputs fail closed.
The frozen Ticket plus assets share16 MiB. Descriptor hashes bind the runtime
layout, exact policy, pinned image, argv and manifests. Unrelated catalog additions
or reordering do not stale a grant; changing/removing its selected operation does.

The separate supervisor-only `sourceRoots` map is keyed by operation ID.
`input/assets/example.json` maps to `<sourceRoots[id]>/assets/example.json`.
No source root appears in the catalog, grants, permits or receipts. The supervisor
pins and reads actual source bytes, verifies manifest hashes, stages a private
snapshot, and verifies that snapshot again before importing the read-only volume.
No client host path, environment, callback URL, shell command or Docker option is
accepted. Missing images fail under the no-pull policy as real startup failure.

Requests and replies use canonical JSON, raw64-byte P-256 signatures encoded as
lowercase hex, exact direction/purpose/audience/key ID, method/path, body hash,
nonce and short10-second expiry. Replies additionally bind status and originating
request hash. Both runtimes use the same serializer/verifier. Transport redirects
are rejected. Replay windows reject saturation while preserving live nonces.
Control and supervisor transport keys and evidence keys must have distinct actual
public coordinates as well as distinct IDs.

Before registered execution, the supervisor obtains a fresh signed checkpoint
from `/api/execution/checkpoint`. That narrow service endpoint authenticates the
supervisor before any D1 query; it has no owner grant-decision capability and does
not accept Sites owner headers as authority. Running work checks every1 second;
3 seconds without a valid allow reply requests cancellation. An independently
armed watchdog always enforces the original deadline, including during outages
or supervisor SIGKILL. No checkpoint, retry or recovery extends it.

Admission journals the immutable permit and deterministic owner/Run/attempt ID
before executable work. A single-instance OS flock protects each supervisor root;
atomic file and directory fsync retain every state/fence. Receipt reads wait for
that durable transaction. A failed journal write or unexpected lock-holder loss
blocks further reads/admission until restart; independent cleanup stays armed. Cancellation serializes
with admission and persists a permanent fence before acknowledgement. An ack is
not physical stop proof. Cleanup remains pending when a create may still arrive;
polling reconciles the independent guardian's eventual confirmed removal.
Recovery queries only the persisted exec ID and never restarts uncertain work.
An exit code alone does not establish that a never-acknowledged exec started.
Unknown results remain `evidence_unavailable`, with unknown fields null.

`result`, `cancel_fence` and `stop` are distinct immutable v2 attestations. They
bind permit hash, owner/Run/Ticket revision/attempt/grant/contract, exact selected
operation, backend identity and unchanged deadline. Success needs actual start,
exit0 and validated capture before that deadline. Startup failure, command
failure, timeout, cancellation and unavailable evidence remain distinct.
Cleanup/non-success observations may occur later without extending execution
rights. Retained streams have exact retained-byte hashes/lengths/truncation flags.
When interruption preserves actual bounded streams, their partial retained bytes
and truncation flags are also attested and downloadable; unknown exit/times stay
null. Artifact and stream bytes survive runtime removal and restart. Content endpoints
accept only exact receipt-declared identities, verify bytes before serving them,
and report unavailable if content is missing or changed.

Supervisor admission retains at most64 identities and8 nonclosed jobs; no replay
fence/tombstone is evicted to make room. HTTP admission is bounded to32 concurrent
requests/64 connections,1 MiB signed requests and bounded replies. Stop
proofs close the D1 physical reservation; logical cancellation never does.
SIGTERM/SIGINT stop admission, request cancellation, and wait for owned cleanup.

### Supervisor Function map

| Module / function | Responsibility |
| --- | --- |
| `scripts/provision-execution.mjs` | Create three real keypairs and usable private Worker/supervisor configuration |
| `runner/main.mjs::runSupervisor` | Privately load keys/configuration and handle operator process lifecycle |
| `runner/server.mjs::startSupervisor` | Loopback HTTP, signature/replay admission, truthful health, bounded routing and shutdown |
| `runner/journal.mjs::openJournal` | Single-instance flock, fsynced bounded journal and serialized admission/fences |
| `runner/registry.mjs::validatePermit`, `stageInputs` | Exact shared registry/permit comparison and verified private asset staging |
| `runner/executor.mjs::createExecutor` | Async stable identity, actual workspace/exec lifecycle, checkpoint supervision, restart cleanup and retained content |
| `runner/receipts.mjs::makeReceipt`, `streamEvidence` | Separate evidence signing and exact retained-byte metadata |
| `runner/client.mjs` | Node entry for the shared signed transport client |
| `runner/workspaces.mjs::startExecution` | Persist exact exec ID/start intent and actual start acknowledgement before success retention |

### Real end-to-end verification

```sh
npm run build
npm run test:execution
npm run test:backend:integration
```

The last command uses the built Worker, fresh D1, synthetic real RS256 Access
identities, separate ephemeral P-256 roles, loopback supervisor and actual Docker.
It verifies signed checkpoint directions, authorized execution, retained artifact
bytes and physical closure, then drives the execution UI through approval/start,
real results/download and account switch. Browser traffic uses the strict owned
loopback proxy/CDP observation harness; blocked origins remain recorded.
`TEST_CHROMIUM_EXECUTABLE=/absolute/chromium` selects a trusted local browser when
needed. Docker/build/browser suites run serially so unrelated host load does not
consume execution budgets. CI preserves existing identity/planning/browser gates
and adds this actual backend gate with trusted host proc access.
