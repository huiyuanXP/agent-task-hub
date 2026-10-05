import type { ExecutionDatabase, EvidenceTrust } from './types.mts';
import { normalizeRegistry } from './registry.mts';
import type { SigningKey, TransportConfiguration } from './transport.mts';
export interface BackendEnvironment {
  DB?: ExecutionDatabase; EXECUTION_REGISTRY?: string; EXECUTION_RUNNER_URL?: string; EXECUTION_RUNNER_AUDIENCE?: string;
  EXECUTION_CHECKPOINT_AUDIENCE?: string; EXECUTION_CONTROL_KEY?: string; EXECUTION_RUNNER_KEY?: string; EXECUTION_EVIDENCE_KEY?: string;
}
export function configuredRegistry(env: BackendEnvironment) { return normalizeRegistry(env.EXECUTION_REGISTRY === undefined ? undefined : JSON.parse(env.EXECUTION_REGISTRY)); }
export async function importSigning(value: string | undefined): Promise<SigningKey> {
  const k = JSON.parse(value ?? 'null'); if (!k || typeof k.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(k.keyId) || k.jwk?.kty !== 'EC' || k.jwk.crv !== 'P-256' || typeof k.jwk.d !== 'string') throw Error('Private P256 signing key required');
  return { keyId:k.keyId,privateKey:await crypto.subtle.importKey('jwk',k.jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']) };
}
export async function importTrust(value: string | undefined): Promise<EvidenceTrust> {
  const k = JSON.parse(value ?? 'null'); if (!k || typeof k.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(k.keyId) || k.jwk?.kty !== 'EC' || k.jwk.crv !== 'P-256' || k.jwk.d !== undefined) throw Error('Public P256 verifier required');
  return {keyId:k.keyId,key:await crypto.subtle.importKey('jwk',k.jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify'])};
}
export function assertDistinctKeyMaterial(...values: (string | undefined)[]) {
  const keys=values.map(value=>JSON.parse(value ?? 'null'));
  if(keys.some(k=>!k?.jwk?.x||!k?.jwk?.y)||new Set(keys.map(k=>k.keyId)).size!==keys.length||new Set(keys.map(k=>k.jwk.x+':'+k.jwk.y)).size!==keys.length)throw Error('Distinct signing material required for each key role');
}
export async function backendConfiguration(env: BackendEnvironment): Promise<{transport:TransportConfiguration;evidenceTrust:EvidenceTrust}> {
  if(!env.EXECUTION_RUNNER_URL||!env.EXECUTION_RUNNER_AUDIENCE)throw Error('Execution is not configured');
  assertDistinctKeyMaterial(env.EXECUTION_CONTROL_KEY,env.EXECUTION_RUNNER_KEY,env.EXECUTION_EVIDENCE_KEY);
  const [signing,trust,evidenceTrust]=await Promise.all([importSigning(env.EXECUTION_CONTROL_KEY),importTrust(env.EXECUTION_RUNNER_KEY),importTrust(env.EXECUTION_EVIDENCE_KEY)]);
  if(new Set([signing.keyId,trust.keyId,evidenceTrust.keyId]).size!==3)throw Error('Distinct transport and evidence key identities required');
  return {transport:{baseUrl:env.EXECUTION_RUNNER_URL,audience:env.EXECUTION_RUNNER_AUDIENCE,direction:'control-to-runner',signing,trust},evidenceTrust};
}
