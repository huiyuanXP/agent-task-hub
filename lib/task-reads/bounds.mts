import { ExecutionError } from '../execution/errors.mts';
// A detail can contain four complete 80,000-UTF16-unit records (~1.92 MB
// in both MCP representations), plus a manual Run with its own record and
// frozen contract (~0.96 MB). Leave room for metadata and one such page item.
// Planning can additionally copy original Idea fields into generated records;
// the 180,000-unit planner input bound plus these shared fields and one manual
// snapshot remains below 4 MiB (actual expanded admission: 3,962,547 bytes).
// Workers retain their separate 1 MiB limit. Larger lists continue by cursor.
export const TASK_READ_ENVELOPE_BYTES = 4 * 1048576;
const ENVELOPE_RESERVE = 8192; // RPC id, result/page keys and a <=2048-char cursor.
const utf8 = new TextEncoder();
/** Cost of the same value in structuredContent and JSON-encoded text content. */
export function taskResultBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return utf8.encode(json).length + utf8.encode(JSON.stringify(json)).length;
}
export function taskPageBudget(context: unknown = {}): number {
  return TASK_READ_ENVELOPE_BYTES - ENVELOPE_RESERVE - taskResultBytes(context);
}
export function taskResultTooLarge(): never {
  throw new ExecutionError('BODY_TOO_LARGE', 'Task result exceeds bound', 413);
}
