import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext, OperationDefinition, OperationDescriptor } from './authorization-types.mts';
import { boundedId, exactObject, ExecutionError, invalid, positiveInteger } from './errors.mts';
import { sha256 } from './evidence.mts';
import { RESOURCE_CEILINGS, LAYOUT, normalizeDefinition, normalizeRegistry } from './registry.mts';
export { RESOURCE_CEILINGS, REGISTERED_OPERATIONS } from './registry.mts';
/** Shared Worker-safe descriptor. The supervisor executes this exact argv. */
export async function operationDescriptor(ticketBody: string, definition: OperationDefinition): Promise<OperationDescriptor> {
  definition = normalizeDefinition(definition);
  const bytes = new TextEncoder().encode(ticketBody).byteLength;
  if (bytes + (definition.inputs ?? []).reduce((n, i) => n + i.bytes, 0) > 16777216) invalid('Ticket input exceeds catalog limit');
  const hash = await sha256(ticketBody);
  const script = `const fs=require('node:fs'),crypto=require('node:crypto');const input=fs.readFileSync('input/ticket.json');if(input.length!==${bytes}||crypto.createHash('sha256').update(input).digest('hex')!=='${hash}')throw Error('Frozen input mismatch');const ticket=JSON.parse(input.toString('utf8'));if(!ticket||typeof ticket!=='object'||Array.isArray(ticket))throw Error('Invalid Ticket');fs.mkdirSync('output',{recursive:true});fs.writeFileSync('output/result.json',JSON.stringify({ok:true,ticketSha256:'${hash}',title:typeof ticket.title==='string'?ticket.title.slice(0,250):''})+'\\n',{flag:'wx'});`;
  const descriptor = { operationId: definition.operationId, label: definition.label, image: definition.image,
    layout: { ...LAYOUT }, argv: definition.argv ?? ['node', '--input-type=commonjs', '-e', script], inputs: [{ path: 'input/ticket.json', sha256: hash, bytes }, ...(definition.inputs ?? [])],
    artifacts: definition.artifacts ?? [{ path: 'output/result.json', maxBytes: 4096 }],
    policy: { network: 'none' as const, credentials: [], maxInputBytes: 16777216, workTmpfsMb: 64, maxLogBytes: 65536, maxArtifactBytes: 1048576, maxArchiveEntries: 4096, ceilings: { ...RESOURCE_CEILINGS } } };
  return { ...descriptor, definitionHash: await sha256(JSON.stringify(descriptor)) };
}
export function snapshotContext(context: AuthorizationContext): AuthorizationContext {
  boundedId(context.owner, 256); boundedId(context.actor, 256);
  if (context.now !== undefined && (!Number.isSafeInteger(context.now) || context.now < 0)) invalid('Invalid trusted clock');
  return { ...context, now: context.now ?? Date.now(), registry: normalizeRegistry(context.registry) };
}
export async function descriptorsForBody(body: string, context: AuthorizationContext): Promise<OperationDescriptor[]> {
  return Promise.all(normalizeRegistry(context.registry).map(definition => operationDescriptor(body, definition)));
}
export async function selectedDescriptors(body: string, context: AuthorizationContext, scope: { operationId: string }[]): Promise<OperationDescriptor[]> {
  const definitions = normalizeRegistry(context.registry);
  return Promise.all(definitions.filter(d => scope.some(s => s.operationId === d.operationId)).map(d => operationDescriptor(body, d)));
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
