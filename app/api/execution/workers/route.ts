import { database } from '../../../../lib/store';
import { canonicalRequest } from '../../../../lib/request-origin';
import { handleWorkersRequest } from '../../../../lib/execution/worker-http.mts';
async function handle(request: Request) { return handleWorkersRequest(database(), canonicalRequest(request)); }
export const GET = handle;
export const POST = handle;
