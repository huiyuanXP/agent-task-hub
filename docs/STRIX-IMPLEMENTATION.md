# Strix agent implementation record

This record tracks the seven claimed tickets #1, #2, #4, #9, #10, #11 and #14. Each ticket receives its own tested commit and push. GitHub issue #27 remains the full project roadmap. Local synthetic verification does not authorize deployment or execution.

## #1 — Reproducible VM1 configuration

Reviewed and included the existing non-secret VM1 configuration and historical validation report. Corrected the development command to `npm run dev`, which works in both profiles, and renamed the already-published issue index.

Fresh verification on 2026-10-04 used a clean index export in `/home/agent/work/agent-task-hub/strix-validation/issue1-clean`, without existing dependencies or D1 state:

- `npm run install:ci`: exit 0; 687 locked packages installed.
- `npm run build` and `npx --no-install tsc --noEmit`: exit 0.
- Both committed migrations applied once, in order, to a fresh local D1 database.
- Portable dev and built preview passed 12 API/MCP groups and six Chromium groups covering anonymous/spoofed/cross-owner denial, revision conflict/history, exclusive claims, idempotent saves, frozen Run contracts and browser persistence.
- Both portable and managed-linux development defaults listened on `127.0.0.1:5173`. Managed development denied anonymous records without mock identity. Built preview used `--local --ip 127.0.0.1`; auxiliary application listeners were loopback.
- Lockfile SHA-256 before/after: `eedaeab6870c0f70f9db869fcaa24abae9b0f945cbc9acb8a43b6e7ed6bcbfca`.
- Read-only independent review found no blocking issue; both documentation corrections were applied. `git diff --check` passed.

Evidence logs and synthetic runtime artifacts are outside Git in `/home/agent/work/agent-task-hub/strix-validation/`. The original `.npmrc` remains absent and documented; no guessed replacement was added. Baseline lint remains 49 errors and two warnings, handled by #2. No original Site, production data, credentials or compiled output were added.
