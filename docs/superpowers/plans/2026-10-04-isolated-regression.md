# Isolated regression implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete GitHub issue #4 with reproducible synthetic API/MCP/browser regressions and PR CI.

**Architecture:** A Node runner creates a separate temporary application workspace and fresh D1 for every invocation, installs the existing application lock, builds, migrates and manages two loopback-only servers. Python checks API/MCP behavior; separately locked Playwright verifies Chromium workflows.

**Tech Stack:** Node 22.23.3, locked Vinext/Cloudflare Wrangler/D1, Python 3, Playwright 1.58.2, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-isolated-regression-design.md`

## Global Constraints

- The application lockfile remains byte-identical.
- Keep Playwright 1.58.2 in `tests/browser/package.json` with its own npm lockfile.
- Never use the original checkout's database or execution-profile selection.
- Block all browser network requests outside the two selected loopback origins.
- No test binds an application listener to a public address or runs remote Wrangler operations.
- No successful external callback is needed or claimed.
- CI grants contents read permission only.

---

### Task 1: Ship the complete isolated regression harness and CI

**Files:**
- Create: `scripts/test-integration.mjs`, `tests/harness.mjs`, `tests/harness.test.mjs`, `tests/api.py`, `tests/browser/checks.mjs`, `tests/browser/package.json`, `tests/browser/package-lock.json`, `.github/workflows/ci.yml`, `docs/TESTING.md`.
- Modify: `package.json`, `README.md`, `docs/STRIX-IMPLEMENTATION.md`.
- Preserve: `package-lock.json`, application source and existing lint rules.

**Interfaces:**
- Consumes: existing `scripts/install-ci.mjs`, `npm run build`, `npm run dev`, `npm start`, generated `dist/server/wrangler.json`, and all `drizzle/*.sql` migrations.
- Produces: `createWorkspace(sourceRoot)` returning a fresh temporary application directory; `loopbackUrl(value)` returning a validated HTTP loopback URL; `freePort()` returning a currently available loopback TCP port; `npm run test:unit`, `npm run test:integration`, and `npm test`.
- Both suites consume `TEST_DEV_URL`, `TEST_PREVIEW_URL`, `TEST_ARTIFACT_DIR`; browser additionally consumes `TEST_PLAYWRIGHT_MODULE`, a file URL to the original checkout's locked Playwright module. API writes `api-evidence.json` and fixture data; browser writes `browser-evidence.json` and screenshot artifacts to the artifact directory.

- [ ] **Step 1: Add real boundary tests first.** The following tests catch copying development data/secrets, workspace reuse and non-loopback targets; expand these with IPv6 and malformed URL inputs using literal expectations.

```js
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, access, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspace, loopbackUrl} from './harness.mjs';
test('test workspaces exclude development state and credentials', async () => {
  const source = await mkdtemp(join(tmpdir(), 'hub-source-'));
  let first, second;
  try {
    await mkdir(join(source, '.wrangler', 'state'), {recursive:true});
    await mkdir(join(source, 'app'), {recursive:true});
    await writeFile(join(source, 'app', 'page.tsx'), 'synthetic source');
    await writeFile(join(source, '.wrangler', 'state', 'development.sqlite'), 'private fixture');
    await writeFile(join(source, '.dev.vars'), 'TEST_ONLY=not-copied');
    first=await createWorkspace(source); second=await createWorkspace(source);
    assert.notEqual(first,second);
    assert.equal(await readFile(join(first,'app','page.tsx'),'utf8'),'synthetic source');
    await assert.rejects(access(join(first,'.wrangler')));
    await assert.rejects(access(join(first,'.dev.vars')));
  } finally {
    for (const dir of [first,second,source].filter(Boolean)) await rm(dir,{recursive:true,force:true});
  }
});
test('only HTTP loopback application targets are accepted', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:5173').origin,'http://127.0.0.1:5173');
  assert.throws(()=>loopbackUrl('https://example.test'));
  assert.throws(()=>loopbackUrl('http://127.0.0.1.example.test'));
  assert.throws(()=>loopbackUrl('http://user:password@127.0.0.1'));
});
```

Run `node --test tests/harness.test.mjs`, record the missing implementation failure, then implement the utilities.

- [ ] **Step 2: Implement lifecycle isolation and port validation.** `createWorkspace` uses a fresh `mkdtemp` path and copies only application inputs (`app`, `build`, `components`, `db`, `drizzle`, `hooks`, `lib`, `public`, `scripts`, `tests`, root package/lock/config files and `.openai/hosting.json`). Exclude dependencies, compiled output, `.git`, `.wrangler`, `.sites-runtime`, `.env*` except the non-secret example, `.dev.vars*`, databases and symlinks. Missing optional source folders can be skipped; other copy errors fail with cleanup. `loopbackUrl` rejects credentials, public hosts, non-HTTP schemes and unexpected URL paths/query/hash. `freePort` reserves then releases a `127.0.0.1` socket.

Implement `scripts/test-integration.mjs` with explicit child-process exit checking and process-group cleanup: create workspace, install and build using the application scripts, migrate sorted SQL files once with local Wrangler, start dev with `--hostname 127.0.0.1 --port` and preview with `--local --ip 127.0.0.1 --port`, wait for both HTTP roots with an absolute deadline and abort if the child exits, execute API then browser, and always stop/reap children. SIGINT/SIGTERM must run the same cleanup. Preserve failure logs under ignored `test-results/`; never upload the temporary D1 directory.

- [ ] **Step 3: Port the real synthetic fixtures.** Read `/home/agent/work/agent-task-hub/initial-validation/local-checks.py` and `browser-checks.mjs` as source fixtures; retain all behavior checks listed in the spec. Replace fixed ports/output paths and private absolute imports with the contracts above. Make Python URL validation independent of caller input, and replace the exact five-tool count with checks for the five baseline tool names so later read-only tools remain compatible. Store API-created IDs/titles as synthetic fixture JSON for browser consumption. Add brand navigation regression checks including modifier behavior. Browser checks collect page errors, block external requests and verify actual rendered state; await hydration/HTTP responses and avoid ambiguous selectors. Print concise PASS lines, fail nonzero on every assertion and close browser in `finally`.

Use the following separately locked package and entry scripts; generate only this browser package's lock via npm and install it via `npm ci --prefix tests/browser`:

```json
{"name":"agent-task-hub-browser-tests","private":true,"type":"module","dependencies":{"playwright":"1.58.2"}}
```

```json
{"test:unit":"node --test tests/*.test.mjs","test:integration":"node scripts/test-integration.mjs","test":"npm run test:unit && npm run test:integration"}
```

- [ ] **Step 4: Add PR/push checks and reproduction docs.** Create a GitHub Actions workflow for `pull_request` and pushes to `main` and `strix/**`; use Node 22.23.3 and Python 3, application/browser lockfile caches, the exact commands in the spec and `npx --prefix tests/browser playwright install --with-deps chromium`. Run with a bounded timeout and upload only failure log/evidence/screenshots from `test-results/`. Document clean setup, temporary storage, ports, parallel/repeat behavior, troubleshooting and the trusted synthetic identity limitation. Update README and the implementation record with actual observed checks.

- [ ] **Step 5: Verify deliverable and isolation.** Run `npm run lint`, `npx --no-install tsc --noEmit`, `npm run build`, unit tests and `npm test`. Run two `npm run test:integration` processes concurrently after a successful single run, verifying distinct workspace/port output and successful cleanup; re-run if new fixes change isolation behavior. Record the untouched application lockfile SHA and ensure no listeners from the harness remain. Review the diff, `git diff --check`, and commit all issue #4 deliverables. Do not push or close the issue: the controller performs the issue-specific push after review.
