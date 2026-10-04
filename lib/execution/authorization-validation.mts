import { boundedId, exactObject, invalid, positiveInteger } from './errors.mts';
import type { OperationScope, PrepareExecutionInput, ResourceBudget } from './authorization-types.mts';
import { RESOURCE_CEILINGS } from './catalog.mts';
export function validateBudget(value: unknown): asserts value is ResourceBudget {
  exactObject(value, ['timeoutMs', 'memoryMb', 'cpus', 'pids']);
  for (const key of ['timeoutMs', 'memoryMb', 'cpus', 'pids'] as const) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 || number > RESOURCE_CEILINGS[key]) invalid('Invalid resource budget');
    if (key !== 'cpus') positiveInteger(number);
  }
}
export function validateScope(value: unknown): asserts value is OperationScope[] {
  if (!Array.isArray(value) || value.length !== 1) invalid('Exactly one operation is required');
  for (const binding of value) {
    exactObject(binding, ['operationId', 'definitionHash']); boundedId(binding.operationId, 80);
    if (typeof binding.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(binding.definitionHash)) invalid('Invalid operation definition hash');
  }
}
export function validatePrepare(input: unknown): asserts input is PrepareExecutionInput {
  exactObject(input, ['ticketId', 'expectedRevision', 'requestId', 'attempt', 'scope', 'budget', 'expiresAt']);
  boundedId(input.ticketId); positiveInteger(input.expectedRevision); positiveInteger(input.attempt);
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) invalid('Invalid request ID');
  positiveInteger(input.expiresAt); validateScope(input.scope); validateBudget(input.budget);
}

/** Canonical order makes JSON key ordering irrelevant to payload identity. */
export function snapshotPrepare(input: PrepareExecutionInput): PrepareExecutionInput {
  return { ticketId: input.ticketId, expectedRevision: input.expectedRevision, requestId: input.requestId, attempt: input.attempt,
    scope: input.scope.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })),
    budget: { timeoutMs: input.budget.timeoutMs, memoryMb: input.budget.memoryMb, cpus: input.budget.cpus, pids: input.budget.pids }, expiresAt: input.expiresAt };
}
