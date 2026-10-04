import { getAuthenticationContext } from '../../../lib/auth-context';
export async function GET() {
  const context = getAuthenticationContext();
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!context?.user) return Response.json({ error: 'Authentication required' }, { status: 401, headers });
  const { user, mode, expiresAt } = context;
  return Response.json({ user, mode, expiresAt }, { headers });
}
