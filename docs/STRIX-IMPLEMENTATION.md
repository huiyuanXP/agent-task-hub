# Strix agent implementation record

This record tracks the seven claimed tickets #1, #2, #3, #4, #9, #10 and #11. Each ticket receives its own tested commit and push. The #14 audit remains outside Git and its implementation is deferred. GitHub issue #27 remains the full project roadmap. Local synthetic verification does not authorize deployment or execution.

## #1 — Reproducible VM1 configuration

Reviewed and included the existing non-secret VM1 configuration and historical validation report. Corrected the development command to `npm run dev`, which works in both profiles, and renamed the already-published issue index.

Fresh verification on 2026-10-04 used a clean index export in `/home/agent/work/agent-task-hub/strix-validation/issue1-clean`, without existing dependencies or D1 state:

- `npm run install:ci`: exit 0; 687 locked packages installed.
- `npm run build` and `npx --no-install tsc --noEmit`: exit 0.
- Both committed migrations applied once, in order, to a fresh local D1 database.
- Portable dev and built preview passed 12 API/MCP groups and six Chromium groups covering anonymous/spoofed/cross-owner denial, revision conflict/history, exclusive claims, idempotent saves, frozen Run contracts and browser persistence.
- Both portable and managed-linux development defaults listened on `127.0.0.1:5173`. Managed development denied anonymous records without mock identity. Built preview used `--local --ip 127.0.0.1`; auxiliary application listeners were loopback.
- Lockfile SHA-256 before/after: `eedaeab6870c0f70f9db869fcaa24abae9b0f945cbc9acb8a43b6e7ed6bcbfca`.
- Read-only independent review found no blocking issue; both documentation corrections were applied. `git diff --check` passed.

Evidence logs and synthetic runtime artifacts are outside Git in `/home/agent/work/agent-task-hub/strix-validation/`. The original `.npmrc` remains absent and documented; no guessed replacement was added. Baseline lint remains 49 errors and two warnings, handled by #2. No original Site, production data, credentials or compiled output were added.

## #2 — Application lint and types

Added shared record bodies, browser drafts/rows, planning results/events, MCP arguments/schema definitions, subscription records and explicit D1 result types. Removed all 47 explicit `any` declarations, the unused icon/catch variable, synchronous first-load effect update and raw homepage anchor. The initial load is scheduled after mounting and canceled during cleanup; normal homepage navigation resets workspace state using Vinext's `onNavigate`, preserving modified-click behavior. Previously compressed files were formatted for review.

Verification on 2026-10-04:

- Baseline reproduction: 49 lint errors and two warnings; final `npm run lint`: exit 0, zero warnings/errors. Existing rule configuration is unchanged.
- Final `npx --no-install tsc --noEmit` and `npm run build`: exit 0.
- Fresh isolated D1 migrations and all 12 API/MCP and six Chromium baseline groups passed after the typing changes. Server startup was awaited after an initial harness connection-refused attempt; no application fix was needed for that setup race.
- A browser test first demonstrated that the converted brand Link failed to return from the Ticket board to the inbox. The test passed after adding the navigation reset.
- Lockfile SHA remains unchanged. Runtime evidence lives outside Git in `strix-validation/issue2-*.log`; no synthetic database or browser artifact is tracked.
- Independent read-only review approved the final diff with no outstanding findings; it also verified Ctrl-click preserves the current workspace.


## #4 — Isolated regression harness and CI

Added a Node runner with allowlisted temporary source copies, fresh local D1 migrations, dynamic loopback ports, child exit/deadline checks and process-group cleanup. Ported the VM1 Python API/MCP and separately locked Playwright 1.58.2 Chromium fixtures, including rendered planning state and normal/modified brand navigation. Added `test:unit`, `test:integration`, `npm test`, reproduction/troubleshooting documentation, and a read-only PR/push workflow on Node 22.23.3 with failure-only log/evidence/screenshot upload.

Verification on 2026-10-04:

- Boundary tests were written first and observed failing for missing utilities. Later RED/GREEN checks covered malformed targets, ignored SIGTERM escalation, a symlinked hosting directory and independent Python target validation. Final unit suite: 11 passed, zero failures.
- Final `npm run lint`, `npx --no-install tsc --noEmit`, `npm run build` and `npm test`: exit 0. Lint remains clean with unchanged rules. Integration passed all 12 API/MCP groups and eight Chromium groups.
- Two final integration processes started 0.002 seconds apart and both passed, using distinct workspaces `/tmp/agent-task-hub-test-hskv3C` and `/tmp/agent-task-hub-test-m6Y1Ya`, with distinct dev/preview ports 35385/42995 and 45591/38799. Both temporary workspaces and successful artifacts were removed.
- A real SIGTERM after both servers became ready exited 1, retained failure logs, removed its workspace and released ports 34875/40705. Final socket/process checks found no listeners or processes from the retained harness runs.
- The application lock remains byte-identical to the base commit, SHA-256 `eedaeab6870c0f70f9db869fcaa24abae9b0f945cbc9acb8a43b6e7ed6bcbfca`. Application source and lint rules are unchanged; targeted generated-directory ignores were added.
- Local command logs and isolation evidence are ignored under `.superpowers/sdd/2026-10-04-isolated-regression/`; failed synthetic artifacts remain in ignored `test-results/`. No database state, generated output, credentials or original Site linkage is tracked.

