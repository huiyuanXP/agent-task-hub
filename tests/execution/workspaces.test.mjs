import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupFixture } from './fixtures/cleanup.mjs';
import * as api from '../../runner/workspaces.mjs';
const manifest = (path, value) => ({ path, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });

test('workspace API provides durable isolated ownership, strict imports and idempotent cleanup', async t => {
  assert.equal(typeof api.createWorkspace, 'function', 'isolated workspace implementation is missing');
  const root = await mkdtemp(join(tmpdir(), 'ath-workspaces-'));
  t.after(() => cleanupFixture(root));
  const run = { owner: 'alice', runId: 'run-a', attempt: 1 };
  const first = await api.createWorkspace(join(root, 'state'), run, {});
  assert.deepEqual(await api.createWorkspace(join(root, 'state'), run, {}), first);
  const second = await api.createWorkspace(join(root, 'state'), { ...run, attempt: 2 }, {});
  assert.notEqual(first.id, second.id);
  await assert.rejects(api.cleanupWorkspace({ ...first, id: second.id }), /ownership|identity/);
  const source = join(root, 'source');
  await mkdir(join(source, 'input'), { recursive: true });
  await writeFile(join(source, 'input/ticket.json'), '{}');
  for (const path of ['../secret', '/etc/passwd', 'input/../ticket', 'input/.env', 'input/.ssh/id_rsa', 'input/.git/config', 'input/a\\b']) {
    await assert.rejects(api.importInputs(first, source, [manifest(path, '{}')]), /path|sensitive/);
  }
  await symlink('/etc/passwd', join(source, 'input/symlink'));
  await assert.rejects(api.importInputs(first, source, [manifest('input/symlink', '{}')]), /link|ELOOP/);
  await link(join(source, 'input/ticket.json'), join(source, 'input/alias'));
  await assert.rejects(api.importInputs(first, source, [manifest('input/alias', '{}')]), /link/);
  await rm(join(source, 'input/alias'));
  await assert.rejects(api.importInputs(first, source, [manifest('input/ticket.json', 'wrong')]), /manifest|bytes|hash/);
  await api.importInputs(first, source, [manifest('input/ticket.json', '{}')]);
  await api.cleanupWorkspace(first);
  await api.cleanupWorkspace(first);
  const recovered = await api.recoverWorkspaces(join(root, 'state'));
  assert.equal(recovered.every(item => item.state === 'removed'), true);
  const state = await api.inspectWorkspace(first);
  assert.equal(state.state, 'removed');
  assert.ok(await readFile(join(root, 'state', first.id, 'metadata.json')));
});

test('policy rejects enlarged budgets, authority and unsupported fields before Docker work', async () => {
  assert.equal(typeof api.createWorkspace, 'function', 'isolated workspace implementation is missing');
  for (const policy of [{ network: 'host' }, { credentials: ['secret'] }, { ceilings: { timeoutMs: 30001 } }, { ceilings: { memoryMb: 257 } }, { ceilings: { cpus: 2 } }, { ceilings: { pids: 65 } }, { workTmpfsMb: 65 }, { maxInputBytes: 16777217 }, { dockerOptions: ['--privileged'] }]) {
    await assert.rejects(api.createWorkspace('/invalid/never-created', { owner: 'a', runId: 'r', attempt: 1 }, policy), /policy|budget|limit|scope|field/);
  }
});

test('CPU fractions that round to unlimited or exceed the grant are refused before resource creation', async () => {
  for (const cpus of [1e-99, 0.00001, 0.010000001]) {
    await assert.rejects(api.createWorkspace('/invalid/never-created', { owner: 'a', runId: 'r', attempt: 1 }, { ceilings: { cpus } }), /CPU|precision|budget/);
  }
});

test('metadata tampering cannot redirect resource cleanup and active capacity fails closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ath-capacity-'));const stateRoot=join(root,'state');
 const workspaces=[];t.after(()=>cleanupFixture(root));
 for(let i=0;i<8;i++)workspaces.push(await api.createWorkspace(stateRoot,{owner:'capacity',runId:root,attempt:i+1},{}));
 await assert.rejects(api.createWorkspace(stateRoot,{owner:'capacity',runId:root,attempt:9},{}),/capacity/);
 const w=workspaces[0],path=join(stateRoot,w.id,'metadata.json'),original=await readFile(path);
 const altered=JSON.parse(original);altered.payload.containerName='foreign-container';await writeFile(path,JSON.stringify(altered));
 await assert.rejects(api.cleanupWorkspace(w),/ownership signature/);await writeFile(path,original);
 await api.cleanupWorkspace(w);const next=await api.createWorkspace(stateRoot,{owner:'capacity',runId:root,attempt:9},{});workspaces.push(next);
 assert.equal((await api.inspectWorkspace(w)).state,'removed');
});

