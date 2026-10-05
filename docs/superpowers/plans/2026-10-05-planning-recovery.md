# Durable planning recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete issue #10 with durable per-target retries, bounded automatic recovery and a usable planning recovery UI.

**Architecture:** D1 stores guarded outbox attempts and planning recovery generations; scheduled/request workers share delivery and recovery functions. Authenticated API/MCP controls claims/manual retries. React consumes safe authoritative status metadata.

**Tech Stack:** Existing locked Vinext/React/Cloudflare Worker/D1/Drizzle, Miniflare and isolated Playwright.

**Spec:** docs/superpowers/specs/2026-10-05-planning-recovery-design.md

## Global Constraints

- Worker/D1; no generic Node server or production resources/credentials/deploy/migration/Ticket execution.
- Preserve both locks, existing edits and all auth, approval and runner behavior; use npm run install:ci if needed.
- Fresh isolated D1 only for tests; generated migrations and snapshot/journal must match db/schema.ts.
- Exact owner/current revision/generation/CAS guards; API/MCP/UI never expose callback secrets or claim/delivery tokens in readonly metadata.
- Timeout8s, delivery lease30s, retry30/60/120/240s,5 attempts; accepted wake5min, planning lease10min,3 automatic recoveries, manual cooldown60s.
- Request/backfill discovery50 jobs per invocation, scheduled outbound20 targets per tick; stable event ID within a generation; cron */1 * * * *.
- No implicit execution or approval; no placeholder implementation. Runtime shape/type validation at new/modified inputs.

### Task 1: Durable delivery and scheduled recovery engine

**Files:** db/schema.ts, generated drizzle migration/meta, lib/events.ts, new focused lib/planning-delivery.ts and lib/planning-recovery.ts as appropriate, lib/types.ts, build/sites-worker.ts, vite.config.ts, app/mcp/route.ts claim/save predicates; tests/planning/fixture.mjs and new recovery.mjs; package and CI check entrypoints.

- [ ] Read the spec and current jobs/subscriptions/Worker build flow. Keep signing/allowlist helpers reusable; avoid import cycles through events.
- [ ] Extend the actual Worker test fixture with opt-in controlled outbound callback/HMAC assertions, request/event scheduling and restart over the same temporary D1 (default unexpected-outbound denial stays).
- [ ] Write meaningful RED actual Worker checks for missing per-target persistence, signed subscribe backfill/cron retry, consumer-disappearance and expired claims before production edits. Assert durable states and observed callbacks rather than source strings.
- [ ] Generate migration for jobs recovery columns and per-target outbox with due indexes/unique generation. Implement bounded lease acquisition/result CAS, signature status classification, persistent retries, summary and backlog discovery from the spec.
- [ ] Implement current/done suppression, expired planning-token CAS and accepted-unclaimed bounded recovery with fresh event generations. Export shared manual/recovery/metadata interfaces for Task2; no duplicate lifecycle logic.
- [ ] Register actual Worker scheduled handler and generated */1 * * * * cron. Test via real scheduled dispatch and Worker restart. Extend claim/save atomic SQL where recovery would otherwise race a planner save.
- [ ] Complete actual Worker tests for timeout, multiple subscribers/owners/project, backoff/permanent/410/redirect, delivery concurrency/crash, recovery exhaustion, done/stale suppression and secret/token privacy. Manipulate only fixture D1 timestamps to avoid waiting minutes.
- [ ] Run build, tsc, lint, new Worker regression and previous revisions regression. Document exact evidence/RED failures and safe metadata interfaces in task report. Commit with strix agent identity. No push/PR/subagents; controller performs review.

### Task 2: Authenticated lifecycle integration and visible recovery

**Files:** app/mcp/route.ts, app/api/planning/route.ts, lib/planning-state.ts, lib/types.ts, app/page.tsx; tests/planning/recovery.mjs or lifecycle.mjs, tests/browser/checks.mjs and/or auth/browser.mjs; docs/PLANNING.md, docs/TESTING.md, docs/STRIX-IMPLEMENTATION.md, package and CI entrypoints.

- [ ] Read Task1 report/shared functions and spec. Write RED actual Worker checks for subscribe/refresh backfill, active vs expired manual retry,60s cooldown and concurrent retry CAS, and all exposed safe lease/retry/failure metadata. Any Task1-covered assertion need not be duplicated.
- [ ] Wire verified subscriptions to shared bounded backfill/delivery; unsubscribe updates safe target reasons. Manual POST uses shared CAS lifecycle, runtime valid ideaId, no active-lease reset, no repeated-generation growth. MCP claims/saves retain exact/current/expiry guards and original tools/protocol envelopes.
- [ ] Expose authoritative metadata in Idea/read planning APIs through shared helper without read-side mutation. UI shows active expiry/expired/failure/backoff/retry eligibility and enables recovery when eligible, preserving account/version guards.
- [ ] Write/observe RED real Chromium recovery states before UI behavior edits, then prove lease countdown/expired retry/permanent and backoff status. Tests only loopback with network policy; synthetic state belongs in fixtures.
- [ ] Update operator docs describing cron, migrations, at-least-once event IDs, bounds/manual retry, exact statuses and scope; add default/hosted check entrypoints if necessary.
- [ ] Run covering Worker/Chromium plus build, lint, tsc and full npm test. Self-review, commit as strix agent, full report with evidence and concerns. No push/PR/subagents; controller performs task and whole-issue review.
