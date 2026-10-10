import { database } from '../../../../lib/store';
import { AuthError, checkRequestOrigin, configuredOrigin, readCredential, revokeToken, sessionCookie } from '../../../../lib/local-auth.mts';
export async function POST(request:Request){
 try{
  checkRequestOrigin(request.headers,'POST',configuredOrigin(),'cookie');
  const credential=readCredential(request.headers);if(credential)await revokeToken(database(),credential.token);
  const headers={'Cache-Control':'private, no-store','Set-Cookie':sessionCookie('',0)};
  if(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return new Response(null,{status:303,headers:{...headers,Location:'/signin'}});
  return Response.json({ok:true},{headers});
 }catch(error){return Response.json({error:error instanceof AuthError?error.message:'Authentication unavailable'},{status:error instanceof AuthError?error.status:503,headers:{'Cache-Control':'private, no-store'}});}
}
