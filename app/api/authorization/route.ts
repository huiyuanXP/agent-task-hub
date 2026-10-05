import { canonicalRequest } from '../../../lib/request-origin';
import { executionEnvironment } from '../../../lib/runtime-environment';
const env = executionEnvironment();
import { configuredRegistry } from '../../../lib/execution/backend-config.mts';
import { getCurrentUser } from '../../../lib/current-user';
import { database } from '../../../lib/store';
import { handleAuthorizationRequest } from '../../../lib/execution/authorization-http.mts';
async function handle(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Authentication required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try { return await handleAuthorizationRequest(database(), { owner: user.userId, actor: user.userId, grantAuthority: 'owner', registry: configuredRegistry(env) }, canonicalRequest(request)); }
  catch { return Response.json({ error: 'Authorization storage unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
export const GET = handle;
export const POST = handle;
