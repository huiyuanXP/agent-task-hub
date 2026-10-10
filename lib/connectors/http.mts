import { AuthError } from '../local-auth.mts';
export async function connectorJSON(req:Request,limit=200000):Promise<unknown> {
 if(!(req.headers.get('content-type')??'').split(';')[0].trim().match(/^application\/json$/i))throw new AuthError(415,'JSON content required');
 const reader=req.body?.getReader();if(!reader)throw new AuthError(400,'JSON body required');
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw new AuthError(413,'Request body too large');}chunks.push(value);}}finally{reader.releaseLock();}
 const body=new Uint8Array(length);let position=0;for(const chunk of chunks){body.set(chunk,position);position+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new AuthError(400,'Invalid JSON');}
}
export function connectorResponse(value:unknown,status=200) {return Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});}
export function connectorFailure(error:unknown) {return connectorResponse({error:error instanceof AuthError?error.message:'Connector service unavailable'},error instanceof AuthError?error.status:503);}
