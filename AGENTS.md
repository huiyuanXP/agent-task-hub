# Agent Task Hub collaboration

## Project direction

The project is changing from the first implementation—ChatGPT reading the project,
creating plugins, Cloudflare hosting and OpenAI OAS/OAuth identity—to a fully local
server deployment. Implement and document the local server as the sole application
architecture. This paragraph is the only place to retain that direction-change
context; remove the previous hosting/authentication setup from application code,
configuration, tests and other documentation instead of marking it deprecated.

## Repository skills

Read `.agents/skills/using-superpowers/SKILL.md` and relevant repository skills
before working. Resolve `superpowers:<name>` to the repository skill of that name;
use the repository copy once, without repeating the global plugin workflow.
Vendored skill examples are tooling, not application source. Keep their provenance
and third-party notices. User scope and authorization take precedence over skills.

## Local application boundaries

- Use Node.js 22.23.3 or newer, native Next.js/React and persistent local SQLite.
  Install from `package-lock.json` with `npm run install:ci`; update the lock only
  for intentional dependency changes and retain unrelated locked versions.
- Default listeners to `127.0.0.1`; use real local account sessions and API tokens.
  Local deployment must not require external identity, hosting, database or plugin
  registration. Keep frontend assets and planning callbacks local.
- Preserve Ideas, Plans, Tickets, revision history, planning recovery, MCP reads,
  execution approvals and the signed local Docker execution backend.
- Planning output and manual snapshots grant no execution permission; real starts
  require a bound approval, registered operation, resource budget and backend.
- Do not execute user-generated Tickets as part of development. Integration may
  use explicit synthetic model fixtures and isolated test workloads.
- Preserve existing working-tree edits and local state. Keep databases, account
  hashes, tokens, private keys, sessions, build/test output and caches out of Git.
- Do not import private/production data or replace an existing database to make a
  test pass; initialize a fresh temporary database for integration checks.

## Verification and documentation

Run `npm run build`, `npx --no-install tsc --noEmit`, `npm run lint` and relevant
local API/MCP/browser tests. Database setup must track applied SQL and verify its
checksums, so normal restarts never reapply schema statements. Docker-backed tests
require a real local daemon and pinned image; record missing prerequisites and
retain the full CI checks without inventing passing results.

Maintain `docs/FEATURES.md` from actual source behavior, grouped by the application's
navigation or functional section, with one sentence per feature. Documents describe
only the current local architecture and do not retain project migration/version
histories. Read `docs/DEPLOYMENT.md`, `docs/AUTHENTICATION.md`, `docs/PLANNING.md`,
`docs/EXECUTION.md`, `docs/RUNNER.md` and `docs/TESTING.md` for current contracts.
