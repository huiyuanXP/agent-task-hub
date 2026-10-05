# Regression checks

Use Node 22.23.3, npm and Python 3 on Linux for the complete suite. The browser observer also requires Linux proc networking tables to verify its debugger listener binding. The harness uses POSIX process groups for cleanup. CI runs on Ubuntu. Install the application from its existing lock and Chromium from the separate Playwright 1.58.2 lock:

```sh
npm run install:ci
npm ci --prefix tests/browser
npx --prefix tests/browser playwright install --with-deps chromium
npm run lint
npx --no-install tsc --noEmit
npm run build
npm test
```

On machines where Chromium's system libraries are already available, `npx --prefix tests/browser playwright install chromium` is sufficient. The application lockfile does not include browser tooling and must not be regenerated to install it.

`npm run test:unit` exercises workspace copying, URL validation, port allocation, command failures, readiness deadlines and server cleanup. `npm run test:execution` checks the execution Run domain and HTTP boundary using fresh native SQLite fixtures, plus the actual isolated Docker workspace backend described in [RUNNER.md](RUNNER.md). The pinned image, local daemon and supported host proc permissions are required; these tests never skip missing isolation prerequisites. `npm run test:browser-policy` uses the separately installed Playwright/Chromium package to test the network boundary with controlled loopback servers. `npm run test:integration` runs the synthetic API/MCP and Chromium suites. `npm test` also runs the pure authentication verifier, actual independent Worker API and independent browser acceptance suites.

After `npm run build`, `npm run test:execution:api` separately checks the actual built Worker execution API with fresh temporary D1 state and all migrations. It binds a dynamically assigned loopback port and remains separate from the integration runner. Do not rebuild `dist` while any standalone built-Worker suite is using it. See [execution Run documentation](EXECUTION.md) for the model and synthetic identity boundary.

Every integration invocation copies an allowlist of application inputs to a new `agent-task-hub-test-*` directory under the OS temporary directory. It installs and builds there, applies all SQL migrations in sorted order once to a fresh local `.wrangler/state`, and starts portable development and built Worker preview on independently allocated `127.0.0.1` ports. It does not use the checkout's execution profile, dependencies, compiled output, D1 state, environment files, credentials or symlinks. The non-secret `.env.example` is permitted. Child processes receive a limited tooling environment; provider credential variables are omitted.

The runner prints each workspace, URL and artifact path. Readiness has a 90-second absolute deadline per server and detects child exit. Application listeners are loopback only; both suites independently validate their targets. API redirects and environment proxy settings are disabled. Chromium sends requests through a temporary loopback proxy with its default loopback bypass disabled. The proxy checks every native redirect hop, including popup and worker requests, and blocks destinations outside the two selected origins. Service-worker registration is disabled. Approved WebSockets remain usable; off-target upgrades and opaque TLS tunnels are refused. The current remote font stylesheet is blocked and the UI uses system fonts. Browser cleanup also closes the proxy and its sockets.

The browser-policy regressions assert zero requests/connections reach forbidden loopback endpoints through document/fetch/popup/worker redirects, service workers, HTTPS tunnels or page/worker WebSockets. They also verify allowed redirect URLs/cookies, interactive rendering, approved WebSockets and proxy listener cleanup. Playwright HTTP routes alone cannot enforce this boundary because they do not run again for redirected requests.

Repeated and parallel runs need no database reset. For example, after the setup above:

```sh
npm run test:integration > /tmp/hub-first.log 2>&1 &
first_pid=$!
npm run test:integration > /tmp/hub-second.log 2>&1 &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
```

Each process gets distinct storage and ports. Port allocation releases a temporary socket before server startup; another process can win that small race. Strict binding makes such a collision fail instead of silently selecting a different port. Retry the failed invocation. Parallel runs install/build separate dependency trees and need enough disk and memory.

The runner stops and reaps child process groups and removes temporary application/D1 storage after success, failure, SIGINT or SIGTERM. Successful artifacts are removed after one complete `VERIFIED_EVIDENCE` JSON record (maximum 64 KiB) is printed, preserving API/browser check results and the full application/blocked/error arrays in captured command logs. Oversized evidence fails instead of being truncated. Failed logs, API/browser evidence, synthetic fixture IDs/titles and screenshots remain in ignored `test-results/run-*`; the path appears in the error output. CI uploads only logs, evidence, synthetic fixture JSON and screenshots on failure, never temporary database state. An uncatchable SIGKILL or machine failure can leave an OS temporary directory; remove the printed directory only after confirming its processes have stopped.

