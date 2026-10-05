import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { database } from '../../../../lib/store';
import { handleBackendRequest } from '../../../../lib/execution/backend-http.mts';
async function handle(request:Request){
  const user=await getChatGPTUser();
  if(!user)return Response.json({error:'Authentication required'},{status:401,headers:{'Cache-Control':'no-store'}});
  try{return await handleBackendRequest(database(),{owner:user.userId,actor:user.userId},request,env);}
  catch{return Response.json({error:'Execution backend unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export const GET=handle;
export const POST=handle;
