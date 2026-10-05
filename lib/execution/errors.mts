export type ExecutionErrorCode = 'WORKER_AUTHORITY_EXPIRED' | 'IDEMPOTENCY_CONFLICT' | 'DELEGATION_CONFLICT' | 'LEASE_CONFLICT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'REQUEST_CONFLICT' | 'ACTIVE_RUN' | 'TRANSITION_CONFLICT' | 'INVALID_EVIDENCE' | 'BODY_TOO_LARGE' | 'UNSUPPORTED_MEDIA' | 'AUTHORIZATION_DENIED' | 'DECISION_CONFLICT' | 'STORAGE_UNAVAILABLE' | 'DISPATCH_CONFLICT' | 'CONFIGURATION_UNAVAILABLE';
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 503;
  constructor(code: ExecutionErrorCode, message: string, status: 400 | 403 | 404 | 409 | 413 | 415 | 503) {
    super(message);
    this.name = 'ExecutionError'; this.code = code; this.status = status;
  }
}
export function invalid(message = 'Invalid execution input'): never { throw new ExecutionError('INVALID_INPUT', message, 400); }
export function exactObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
export function boundedId(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
}
export function positiveInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
}
