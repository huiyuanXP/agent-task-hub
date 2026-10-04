# Isolated API, MCP and browser regression design

Issue #4 adds reproducible regression coverage after #1 and #2. Use the existing VM1 synthetic checks as behavior fixtures, with no live identity, subscription, external webhook, production record or executor. Tests must prove both development mock-auth protections and owner scoping after trusted synthetic identity is supplied to a built Worker. They must state that this does not provide independent authentication (#3).

## Decisions

Use a Node orchestration script plus the existing Python API and Playwright Chromium checks. Retaining the already-validated checks reduces drift; migrating the API harness to a different testing library is unnecessary. Allocate separate loopback ports for each run, copy an allowlist of application sources into an OS temporary directory, run the locked installer and build there, and apply every SQL migration in sorted order once to its new `.wrangler/state`. Never use the original checkout's database or execution-profile selection.

Keep Playwright 1.58.2 in `tests/browser/package.json` with its own npm lockfile. The application lockfile remains byte-identical. CI installs both locks explicitly. Browser artifacts and test workspaces are temporary or ignored, and servers are stopped on success, error and interruption. Failed logs are retained with their path reported; successful scratch workspaces may be removed.

## Coverage

Reuse the VM1 fixtures to cover anonymous API/MCP refusal; discovery; mock header spoofing, host/origin/method/prefetch/redirect handling; fresh D1 emptiness; cross-origin writes; invalid ticket state/evidence/references; revision conflict and history; superseded job rejection; MCP idempotent idea creation; exclusive claim and invalid-token rejection; atomic/idempotent plan save; stale revision rejection; frozen Run contracts; cross-owner queries and writes after trusted identity; sign-out; browser hydration, capture, Plan/Ticket/Run views and reload persistence. Add the confirmed brand Link regression: normal home navigation restores inbox/filter state and modified navigation preserves the current workspace.

No successful external callback is needed or claimed. Block all browser network requests outside the two selected loopback origins. The present remote font stylesheet may be blocked until #14 removes the network dependency; system font fallback must remain usable.

## Gates and contracts

`npm run test:unit` runs orchestration boundary tests. `npm run test:integration` runs migrations, both servers and the full synthetic API/browser suites. `npm test` runs both. The CI PR/push workflow runs `npm run install:ci`, `npm run lint`, `npx --no-install tsc --noEmit`, `npm run build`, the browser lock installation, Chromium installation and `npm test` on Node 22.23.3. It grants contents read permission only, uses bounded job timeouts and uploads failure logs without database state or credentials.

Harness URLs are supplied through `TEST_DEV_URL` and `TEST_PREVIEW_URL`, validated to be HTTP loopback URLs. API evidence and fixture JSON use `TEST_ARTIFACT_DIR`; browser imports the original checkout's separately installed Playwright module using `TEST_PLAYWRIGHT_MODULE`, while exercising the temporary application. No test binds an application listener to a public address or runs remote Wrangler operations.
