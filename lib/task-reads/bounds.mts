import { ExecutionError } from '../execution/errors.mts';
/** Wire limits are UTF-8 bytes, including JSON escaping and both MCP representations. */
export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;
// A 200000-byte request bounds the echoed RPC ID; leave room for it and route metadata.
export const MAX_TASK_RESULT_BYTES = MAX_MCP_RESPONSE_BYTES - 256 * 1024;
export interface TaskReadOptions { project?: string; byteBudget?: number }
export function utf8JSONBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function taskResultBytes(value: unknown): number {
  return utf8JSONBytes({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
}
export function responseTooLarge(): never {
  throw new ExecutionError('RESPONSE_TOO_LARGE', 'Task response exceeds the byte limit', 413);
}
export function resultBudget(bytes = MAX_TASK_RESULT_BYTES): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_TASK_RESULT_BYTES) responseTooLarge();
  return bytes;
}
export function assertTaskResultBytes(value: unknown, byteBudget?: number): void {
  if (taskResultBytes(value) > resultBudget(byteBudget)) responseTooLarge();
}
/** Base detail fields consume the same dual-representation envelope budget as the child page. */
export function nestedPageBudget(base: Record<string, unknown>, field: string, byteBudget?: number): number {
  const empty = { items: [], next_cursor: null };
  return resultBudget(resultBudget(byteBudget) - (taskResultBytes({ ...base, [field]: empty }) - taskResultBytes(empty)));
}
export function boundedMCPResponse(value: unknown, status = 200, headers: Record<string, string> = { 'Cache-Control': 'private, no-store' }): Response {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_MCP_RESPONSE_BYTES) responseTooLarge();
  return new Response(text, { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
