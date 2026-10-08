# Workspace Loop Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with the user's explicitly authorized parallel implementation. Shared state, API contract decisions and integration belong to the controller.

**Goal:** Deliver an installable project-scoped MCP client, visible connection management and an approved local planning/development/acceptance loop.

**Architecture:** Separate browser owner sessions from project-scoped connector credentials. A standalone Node package serves STDIO MCP and a persistent Agent daemon; the daemon polls revision-bound planning and approved development jobs. Existing Docker operations stay distinct from local development.

**Tech Stack:** Node >=22.23.3, existing locked Next/React, SQLite, Codex CLI JSONL and schema output.

**Spec:** `docs/superpowers/specs/2026-10-08-workspace-loop-design.md` and its three linked subproject specs.

## Global Constraints

- Preserve existing uncommitted native test migration and preview SQLite data.
- No simultaneous builds while preview serves the same `.next`; controller owns build/restart.
- User approved implementation and synthetic real project work; per-Ticket approvals are product functionality, not extra development permission gates.
- Machine connections never receive owner API tokens, never approve their own tasks, never cross projects.
- Exact meaningful functional checks, no duplicate review loops; extra critical review allocation at outset: 120 seconds / 1,200 tokens.
- Default loopback listener, canonical public HTTPS URL, outbound-only clients.
- Codex is currently not logged in; do all independent work, but no fabricated live model success.

## Shared interfaces (controller-owned)

Owner `GET /api/connectors` returns `{connections,projects}`. Each project is `{id,name}`. Each connection is `{id,name,projectId,project,version,status,lastSeen,agentReady,agentError,capabilities,revokedAt}`; timestamps use epoch milliseconds.

Owner `POST /api/connectors` actions:

```json
{"action":"invite","project":"通用","name":"本机工坊","capabilities":["read","submit","plan","execute"]}
```

Returns `{code,expiresAt,projectId,project,origin,downloadUrl}`. Revoke accepts `{action:"revoke",connectionId}`.

Public `POST /api/connector/enroll` accepts `{code,name,version,workspace}` and returns `{token,connection,origin}`; workspace is a display name, no remote-selected local absolute path.

Machine `POST /api/connector/heartbeat` with bearer token accepts `{mode:"mcp"|"agent",version,agentReady,error?}`. Returns `{connection}`.

Machine `POST /api/connector/mcp` serves JSON-RPC. Tools include project-bound existing planning and Ticket/Plan reads, `create_ticket`, `fail_planning_job`. Connector cannot call owner decisions or arbitrary events. Standard planning signatures and result fields match existing `/mcp`.

Service functions from `lib/connectors/service.mts`:

```ts
authenticateConnector(db, headers): Promise<ConnectorPrincipal>
// ConnectorPrincipal = {id:string,owner:string,projectId:string,project:string,capabilities:string[]}
```

Machine `POST /api/connector/agent` accepts `{action:"claim"}` and returns `{job:null}` or `{job:{id,leaseToken,ticketId,revision,body,leaseExpiresAt,timeoutMs}}`. Other actions use `{action,runId,leaseToken,...}`: renew returns `{leaseExpiresAt,cancelRequested}`; event adds `{eventId,stage,message}`; complete adds `{result:{summary,diff,files,tests,worktree,agentSession?}}`; fail adds `{error}`. Tests are `{command,exitCode,output}`; files are strings. JSON requests have bounded body/field sizes.

Owner `GET /api/workspace-runs?ticketId=...` returns `{runs}` with fields `{id,ticketId,revision,connectionId,project,state,createdAt,updatedAt,timeoutMs,error,result,events}`. Events have `{id,sequence,stage,message,createdAt}`.

Owner `POST /api/workspace-runs` prepare accepts `{action:"prepare",ticketId,revision,connectionId,requestId,timeoutMs}`. Actions approve, reject, cancel, accept and rework accept `{action,runId}`. Returns `{run}`. States: pending, approved, running, review, succeeded, failed, cancelled. Approvals freeze Ticket revision; review requires real result evidence.

## Task 1 — Connector registration, scoped MCP and status

**Files:** `migrations/004_connectors.sql`, `lib/connectors/*.mts`, `app/api/connectors/route.ts`, `app/api/connector/{enroll,heartbeat,mcp}/route.ts`, shared MCP domain extraction if necessary, `scripts/server.mjs`, `tests/connectors/*`.

