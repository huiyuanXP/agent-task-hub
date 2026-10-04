import { getChatGPTUser } from '../../chatgpt-auth';
import { database } from '../../../lib/store';
import { handleExecutionRequest } from '../../../lib/execution/http.mts';

async function handle(request: Request): Promise<Response> {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: 'Authentication required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    return await handleExecutionRequest(database(), { owner: user.userId, actor: user.userId }, request);
  } catch {
    return Response.json({ error: 'Execution storage unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = handle;
export const POST = handle;
