import { database } from '../../../../lib/store';
import { AuthError, checkRequestOrigin, configuredOrigin, login, sessionCookie } from '../../../../lib/local-auth.mts';
export async function POST(request:Request){
 try{
  checkRequestOrigin(request.headers,'POST',configuredOrigin(),'none');
  if(!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON required'},{status:400});
  const text=await request.text();if(text.length>4096)return Response.json({error:'Invalid login input'},{status:400});
  let input;try{input=JSON.parse(text);}catch{return Response.json({error:'Invalid login input'},{status:400});}
  const {token,...session}=await login(database(),input);
  return Response.json(session,{headers:{'Cache-Control':'private, no-store','Set-Cookie':sessionCookie(token,session.expiresAt)}});
 }catch(error){return Response.json({error:error instanceof AuthError?error.message:'Authentication unavailable'},{status:error instanceof AuthError?error.status:503,headers:{'Cache-Control':'private, no-store'}});}
}