- [ ] Implement owner-scoped stable projects, single-use 10-minute invitations, hashed connector tokens, 30-day expiry/revocation, atomic enrollment.
- [ ] Exempt only explicit machine routes from owner-session boundary, authenticate inside each route; retain browser origin protections.
- [ ] Implement scoped machine tools and planning claims/saves using real existing domain semantics; enforce project on every ID and list.
- [ ] Implement heartbeat, last use and 45/90-second status derivation; distinguish MCP recent-use from daemon online.
- [ ] Prove invitation replay denial, revoked/project-separated access, actual claim/save and heartbeat via meaningful domain/API tests. Do not build shared output.

Example functional assertion:

```js
assert.equal((await machine.call('list_tickets',{})).items.every(t=>t.project==='test'),true);
await owner.revoke(connection.id);
assert.equal((await machine.request('/api/connector/heartbeat',{})).status,401);
```

## Task 2 — Standalone installer, MCP and daemon

**Files:** `connector/package.json`, `connector/*.mjs`, `connector/README.md`, `scripts/package-connector.mjs`, client unit/process checks. Root controls application package and download route.

- [ ] Build self-contained Node package with install, doctor, mcp, agent, set-url and uninstall subcommands; credentials 0600.
- [ ] Add project-local MCP configuration and optional Codex registration, preserve existing unrelated client config; print exact usable command.
- [ ] Implement actual STDIO initialization/tool forwarding; diagnostics/heartbeat and stable install ID.
- [ ] Implement genuine Codex read-only schema planning and workspace-write JSONL development with Git worktree, bounded process/lease lifecycle, actual tests and diff.
- [ ] Package only runtime/guide files; test unpacked archive in temporary Git project with real protocol messages. Do not require repository symlinks.

Example package smoke command:

```sh
node connector/cli.mjs doctor --config /tmp/ath-test/.agent-task-hub/connection.json
```

## Task 3 — Approved local development Run service

**Files:** `migrations/005_workspace_runs.sql`, `lib/workspace-runs/*.mts`, `app/api/workspace-runs/route.ts`, `app/api/connector/agent/route.ts`, `tests/workspace-runs/*`.

- [ ] Freeze Ticket/connection/project/timeout on idempotent preparation; explicit owner approve/reject/cancel/accept/rework.
- [ ] Implement transactional exclusive claims, finite lease/generation, renewal, ordered idempotent events, evidence completion and failure.
- [ ] Check connection revocation, project, Ticket revision and task cancellation at every consequential mutation.
- [ ] Persist immutable result/evidence and mark Ticket done only at owner acceptance; retain prior Run results.
- [ ] Validate competing claims, stale revision, owner/worker permission separation, revoke/cancel/expiry and actual result requirements without Docker dependency.

## Task 4 — Owner UI, download and current documentation

**Files:** `components/connectors/*.tsx`, `components/workspace-runs/*.tsx`, `app/page.tsx`, `app/install/page.tsx`, `app/api/connectors/download/route.ts`, `app/globals.css`, current docs.

- [ ] Make connector cards actionable: guide, package download, invite, installation command, project and capability choice.
- [ ] Show connection states/details/revoke, automatic status refresh, live Agent authentication failure.
- [ ] Show pending approvals, development events/diff/tests, cancellation and acceptance alongside existing distinct Docker operation panel.
- [ ] Add package build script to application build sequence and downloadable immutable runtime archive; package and installation guide are public code/instructions with no credentials; all owner and client data remain authenticated.
- [ ] Complete native current-only docs and FEATURES with actual source behavior, retaining user AGENTS directions.

## Task 5 — Controller integration and self-hosted acceptance

- [ ] Run one sequential fresh build, types and lint; fix actual failures.
- [ ] Run selected native auth/planning/MCP integration and all new behavioral checks once; do not report old interrupted run as passing.
- [ ] Fresh Git project, real archive download/install, actual STDIO MCP initialization and submission, backend registration and browser state.
- [ ] Start daemon, observe model readiness and online/offline/reconnect/revoke. Real model step requires local login.
- [ ] Complete one real approved development Ticket with actual worktree diff/test evidence and browser acceptance, then use the same registered connector for the factory's own project.
- [ ] Preserve two existing user ideas, provision factory connector, refresh preview, write actual evidence and limitations.
- [ ] Commit owned source changes, integrate visible primary reversibly if clean; no external push/merge/publish without task scope.

Only mark tasks and the full objective complete with actual delivered evidence.
