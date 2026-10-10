# Local server implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task; each task has real RED/GREEN and independent review.

**Goal:** Run the complete existing workspace locally and document only the local system plus a source-backed feature inventory.
**Architecture:** Native Next Node server, persistent native SQLite, local sessions/API tokens, process timer, local signed consumers/Runner; existing domain invariants retained.
**Tech Stack:** Node22.23.3+, locked Next16.3.4/React19.2.6, node:sqlite, Node crypto, existing pinned Playwright1.58.2/Docker registry.
**Spec:** docs/superpowers/specs/2026-10-05-local-server-design.md

## Global Constraints

- Local-only current architecture; historical direction note only in AGENTS.md. No deprecated/legacy hosted compatibility paths or project-transition/version narratives elsewhere.
- Preserve existing edits/private files; no production-data import, provider/private key copy, deployment or physical user-generated Ticket execution.
- Retain all implemented planning/MCP/approval/Run/Runner semantics and ownership/atomicity/strict DTOs; preserve signed /api/execution/checkpoint service route.
- Default host127.0.0.1/port5173/originhttp://127.0.0.1:5173; SQLite.local/data.sqlite; tracked checksum schema; no state mutation during build.
- Locked Next16.3.4/React19.2.6/browser1.58.2 and unrelated versions preserved; deliberate removal of unused dependencies and lock pruning allowed.
- Real local scrypt accounts, hashed opaque tokens, browser12h/API30d defaults, same-origin/Host checks, no default password/anonymous registration/identity-header trust.
- Planning50jobs/50targets/20outbound, attempt8s/lease30s/backoff30,60,120,240s/5attempts, accepted5min/planner10min/auto3/manual60s; local timer60s, callback loopback only.
- Every feature in FEATURES.md one Chinese sentence, grouped by actual navigation/functional section, implemented behavior only; no remote assets/telemetry.
- Fresh isolated DB/process/browser tests; no raw schema replay or skipped isolation prerequisites. Independent task review and whole-source review precede completion.

### Task 1: Native server, SQLite and local identity

