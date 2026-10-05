/** Administrator limits. Grant policy may only reduce these values. */
export const IMAGE = 'node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c';
export const CEILINGS = Object.freeze({ timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 });
export const PROXY_KEYS = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy']);
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('Unexpected policy or identity field');
}
function limit(value, fallback, maximum, integer = true) {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n <= 0 || n > maximum || (integer && !Number.isSafeInteger(n))) throw Error('Policy budget exceeds limit');
  return n;
}
export function normalizePolicy(policy = {}) {
  exact(policy, ['network', 'credentials', 'ceilings', 'maxInputBytes', 'workTmpfsMb', 'maxLogBytes', 'maxArtifactBytes', 'maxArchiveEntries']);
  if ((policy.network ?? 'none') !== 'none' || (policy.credentials !== undefined && (!Array.isArray(policy.credentials) || policy.credentials.length))) throw Error('Unsupported network or credential scope');
  const ceilings = policy.ceilings ?? {};
  const cpus = ceilings.cpus ?? CEILINGS.cpus;
  if (cpus < 0.01 || Math.round(cpus * 100) / 100 !== cpus) throw Error('Unsupported CPU budget precision; use 0.01 CPU increments');
  exact(ceilings, Object.keys(CEILINGS));
  return { network: 'none', credentials: [], ceilings: Object.fromEntries(Object.entries(CEILINGS).map(([key, max]) => [key, limit(ceilings[key], max, max, key !== 'cpus')])),
    maxInputBytes: limit(policy.maxInputBytes, 16777216, 16777216), workTmpfsMb: limit(policy.workTmpfsMb, 64, 64),
    maxLogBytes: limit(policy.maxLogBytes, 65536, 65536), maxArtifactBytes: limit(policy.maxArtifactBytes, 1048576, 1048576), maxArchiveEntries: limit(policy.maxArchiveEntries, 4096, 4096) };
}
export function relativePath(path, prefix) {
  if (typeof path !== 'string' || path.length > 200 || !path.startsWith(prefix + '/')) throw Error('Invalid manifest path prefix');
  const segments = path.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || !/^[A-Za-z0-9_.-]+$/.test(s))) throw Error('Unsafe manifest path');
  if (segments.some(s => /^(?:\.env(?:\..*)?|\.ssh|\.git|\.aws|\.azure|\.config|\.docker|\.npmrc|\.netrc|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(s) || /\.(?:pem|key|p12|pfx)$/i.test(s))) throw Error('Sensitive input path');
  return segments.slice(1).join('/');
}
