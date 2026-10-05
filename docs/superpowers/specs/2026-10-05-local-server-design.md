# Local server design

## Architecture

Native Next.js16.3.4/React19.2.6 serves the existing workspace and App Router APIs
in a Node.js22.23.3 process. SQLite is a local persistent file, default
`.local/data.sqlite`, with WAL, busy timeout and atomic synchronous batches.
The local server is the sole application runtime. Browser assets, identity,
records, planning callbacks and execution services operate locally. Defaults:
APP_HOST=127.0.0.1, APP_PORT=5173, APP_ORIGIN=http://127.0.0.1:5173.

Retain the existing Idea/Plan/Ticket/history, deterministic revision jobs, durable
per-target deliveries, readonly MCP pages, approval audit/frozen Runs and signed
Docker backend. Keep SQL/domain invariants, private ownership, source distinctions,
strict projections and execution permission boundaries. No physical execution of
user-generated Tickets or private-data import is part of development.

## Storage and process

Use node:sqlite and a structural LocalDatabase interface (prepare/bind/first/all/run,
atomic batch returning meta.changes); no await inside native transaction. Persist
records through restart, rollback every batch on failure and never interleave
concurrent statements inside a batch. Apply sorted SQL once with checksum ledger
inside BEGIN IMMEDIATE; changed applied SQL or failed schema is a startup error,
never silently reset/reapply. Retain every existing business table/index/check/
trigger in an authoritative local baseline; remove unused identity storage and
add local users, auth tokens and login-throttle tables. Local state files newly
created use private directory/file permissions and stay ignored. Do not touch any
existing unrelated database.

`npm run install:ci` performs locked npm ci. Keep pinned existing application and
browser versions; remove unused platform/identity/connector/build packages and
unused ORM generation tooling rather than retaining runtime scaffolding.
`npm run dev` and `npm start` run the same custom Node HTTP server with native Next
(dev mode or prepared production .next build). `npm run build` is native Next build
and never initializes account/database/scheduler state. Server startup explicitly
initializes local DB and starts background processing after HTTP readiness;
shutdown stops the timer, drains in-flight work and closes only owned resources.
Telemetry disabled; no remote fonts/assets. No application bind on all interfaces
by default. APP_ORIGIN is canonical and controls Host/origin checks.

## Local identity

Local accounts have random stable IDs, unique normalized usernames, display names
and scrypt password hashes with random salts. Only local CLI can create accounts,
reset passwords and issue/revoke API tokens; no anonymous registration or default
password. CLI reads a password interactively or from stdin, never command-line
password arguments. Test fixtures create synthetic accounts via the same helpers.
Browser login is username/password at /signin and POST /api/auth/login; logout is
same-origin POST /api/auth/logout. Bound safe relative return paths avoid external
redirects. Persistent random opaque session/API tokens are stored only as hashes;
HttpOnly SameSiteStrict browser cookies, Secure for HTTPS, real expiry and immediate
logout revocation. Default browser lifetime12h, default API token30days; enforce
bounded positive TTLs. Reject conflicting credentials and spoofed identity headers.
Unknown/expired/revoked tokens401, invalid origin/host403, storage503; no private
credential values in DTO/error/logs. Login throttles repeated failed attempts and
uses constant-time hash verification without revealing account existence.

The same current local session helper protects every data API and MCP call. Reads
use no-store. Cookie writes require exact configured origin; authenticated Bearer
clients can call MCP without Origin, but a supplied mismatching Origin is rejected.
The separately signed /api/execution/checkpoint service route retains its own
transport authentication and never depends on browser owner credentials. Preserve
client expiry/account-switch/401/403 clearing and stale-response guards. Safe
session DTO mode is local; topbar/profile and links use local account terms.

## Planning and execution

Node process timer calls the same recover/discover/deliver routine every60seconds;
no overlap within one process, persistent leases/CAS protect multiple processes.
An explicit scheduler interval setting allows operators to tune/disable it; tests
exercise a1-second actual timer plus explicit production helper calls. Existing
bounds remain:50jobs discovery/recovery,50scoped target invalidations,20outbound;
8s attempt,30s delivery lease,5 attempts with30/60/120/240s backoff;5min accepted
wake,10min planner claim,3automatic recoveries and60s manual cooldown. No-subscription
preserves budget, old/done jobs suppress work, stable IDs within a generation.

Callbacks accept explicit http/https loopback origins (127.0.0.1, localhost, ::1),
paths allowed, no userinfo/fragments/redirects/public or shortened IP names. Challenge,
HMAC, payload cap and secret rotation stay intact. Actual local consumer tests
verify signatures and restart/retry; no application-specific external domain.
Configured local Runner retains distinct transport/result signing keys, fixed
registry, approvals/permit binding, resource limits, checkpoints, cancellation,
immutable attestations and verified download. Read interfaces never start work.

## Documentation and source cleanup

AGENTS.md retains the user-requested direction note; all other app code/config/test/
docs describe only this architecture. Delete unused hosting/build/connector/example
scaffolding, old identity code, obsolete profile scripts and historical archive/
version/project-transition documents. Rewrite README and current operations,
authentication, planning, MCP, execution, runner, testing and roadmap docs. Remove
old names/URLs instead of keeping deprecated compatibility paths. Do not alter
vendored skill provenance or third-party licenses. Current local design/plan files
contain no historical hosting/identity narrative.

FEATURES.md groups concise one-sentence bullets under 点子收件箱, 规划工作台,
Ticket 看板 (including execution authorization), 待我处理, 执行记录, 连接与执行,
项目/通用工作区 and functional MCP/local Runner sections. Include only implemented
behavior and meaningful operating conditions; manual records are snapshots, real
Runs live in authorization/API/MCP, periodic task fields aren't a scheduler, and
the default registered operation validates a frozen Ticket rather than arbitrary
work. Remove obsolete connection cards and hosted login copy; local status copy
must describe real state without unsupported product claims.

## Verification

TDD on real SQLite and real native Next Node HTTP: tracked schema restart/checksum/
rollback/concurrency; real local account login/cookie/Bearer/spoofed/anonymous/owner/
CSRF/expiry/logout/throttle; actual signed service checkpoint; record revisions/
planning claims/atomic saves/recovery/callback HMAC and actual process timer;
MCP typedfilters/cursors/history/manual+realRun/effectivegrant/v1-v2diagnostics/
readonly snapshots. Keep current pure execution and browser network policy tests.
Port fixture/assertions to fresh local DB/processes; no platform-emulation test
runtime. Real Chromium checks navigation/forms/current identity/local login/logout/
private-state races/recovery and zero external asset requests. Independent two
simultaneous local invocations have separate files/ports and clean shutdown.
CI locked install/build/types/lint, local integration and mandatory real Docker
backend suite remain explicit. No skipping missing isolation prerequisites; local
absence is reported and hosted full acceptance stays required where publishing is
authorized. Final audit inspects actual source/function list and retained dependency
tree, not just text substitutions.
