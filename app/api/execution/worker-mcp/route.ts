import { database } from '../../../../lib/store';
import { executionEnvironment } from '../../../../lib/runtime-environment';
import { canonicalRequest } from '../../../../lib/request-origin';
import { handleWorkerMCPRequest } from '../../../../lib/execution/worker-mcp.mts';
async function handle(request: Request) { return handleWorkerMCPRequest(database(), canonicalRequest(request), undefined, executionEnvironment()); }
export const POST = handle;
export const GET = handle;
