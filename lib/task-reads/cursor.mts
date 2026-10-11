import { resultBudget, responseTooLarge, taskResultBytes } from './bounds.mts';
import { boundedId, exactObject, invalid } from '../execution/errors.mts';
import { oneOf, runSources, type Filters, type ReadResource } from './validation.mts';
export interface CursorContext { owner: string; resource: ReadResource; filters: Filters }
export interface CursorPosition { created: string; id: string; source?: 'manual' | 'execution' }
function encode(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
async function digest(context: CursorContext): Promise<string> {
  const filters = Object.fromEntries(Object.entries(context.filters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const data = JSON.stringify([context.owner, context.resource, filters]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))), n => n.toString(16).padStart(2, '0')).join('');
}
function position(raw: unknown, resource: ReadResource): CursorPosition {
  exactObject(raw, resource === 'ticket_runs' ? ['created', 'id', 'source'] : ['created', 'id']);
  boundedId(raw.created, 128); boundedId(raw.id);
  if (resource === 'ticket_runs') {
    oneOf(raw.source, runSources);
    return { created: raw.created, id: raw.id, source: raw.source as 'manual' | 'execution' };
  }
  return { created: raw.created, id: raw.id };
}
export async function encodeCursor(keys: CursorPosition, context: CursorContext): Promise<string> {
  return encode(JSON.stringify({ v: 1, resource: context.resource, keys: position(keys, context.resource), context: await digest(context) }));
}
/** A cursor supplies position only. Every query still needs its independent owner predicate. */
export async function decodeCursor(cursor: string | undefined, context: CursorContext): Promise<CursorPosition | null> {
  if (cursor === undefined) return null;
  try {
    if (cursor.length < 1 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
    const bytes = Uint8Array.from(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    exactObject(raw, ['v', 'resource', 'keys', 'context']);
    if (raw.v !== 1 || raw.resource !== context.resource || raw.context !== await digest(context)) invalid();
    const keys = position(raw.keys, context.resource);
    // Reject padding, duplicate/unknown fields, alternate JSON orders/whitespace and noncanonical encodings.
    if (cursor !== await encodeCursor(keys, context)) invalid();
    return keys;
  } catch { invalid('Invalid task query cursor'); }
}
export interface Page<T> { items: T[]; next_cursor: string | null }
export async function makePage<T extends CursorPosition, U>(rows: T[], limit: number, context: CursorContext, project: (row: T) => U | Promise<U>, byteBudget?: number): Promise<Page<U>> {
  const budget = resultBudget(byteBudget);
  let page: Page<U> = { items: [], next_cursor: null };
  if (taskResultBytes(page) > budget) responseTooLarge();
  for (const row of rows.slice(0, limit)) {
    const item = await project(row);
    const hasMore = page.items.length + 1 < rows.length;
    const next: Page<U> = { items: [...page.items, item], next_cursor: hasMore
      ? await encodeCursor({ created: row.created, id: row.id, ...(context.resource === 'ticket_runs' ? { source: row.source } : {}) }, context) : null };
    if (taskResultBytes(next) > budget) {
      if (page.items.length === 0) responseTooLarge();
      return page;
    }
    page = next;
  }
  return page;
}
