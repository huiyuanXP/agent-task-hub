# Regression checks

Use Node 22.23.3, npm and Python 3 on Linux or macOS. The harness uses POSIX process groups for cleanup. CI runs on Ubuntu. Install the application from its existing lock and Chromium from the separate Playwright 1.58.2 lock:

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

`npm run test:unit` exercises workspace copying, URL validation, port allocation, command failures, readiness deadlines and server cleanup. `npm run test:execution` checks the execution Run domain and HTTP boundary using fresh native SQLite fixtures. `npm run test:browser-policy` uses the separately installed Playwright/Chromium package to test the network boundary with controlled loopback servers. `npm run test:integration` runs the synthetic API/MCP and Chromium suites. `npm test` also runs the pure authentication verifier, actual independent Worker API and independent browser acceptance suites.

After `npm run build`, `npm run test:execution:api` separately checks the actual built Worker execution API with fresh temporary D1 state and all migrations. It binds a dynamically assigned loopback port and remains separate from the integration runner. Do not rebuild `dist` while any standalone built-Worker suite is using it. See [execution Run documentation](EXECUTION.md) for the model and synthetic identity boundary.

Every integration invocation copies an allowlist of application inputs to a new `agent-task-hub-test-*` directory under the OS temporary directory. It installs and builds there, applies all SQL migrations in sorted order once to a fresh local `.wrangler/state`, and starts portable development and built Worker preview on independently allocated `127.0.0.1` ports. It does not use the checkout's execution profile, dependencies, compiled output, D1 state, environment files, credentials or symlinks. The non-secret `.env.example` is permitted. Child processes receive a limited tooling environment; provider credential variables are omitted.

The runner prints each workspace, URL and artifact path. Readiness has a 90-second absolute deadline per server and detects child exit. Application listeners are loopback only; both suites independently validate their targets. API redirects and environment proxy settings are disabled. Chromium sends requests through a temporary loopback proxy with its default loopback bypass disabled. The proxy checks every native redirect hop, including popup and worker requests, and blocks destinations outside the two selected origins. Service-worker registration is disabled. Approved WebSockets remain usable; off-target upgrades and opaque TLS tunnels are refused. The current remote font stylesheet is blocked and the UI uses system fonts. Browser cleanup also closes the proxy and its sockets.

The seven browser-policy regressions assert zero requests/connections reach forbidden loopback endpoints through document/fetch/popup/worker redirects, service workers, HTTPS tunnels or page/worker WebSockets. They also verify allowed redirect URLs/cookies, interactive rendering, approved WebSockets and proxy listener cleanup. Playwright HTTP routes alone cannot enforce this boundary because they do not run again for redirected requests.

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

The runner stops and reaps child process groups and removes temporary application/D1 storage after success, failure, SIGINT or SIGTERM. Successful artifacts are removed. Failed logs, API/browser evidence, synthetic fixture IDs/titles and screenshots remain in ignored `test-results/run-*`; the path appears in the error output. CI uploads only logs, evidence, synthetic fixture JSON and screenshots on failure, never temporary database state. An uncatchable SIGKILL or machine failure can leave an OS temporary directory; remove the printed directory only after confirming its processes have stopped.

If setup fails, check that `npm run install:ci` works, the browser package was installed with `npm ci --prefix tests/browser`, Chromium/system libraries are available, and the OS temp directory has space. For readiness failures, inspect `dev.log` and `preview.log`. For assertion failures, inspect `api.log`, `browser.log`, evidence JSON and the browser failure screenshot. The runner never applies raw migrations to an existing development database.

The standalone suites consume `TEST_DEV_URL`, `TEST_PREVIEW_URL` and `TEST_ARTIFACT_DIR`. Browser checks additionally consume `TEST_PLAYWRIGHT_MODULE`, a file URL to the original checkout's locked Playwright module. The orchestration script supplies these values; ordinarily run the npm commands instead of supplying targets manually. API-created IDs and titles are stored in `fixtures.json` for browser selectors.

Coverage includes anonymous API/MCP denial and discovery; mock-auth spoofing/host/origin/method/prefetch/redirect protections; fresh D1 emptiness; cross-origin writes and invalid records; revision conflicts/history; superseded jobs; idempotent MCP creation and save; exclusive claims and token rejection; stale revision rejection; frozen Run contracts; cross-owner reads/writes; sign-out; browser hydration, capture, Plan/Ticket/Run views, reload persistence and normal/modified brand navigation.

Built preview owner-scoping checks supply trusted **synthetic** Sites identity headers. They exercise the application's ownership boundary after identity has been trusted, and do not establish independent authentication. Independent verified identity has its own suites below. No real accounts, provider keys, production records, successful external callbacks, deployment or execution adapters are exercised. Planning output and Run snapshots do not authorize or prove execution.

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
No provider registration, DNS lookup, real credential, production data, live SSO
or upstream logout propagation is involved.

Checks cover verified display/initials, development label and POST logout,
account switching, real nonmember denial, data origin rejection, storage 503,
expiry without a refresh, delayed successful refresh after expiry and normal/
modified home navigation. Existing integration covers capture, planning,
history, filters and frozen Run views; standalone authorization covers the
persisted decision panel. Fixtures close their own browser, proxy, ingress and
Worker and remove temporary D1 on both success and failure.
