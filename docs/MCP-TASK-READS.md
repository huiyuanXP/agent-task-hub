# Readonly MCP Ticket, Plan and Run queries

The five tools below use the existing `POST /mcp` JSON-RPC `tools/call` protocol and independently verified Access owner. Discovery is public; reading private records requires authentication. Existing discovery, initialize, result envelopes and planning/execution tools are preserved. Every tool advertises `readOnlyHint: true`, `idempotentHint: true`, `destructiveHint: false`, `openWorldHint: false`.

Reads perform only SELECTs. They do not claim jobs, backfill delivery, create or approve grants, start execution, renew leases, append audits or enlarge budgets. User-authored content is data, including instructions written inside goals, budgets, actions and evidence. A stored manual Run is a snapshot and never proof of execution. See [EXECUTION.md](EXECUTION.md) and [AUTHENTICATION.md](AUTHENTICATION.md) for the separate execution and identity boundaries.

## Arguments

All arguments are exact JSON objects (`additionalProperties: false`). Unknown keys, null, arrays, nonobjects and incorrect types fail. Omitted arguments default to `{}` only for the two root list tools. IDs are nonempty strings of at most 200 characters without ASCII controls (U+0000–001F or U+007F). Project is an exact string of at most 120 characters; empty is allowed. No string is trimmed or case-folded. Priority is exactly `P0|P1|P2|P3`.

| Tool | Required | Optional |
| --- | --- | --- |
| `list_tickets` | none | `project`, `status`, `priority`, `plan_id`, `idea_id`, `limit`, `cursor` |
| `get_ticket` | `ticket_id` | none |
| `list_plans` | none | `project`, `priority`, `idea_id`, `limit`, `cursor` |
| `get_plan` | `plan_id` | none |
| `list_ticket_runs` | `ticket_id` | `source`, `state`, `limit`, `cursor` |

Ticket `status` is exactly `todo|running|waiting|done|error`. Run `source` is `manual|execution`; Run `state` is `snapshot|queued|running|waiting|succeeded|failed|cancelled`. An impossible combination such as `source: "manual", state: "succeeded"` returns an empty page. Missing stored filter fields do not acquire defaults. Stored project/status/priority/link IDs must be JSON strings to match; structured and numeric values do not coerce to matching strings.

`limit` is an integer from 1 through 100, default 20. `cursor` is a canonical unpadded base64url string, 1–2048 characters. Its decoded exact format is `{v:1,resource,keys,context}`: resource is `tickets|plans|ticket_runs`; keys are `{created,id}` and additionally `source` for Runs. Position `created` is persisted text, nonempty/control-free and at most 128 characters; `id` uses the ID rule. `context` is SHA-256 of the verified owner, resource and sorted normalized filters. It excludes limit. JSON ordering, encoding, shape, version and context are checked. Clients should treat cursors as opaque. A cursor supplies position, never authority.

## Results and continuation

