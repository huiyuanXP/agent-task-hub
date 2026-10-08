import { configuredOrigin } from "../../../lib/local-auth.mts";

export const dynamic = "force-dynamic";

export async function GET() {
  const origin = configuredOrigin();
  return Response.json({
    name: "agent-task-hub-connector", version: "1.0.0", minimumNodeVersion: "22.23.3",
    origin, downloadUrl: `${origin}/api/connectors/download`, guideUrl: `${origin}/install`,
    archiveRoot: "agent-task-hub-connector", cli: "agent-task-hub-connector/cli.mjs",
    installation: {
      arguments: ["install", "--url", origin, "--workspace", "<absolute-git-repository-path>", "--code-stdin"],
      authorizationCode: { source: "owner creates in connection page", transport: "stdin", singleUse: true, expiresInSeconds: 600 },
    },
    endpoints: { enroll: "/api/connector/enroll", heartbeat: "/api/connector/heartbeat", mcp: "/api/connector/mcp", agent: "/api/connector/agent" },
    commands: ["install", "doctor", "mcp", "agent", "set-url", "uninstall"],
    verification: ["diagnostics", "MCP initialize/tools/list/tools/call", "backend connection record", "agent heartbeat"],
  }, { headers: { "Cache-Control": "no-store" } });
}
