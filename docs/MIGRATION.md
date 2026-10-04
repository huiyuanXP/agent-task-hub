# Migration handoff

## What works today

The current app stores owner-scoped Ideas, Plans, Tickets, immutable Run snapshot records, and history in D1. Idea revisions create planning jobs. MCP supports reading/claiming those jobs and saving a plan plus tickets; claim leases and revision checks prevent stale writes. Event delivery is bounded and signed, with callbacks restricted in `lib/events.ts` to trusted OpenAI HTTPS hosts. It is not a general-purpose webhook or execution runner.

## Hosting and identity boundary

Built Workers default to independent Cloudflare Access verification, exact-origin protection and explicit private membership. UI, API and MCP share one request-scoped verified identity; caller-supplied Sites headers are stripped. Missing configuration fails closed. See [AUTHENTICATION.md](AUTHENTICATION.md) for public metadata, safe session DTO, expiry, token transports and same-origin POST logout revocation.

Access owners are namespaced hashes of issuer and subject. Existing Sites owners are not silently mapped to them. Reconciliation of imported owners, backup/restore and production migration remain separately authorized issue #7 work. A SourceMember's account access is not execution approval or permission to invoke a backend.

Portable development is loopback-only and explicitly labeled. Synthetic legacy tests require both `AUTH_MODE=trusted-sites` and `AUTH_TRUST_SITES_HEADERS=1`; never enable that trust on an independently exposed public endpoint. New Access application registration, ingress/alternate-route protection and actual SSO acceptance remain issue #5. This source does not carry the original Site's platform access policy.

## Persistence boundary

`DB` is a Cloudflare D1 binding. The ordered SQL migrations create planning records/jobs/subscriptions, execution Runs/authorizations and local auth revocations; schema source and migration metadata are included. Apply all `drizzle/*.sql` in filename order exactly once to fresh isolated D1 state, as shown in README. Never reapply raw SQL to an existing schema. `cloudflare:workers`, D1 prepared statements/batches, and Worker runtime behavior are platform dependencies. Moving to a Node app server or another database requires an adapter and transaction/authorization tests; changing a connection string is not enough.

The placeholder database ID in `vite.config.ts` supports local emulation and does not identify the production database. No database files, record bodies, owner IDs, subscription endpoints, signing secrets, or data backups are included. Any future data migration must be a separate authorized operation with encrypted backup, tested restore, owner-ID mapping, and reconciliation. Recreate/rotate subscriptions for a new environment rather than copying signing secrets into Git.

## Deployment separation

The only hosting-config change in this package is deletion of the original `project_id`; D1 and MCP declarations remain for build compatibility. The original checkout and deployment were not changed. Treat this as an unregistered source template. Do not connect this new repository to the original Site or publish over it during development. Keep old production read/write behavior stable while new services are verified separately.

## Remaining architecture

Independent identity, persistent Run/revision state and explicit approval records now exist in source. The remaining direction includes a tightly scoped app-server execution adapter in a dedicated workspace, durable progress events and cancellation/reconnect. Resource provisioning, credentials and real app-server execution lifecycle remain future work. Planning output must never grant execution authority by itself.

Use the roadmap's single-ticket pilot and fault tests before any staged cutover. Preserve the original Site and rollback path until new storage, authorization, and execution recovery are validated.
