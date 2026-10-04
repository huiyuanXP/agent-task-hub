import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as api from '../../runner/workspaces.mjs';
import * as docker from '../../runner/docker.mjs';
async function workspace(t, policy = {}) {
  assert.equal(typeof api.startWorkspace, 'function', 'Docker lifecycle implementation is missing');
  const root = await mkdtemp(join(tmpdir(), 'ath-docker-'));
  const w = await api.createWorkspace(join(root, 'state'), { owner: 'test', runId: root, attempt: 1 }, policy);
  t.after(async () => { await api.cleanupWorkspace(w); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'source/input'), { recursive: true });
  const bytes = Buffer.from('{"title":"real Docker"}');
  await writeFile(join(root, 'source/input/ticket.json'), bytes);
  await api.importInputs(w, join(root, 'source'), [{ path: 'input/ticket.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]);
  await api.startWorkspace(w);
  return w;
}
async function execute(w, script) {
  const execution = await api.createExecution(w, ['node', '-e', script]);
  assert.match(execution.id, /^[a-f0-9]{64}$/);
  return api.startExecution(w, execution.id);
}
test('real Docker denies host, sibling, network, root/input writes and inherited authority; exposes true exec status', async t => {
  const w = await workspace(t);
  const result = await execute(w, `const fs=require('fs'),net=require('net');let denied=0;for(const p of ['/workspace','/var/run/docker.sock','/job/other']){try{fs.readdirSync(p)}catch{denied++}}for(const p of ['/etc/injected','/job/input/ticket.json']){try{fs.writeFileSync(p,'bad')}catch{denied++}}if(process.getuid()!==1000)throw Error('uid');for(const k of ['HTTP_PROXY','HTTPS_PROXY','FTP_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','ftp_proxy','all_proxy','no_proxy'])if(process.env[k])throw Error('proxy');fs.writeFileSync('output/result.json','artifact');const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(99));s.on('error',()=>{console.log('denied='+denied);process.exit(23)});setTimeout(()=>process.exit(98),1000);`);
  assert.equal(result.exitCode, 23);
  assert.equal(result.stdout.toString(), 'denied=5\n');
  assert.equal(result.stderr.length, 0);
  const artifacts = await api.captureArtifacts(w, [{ path: 'output/result.json', maxBytes: 128 }]);
  assert.equal(artifacts[0].bytes.toString(), 'artifact');
  assert.equal(artifacts[0].sha256, 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c');
  assert.equal((await api.inspectWorkspace(w)).state, 'frozen');
});
test('real Docker enforces writable mount caps and output stream limits', async t => {
  const w = await workspace(t, { workTmpfsMb: 1, maxLogBytes: 1024 });
  const result = await execute(w, `const fs=require('fs');let denied=0;for(const [p,n] of [['output/full',2],['/tmp/full',9],['/dev/shm/full',9]])try{fs.writeFileSync(p,Buffer.alloc(n*1024*1024))}catch(e){if(e.code==='ENOSPC')denied++}console.error('denied='+denied);console.log('x'.repeat(100000));`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr.toString(), 'denied=3\n');
});
for (const [name, script] of [
  ['hardlink declared first', "fs.writeFileSync('output/a','same');fs.linkSync('output/a','output/z')"],
  ['hardlink alias first', "fs.writeFileSync('output/z','same');fs.linkSync('output/z','output/a')"],
  ['symlink', "fs.writeFileSync('output/a','same');fs.symlinkSync('a','output/z')"],
  ['FIFO', "fs.writeFileSync('output/a','same');require('child_process').execFileSync('mkfifo',['output/z'])"],
]) test(`full actual frozen tmpfs scan rejects ${name}`, async t => {
  const w = await workspace(t);
  assert.equal((await execute(w, `const fs=require('fs');${script}`)).exitCode, 0);
  await assert.rejects(api.captureArtifacts(w, [{ path: 'output/a', maxBytes: 128 }]), /link|special|ELOOP/);
  assert.equal((await api.inspectWorkspace(w)).state, 'frozen');
});
test('watchdog removes running container at immutable deadline and cannot restart a finalized ID', async t => {
  // Keep the total deadline fixed, while leaving setup enough room to reach
  // the running-execution condition this regression specifically exercises.
  const w = await workspace(t, { ceilings: { timeoutMs: 15000 } });
  const state = await api.inspectWorkspace(w);
  const execution = await api.createExecution(w, ['node', '-e', 'setInterval(()=>{},1000)']);
  await assert.rejects(api.startExecution(w, execution.id), /deadline|removed|exit|socket|aborted|timeout/);
  await api.cleanupWorkspace(w);
  await assert.rejects(api.startWorkspace(w), /removed|state|final/);
  assert.equal(await docker.inspectContainer(state.containerId), null);
});

test('daemon resource limits are effective and command status cannot be forged by guest prose',async t=>{
 const w=await workspace(t,{ceilings:{cpus:0.25,memoryMb:128,pids:16}});
 const result=await execute(w,`const fs=require('fs');console.log(JSON.stringify({cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}));console.log('EXIT_CODE=0');fs.writeFileSync('output/status','0');process.exit(19)`);
 assert.equal(result.exitCode,19);
 const limits=JSON.parse(result.stdout.toString().split('\n')[0]);assert.equal(limits.cpu,'25000 100000');assert.equal(limits.memory,'134217728');assert.equal(limits.pids,'16');
 const state=await api.inspectWorkspace(w),c=await docker.inspectContainer(state.containerId);
 assert.equal(c.HostConfig.LogConfig.Type,'none');assert.equal(c.HostConfig.NanoCpus,250000000);
 await assert.rejects(api.createExecution(w,['node','-e','process.exit(0)']),/reserved/);
 await assert.rejects(api.startExecution(w,state.execution.id),/state/);
});

test('timeout retains bounded partial output while refusing evidence success',async t=>{
 const w=await workspace(t,{ceilings:{timeoutMs:10000},maxLogBytes:32});
 const e=await api.createExecution(w,['node','-e',"console.log('before timeout');setInterval(()=>{},1000)"]);
 await assert.rejects(api.startExecution(w,e.id),/deadline|removed|exit|timeout|aborted/);
 await api.cleanupWorkspace(w);
 const state=await api.inspectWorkspace(w);
 assert.equal(state.execution.phase,'unavailable');
 const {readFile}=await import('node:fs/promises');
 assert.match(await readFile(join(w.root,w.id,'stdout.log'),'utf8'),/before timeout/);
 assert.equal(state.artifacts,undefined);
});

test('capture verifies pinned process identity and removal cannot redirect an existing proc-directory handle',async t=>{
 const w=await workspace(t);assert.equal((await execute(w,"require('fs').writeFileSync('output/result.json','pinned')")).exitCode,0);
 await api.captureArtifacts(w,[{path:'output/result.json',maxBytes:128}]);const state=await api.inspectWorkspace(w);
 const {pinFrozenOutput}=await import('../../runner/container-files.mjs');
 await assert.rejects(pinFrozenOutput({...state,authority:'wrong'}),/ownership/);
 await assert.rejects(pinFrozenOutput({...state,processIdentity:'wrong'}),/identity/);
 const pinned=await pinFrozenOutput(state);
 try{await api.cleanupWorkspace(w);await assert.rejects(pinned.verify(),/ENOENT|ESRCH|removed|identity/)}finally{await pinned.close()}
});
test('entire frozen tmpfs obeys entry caps even when declared artifact itself is small',async t=>{
 const w=await workspace(t,{maxArchiveEntries:3});assert.equal((await execute(w,"const fs=require('fs');fs.writeFileSync('output/result.json','ok');for(let i=0;i<4;i++)fs.writeFileSync('output/hidden'+i,'')")).exitCode,0);
 await assert.rejects(api.captureArtifacts(w,[{path:'output/result.json',maxBytes:128}]),/entries/);
 assert.equal((await api.inspectWorkspace(w)).artifacts,undefined);
});
test('expired collection produces unavailable evidence without extending the original deadline',async t=>{
 const w=await workspace(t,{ceilings:{timeoutMs:10000}});assert.equal((await execute(w,"require('fs').writeFileSync('output/result.json','late')")).exitCode,0);
 const state=await api.inspectWorkspace(w);
 await new Promise(resolve=>setTimeout(resolve,Math.max(1,state.deadlineMs-Date.now()+20)));
 await assert.rejects(api.captureArtifacts(w,[{path:'output/result.json',maxBytes:128}]),/deadline|ready|removed/);
 await api.cleanupWorkspace(w);assert.equal((await api.inspectWorkspace(w)).deadlineMs,state.deadlineMs);assert.equal((await api.inspectWorkspace(w)).artifacts,undefined);
});

test('the shared catalog argv reads imported input and produces its declared result at the fixed layout',async t=>{
 const {operationDescriptor,REGISTERED_OPERATIONS}=await import('../../lib/execution/catalog.mts');
 const descriptor=await operationDescriptor('{"title":"real Docker"}',REGISTERED_OPERATIONS[0]);
 const w=await workspace(t,descriptor.policy),e=await api.createExecution(w,descriptor.argv);
 assert.equal((await api.startExecution(w,e.id)).exitCode,0);
 const artifacts=await api.captureArtifacts(w,descriptor.artifacts);
 const result=JSON.parse(artifacts[0].bytes.toString());assert.equal(result.title,'real Docker');assert.equal(result.ok,true);
});
