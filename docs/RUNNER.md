# Isolated runner workspaces

This Node-only adapter supplies the workspace and Docker lifecycle primitives for
remote execution. It does not expose an HTTP endpoint, authorize operations or
issue successful Run receipts. The supervisor must supply an approved fixed argv
from the shared catalog, an owner/Run/attempt identity and a reduced grant policy.
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
| Declared retained artifacts | 1 MiB total, at most 64 files |
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
These primitives do not authorize arbitrary argv; the later supervisor must bind
its registry and grant to the immutable Run contract and maintain physical Ticket
reservations through cancellation and uncertain cleanup.
