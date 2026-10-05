# 12-ticket migration roadmap

Current tracking lives in [GitHub roadmap issue #27](https://github.com/huiyuanXP/agent-task-hub/issues/27), with the [published issue index](GITHUB-ISSUE-ROADMAP.md). The outline below is the original migration handoff; initial VM1 verification has since completed, and open implementation/integration work is tracked in those issues.

Concise handoff based on the existing migration plan summary. This is a roadmap, not a live task/database export or a claim that implementation has begun. The exact persisted ticket bodies were not queried during packaging. This historical outline does not reflect current completion status; each stage gates dependent stages. Independent identity is now implemented and locally verified in source (see [AUTHENTICATION.md](AUTHENTICATION.md)); new provider resources and live operational acceptance remain separately scoped.

## 01. Remote and baseline

Scope: Inventory the approved Remote/runtime and capture the source baseline without changing live production.

Acceptance: A reproducible environment inventory and source baseline are recorded; access boundaries are explicit.

## 02. Backup and restore

Scope: Design a separately authorized encrypted backup and exercise restore in isolation.

Acceptance: A restore drill reconciles counts/revisions and documents rollback; no secrets or exports enter Git.

## 03. Dedicated workspace

Scope: Create a separate execution workspace with scoped filesystem and network access.

Acceptance: A test run cannot mutate the original production workspace or access unintended resources.

## 04. Independent identity

Scope: Implement verified sessions and owner/membership enforcement for UI, API, and MCP.

Acceptance: Anonymous, spoofed-header, and cross-owner access tests fail safely; ID mapping is specified.

## 05. Run and revision model

Scope: Define immutable execution contracts tied to ticket revisions and idempotent run creation.

Acceptance: Stale revisions are rejected and retries do not create duplicate runs.

## 06. Controlled app-server adapter

Scope: Add an allowlisted execution adapter with explicit authorization and resource limits.

Acceptance: Only approved operations execute; an unapproved request cannot start work or expand permissions.

## 07. Durable progress events

Scope: Persist ordered events and resumable cursors independently of live connections.

Acceptance: Replay after disconnect has no missing or duplicate effective state transitions.

## 08. Approval and audit trail

Scope: Record requests, approvals, decisions, actor identity, and consequential actions.

Acceptance: Every gated action has matching valid approval evidence and an inspectable audit record.

## 09. Cancellation and reconnect

Scope: Implement cancellation, lease recovery, reconnection, and terminal-state reconciliation.

Acceptance: Crash/restart and cancellation tests leave no unnoticed duplicate or orphan execution.

## 10. Progress and evidence UI

Scope: Display actual execution state, waiting reason, event history, and acceptance evidence.

Acceptance: UI distinguishes planning, running, waiting, failed, and complete; completion requires evidence.

## 11. Single-ticket pilot and fault tests

Scope: Run one bounded approved ticket with auth, retry, crash, timeout, and rollback tests.

Acceptance: Acceptance and safety tests pass with recorded evidence before expanding execution.

## 12. Staged cutover and rollback

Scope: Migrate only after pilot acceptance; reconcile ownership/data and retain the old private Site.

Acceptance: A staged transition and rollback rehearsal pass; production changes receive separate approval.
