# Agent Task Hub

Source handoff for a private task-planning workspace: Ideas → Plans → Tickets, execution snapshot records, history, and a planning-only MCP/event interface. Chinese-language application UI.

**This is the current Sites application source, not the proposed independent app-server runner.** Public authentication, a production-independent identity provider, and the task-execution adapter are not implemented. The existing live Site remains owner-private and separate from this archive.

## Source and safe separation

- Base commit: `98991e5dbaff6b5ac6cdd68f89e033a06a350c38` (reported live version 6 by the source owner)
- Exported from the recovered official source checkout on 2026-10-01; no Git history or production data included
- `.openai/hosting.json` keeps the logical `DB` and MCP capability declarations needed by the build, but its original `project_id` has been removed
- This copy has no link to the original deployed Site. Do not reinsert the original ID. A new deployment needs separate registration, resources, access policy, and explicit review
- See [migration handoff](docs/MIGRATION.md), [12-ticket roadmap](docs/ROADMAP.md), and [package validation](docs/PACKAGING.md)
- See [VM1 initialization and validation](docs/VM1-VALIDATION.md) for reproduced checks, local repairs, and independent deployment prerequisites.
- Track upcoming work in the [GitHub issue roadmap](https://github.com/huiyuanXP/agent-task-hub/issues/27) and [published issue index](docs/GITHUB-ISSUE-ROADMAP.md).

## Requirements

Node.js 22.13.0 or later, npm, and a platform supported by the locked dependencies. This project uses React 19, Vinext/Vite, a Cloudflare Worker, and D1/SQLite. It is not a generic Node server package. Keep `package-lock.json`; do not substitute fresh dependency versions during initial reproduction.

## Install, build, and local preview

From the extracted project directory:

```sh
npm run install:ci
npm run build
```

A clean clone defaults to the portable execution profile. Build output is `dist/`; the generated Worker configuration is `dist/server/wrangler.json`. No dependencies were installed or build rerun while creating this archive.

For a **fresh local database only**, apply both committed migrations in order after building:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_lethal_shadow_king.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_keen_eddie_brock.sql
npm run dev
```

Open the loopback URL printed by the dev server (normally `http://localhost:5173`). Visit `/signin-with-chatgpt?return_to=/` there to use the development-only mock identity. It is synthetic and does not log into a real account. Local records are initially empty. Do not reapply these raw SQL files to a database that already has their schema.

`npm start` previews the built Worker on loopback using the same local D1 state, but does **not** simulate sign-in; use the development server for authenticated local UI work. Keep mock-auth development servers private and loopback-only.

The `.env.example` contains only optional non-secret tooling switches. Local preview needs no copied production secrets. The application reads the `DB` runtime binding rather than a database connection-string variable.

## Regression checks

Run `npm ci --prefix tests/browser` and `npx --prefix tests/browser playwright install --with-deps chromium` after the locked application install, then run `npm test`. The suite builds a fresh temporary application and D1 database, selects loopback ports and cleans up its servers after each run. `npm run test:unit` runs harness boundary checks; `npm run test:integration` runs synthetic API/MCP and browser regressions. See [testing instructions](docs/TESTING.md) for parallel runs, artifacts and the synthetic identity boundary. PRs and pushes to `main` or `strix/**` run the same checks in CI.

## Repository layout

- `app/page.tsx`, `app/globals.css`: workspace UI
- `app/api/records`, `app/api/planning`: authenticated records and planning status
- `app/mcp/route.ts`: planning tools, event subscriptions, claim/save protocol
- `app/chatgpt-auth.ts`: Sites identity-header helpers
- `lib/events.ts`, `lib/planning-state.ts`: delivery and revision-aware planning
- `db/`, `drizzle/`: schema, ordered migrations, and migration metadata
- `build/`, `scripts/`: **source code** for build/runtime integration; retain these folders
- `components/`, `hooks/`, `public/`, `vendor/`: shared UI and assets; retain bundled license notices

Planning jobs do not authorize ticket execution. A saved Run is currently a record/snapshot, not proof that a real execution service exists. Subscription records and signing secrets live in runtime storage and are deliberately not part of this package; webhook consumers and subscriptions must be configured separately.

## Create your GitHub repository

Create an empty repository, then run in this extracted directory:

```sh
git init
git add .
git commit -m "Import Agent Task Hub source"
git branch -M main
git remote add origin <YOUR_GITHUB_REPOSITORY_URL>
git push -u origin main
```

Choose private visibility initially and review the source and dependency licenses before public release. No repository was created, pushed, or deployed as part of packaging. No application license has been invented or granted by this archive; retain third-party notices and choose an application license separately if desired.
