# Package provenance and validation

- Source commit: `98991e5dbaff6b5ac6cdd68f89e033a06a350c38`
- Export date: 2026-10-01 UTC
- Method: Git tracked-tree export into a separate directory; no Git history or untracked local files copied
- Deployment provenance: source owner recovered the official checkout and reported this commit matches live version 6; packaging independently verified the checkout HEAD
- Original checkout and production deployment: unchanged

## Intentional differences from the commit

1. Removed tracked `tsconfig.tsbuildinfo` (generated build cache)
2. Removed `project_id` from `.openai/hosting.json`, retaining logical bindings/capabilities
3. Replaced starter README with project-specific setup/handoff instructions
4. Added non-secret `.env.example`, expanded `.gitignore` for local databases/cache, and added handoff docs
5. Added a per-file SHA-256 manifest (excluding the manifest itself)

Application/runtime implementation and the locked dependencies are otherwise unchanged. `build/` is source tooling, not compiled output, and is intentionally included.

## Checks performed during packaging

- All included JSON files parsed successfully
- Both ordered SQL migrations executed successfully against an empty in-memory SQLite database; expected tables exist with zero records
- Node syntax checks passed for 13 `.mjs` source files
- ZIP entry safety, CRC integrity, and per-file SHA-256 manifest verified
- Best-effort pattern scan and file-inventory review for credentials, original deployment linkage, data exports, caches, and personal identifiers

No dependencies were installed; TypeScript checking, framework build, browser tests, D1-specific behavior, and end-to-end execution were **not rerun** for this handoff. Historical build checks reported by the source owner are not a fresh validation. An SQLite schema smoke test is not a substitute for D1 integration testing. Pattern scanning cannot guarantee absence of every sensitive value or prove production security. Review again before making a repository public.

Excluded: `.git`, `node_modules`, compiled outputs/caches, local runtime state, `.env` secrets, live record/database exports, and subscription data. Synthetic local-preview identity remains part of the development tooling. Preserved third-party license notices do not constitute an application license.