If setup fails, check that `npm run install:ci` works, the browser package was installed with `npm ci --prefix tests/browser`, Chromium/system libraries are available, and the OS temp directory has space. For readiness failures, inspect `dev.log` and `preview.log`. For assertion failures, inspect `api.log`, `browser.log`, evidence JSON and the browser failure screenshot. The runner never applies raw migrations to an existing development database.

The standalone suites consume `TEST_DEV_URL`, `TEST_PREVIEW_URL` and `TEST_ARTIFACT_DIR`. Browser checks additionally consume `TEST_PLAYWRIGHT_MODULE`, a file URL to the original checkout's locked Playwright module. The orchestration script supplies these values; ordinarily run the npm commands instead of supplying targets manually. API-created IDs and titles are stored in `fixtures.json` for browser selectors.

Coverage includes anonymous API/MCP denial and discovery; mock-auth spoofing/host/origin/method/prefetch/redirect protections; fresh D1 emptiness; cross-origin writes and invalid records; revision conflicts/history; superseded jobs; idempotent MCP creation and save; exclusive claims and token rejection; stale revision rejection; frozen Run contracts; cross-owner reads/writes; sign-out; browser hydration, capture, Plan/Ticket/Run views, reload persistence and normal/modified brand navigation.

Built preview owner-scoping checks supply trusted **synthetic** Sites identity headers. They exercise the application's ownership boundary after identity has been trusted, and do not establish independent authentication. Independent verified identity has separate token, Worker and browser acceptance suites below. These baseline preview bindings explicitly select synthetic trusted-sites compatibility; they do not select it in production. The browser/API suites use no real accounts, provider keys, production records, successful external callbacks or deployment. The separate execution suite exercises real synthetic Docker workloads; it grants no authority to planning output. Planning output and Run snapshots do not authorize or prove execution.


## Docker and CI permissions

Before the complete suite, prepare the pinned image and local Docker backend using
[RUNNER.md](RUNNER.md). Capture requires trusted host access to the owned UID1000
container's proc root. The tested service UID1000 can access it; Docker socket group
membership alone does not grant proc access to an unrelated host UID.

CI prepares the local daemon/image explicitly and runs the execution suite through
its existing trusted `sudo` capability with an empty environment and the selected
absolute Node binary. This grants proc inspection to the host test supervisor only;
the guest remains UID1000 with the same Docker restrictions. Frontend unit, browser
policy, independent authentication and integration checks run as the ordinary CI
user. Together these steps cover `npm test`, without running Chromium as root. Unsupported
proc/cgroup/PID topology fails before registered guest execution. CI negotiates only
Docker API1.41–1.51; Docker28.4.0 is the recorded local validation version.


When the pinned Chromium download is unavailable but a trusted local Chromium is
already installed, select its absolute executable path explicitly:

```sh
TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser-policy
TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:integration
```

The selector resolves to a regular executable file and is checked before framework allocation. This only selects the browser binary. The locked Playwright package, mandatory
proxy, permitted origins and all redirect/WebSocket restrictions are unchanged.
CI omits the selector and installs Playwright's pinned Chromium. Record the local
browser version with test evidence when using this portability option.


The proxy retains every blocked origin, including a system browser's own background
software requests. Page/context and owned worker external request origins are also recorded separately;
the UI regression keeps its strict font-only assertion against those application
requests. Background traffic is still blocked and remains visible in evidence. The
policy suite verifies real forbidden page redirects appear in application tracking
while the forbidden server receives zero contacts.


Worker request evidence uses public Chromium CDP over a harness-generated ephemeral
loopback listener. Linux `/proc/net/tcp` and `tcp6` verification rejects every
wildcard or non-loopback binding on that port before discovery. The discovered
WebSocket URL must use the same IPv4 loopback address/port and browser protocol path;
redirects are refused. Only the single owned test context's renderer/worker targets
are observed. Targets pause until Network observation and recursive attachment are
installed, then resume; command/session/message limits and timeouts fail the test
and close the browser if observation breaks. A protocol delivery barrier precedes
final evidence assertions. Application requests to the debugger port remain denied
by the mandatory proxy. No user-provided debugger URLs, flags or launch options are
accepted. The policy suite verifies worker-only forbidden WebSockets appear as
`ws:` application origins, fail the strict font-only allowlist, and make zero
forbidden contacts; it also covers wildcard/non-loopback rejection using controlled
proc-table rows.
No wildcard listener is opened by the tests; actual debugger listeners are verified
on loopback, and application access to their ports remains denied.

The managed host build can print `WARNING Proxy environment variables detected.
We'll use your proxy for fetch requests.` This is expected host package/build
network configuration; it is retained rather than bypassed. A successful build is
not a claim of warning-free output or guest proxy inheritance. Docker runtime
proxy fields remain explicitly empty and are verified by the execution suite.


