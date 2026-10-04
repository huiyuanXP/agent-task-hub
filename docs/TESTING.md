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

`npm run test:unit` exercises workspace copying, URL validation, port allocation, command failures, readiness deadlines and server cleanup. `npm run test:integration` runs the synthetic API/MCP and Chromium suites. `npm test` runs both.

Every integration invocation copies an allowlist of application inputs to a new `agent-task-hub-test-*` directory under the OS temporary directory. It installs and builds there, applies all SQL migrations in sorted order once to a fresh local `.wrangler/state`, and starts portable development and built Worker preview on independently allocated `127.0.0.1` ports. It does not use the checkout's execution profile, dependencies, compiled output, D1 state, environment files, credentials or symlinks. The non-secret `.env.example` is permitted. Child processes receive a limited tooling environment; provider credential variables are omitted.

The runner prints each workspace, URL and artifact path. Readiness has a 90-second absolute deadline per server and detects child exit. Application listeners are loopback only; both suites independently validate their targets. API redirects and environment proxy settings are disabled. Chromium blocks requests and WebSockets outside the two selected origins; the current remote font stylesheet is blocked and the UI uses system fonts.

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

Built preview owner-scoping checks supply trusted **synthetic** Sites identity headers. They exercise the application's ownership boundary after identity has been trusted, and do not establish independent authentication. Independent verified identity remains issue #3. No real accounts, provider keys, production records, successful external callbacks, deployment or execution adapters are exercised. Planning output and Run snapshots do not authorize or prove execution.
