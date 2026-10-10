import { canonicalRequest } from '../../../lib/request-origin';
import { getCurrentUser } from '../../../lib/current-user';
import { database } from '../../../lib/local-store.mts';
import { handleWorkspaceRequest,workspaceErrorResponse } from '../../../lib/workspace-runs/http.mts';

async function handle(request:Request):Promise<Response> {
 try {
  const user=await getCurrentUser();
  return handleWorkspaceRequest(database(),user?.userId??null,canonicalRequest(request));
 }catch(error){return workspaceErrorResponse(error);}
}
export const GET=handle;
export const POST=handle;
