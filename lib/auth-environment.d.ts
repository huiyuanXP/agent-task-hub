import type { AccessEnvironment } from './access-identity.mts';
declare global {
  interface ImportMetaEnv { readonly SITES_MOCK_AUTH: boolean; }
  namespace Cloudflare {
    interface Env extends AccessEnvironment {
      AUTH_MODE?: 'access' | 'trusted-sites';
      AUTH_TRUST_SITES_HEADERS?: string;
      EXECUTION_WORKER_MACHINE_INGRESS?: string;
    }
  }
}
export {};
