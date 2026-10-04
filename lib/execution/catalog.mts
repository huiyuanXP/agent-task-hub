import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext, OperationDefinition, OperationDescriptor } from './authorization-types.mts';
import { boundedId, exactObject, ExecutionError, invalid, positiveInteger } from './errors.mts';
import { sha256 } from './evidence.mts';
export const RESOURCE_CEILINGS = Object.freeze({ timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 });
export const REGISTERED_OPERATIONS: readonly OperationDefinition[] = Object.freeze([Object.freeze({
  operationId: 'ticket.validate.v1', label: 'Validate frozen Ticket',
  image: 'node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c', scriptVersion: 1,
})]);
/** Shared Worker-safe descriptor. The supervisor executes this exact argv. */
export async function operationDescriptor(ticketBody: string, definition: OperationDefinition): Promise<OperationDescriptor> {
  exactObject(definition, ['operationId', 'label', 'image', 'scriptVersion']);
  boundedId(definition.operationId, 80); boundedId(definition.label, 120);
  if (definition.scriptVersion !== 1 || typeof definition.image !== 'string' || !/^node@sha256:[a-f0-9]{64}$/.test(definition.image)) invalid('Invalid registered operation');
  definition = { ...definition };
  const bytes = new TextEncoder().encode(ticketBody).byteLength;
  if (bytes > 16777216) invalid('Ticket input exceeds catalog limit');
  const hash = await sha256(ticketBody);
  const script = `const fs=require('node:fs'),crypto=require('node:crypto');const input=fs.readFileSync('input/ticket.json');if(input.length!==${bytes}||crypto.createHash('sha256').update(input).digest('hex')!=='${hash}')throw Error('Frozen input mismatch');const ticket=JSON.parse(input.toString('utf8'));if(!ticket||typeof ticket!=='object'||Array.isArray(ticket))throw Error('Invalid Ticket');fs.mkdirSync('output',{recursive:true});fs.writeFileSync('output/result.json',JSON.stringify({ok:true,ticketSha256:'${hash}',title:typeof ticket.title==='string'?ticket.title.slice(0,250):''})+'\\n',{flag:'wx'});`;
  const descriptor = { operationId: definition.operationId, label: definition.label, image: definition.image,
    argv: ['node', '--input-type=commonjs', '-e', script], inputs: [{ path: 'input/ticket.json', sha256: hash, bytes }],
    artifacts: [{ path: 'output/result.json', maxBytes: 4096 }],
    policy: { network: 'none' as const, credentials: [], maxInputBytes: 16777216, workTmpfsMb: 64, ceilings: { ...RESOURCE_CEILINGS } } };
  return { ...descriptor, definitionHash: await sha256(JSON.stringify(descriptor)) };
}
export function snapshotContext(context: AuthorizationContext): AuthorizationContext {
  boundedId(context.owner, 256); boundedId(context.actor, 256);
  if (context.now !== undefined && (!Number.isSafeInteger(context.now) || context.now < 0)) invalid('Invalid trusted clock');
  const registry = context.registry ?? REGISTERED_OPERATIONS;
  if (!Array.isArray(registry) || registry.length !== 1) invalid('Exactly one registered operation is supported');
  return { ...context, now: context.now ?? Date.now(), registry: registry.map(item => ({ ...item })) };
}
export async function descriptorsForBody(body: string, context: AuthorizationContext): Promise<OperationDescriptor[]> {
  return Promise.all((context.registry ?? REGISTERED_OPERATIONS).map(definition => operationDescriptor(body, definition)));
}
export async function getOperationCatalog(db: ExecutionDatabase, context: AuthorizationContext, input: { ticketId: string; expectedRevision: number }) {
  exactObject(input, ['ticketId', 'expectedRevision']); boundedId(input.ticketId); positiveInteger(input.expectedRevision);
  input = { ...input }; context = snapshotContext(context);
  const ticket = await db.prepare("SELECT revision,body FROM records WHERE id=? AND owner=? AND kind='ticket'")
    .bind(input.ticketId, context.owner).first<{ revision: number; body: string }>();
  if (!ticket) throw new ExecutionError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.revision !== input.expectedRevision) throw new ExecutionError('REVISION_CONFLICT', 'Ticket revision changed', 409);
  let body: unknown; try { body = JSON.parse(ticket.body); } catch { invalid('Invalid Ticket input'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || [...ticket.body].length > 80000) invalid('Invalid Ticket input');
  return { ticketId: input.ticketId, ticketRevision: ticket.revision, operations: await descriptorsForBody(ticket.body, context), ceilings: { ...RESOURCE_CEILINGS } };
}
