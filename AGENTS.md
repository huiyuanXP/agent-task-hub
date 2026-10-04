# Agent Task Hub collaboration

## Repository skills

Superpowers 6.3.0 is checked into `.agents/skills/`. Codex discovers these skills
from this repository without a global plugin installation. Before beginning work,
read `.agents/skills/using-superpowers/SKILL.md` and then the skills relevant to the
user's task. Read supporting files only when their skill calls for them.

Upstream uses plugin-qualified names such as `superpowers:brainstorming`.
For repository skills, resolve `superpowers:<name>` to
`.agents/skills/<name>/SKILL.md`; native skill names are the unqualified names in
their frontmatter. If the global plugin also appears, use the repository copy for
this project and do not run the same workflow twice. Follow actual available
tools and their schemas when a reference describes another runtime or version.

Skills support the user's request; they do not expand its scope or grant authority
to push, deploy, access production data, or execute generated Tickets. Honor user
instructions and authorization already given in the session. See
`.agents/README.md` for provenance, updates and discovery verification.

## Project boundaries

- This is a Vinext/React Cloudflare Worker with D1, not a generic Node server.
  Use the locked `npm run install:ci`; preserve `package-lock.json`.
- Planning output and stored Run snapshots do not authorize or prove execution.
  Independent authentication and the execution runner are roadmap work.
- Keep mock authentication, application previews and optional visual-companion
  servers on loopback. For the companion, disable telemetry with
  `SUPERPOWERS_DISABLE_TELEMETRY=1` when launching it.
- Do not reconnect the original live Site, import production data, or copy
  private keys/provider credentials. Deployment and data migration require their
  own explicitly authorized scope.
- Preserve existing working-tree edits. Keep local databases, credentials,
  sessions, generated output and plugin caches out of Git.

## Checks and roadmap

Run checks relevant to the change. Application checks are `npm run build`,
`npx --no-install tsc --noEmit` and `npm run lint`; use fresh isolated local D1
state for integration tests, never reapply raw migrations to existing schemas.
The imported lint baseline currently has 49 errors and two warnings, tracked in
GitHub issue #2; distinguish that baseline from regressions introduced by a change.

GitHub issue #27 is the roadmap overview. Consult `docs/MIGRATION.md`,
`docs/ROADMAP.md` and, when present, `docs/VM1-VALIDATION.md` for the architecture and
validation boundary. The vendored skills' examples and tools are not application
source and are excluded from application TypeScript and ESLint checks.
