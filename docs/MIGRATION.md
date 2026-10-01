# Migration handoff

## What works today

The current app stores owner-scoped Ideas, Plans, Tickets, immutable Run snapshot records, and history in D1. Idea revisions create planning jobs. MCP supports reading/claiming those jobs and saving a plan plus tickets; claim leases and revision checks prevent stale writes. Event delivery is bounded and signed, with callbacks restricted in `lib/events.ts` to trusted OpenAI HTTPS hosts. It is not a general-purpose webhook or execution runner.

## Hosting and identity boundary

Production identity currently comes from Sites dispatch headers: `oai-authenticated-user-id`, `oai-authenticated-user-email`, and optional encoded name headers. Sites owns the sign-in, sign-out, and callback routes. These are not standalone authentication services provided by this repository. Sites user IDs are Site-scoped; do not assume a newly registered Site or external identity provider will produce matching IDs.

Never trust public clients to set these headers. An independent host needs verified sessions, a server-controlled identity adapter, membership/owner authorization, and removal or rejection of spoofed identity headers at the trusted boundary. Audit the browser and MCP paths together. Preview mock login is local-only, not a production login solution. The live Site's owner-private access policy is platform state and is not carried in this ZIP.

## Persistence boundary

`DB` is a Cloudflare D1 binding. The two SQL migrations create `records`, `jobs`, and `subscriptions`; schema source and migration metadata are included. `cloudflare:workers`, D1 prepared statements/batches, and Worker runtime behavior are platform dependencies. Moving to a Node app server or another database requires an adapter and transaction/authorization tests; changing a connection string is not enough.

The placeholder database ID in `vite.config.ts` supports local emulation and does not identify the production database. No database files, record bodies, owner IDs, subscription endpoints, signing secrets, or data backups are included. Any future data migration must be a separate authorized operation with encrypted backup, tested restore, owner-ID mapping, and reconciliation. Recreate/rotate subscriptions for a new environment rather than copying signing secrets into Git.

## Deployment separation

The only hosting-config change in this package is deletion of the original `project_id`; D1 and MCP declarations remain for build compatibility. The original checkout and deployment were not changed. Treat this as an unregistered source template. Do not connect this new repository to the original Site or publish over it during development. Keep old production read/write behavior stable while new services are verified separately.

## Target architecture (planned, not implemented)

The migration direction is a private control-plane API plus independent identity, persistent Run/revision state, a tightly scoped app-server execution adapter in a dedicated workspace, durable progress events, approval/audit records, cancellation/reconnect, and evidence-based UI. Remote provisioning, credentials, app-server lifecycle, approvals, and execution permissions are all future work, not supplied by the ZIP. Planning output must never grant execution authority by itself.

Use the roadmap's single-ticket pilot and fault tests before any staged cutover. Preserve the original Site and rollback path until new storage, authorization, and execution recovery are validated.
