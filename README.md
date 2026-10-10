# Portable real Agent Task Hub MCP acceptance

Pure source test bundle from e5efe30. This is a synthetic local fixture, not a VM1 network test. Node 22.23.3 or later is required. No npm install or web build is required; package files and unchanged lockfile are included for provenance.

Run an MCP STDIO client with command `node` and arguments `--experimental-strip-types`, the absolute path to `tests/mcp/cloud-model-stdio.mjs`, `--evidence-dir`, and an absolute evidence directory. Use this directory as cwd. Allow 60 seconds startup. Standard output is JSON-RPC only.

The entry initializes a fresh temporary SQLite database, synthetic account, ephemeral read/submit/plan enrollment and seed Ticket. The HTTP endpoint is loopback only. Tool handling and STDIO transport are original project modules; fixture initialization is clearly separate. It reads no existing database, enrollment config or model credentials. Temporary credentials are held in memory and not exported. EOF, signals or 40 minutes clean up the temporary database.

Real model acceptance: initialize, tools/list, list_tickets, get_ticket, then create_ticket using a fresh request_id; read back the created Ticket. Optionally create_idea, claim_planning_job and save_plan_and_tickets. Use exact tool schemas. Existing Ticket status updates are absent from the product toolset; record this as a product capability gap, not a fixture failure. No execution capability is enrolled.

Evidence JSON records method/tool/HTTP result and synthetic record IDs, titles and revisions. It contains no token, raw tool arguments or real account data. A harness preflight is not evidence of a real model invocation; the model worker must provide its own invocation and tool results.

SOURCE-MANIFEST.json lists source hashes and dependencies. This branch is a portable test artifact and should not be merged as an application branch.
