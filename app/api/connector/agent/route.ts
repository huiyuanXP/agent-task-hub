import { database } from '../../../../lib/local-store.mts';
import { authenticateConnector } from '../../../../lib/connectors/service.mts';
import { AuthError } from '../../../../lib/local-auth.mts';
import { handleWorkspaceAgentRequest,workspaceErrorResponse } from '../../../../lib/workspace-runs/http.mts';

export async function POST(request:Request):Promise<Response> {
 try {
  const db=database(),principal=await authenticateConnector(db,request.headers);
  return handleWorkspaceAgentRequest(db,principal,request);
 }catch(error){
  if(error instanceof AuthError)return Response.json({error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
  return workspaceErrorResponse(error);
 }
}
