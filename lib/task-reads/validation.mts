import { boundedId, exactObject, invalid } from '../execution/errors.mts';
export const priorities = ['P0', 'P1', 'P2', 'P3'] as const;
export const ticketStatuses = ['todo', 'running', 'waiting', 'done', 'error'] as const;
export const runSources = ['manual', 'execution'] as const;
export const runStates = ['snapshot', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;
export type ReadResource = 'tickets' | 'plans' | 'ticket_runs';
export type Filters = Record<string, string>;
export interface ListInput { filters: Filters; limit: number; cursor?: string }
export function oneOf(value: unknown, values: readonly string[]): asserts value is string {
  if (typeof value !== 'string' || !values.includes(value)) invalid('Invalid task query input');
}
export function readListInput(resource: ReadResource, raw: unknown): ListInput {
  const filterKeys = resource === 'tickets' ? ['project', 'status', 'priority', 'plan_id', 'idea_id']
    : resource === 'plans' ? ['project', 'priority', 'idea_id'] : ['ticket_id', 'source', 'state'];
  const args = raw === undefined ? {} : raw;
  exactObject(args, [...filterKeys, 'limit', 'cursor']);
  const filters: Filters = {};
  for (const key of filterKeys) {
    if (!(key in args)) continue;
    const value = args[key];
    if (key === 'project') {
      if (typeof value !== 'string' || value.length > 120) invalid('Invalid task query input');
    } else if (key === 'priority') oneOf(value, priorities);
    else if (key === 'status') oneOf(value, ticketStatuses);
    else if (key === 'source') oneOf(value, runSources);
    else if (key === 'state') oneOf(value, runStates);
    else boundedId(value);
    filters[key] = value as string;
  }
  if (resource === 'ticket_runs' && !('ticket_id' in filters)) invalid('Ticket ID required');
  const limit = 'limit' in args ? args.limit : 20;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Invalid task query limit');
  if ('cursor' in args && (typeof args.cursor !== 'string' || args.cursor.length < 1 || args.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(args.cursor))) invalid('Invalid task query cursor');
  return { filters, limit, ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) };
}
export function readRootId(raw: unknown, key: 'ticket_id' | 'plan_id'): string {
  exactObject(raw, [key]); boundedId(raw[key]); return raw[key];
}
