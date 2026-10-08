# Agent Task Hub connector

This standalone package needs Node.js 22.23.3 or newer and Git. It has no npm dependencies. Use the local account's **连接与执行** page to create a single-use, project-scoped invitation, download this archive, then unpack it:

```sh
tar -xzf agent-task-hub-connector.tgz
node /absolute/download/agent-task-hub-connector/cli.mjs install --url https://your-hub.example --workspace /absolute/git/project
```

The installer asks for the invitation without echoing it. For automated installation, pipe the code to the same command with `--code-stdin`; keep the code out of shell history. `--name DISPLAY_NAME` selects the connection's display name. HTTP is accepted only on loopback. `--config /absolute/private/connection.json` selects a different private configuration location.

Installation exchanges the invitation at `/api/connector/enroll`, retains only a project-scoped connector credential, copies this runtime to `.agent-task-hub/runtime/1.0.0/`, and writes a managed entry into project `.codex/config.toml`. Existing unrelated entries are preserved. The output includes an absolute Node command and STDIO arguments usable by any MCP client. Codex loads project configuration after the project is trusted. The downloaded directory can then be removed. Private credentials have mode 0600; private directories have mode 0700. Git's local exclude file excludes `.agent-task-hub/` from commits.

Use the absolute installed CLI path printed by installation:

```sh
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs doctor --workspace /absolute/project
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /absolute/project
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs set-url --workspace /absolute/project --url https://new-hub.example
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs uninstall --workspace /absolute/project
```

All commands accept `--config FILE`. `doctor` verifies Git, service authentication and local Codex readiness. `set-url` authenticates against the new service before retaining the same connection identity. Repeated installation from a newly downloaded package refreshes the installed runtime and reuses the existing connection without redeeming another invitation. `uninstall` removes local credentials/runtime and only its managed MCP entry; stop the Agent first. Retained worktrees/results and server history remain available. Revoke a connection on the Hub page to invalidate its credential immediately.

`mcp` is a JSON Lines STDIO server supporting initialize, initialized notification, ping, tool listing/calls and cancellation. Its stdout contains protocol messages only. It forwards bearer-authenticated requests to the enrolled project's machine endpoint; it never receives the owner's token or approval tools. No inbound listener is opened.

`agent` stays running until SIGINT/SIGTERM, heartbeats every 15 seconds and checks jobs every 5 seconds. It only claims tasks after `codex login status` succeeds, or an inherited API credential has passed a real bounded Codex authentication probe. Missing model login leaves the daemon connected with `agentReady=false`. Run `codex login` separately using your own local account; credentials are never copied into this package or sent to the Hub. Inherited `OPENAI_API_KEY` is mapped to `CODEX_API_KEY` only inside the Codex child process. `--codex EXECUTABLE` selects an installed Codex executable. `--once` runs one polling cycle.

Planning uses real `codex exec` in read-only mode with strict schema output and the existing revision-bound claim/save tools. Development consumes only approved runs, creates an isolated Git worktree, uses workspace-write sandbox and JSONL events, renews its lease, and reports actual Git diff/files and completed successful test-command receipts. Both use the explicitly requested `gpt-6.1-sol` model with high reasoning. The subprocess ignores unrelated user configuration and receives an explicit project MCP configuration; repository instructions and execution rules remain active. It never bypasses sandbox/approvals. Owner acceptance is a separate server action.

Cancellation, revocation, lease loss and finite timeouts stop the managed process group before a failure acknowledgement. A private journal and installation lock reconcile surviving subprocesses after restart; interrupted work is not automatically executed again. Worktrees remain under the private configuration directory for inspection and application by the owner. Changes to the main workspace, pushes, merges and publishing are not automatic.

`--test-runner FILE` is an explicit synthetic process fixture for the package's tests. Its events and result summaries identify synthetic evidence. It does not demonstrate a real model call. Delivery tests use an actual archive, installer, STDIO subprocess and Git worktree; fixture backend/model receipts are labelled synthetic.

Official Codex references: [MCP configuration](https://developers.openai.com/codex/mcp/) and [noninteractive execution](https://developers.openai.com/codex/noninteractive/).
