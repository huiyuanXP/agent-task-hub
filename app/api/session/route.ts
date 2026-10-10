import { getCurrentSession } from '../../../lib/current-user';
export async function GET(){
 const session=await getCurrentSession();
 return Response.json(session??{error:'Authentication required'},{status:session?200:401,headers:{'Cache-Control':'private, no-store'}});
}