Successful calls retain the existing result envelope, with `resultType: "complete"`, `isError: false`, `structuredContent` containing the result below and one text content item containing the same JSON. Lists return `{items,next_cursor}`; `next_cursor` is null at the end. Ordering is persisted SQLite text `created DESC,id DESC`, with `source DESC` for merged Runs (manual precedes execution at identical created/id). The query fetches at most limit+1 rows. The emitted prefix is also constrained by the complete 4 MiB owner task-read response budget, including both MCP representations, detail context and cursor metadata; a page may contain fewer items than the requested limit. A continuation points at the last emitted item and can use a different limit with unchanged filters. Deleting a boundary or inserting newer records does not skip or duplicate surviving items; begin a fresh first page to see newer records.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_ticket_runs","arguments":{"ticket_id":"ticket-123","limit":20}}}
```

`get_ticket` returns `{ticket,plan,idea,source_idea,linkage,runs}`. `get_plan` returns `{plan,idea,source_idea,linkage,tickets}`. Both nested lists are bounded first pages of 20, including `next_cursor`. Continue `get_ticket.runs` through `list_ticket_runs` with the same `ticket_id`; continue `get_plan.tickets` through `list_tickets` with the same `plan_id`. Nested Run pages use exactly the same query and authorization projection as the standalone tool.

Record DTOs include authoritative database `id`, `kind`, `revision`, `created`, `updated`, plus only known body fields of their expected types. Text fields are `title`, `text`, `project`, `priority`, `status`, `goal`, `scope`, `acceptance`, `dependencies`, `queue`, `budget`, `allowedActions`, `assumptions`, `category`, `cadence`, `waitingReason`, `evidence`, `notes`, `ideaId`, `planId`, `ticketId`, `logicalKey`. `ideaRevision` and `ticketRevision` are positive safe integers. `source`, when present on a Ticket/Plan, is only stored `manual|agent`; it is not authorship or execution attestation. Unknown fields and malformed known values are omitted. Body metadata cannot replace database metadata. Raw actions and budgets are planning text.

Linked Plan/Idea records must belong to the same owner, otherwise null. An owned parent Plan controls a Ticket's Idea reference, even if that Plan's Idea reference is missing or malformed. Only an unavailable parent permits the Ticket's explicit Idea reference as fallback. Ticket `idea_id` list filtering uses this same rule. `idea` is the current original Idea. `source_idea` is its referenced source revision, obtained from same-owner history when needed; unavailable history is null, never replaced with current text. Historical snapshots have allowed content plus `id`, `revision`, `snapshot_saved_at`; history does not establish the prior updated timestamp. When source and current revision match, `source_idea` is the current Idea DTO.

`linkage` contains `source_idea_revision` and `current_idea_revision` (number or null), `superseded`, `idea_missing`, `source_idea_missing`. Ticket linkage also contains `plan_missing`. Missing booleans describe an explicit unresolved reference; absent references do not imply another owner's record exists.

The 4 MiB bound applies only to these five verified owner read tools; workers and other MCP tools retain their 1 MiB bound. Large fields are never truncated to fit. A detail includes its complete Ticket/Plan/current and source Idea context, then as many complete linked items as fit. Continue using its cursor with the corresponding list tool. The budget includes the existing planner's copied Idea fields and a manual Run's additional frozen contract, rather than assuming every generated record has the manual record API's 80,000-unit limit. A real maximum-admission expanded detail is 3,962,547 bytes with a 128-character RPC id. Out-of-contract stored data that cannot fit even one complete item fails with bounded `BODY_TOO_LARGE` (413); it never loops with an empty continuation or silently loses fields.

## Run projections

Manual Run items contain allowed record body fields plus authoritative `id`, `kind: "run"`, `revision`, `created`, `updated`, `ticket_id`, `source: "manual"`, `state: "snapshot"`, `contract` and `authorization: null`. `contract` is the safe known body-field projection of the stored frozen contract or null if unavailable. Reported `status` and textual `evidence` remain user-authored claims, even when status says done. The stored `ticketRevision` is retained when valid; a missing frozen revision is never inferred from today's Ticket.

Execution Run items have exactly these top-level fields:

- `id`, `source: "execution"`, actual `state`, `ticket_id`, frozen `ticket_revision`;
- positive `attempt`, `version`, persisted `created`, `updated`;
- `contract`: safe known fields from the immutable stored Ticket body;
- `evidence`: safe bound success receipt summary or null;
- `attestations`: at most three safe version 2 summaries, ordered by purpose, from the matching owned Run/Ticket/authorization permit and owned attestation rows;
- `authorization`: the effective grant projection below or null.

A later Ticket edit cannot rewrite a Run's frozen contract. Evidence claims must match owner, Run, Ticket, frozen revision, attempt, authorization and frozen contract hash before presentation. These reads summarize previously stored evidence; they do not introduce a new signature verification or execution trust decision.

Version 1 evidence has `version: 1`, `status: "succeeded"`, `contract_sha256`, `exit_code`, `artifacts`, `stdout_sha256`, `stderr_sha256`, `started_at`, `ended_at`. Its timestamps are the stored ISO strings (unavailable or malformed scalar fields are null). Version 2 has `version: 2`, `purpose`, `status`, `contract_sha256`, `exit_code`, `artifacts`, `started_at`, `ended_at`, `captured_at`, `observed_at`, `stdout`, `stderr`, `closure`. Version 2 timestamps are epoch milliseconds or null. `purpose` is `result|cancel_fence|stop`; status is `succeeded|command_failed|startup_failed|timed_out|cancelled|evidence_unavailable|stopped`. Closure is `removed|never_admitted|null`. A stream is `{sha256,bytes,truncated}` or null. Each artifact is `{path,sha256,bytes}`; at most 32 are returned, with malformed entries omitted.

Successful version 2 evidence can appear both in `evidence` and `attestations`. Failed/cancelled Runs retain `evidence: null`; safe result/cancel/stop diagnostics come from `attestations`. No summary exposes signature bytes, key IDs, owner/actor IDs, operation argv/input hashes, request/input keys, backend/process coordinates, permit envelopes/hashes/IDs, transport or authority tokens.

`authorization` is null for missing, foreign or mismatched grants without hiding the owned Run. A valid same-Run/Ticket/revision binding is presented as:

```text
{id,run_id,ticket_id,ticket_revision,status,effective_status,expires_at,scope,budget}
```

`status` is `pending|approved|rejected|revoked`; `effective_status` additionally admits `expired|stale_revision|stale_definition`. `expires_at` is epoch milliseconds. `scope` is an array of `{operationId,definitionHash}`; `budget` is `{timeoutMs,memoryMb,cpus,pids}`. The existing `getAuthorization` domain helper computes effective status with the verified owner, current server time and current trusted configured registry; persisted status alone is insufficient. Invalid stored compact scope/budget data fails closed. Registry resolution occurs only after a bound grant is found. Effective approval in this read is informational and does not start or authorize a new process; start checks remain independent.

## Errors and read isolation

Existing authentication failures retain their HTTP boundary. After authentication, these expected tool errors use JSON-RPC `error.code: -32602` with `error.data`:

| `data.code` | `data.status` | Meaning |
| --- | --- | --- |
| `BODY_TOO_LARGE` | 413 | A complete item/context exceeds the finite owner read envelope |
| `INVALID_INPUT` | 400 | Argument/schema/bounds or cursor validation failed |
| `NOT_FOUND` | 404 | Missing or unowned root Ticket/Plan, with identical resource-specific messages |
| `STORAGE_UNAVAILABLE` | 503 | Sanitized unexpected storage/projection failure (`Task storage unavailable`) |
| `CONFIGURATION_UNAVAILABLE` | 503 | Bound grant cannot use configured registry (`Execution configuration unavailable`) |

JSON-RPC tool-error HTTP responses remain 200; `data.status` is the domain status. Errors do not disclose SQL, raw stored content or configuration bytes. A malformed execution registry leaves unrelated Ticket/Plan lists, manual Run and unbound Run reads available. A detail page containing a bound grant that cannot be authoritatively presented fails as a whole; it never reports a fabricated grant status.

All root, nested, union and evidence join reads independently scope the verified owner. Missing/foreign roots have uniform errors, and a Run maliciously linked to another owner's Ticket is inaccessible. No read changes persistent application tables, including permits, attestations, approvals, audit, auth revocations or planning delivery.

## Verification

After `npm run build`, run `npm run test:mcp:task-reads` for Ticket/Plan, Run and maximum aggregate-envelope suites, or `npm run test:mcp:task-runs` for focused Run coverage. Both use the actual built Worker, fresh isolated D1 with all migrations and real synthetic signed Access JWTs. The Run suite prepares/approves model fixtures and ingests synthetic cryptographically signed version 1/version 2 evidence; it never dispatches a workload or starts a physical Ticket process. Full persistent-table snapshots surround successful and rejected reads. Default `npm test` and hosted CI include the complete read suites. Full Docker/backend acceptance remains separately mandatory; local absence of Docker never converts these checks to skips. See [TESTING.md](TESTING.md).