Execution fixture teardown uses bounded reconciliation and deletes its private
signed state root only after every owned workspace is confirmed removed. If a
create remains uncertain, teardown fails with the retained root path and leaves
its cleanup guardian/key/metadata intact. A later stopped resource can then be
reaped without losing the durable cleanup obligation. The actual late-create
regression checks this behavior; successful tests leave no owned Docker resources.

## Independent identity acceptance

`npm run test:auth` runs real JOSE-signed ephemeral token and policy tests.
`npm run test:auth:api` builds, then checks the actual Worker with fresh temporary
D1 and every committed migration once. `npm run test:auth:browser` uses that built
artifact and the separately locked Playwright install. Run these sequentially;
`npm test` already does so. Standalone execution authorization acceptance is:

```sh
EXECUTION_PLAYWRIGHT_MODULE=./tests/browser/node_modules/playwright/index.mjs node --experimental-strip-types tests/execution/authorization-worker.mjs
```

The independent browser fixture uses a clearly test-only loopback ingress facade
to translate browser requests to the configured synthetic HTTPS app origin. It
supplies newly signed assertions, while the actual Worker verifies JWTs against
an ephemeral synthetic JWKS. Session/data responses are never mocked. Native
browser traffic still crosses the existing restrictive network proxy; only the
facade origin is permitted. The provider-owned logout destination terminates at
the fixture, and the suite separately verifies actual local token replay denial.
The auth browser emits a bounded `VERIFIED_AUTH_BROWSER_EVIDENCE` summary after
the observer flush, retaining every blocked proxy origin alongside strict font-only
owned application origins, page errors, network errors and synthetic JWKS URLs.
No provider registration, DNS lookup, real credential, production data, live SSO
or upstream logout propagation is involved.

Checks cover verified display/initials, development label and POST logout,
account switching, real nonmember denial, data origin rejection, storage 503,
expiry without a refresh, delayed successful refresh after expiry and normal/
modified home navigation. Existing integration covers capture, planning,
history, filters and frozen Run views; standalone authorization covers the
persisted decision panel. Fixtures close their own browser, proxy, ingress and
Worker and remove temporary D1 on both success and failure.

## Planning recovery acceptance

After the build, `npm run test:planning:recovery` exercises durable callback attempts,
restart, real scheduled dispatch, claim expiry/recovery and bounded housekeeping
against fresh D1. `npm run test:planning:lifecycle` checks authenticated subscription
backfill/refresh/unsubscribe, malformed input, same-origin/owner boundaries, manual
retry CAS/cooldown and safe read-only API/MCP/Idea metadata. Controlled callback
fixtures verify the real challenge and HMAC; unexpected destinations fail. No live
subscription or production resources are used.

`npm run test:planning:browser` drives real Chromium through the existing restrictive
proxy and a loopback-only test ingress to the authenticated built Worker. Fixture-only
D1 timestamps provide active/expired/permanent/backoff states; UI responses are real.
It checks countdown and local expiry, a successful manual recovery POST/refresh,
permanent reason visibility, next retry, disabled backoff and a usable missing-job
fallback. It retains page/network error and blocked-origin evidence. Each invocation
closes its owned ingress/proxy/browser/Worker and removes temporary D1 state. All
three suites are part of default and hosted entrypoints. Do not rebuild the shared
compiled Worker while standalone suites are running.

Full local `npm test` still requires the upstream pinned Docker image, daemon and
host proc permissions. A machine without Docker cannot claim full-suite success;
run application/auth/planning/browser/integration checks separately and retain the
full command's failures. Hosted Ubuntu CI supplies the explicit Docker boundary
without skipping or weakening those execution checks.

## Readonly MCP task queries

After building, `npm run test:mcp:task-reads` runs both the Ticket/Plan and merged
manual/execution Run suites against the actual Worker. `npm run test:mcp:task-runs`
is the focused Run entrypoint. These checks run in default `npm test` and explicitly
in hosted CI after the existing built-Worker identity check. See
[MCP-TASK-READS.md](MCP-TASK-READS.md) for exact schemas, results and continuation.

Fixtures use fresh isolated D1/all migrations and synthetic signed Access JWTs.
Coverage includes exact stored types/filters, owner/root/nested isolation, canonical
context-bound keysets, cross-source identical IDs, bounded nested pages, immutable
frozen contracts, current registry/effective authorization, and safe version 1 and
version 2 evidence plus failed/cancel/stop diagnostics. Synthetic domain preparation,
approval and signed evidence ingestion do not dispatch or physically execute Tickets.
Before/after snapshots include every persistent user table, including authorization
audits, permits, attestations and auth revocations; rejected reads are also readonly.
Malformed execution configuration only blocks presentation of a bound grant.
