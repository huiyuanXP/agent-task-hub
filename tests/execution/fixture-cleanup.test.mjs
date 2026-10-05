import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cleanupFixture } from './fixtures/cleanup.mjs';
import * as api from '../../runner/workspaces.mjs';
import * as disk from '../../runner/state.mjs';
import * as docker from '../../runner/docker.mjs';

test('fixture cleanup preserves an uncertain owned root until a real late create is reaped', async t => {
  const root = await mkdtemp('/tmp/ath-fixture-cleanup-');
  const w = await api.createWorkspace(root+'/state',{owner:'fixture-cleanup',runId:root,attempt:1});
  const backup=await mkdtemp('/tmp/ath-fixture-backup-');
  let lateAttempted=false;
  t.after(async()=>{
    try{await access(root+'/state/'+w.id+'/metadata.json')}catch{await mkdir(root,{mode:0o700,recursive:true});await cp(backup+'/state',root+'/state',{recursive:true})}
    // This injected intent has no daemon request unless the test reached create.
    if(!lateAttempted)await disk.withWorkspace(w,async(state,save)=>{state.creates.container='none';await save()});
    await cleanupFixture(root);await rm(backup,{recursive:true,force:true});
  });
  await mkdir(root+'/source/input',{recursive:true});await writeFile(root+'/source/input/a','{}');
  await api.importInputs(w,root+'/source',[{path:'input/a',bytes:2,sha256:createHash('sha256').update('{}').digest('hex')}]);
  await disk.withWorkspace(w,async(state,save)=>{state.creates.container='intent';state.state='removal_pending';await save()});
  const state=await api.inspectWorkspace(w);
  await cp(root+'/state',backup+'/state',{recursive:true});
  await assert.rejects(cleanupFixture(root),/pending.*preserv/i);
  await access(root+'/state/.ownership-key');await access(root+'/state/'+w.id+'/metadata.json');
  assert.equal(await disk.processIdentity(state.guardian.pid),state.guardian.start);
  lateAttempted=true;
  const late=await docker.request('POST',`/containers/create?name=${state.containerName}`,{body:docker.containerConfig(state)});
  const observed=await docker.inspectContainer(late.Id);if(observed)assert.equal(observed.State.Running,false);
  const until=Date.now()+8000;
  while((await api.inspectWorkspace(w)).state!=='removed'){if(Date.now()>until)throw Error('Late fixture create not reaped');await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(await docker.inspectContainer(late.Id),null);assert.equal(await docker.inspectVolume(state.volumeName),null);
});
