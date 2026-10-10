import { database } from '../../../../lib/local-store.mts';
import { AuthError, checkRequestOrigin, configuredOrigin } from '../../../../lib/local-auth.mts';
import { enrollConnector } from '../../../../lib/connectors/service.mts';
import { connectorJSON, connectorResponse, connectorFailure } from '../../../../lib/connectors/http.mts';
export async function POST(req:Request) {
 try {
  checkRequestOrigin(req.headers,'POST',configuredOrigin(),'bearer');
  if(req.headers.has('cookie'))throw new AuthError(403,'Enrollment requires an invitation');
  return connectorResponse(await enrollConnector(database(),await connectorJSON(req,4096)),201);
 }catch(error){return connectorFailure(error);}
}
