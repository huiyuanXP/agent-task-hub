import { database } from '../../../../lib/store';
import { canonicalRequest } from '../../../../lib/request-origin';
import { handleWorkerMCPRequest } from '../../../../lib/execution/worker-mcp.mts';
async function handle(request: Request) { return handleWorkerMCPRequest(database(), canonicalRequest(request)); }
export const POST = handle;
export const GET = handle;
