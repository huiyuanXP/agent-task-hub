import { boundedId, exactObject, invalid } from './errors.mts';
import type { OperationDefinition, ResourceBudget } from './authorization-types.mts';
export const MAX_PERMIT_BYTES = 1048576;
export const RESOURCE_CEILINGS = Object.freeze({ timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 });
export const REGISTERED_OPERATIONS: readonly OperationDefinition[] = Object.freeze([Object.freeze({
  operationId: 'ticket.validate.v1', label: 'Validate frozen Ticket',
  image: 'node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c', scriptVersion: 1,
})]);
export const LAYOUT = Object.freeze({ version: 1, cwd: '/job', input: '/job/input', output: '/job/output', executable: 'node' });
export function manifestPath(value: unknown, prefix: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith(prefix + '/')) invalid('Invalid manifest prefix');
  const parts = value.split('/');
  if (parts.some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..' || /^(?:\.env(?:\..*)?|\.ssh|\.git|\.aws|\.azure|\.config|\.docker|\.npmrc|\.netrc|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(p) || /\.(?:pem|key|p12|pfx)$/i.test(p))) invalid('Unsafe manifest path');
}
function noConflicts(paths: string[]) {
  const complete = new Set(paths);
  if (complete.size !== paths.length) invalid('Conflicting manifest paths');
  for (const path of paths) {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (complete.has(parts.slice(0, length).join('/'))) invalid('Conflicting manifest paths');
    }
  }
}
export function normalizeDefinition(value: unknown): OperationDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid operation');
  const custom = Object.hasOwn(value, 'argv');
  exactObject(value, custom ? ['operationId', 'label', 'image', 'scriptVersion', 'argv', 'inputs', 'artifacts'] : ['operationId', 'label', 'image', 'scriptVersion']);
  const d = value as unknown as OperationDefinition;
  boundedId(d.operationId, 80); boundedId(d.label, 120);
  if (d.scriptVersion !== 1 || typeof d.image !== 'string' || !/^node@sha256:[a-f0-9]{64}$/.test(d.image)) invalid('Invalid registered operation');
  const base = { operationId: d.operationId, label: d.label, image: d.image, scriptVersion: 1 as const };
  if (!custom) return base;
  if (!Array.isArray(d.argv) || !d.argv.length || d.argv.length > 64 || d.argv[0] !== 'node' ||
      d.argv.some(a => typeof a !== 'string' || a.length > 16384 || a.includes('\0')) || new TextEncoder().encode(d.argv.join('')).length > 32768) invalid('Invalid fixed Node argv');
  if (!Array.isArray(d.inputs) || d.inputs.length > 1023 || !Array.isArray(d.artifacts) || d.artifacts.length > 32) invalid('Invalid registered manifests');
  const inputs = d.inputs.map(item => {
    exactObject(item, ['path', 'sha256', 'bytes']); manifestPath(item.path, 'input/assets');
    if (new TextEncoder().encode(item.path.slice('input/'.length)).length > 99) invalid('Input tar path exceeds 99 UTF-8 bytes');
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) invalid('Invalid input manifest');
    return { path: item.path, sha256: item.sha256, bytes: item.bytes };
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const artifacts = d.artifacts.map(item => {
    exactObject(item, ['path', 'maxBytes']); manifestPath(item.path, 'output');
    if (!Number.isSafeInteger(item.maxBytes) || item.maxBytes <= 0 || item.maxBytes > 1048576) invalid('Invalid artifact limit');
    return { path: item.path, maxBytes: item.maxBytes };
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  noConflicts(inputs.map(i => i.path)); noConflicts(artifacts.map(a => a.path));
  if (inputs.reduce((n,i) => n + i.bytes, 0) > 16777216 || artifacts.reduce((n,a) => n + a.maxBytes, 0) > 1048576) invalid('Manifest capacity exceeded');
  return { ...base, argv: [...d.argv], inputs, artifacts };
}
/** Undefined alone means optional configuration is absent; malformed explicit data fails. */
export function normalizeRegistry(value: unknown = REGISTERED_OPERATIONS): OperationDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid('Registry requires 1 to 32 definitions');
  const definitions = value.map(normalizeDefinition);
  if (new Set(definitions.map(d => d.operationId)).size !== definitions.length) invalid('Duplicate registered operation');
  return definitions;
}
export function validateResourceBudget(value: unknown): asserts value is ResourceBudget {
  exactObject(value, ['timeoutMs', 'memoryMb', 'cpus', 'pids']);
  for (const key of ['timeoutMs', 'memoryMb', 'cpus', 'pids'] as const) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > RESOURCE_CEILINGS[key] || (key !== 'cpus' && !Number.isSafeInteger(n))) invalid('Invalid resource budget');
    if (key === 'cpus' && (n < 0.01 || Math.round(n * 100) / 100 !== n)) invalid('Unsupported CPU budget precision; use 0.01 CPU increments');
  }
}
