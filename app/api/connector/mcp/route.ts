import { database } from '../../../../lib/local-store.mts';
import { handleConnectorMCP } from '../../../../lib/connectors/mcp.mts';
import { configuredRegistry } from '../../../../lib/execution/backend-config.mts';
import { executionEnvironment } from '../../../../lib/runtime-environment';
export async function POST(req:Request) {return handleConnectorMCP(database(),req,()=>configuredRegistry(executionEnvironment()));}
export async function GET() {return new Response('MCP JSON-RPC endpoint. Use POST.',{status:405,headers:{Allow:'POST','Cache-Control':'private, no-store'}});}
