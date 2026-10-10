import { database } from '../../../../lib/local-store.mts';
import { authenticateConnector, heartbeatConnector } from '../../../../lib/connectors/service.mts';
import { connectorJSON, connectorResponse, connectorFailure } from '../../../../lib/connectors/http.mts';
export async function POST(req:Request) {
 try {const db=database(),principal=await authenticateConnector(db,req.headers);return connectorResponse(await heartbeatConnector(db,principal,await connectorJSON(req,8192)));}catch(error){return connectorFailure(error);}
}