**Files:** lib/database.mts/local-store.mts/local-auth.mts/current-user.ts; lib/store facade/types; app APIs/MCP/session/auth/signin/page; scripts/server.mjs/install-ci.mjs/accounts.mjs/build.mjs; migrations/schema SQL; package/lock/config/Next types; tests/local/*.test.mjs and fixture foundation. Remove unused runtime/build/identity/connector/examples and old ORM setup.

**Interfaces:** LocalDatabase.prepare(sql).bind(...primitive).first<T>()/all<T>()/run(); batch(LocalStatement[]) atomic returns{meta:{changes}}[]. database():LocalDatabase. local account helpers create/reset/issue/revoke/validate; getCurrentSession():safe local DTO|null; getCurrentUser():LocalUser|null, reads native Next headers; generic signed service route uses process environment. Server start supports --dev and --port, APP_DB_PATH/APP_ORIGIN and loopback defaults.

- [ ] Read spec and external dependency/feature audits. Write real SQLite transaction/checksum and local authentication RED before implementation; missing module/function failure must be intended, not setup error.
- [ ] Implement SQL baseline retaining business checks/triggers; migration ledger BEGIN IMMEDIATE/checksum; async-compatible structural statements with synchronous transaction operations. Test failure rollback/restart and owner CAS.
- [ ] Implement local scrypt accounts/token hashes/expiry/logout/throttle with exact runtime validation and no implicit registration. CLI stdin/interactive secrets, no password arguments. Write expiry/spoofed/conflicting token/owner/CSRF RED then GREEN.
- [ ] Replace framework scripts/package tree with native Next server/build, environment DB, current-user helpers and real local login/session/logout UI; replace all route env/D1/auth naming. Restore independently signed checkpoint App Router route. Remove dead hosted runtime and direct dependencies, keep unrelated lock versions; initialize no DB during build.
- [ ] Build and serve native Next using fresh test DB, seed via real account helper, prove actual HTTP auth/CRUD/MCP/checkpoint routes. Test leaves no listeners/state in repo. Ensure all old business types compile using structural local DB types; no temporary auth/data fallback.
- [ ] Run focused local unit/HTTP tests, build/types/lint; report actual removed dependencies and exported interfaces, RED/GREEN/concerns. Commit as strix agent; no subagents/push/deploy.

SQLite anchor:
```js
sqlite.exec('BEGIN IMMEDIATE');
try { const output=statements.map(s=>s.execute()); sqlite.exec('COMMIT'); return output; }
catch (error) { sqlite.exec('ROLLBACK'); throw error; }
```
Real behavior anchor:
```js
assert.equal((await request('/api/records')).status,401);
const login=await request('/api/auth/login',{username:'alice',password:'synthetic-password'});
assert.equal(login.status,200);
assert.equal((await request('/api/records',undefined,{cookie:login.cookie})).status,200);
await request('/api/auth/logout',{}, {cookie:login.cookie});
assert.equal((await request('/api/records',undefined,{cookie:login.cookie})).status,401);
```

### Task 2: Local process planning and signed consumers

**Files:** focused planning/database/transport modules, scripts/server.mjs/runtime scheduler, MCP subscription validation, connection copy; local planner/timer tests. Rename pure scheduler imports to explicit Node-compatible modules where needed; preserve all existing domain timing/guards.

- [ ] Read Task1 interfaces/spec. Write actual local callback/timer RED: public destination rejected, local HMAC challenge/event accepted, due persistent job delivered without a browser request, restart retains retry.
- [ ] Replace external domain policy with strict explicit loopback callback parsing; signed payload/rotation/cap/no redirects unchanged. Update UI connection labels to local storage/consumer/Runner; remove unsupported hosted/device cards.
- [ ] Implement startup timer60s/no in-process overlap, configurable disabled/tuned interval, graceful drain/stop; use persisted existing lease/CAS for multiprocess concurrency. Build must never start timers or open production state.
- [ ] Test no-sub/backfill/retry/backoff/lease/crash/exhaustion/manual cooldown/current-owner/revision limits on real local SQLite/HTTP consumer plus actual1-second server timer. No fake producer or private production callback.
- [ ] Run focused tests/build/types/lint and Task1 HTTP checks; commit/report source interfaces/evidence/concerns, no subagents/push.

### Task 3: Native API/MCP/browser fixtures and complete checks

**Files:** tests/local fixture, tests/auth, tests/planning, tests/mcp, tests/execution HTTP fixtures, tests/browser/checks, tests/harness, scripts/test-integration.mjs, package/CI. Keep pure domain/Docker/network isolation assertions; remove old emulation/auth fixtures.

- [ ] Port actual scenario assertions to native server processes and real local login/API tokens with fresh local file/ports; fixture owns only its tempdir, never copies credentials or existing state. Retain strict raw args/cursor/owner/projection/all-table readonly snapshots.
- [ ] Test real account login/logout/expiry/denial/late response and navigation/planning recovery in Chromium. All assets local, zero external requests; preserved restrictive browser network boundary.
- [ ] Exercise signed checkpoint route with synthetic service keys, approval/current registry and v1/v2 model ingestion without dispatching user-generated work. Preserve synthetic real Docker backend checks as separately explicit suite.
- [ ] Update harness/input allowlist to native source; tests capture failures and clean processes. Run two simultaneous independent instances and interruption shutdown; compare distinct persistent DB files and ports.
- [ ] Wire CI/default commands with locked install/build/types/lint/local API/MCP/Chromium, pure execution and mandatory Docker checks. Separate missing Docker from passing app scope; never leave a stalled owned process or fabricate success.
- [ ] Run complete native build/lint/types/app checks and applicable existing domain/network checks. Self-review/report/commit, no subagents/push.

### Task 4: Current-only documentation and navigation feature inventory

**Files:** README, AGENTS.md, docs/DEPLOYMENT.md/AUTHENTICATION.md/FEATURES.md/PLANNING.md/MCP-TASK-READS.md/EXECUTION.md/RUNNER.md/TESTING.md/ROADMAP.md and current source comments. Delete historical deployment/package/validation/implementation archives and stale project plans/specs; retain this current local spec/plan and relevant current backend contracts.

- [ ] Read audits and actual final source/test reports; rewrite docs as current local product/setup, with no prior hosting/identity version narrative or deprecated redirects.
- [ ] FEATURES.md actual nav sections: 点子收件箱,规划工作台,Ticket看板(授权面板),待我处理,执行记录,连接与执行,项目/通用工作区; MCP/localRunner functional sections. One sentence per implemented feature; distinguish manual snapshot vs actual Run and fixed validation operation vs arbitrary work. Keep supported UI state/operating conditions exact.
- [ ] Document local installation/account/token commands, DB files/checksum schema, startup/restart/process timer/consumer, signed Runner/checkpoint and current test entrypoints; no unsupported remote/provider prerequisites or copyable real credentials.
- [ ] Remove obsolete docs/examples/config/import/identifiers/dependencies referenced by old setup. Retain third-party skill/license provenance. Audit tracked source/dependency tree for actual removed platform runtime and links to deleted files; no invented tests that merely grep text.
- [ ] Final source-function/document self-review; run relevant checks only for changed behavior, whole independent review and actual native smoke/check evidence. Commit/report without external publish.
