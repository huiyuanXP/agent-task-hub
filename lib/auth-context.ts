import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatGPTUser } from '../app/chatgpt-auth';

import type { WorkerPrincipal } from './execution/worker-types.mts';
export interface OwnerAuthenticationContext {
  kind: 'owner';
  mode: 'access' | 'trusted-sites' | 'development';
  user: ChatGPTUser | null;
  expiresAt: number | null;
  tokenHash?: string;
}

export type AuthenticationContext = OwnerAuthenticationContext | { kind: 'execution_worker'; mode: 'access' | 'trusted-sites'; user: null; expiresAt: number; worker: WorkerPrincipal };

// Vinext derives revalidation contexts. Keep identity in its own request scope,
// just as the connector capability is retained across those derived contexts.
const authentication = new AsyncLocalStorage<AuthenticationContext>();
export function runWithAuthentication<T>(context: AuthenticationContext, run: () => T): T {
  return authentication.run(context, run);
}
export function getAuthenticationContext(): AuthenticationContext | undefined {
  return authentication.getStore();
}