test('cleanup refuses an actual foreign Docker volume with the deterministic name',async t=>{
 const docker=await import('../../runner/docker.mjs');const root=await mkdtemp('/tmp/ath-foreign-');
 const w=await api.createWorkspace(root+'/state',{owner:'foreign-test',runId:root,attempt:1},{}),state=await api.inspectWorkspace(w);
 await docker.request('POST','/volumes/create',{body:{Name:state.volumeName,Labels:{'synthetic.foreign':'true'}}});
 t.after(async()=>{await docker.request('DELETE','/volumes/'+state.volumeName);await cleanupFixture(root)});
 await assert.rejects(api.cleanupWorkspace(w),/Foreign resource ownership/);
 assert.ok(await docker.inspectVolume(state.volumeName));
});

test('an unresolved Docker create remains pending after 404 and reaps a later owned object without starting it',async t=>{
 const docker=await import('../../runner/docker.mjs'),disk=await import('../../runner/state.mjs');
 const root=await mkdtemp('/tmp/ath-late-create-');const w=await api.createWorkspace(root+'/state',{owner:'late',runId:root,attempt:1},{});
 t.after(async()=>{await cleanupFixture(root)});
 await disk.withWorkspace(w,async(state,save)=>{state.state='importing';state.creates={volume:'intent',importer:'intent',container:'none'};await save()});
 await api.cleanupWorkspace(w);
 assert.equal((await api.inspectWorkspace(w)).state,'removal_pending');
 const s=await api.inspectWorkspace(w);
 await docker.request('POST','/volumes/create',{body:{Name:s.volumeName,Labels:docker.labels(s)}});
 await api.cleanupWorkspace(w);assert.ok(await docker.inspectVolume(s.volumeName),'volume retained while importer create is unresolved');
 const created=await docker.request('POST',`/containers/create?name=${s.importerName}`,{body:docker.containerConfig(s,true),timeoutMs:20000});
 assert.equal((await docker.inspectContainer(created.Id)).State.Running,false);
 await api.cleanupWorkspace(w);
 assert.equal(await docker.inspectContainer(created.Id),null);assert.equal(await docker.inspectVolume(s.volumeName),null);
 assert.equal((await api.inspectWorkspace(w)).state,'removed');
 await assert.rejects(api.startWorkspace(w),/state|final/);
});

test('retention capacity preserves tombstones and refuses the next identity',async t=>{
 const root=await mkdtemp('/tmp/ath-retention-');t.after(()=>rm(root,{recursive:true,force:true}));
 let first;
 for(let attempt=1;attempt<=64;attempt++){const w=await api.createWorkspace(root+'/state',{owner:'retained',runId:root,attempt},{});first??=w;await api.cleanupWorkspace(w)}
 await assert.rejects(api.createWorkspace(root+'/state',{owner:'retained',runId:root,attempt:65},{}),/retention capacity/);
 assert.equal((await api.inspectWorkspace(first)).state,'removed');
 assert.deepEqual(await api.createWorkspace(root+'/state',{owner:'retained',runId:root,attempt:1},{}),first);
 await assert.rejects(api.startWorkspace(first),/state|final/);
});

test('recovery removes a pre-metadata reservation crash without blocking other owned cleanup',async t=>{
 const root=await mkdtemp('/tmp/ath-reservation-');t.after(()=>rm(root,{recursive:true,force:true}));
 const w=await api.createWorkspace(root+'/state',{owner:'reservation',runId:root,attempt:1},{});
 const orphan='ath-'+'a'.repeat(40);await mkdir(root+'/state/'+orphan,{mode:0o700});
 const recovered=await api.recoverWorkspaces(root+'/state');assert.equal(recovered.length,1);assert.equal(recovered[0].state,'removed');
 const {access}=await import('node:fs/promises');await assert.rejects(access(root+'/state/'+orphan),{code:'ENOENT'});
 assert.equal((await api.inspectWorkspace(w)).state,'removed');
});

test('atomic metadata readers keep valid pinned snapshots while rename retires the old inode',async t=>{
 const disk=await import('../../runner/state.mjs');const root=await mkdtemp('/tmp/ath-atomic-');t.after(()=>rm(root,{recursive:true,force:true}));
 await disk.atomicWrite(root,'snapshot',Buffer.from('trusted'));
 await Promise.all([...(Array.from({length:4},()=> (async()=>{for(let i=0;i<300;i++)assert.equal((await disk.safeRead(root+'/snapshot',2097152,true)).toString(),'trusted')})())),(async()=>{for(let i=0;i<300;i++)await disk.atomicWrite(root,'snapshot',Buffer.from('trusted'))})()]);
});
