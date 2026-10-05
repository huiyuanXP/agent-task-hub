import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperationCatalog, operationDescriptor, REGISTERED_OPERATIONS } from '../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization, getAuthorization } from '../../lib/execution/authorization.mts';
import { validateBudget } from '../../lib/execution/authorization-validation.mts';
import { fixture, context } from './sqlite.mjs';
const custom = () => ({ operationId: 'admin.example.v1', label: 'Example', image: REGISTERED_OPERATIONS[0].image, scriptVersion: 1,
  argv: ['node', '--input-type=commonjs', '-e', 'process.stdout.write("actual")'], inputs: [], artifacts: [] });
const budget = { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 };
test('selected grant survives unrelated registry additions/reordering but selected changes/removal invalidate it', async t => {
  const { db } = fixture(t); const owner = { ...context, grantAuthority: 'owner', registry: [REGISTERED_OPERATIONS[0], custom()] };
  const catalog = await getOperationCatalog(db, owner, { ticketId: 'ticket-1', expectedRevision: 1 });
  assert.equal(catalog.operations.length, 2);
  const selected = catalog.operations[1];
  const { authorization } = await prepareExecution(db, owner, { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'selected', attempt: 1, budget,
    expiresAt: Date.now() + 60000, scope: [{ operationId: selected.operationId, definitionHash: selected.definitionHash }] });
  await decideAuthorization(db, owner, { authorizationId: authorization.id, decisionId: 'approve', outcome: 'approved' });
  assert.equal(authorization.operations.length, 1);
  assert.equal((await getAuthorization(db, { ...owner, registry: [custom(), REGISTERED_OPERATIONS[0], { ...custom(), operationId: 'unrelated' }] }, authorization.id)).effectiveStatus, 'approved');
  assert.equal((await getAuthorization(db, { ...owner, registry: [REGISTERED_OPERATIONS[0]] }, authorization.id)).effectiveStatus, 'stale_definition');
  assert.equal((await getAuthorization(db, { ...owner, registry: [{ ...custom(), argv: ['node', '-e', 'process.exit(1)'] }] }, authorization.id)).effectiveStatus, 'stale_definition');
});
test('registry snapshots nested administrator data and canonically hashes unordered manifests while preserving argv', async () => {
  const definition = { ...custom(), inputs: [{ path: 'input/assets/b', bytes: 1, sha256: 'b'.repeat(64) }, { path: 'input/assets/a', bytes: 1, sha256: 'a'.repeat(64) }], artifacts: [{ path: 'output/b', maxBytes: 10 }, { path: 'output/a', maxBytes: 10 }] };
  const original = structuredClone(definition); const pending = operationDescriptor('{}', definition);
  definition.argv[2] = 'MUTATED'; definition.inputs[0].sha256 = 'c'.repeat(64); definition.artifacts[0].path = 'output/changed';
  const descriptor = await pending;
  assert.deepEqual(descriptor.argv, original.argv);
  assert.equal(descriptor.inputs[0].path, 'input/ticket.json');
  assert.equal(descriptor.inputs[1].path, 'input/assets/a');
  assert.equal(descriptor.layout.cwd, '/job');
  const reordered = await operationDescriptor('{}', { ...original, inputs: [...original.inputs].reverse(), artifacts: [...original.artifacts].reverse() });
  assert.equal(descriptor.definitionHash, reordered.definitionHash);
});
test('invalid explicit registries, forbidden argv/paths and aggregate input capacity fail closed', async t => {
  const { db } = fixture(t);
  for (const registry of [[], null, [custom(), custom()], Array.from({ length: 33 }, (_, i) => ({ ...custom(), operationId: 'op' + i }))])
    await assert.rejects(getOperationCatalog(db, { ...context, registry }, { ticketId: 'ticket-1', expectedRevision: 1 }));
  for (const change of [{ argv: ['sh', '-c', 'true'] }, { argv: ['node', '\0'] }, { image: 'node:latest' }, { sourceRoot: '/private' },
    { inputs: [{ path: 'input/assets/' + 'a'.repeat(100), bytes: 0, sha256: 'a'.repeat(64) }] },
    { inputs: [{ path: 'input/ticket.json', bytes: 0, sha256: 'a'.repeat(64) }] },
    { inputs: [{ path: 'input/assets/a', bytes: 0, sha256: 'a'.repeat(64) }, { path: 'input/assets/a/b', bytes: 0, sha256: 'b'.repeat(64) }] },
    { inputs: [{ path: 'input/assets/large', bytes: 16777216, sha256: 'a'.repeat(64) }] }])
    await assert.rejects(operationDescriptor('{}', { ...custom(), ...change }));
});
test('authorization rejects CPU quantities the Docker adapter cannot enforce', () => {
  for (const cpus of [0.001, 0.015, 0.999]) assert.throws(() => validateBudget({ ...budget, cpus }));
  for (const cpus of [0.01, 0.29, 1]) assert.doesNotThrow(() => validateBudget({ ...budget, cpus }));
});
test('static tar paths enforce the actual 99-byte boundary and reject multibyte names before approval',async()=>{
 const atLimit={...custom(),inputs:[{path:'input/assets/'+'a'.repeat(92),bytes:0,sha256:'a'.repeat(64)}]};
 assert.equal((await operationDescriptor('{}',atLimit)).inputs[1].path.length,105);
 for(const path of ['input/assets/'+'a'.repeat(93),'input/assets/é'])await assert.rejects(operationDescriptor('{}',{...custom(),inputs:[{path,bytes:0,sha256:'a'.repeat(64)}]}));
});
test('bounded maximal Ticket, escaped argv and static manifests fit the shared signed transport ceiling',async()=>{
 const {MAX_PERMIT_BYTES}=await import('../../lib/execution/registry.mts');
 const definition={...custom(),argv:['node','\u0001'.repeat(16382),'\u0001'.repeat(16382)],inputs:Array.from({length:1023},(_,i)=>({path:'input/assets/'+String(i).padStart(4,'0')+'a'.repeat(88),bytes:0,sha256:'a'.repeat(64)})),artifacts:Array.from({length:32},(_,i)=>({path:'output/'+String(i).padStart(2,'0')+'a'.repeat(191),maxBytes:1}))};
 for(const payload of ['😀'.repeat(79980),'\\'.repeat(39980),'"'.repeat(39980),'\u0001'.repeat(13320)]){
  const body=JSON.stringify({payload});assert.ok([...body].length<=80000);const operation=await operationDescriptor(body,definition);
  const wire=JSON.stringify({permit:{version:1,permitId:'p'.repeat(256),owner:'o'.repeat(256),runId:'r'.repeat(256),ticketId:'t'.repeat(256),ticketRevision:1,attempt:1,authorizationId:'g'.repeat(256),contractSha256:'a'.repeat(64),ticketBody:body,operation,budget,issuedAt:1800000000000,deadlineMs:1800000030000,expiresAt:1800000030000}});
  assert.ok(Buffer.byteLength(wire)<MAX_PERMIT_BYTES,Buffer.byteLength(wire)+' byte envelope');
 }
});