Built-preview owner checks deliberately supply trusted synthetic Sites identity headers; independent authentication remains #3 and will adapt these fixtures separately. No successful external callback, production data, deployment or task execution was exercised. CI configuration is committed for controller review; GitHub execution awaits the controller's issue-specific push.


The first #4 review found that Playwright HTTP routes skip later URLs in redirect chains. A real Playwright 1.58.2 loopback probe reproduced one forbidden-origin request. The review fix routes Chromium through a temporary loopback proxy with the implicit loopback bypass disabled, validates every request/upgrade before forwarding, disables service workers, and closes owned sockets/listeners. Native redirect URLs, cookies, hydration and modified-click popups remain intact. Approved plain WebSocket CONNECT requests are parsed as HTTP and revalidated rather than relayed as opaque TCP; TLS and off-target tunnels remain blocked.

Fix verification: seven real browser-policy regressions passed with zero forbidden document/fetch/popup/worker requests, zero off-target CONNECT or page/worker WebSocket connections, and zero forwarded opaque TLS connections. The full `npm test` passed 11 harness tests, seven policy tests, 12 API/MCP groups and eight Chromium groups; the final policy rerun included explicit worker-WebSocket coverage. Lint and TypeScript passed. Application source, lint rules and both lockfiles remain unchanged; targeted generated-directory ignores were added. Logs and the scoped review report remain in ignored `.superpowers/sdd/2026-10-04-isolated-regression/`; no parallel D1 repetition was needed for this browser-policy fix.

## Issue #3 — independent private account identity

Built Workers now fail closed to Cloudflare Access verification with explicit
team/audience/application-origin metadata and private membership. JOSE validates
RS256 application JWTs against only the configured team certs endpoint. All
caller Sites identity headers are stripped; one request-scoped identity serves
UI, APIs and MCP. Owners are issuer/subject hashes, independent of mutable email.
D1 local token-hash revocation makes same-origin POST logout immediately effective.
Provider registration, ingress, live SSO and upstream logout remain issue #5;
production owner reconciliation remains issue #7. Account membership does not
grant execution approval or backend authority.

The UI consumes the safe no-store session DTO, displays verified name/initials,
labels development identity and submits real POST logout. Authentication denial,
account switching and supplied expiry clear private rows, draft, capture,
planning state and filters. Sequence guards prevent delayed old refreshes from
restoring data. Temporary network/storage failures remain distinct. A built
browser test exposed Vinext's production home-link client navigation error;
the already-mounted home reset now prevents that redundant navigation while
modified clicks preserve native link behavior.

Verifier, actual Worker and real Chromium acceptance use fresh synthetic keys,
private members and isolated D1 with every migration applied once. The browser
fixture has a test-only loopback ingress that translates to a synthetic configured
HTTPS origin, preserves real JWT verification and uses the existing restrictive
network proxy. No provider keys, live accounts, production records, successful
live login, deployment or execution backend are involved. Existing synthetic
Sites compatibility requires both explicit trust settings and remains separately
identified in tests. See [AUTHENTICATION.md](AUTHENTICATION.md) and
[TESTING.md](TESTING.md) for configuration, boundaries and repeatable commands.

Task-level RED/GREEN logs and the complete verification report are retained in
ignored `.superpowers/sdd/2026-10-04-independent-identity/`. The root dependency
lock adds only pinned JOSE 6.2.12 across this issue; all pre-existing package
versions and the separate browser lock are preserved. No lint rule was weakened.
Controller review, issue-specific push/PR and hosted CI remain the controller's
responsibility; no deployment is part of this source change.

## #9 — Automatic planning on Idea revision

All successful Idea saves now atomically create history, the new revision and its deterministic revision-specific planning job. An early revision check prevents a mismatched history snapshot; the transaction retains its concurrent CAS. The job insert is gated by that save's unique history row and new Idea revision, so a losing request cannot create an orphan or overwrite another event. Delivery follows commit. Every saved context revision triggers planning; a stale duplicate gets 409. Prior Plan cards explicitly identify their source/current Idea revisions, and current result actions cannot open another revision's Plan.

The pre-fix isolated API test observed no v2 job immediately after saving. After the fix it passes without a manual planning request. A browser regression failed on the missing stale Plan label before implementation and passed afterward. Actual signed-identity Worker/D1 checks passed correct event content, duplicate/history behavior, six racing edits with one winner/one history/one job, cross-owner/stale planner denial, and full revision/history rollback under an injected job-storage failure. Existing API/MCP and browser baseline passed; locks and authentication/Run/approval behavior are retained. Full final checks and review are recorded with this ticket's commit/PR evidence.

#9 final review found a runtime project type gap. A shared Idea guard now rejects malformed/oversized project values before either create or update writes. Its actual Worker regression failed with 201 before the fix and passes with 400 plus unchanged records/history/jobs. Independent scoped re-review reports no remaining findings. Build, full npm test, lint and TypeScript passed; the validation fix was followed by a fresh build and Worker regression.
