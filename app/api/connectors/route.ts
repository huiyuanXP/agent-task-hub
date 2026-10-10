import { database } from '../../../lib/local-store.mts';
import { getCurrentUser } from '../../../lib/current-user';
import { AuthError, configuredOrigin } from '../../../lib/local-auth.mts';
import { connectorJSON, connectorResponse, connectorFailure } from '../../../lib/connectors/http.mts';
import { connectorInput, inviteConnector, listConnections, revokeConnector } from '../../../lib/connectors/service.mts';
export async function GET() {
 try {const user=await getCurrentUser();if(!user)throw new AuthError(401,'Authentication required');return connectorResponse(await listConnections(database(),user.userId));}catch(error){return connectorFailure(error);}
}
export async function POST(req:Request) {
 try {
  const user=await getCurrentUser();if(!user)throw new AuthError(401,'Authentication required');
  if(req.headers.get('origin')!==configuredOrigin())throw new AuthError(403,'Request origin rejected');
  const input=await connectorJSON(req,4096);connectorInput(input,['action','project','name','capabilities','connectionId']);
  if(input.action==='invite')return connectorResponse(await inviteConnector(database(),user.userId,input),201);
  if(input.action==='revoke')return connectorResponse(await revokeConnector(database(),user.userId,input));
  throw new AuthError(400,'Unknown connector action');
 }catch(error){return connectorFailure(error);}
}
