# Repository Superpowers skills

This directory contains a pinned, portable copy of **Superpowers 6.3.0** for Codex
sessions working in Agent Task Hub. It is maintained with the repository; it does
not depend on the installing user's plugin cache or an absolute symlink.

## Use

Open a new Codex session in this repository or a child directory. Codex scans
repository `.agents/skills/` directories and discovers each `SKILL.md`. The root
`AGENTS.md` points to the bootstrap and explains how upstream `superpowers:<name>`
references resolve to these native repository skills. If an existing session has
not refreshed discovery, restart it. A separately installed Superpowers plugin is
not required; if one is installed, prefer the repository copy for this project.

The 14 skills cover brainstorming, planning, plan execution, debugging, TDD,
verification, code review, worktrees, parallel/subagent workflows, branch finishing
and skill authoring. Availability of the skills does not itself provide subagent
tools or enable machine-level features; use the current Codex tool capabilities.

No executable session-start hook is installed. The packaged plugin's `hooks`
configuration was empty. Native discovery plus `AGENTS.md` provides the bootstrap
without changing another user's global Codex configuration or starting a server.
Optional skill helpers run only when the chosen workflow needs them.

## Provenance and maintenance

- Upstream: <https://github.com/obra/superpowers>
- Distribution: OpenAI curated Codex plugin, version 6.3.0, package snapshot
  `5fd93af4` (a package identifier, not a claimed upstream Git commit).
- `skills/` includes the original skills and their supporting resources unchanged.
- `LICENSE.superpowers` retains the upstream MIT license. It applies to this
  vendored material and does not assign a license to the application.
- `superpowers.json` records version, source and SHA-256 hashes for all copied files.
- `package.json` supplies the pinned version to the optional visual companion;
  it has no dependencies, install scripts or workspace registration.
- Project-specific integration lives in root `AGENTS.md` and this README.

For an update, review a specific new upstream package, replace the complete skill
tree and license, regenerate the manifest, and review the changed workflows and
helpers. Do not auto-sync an unpinned remote source during ordinary development.
Check frontmatter, support files, executable modes, discovery from the repository
and a clean checkout, and application typecheck/lint isolation before committing.

Official Codex discovery documentation:
<https://developers.openai.com/codex/skills/>.
