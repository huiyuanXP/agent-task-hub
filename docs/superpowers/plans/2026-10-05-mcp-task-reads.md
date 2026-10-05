# Readonly MCP task queries implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete #11 with safe paginated Ticket/Plan/Run MCP reads and current effective authorization context.

**Architecture:** Focused owner-scoped readonly query/DTO/cursor helpers integrate into the current MCP route, reusing real Run and authorization storage. Actual verified Worker tests prove privacy, pagination and mutation-free behavior.

**Tech Stack:** Locked Vinext/React/Cloudflare Worker/D1/JOSE, Miniflare, existing execution domain.

**Spec:** docs/superpowers/specs/2026-10-05-mcp-task-reads-design.md

## Global Constraints

- No production credentials/data/deploy/provisioning/Ticket execution; Worker/D1 only, fresh isolated D1 tests, preserve both locks and all existing tools/protocol envelopes.
- New reads require verified owner; every root/nested/union query includes owner; uniform missing/unowned root NOT_FOUND404, INVALID_INPUT400 under -32602.
- Readonly/non-destructive/idempotent/closed-world annotations; never claim, grant, start, mutate lease/audit or increase budgets.
- Exact runtime object validation and spec bounds: IDs200,project120,cursor2048,limit1..100/default20; priorityP0..P3,status/current Run enums verbatim from spec.
- Keyset created/id DESC; merged Run source DESC tie-breaker; context-bound canonical cursor binds owner/resource/normalized filters, excluding limit.
- Safe body allowlist and authoritative metadata; no token/secret/signature/owner-actor/request-input-key leakage; actual getAuthorization for effective status.
- get_ticket bounded first20 Run page; get_plan bounded first20 Ticket page; continuation through list tools, no silent unbounded nested collections.

### Task 1: Ticket/Plan readonly query core and MCP integration

**Files:** new focused lib/task-reads modules for cursor/validation/DTO/queries/schemas, app/mcp/route.ts minimal dispatch integration; tests/mcp/task-reads.mjs using planning fixture; package/CI entrypoints.

- [ ] Read spec, current records/history/planning and MCP/execution dispatcher. No generic server or duplicate auth boundary.
- [ ] Write RED actual Worker tests for absent tools, exact filtering and owner privacy before implementation; add meaningful malformed input and pagination cases as behavior grows.
- [ ] Implement runtime schemas/validation, bound canonical cursor and parameterized owner-scoped keyset Ticket/Plan lists. Use limit+1; stable equal-created ordering and page-size-independent context.
- [ ] Implement get_ticket/get_plan current record metadata and safe linked current/original Idea/history, superseded linkage, Plan and bounded linked Tickets. Task2 adds Run collections; avoid fake/stub Run values.
- [ ] Integrate first4 readonly tools with existing envelopes and validated owner, sanitized ExecutionError failures. Prove original tools/protocol compatibility and no private metadata/body-key override.
- [ ] Run build/lint/types/new actual Worker tests/current planning regression; assert no persistent mutation from reads. Commit as strix agent, full RED/GREEN/self-review report; no push/PR/subagents.

Task1 behavior anchors (literal expectations; the production change that must fail these tests is removing owner/cursor/limit validation):

```js
const listed = await rpc('list_tickets', {project:'Alpha',status:'todo',priority:'P1',limit:1});
assert.equal(listed.result.structuredContent.items.length, 1);
assert.equal(listed.result.structuredContent.items[0].id, 'ticket-z'); // fixed equal-created fixtures z then a
assert.ok(listed.result.structuredContent.next_cursor);
const next = await rpc('list_tickets', {project:'Alpha',status:'todo',priority:'P1',limit:2,cursor:listed.result.structuredContent.next_cursor});
assert.deepEqual(next.result.structuredContent.items.map(row=>row.id), ['ticket-a']);
const bad = await rpc('list_tickets', {limit:0});
assert.equal(bad.error.data.code, 'INVALID_INPUT');
const foreign = await rpc('get_ticket', {ticket_id:'bob-only'});
const missing = await rpc('get_ticket', {ticket_id:'absent'});
assert.deepEqual(foreign.error, missing.error);
```

Owner/keyset query construction anchor (add spec filters with bound values, never interpolate user strings):

```sql
SELECT * FROM records
WHERE owner=? AND kind='ticket'
  AND (created < ? OR (created = ? AND id < ?))
ORDER BY created DESC,id DESC LIMIT ?
```

### Task 2: Real and legacy Run/effective-authorization reads and final contract

**Files:** new focused Run query module and Task1 query/schema module, app/mcp/route.ts integration, tests/mcp/task-reads.mjs or runs.mjs; docs/MCP-TASK-READS.md, docs/TESTING.md, docs/STRIX-IMPLEMENTATION.md, package/CI.

- [ ] Read Task1 interfaces/report and spec. RED tests missing list_ticket_runs/get_ticket Run page plus cross-source tie pagination/owner links/frozen contracts/effective statuses.
- [ ] Implement owner-filtered SQL union/keyset of manual snapshots and execution_runs with source tie-breaker. Exact source/state filters; manual remains snapshot regardless its reported done status. Include bounded safe frozen context/evidence summary without signing bytes/authority keys.
- [ ] Reuse getAuthorization and verify same Run/Ticket/revision binding; project safe effective status/scope/budget/expiry only. get_ticket adds same default20 page with next_cursor. No duplicate run/authorization logic.
- [ ] Prove auth expiry/revocation/stale revision/definition and no real process start, arbitrary secret/key filtering, uniform root errors, forged/foreign context cursors denied and all tables unchanged after every readonly tool.
- [ ] Document exact schemas/result fields/error codes/readonly semantics and continuation/legacy boundary. Add default/hosted entrypoints covering all actual Worker cases.
- [ ] Run covering Worker regression plus lint/types/build/current auth/planning/Chromium/integration. Full npm test where local Docker exists; absent Docker remains disclosed and required hosted CI. Self-review and commit as strix agent; full evidence report, no push/PR/subagents.

Task2 union pagination anchor (outer predicates bind source/state/position, all table branches scope owner and root ticket):

```sql
SELECT * FROM (
  SELECT id,created,'manual' AS source,'snapshot' AS state,body AS contract
  FROM records WHERE owner=? AND kind='run' AND json_extract(body,'$.ticketId')=?
  UNION ALL
  SELECT id,created,'execution' AS source,state,ticket_body AS contract
  FROM execution_runs WHERE owner=? AND ticket_id=?
)
WHERE created<? OR (created=? AND (id<? OR (id=? AND source<?)))
ORDER BY created DESC,id DESC,source DESC LIMIT ?
```

Task2 expected effective-authorization projection (use actual domain helper, not persisted status alone):

```ts
const grant = await getAuthorization(db, {owner,actor:owner}, run.authorization_id);
const bound = grant.runId === run.id && grant.ticketId === run.ticket_id && grant.ticketRevision === run.ticket_revision;
const authorization = bound ? {id:grant.id,run_id:grant.runId,ticket_id:grant.ticketId,
  ticket_revision:grant.ticketRevision,status:grant.status,effective_status:grant.effectiveStatus,
  expires_at:grant.expiresAt,scope:grant.scope,budget:grant.budget} : null;
```
