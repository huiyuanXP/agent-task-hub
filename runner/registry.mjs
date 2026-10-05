import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_PERMIT_BYTES, normalizeRegistry, validateResourceBudget } from '../lib/execution/registry.mts';
import { operationDescriptor } from '../lib/execution/catalog.mts';
import { canonical } from '../lib/execution/transport.mts';
import { sha256 } from '../lib/execution/evidence.mts';
import { exactObject, boundedId, positiveInteger } from '../lib/execution/errors.mts';
import { snapshotInputs } from './inputs.mjs';
export function registryConfiguration(registry, sourceRoots = {}) {
  const definitions = normalizeRegistry(registry);
  if (!sourceRoots || typeof sourceRoots !== 'object' || Array.isArray(sourceRoots) || Object.entries(sourceRoots).some(([id,path]) => !definitions.some(d=>d.operationId===id) || typeof path !== 'string' || !path.startsWith('/'))) throw Error('Invalid private source roots');
  return { definitions, sourceRoots: { ...sourceRoots } };
}
export async function validatePermit(input, registry, newStart = true) {
  exactObject(input,['version','permitId','owner','runId','ticketId','ticketRevision','attempt','authorizationId','contractSha256','ticketBody','operation','budget','issuedAt','deadlineMs','expiresAt']);
  const p = structuredClone(input);
  if(Buffer.byteLength(canonical(p)) > MAX_PERMIT_BYTES - 64)throw Error('Dispatch envelope exceeds transport capacity');
  if (Object.keys(p).length !== 15 || p.version !== 1) throw Error('Invalid dispatch version');
  for (const key of ['permitId','owner','runId','ticketId','authorizationId']) boundedId(p[key],256);
  for (const key of ['ticketRevision','attempt','issuedAt','deadlineMs','expiresAt']) positiveInteger(p[key]);
  validateResourceBudget(p.budget);
  if (typeof p.ticketBody !== 'string' || p.ticketBody.length > 320000 || await sha256(p.ticketBody) !== p.contractSha256 ||
      p.deadlineMs <= p.issuedAt || p.deadlineMs > p.issuedAt+p.budget.timeoutMs || p.deadlineMs > p.expiresAt || p.issuedAt > Date.now()+1000 ||
      (newStart && p.deadlineMs <= Date.now())) throw Error('Invalid dispatch contract or deadline');
  const ticket = JSON.parse(p.ticketBody); if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) throw Error('Invalid frozen Ticket');
  if (newStart) {
    const definition=registry.definitions.find(d=>d.operationId===p.operation?.operationId);
    if (!definition || canonical(await operationDescriptor(p.ticketBody,definition))!==canonical(p.operation)) throw Error('Registered operation drift');
  }
  return p;
}
/** Read administrator assets once through pinned handles, then verify the staged bytes again at import. */
export async function stageInputs(directory, permit, registry) {
  await mkdir(directory,{mode:0o700});
  try {
    const inputs=permit.operation.inputs, assets=inputs.filter(i=>i.path!=='input/ticket.json');
    let files=[];
    if(assets.length){const root=registry.sourceRoots[permit.operation.operationId];if(!root)throw Error('Static source unavailable');files=await snapshotInputs(root,assets,permit.operation.policy,true);}
    await mkdir(join(directory,'input'),{mode:0o700});
    await writeFile(join(directory,'input/ticket.json'),permit.ticketBody,{flag:'wx',mode:0o600});
    for(const file of files){const target=join(directory,'input',file.path);await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true,mode:0o700});await writeFile(target,file.bytes,{flag:'wx',mode:0o600});}
  } catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
