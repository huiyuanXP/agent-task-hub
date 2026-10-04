import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as api from '../../runner/workspaces.mjs';
import * as docker from '../../runner/docker.mjs';
const childScript=fileURLToPath(new URL('./fixtures/workspace-child.mjs',import.meta.url));
async function waitUntil(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('Timed out waiting for cleanup')}
async function child(t,mode,extra={}){
 const root=await mkdtemp('/tmp/ath-child-');const p=spawn(process.execPath,[childScript,root,mode],{env:{PATH:'/usr/bin:/bin',...extra},stdio:['ignore','ignore','pipe','ipc']});
 let errors='';p.stderr.on('data',b=>{errors+=b.toString().slice(0,4096-errors.length)});
 const message=await new Promise((resolve,reject)=>{p.once('message',resolve);p.once('exit',()=>reject(Error('Child failed: '+errors)));p.once('error',reject)});
 t.after(async()=>{p.kill('SIGKILL');await api.cleanupWorkspace(message.workspace);await rm(root,{recursive:true,force:true})});
 return{p,root,...message};
}
for(const mode of ['running','paused'])test(`SIGKILL of supervisor during ${mode} work leaves independent watchdog cleanup`,async t=>{
 const {p,workspace,state,captureFinished}=await child(t,mode);const deadline=state.deadlineMs;
 if(mode==='paused')assert.equal(captureFinished,false,'kill during active frozen capture');
 if(mode==='paused')assert.equal((await docker.inspectContainer(state.containerId)).State.Paused,true);
 p.kill('SIGKILL');
 await waitUntil(async()=>await docker.inspectContainer(state.containerId)===null,Math.max(1,deadline-Date.now())+8000);
 await waitUntil(async()=>await docker.inspectVolume(state.volumeName)===null,5000);
 const terminal=await api.inspectWorkspace(workspace);assert.equal(terminal.state,'removed');assert.equal(terminal.deadlineMs,deadline);
 await api.cleanupWorkspace(workspace);await assert.rejects(api.startWorkspace(workspace),/state|final/);
});
test('isolated synthetic Docker client defaults and remote selectors never enter effective guest environment',async t=>{
 const config=await mkdtemp('/tmp/ath-docker-config-');t.after(()=>rm(config,{recursive:true,force:true}));
 await writeFile(config+'/config.json',JSON.stringify({currentContext:'synthetic-remote',proxies:{default:{httpProxy:'http://synthetic-secret.invalid:8080',httpsProxy:'http://synthetic-secret.invalid:8080',ftpProxy:'http://synthetic-secret.invalid:8080',allProxy:'http://synthetic-secret.invalid:8080',noProxy:'synthetic-secret.invalid'}}}),{mode:0o600});
 const {state}=await child(t,'environment',{DOCKER_CONFIG:config,DOCKER_CONTEXT:'synthetic-remote',DOCKER_HOST:'tcp://synthetic-remote.invalid:2375',HTTP_PROXY:'http://synthetic-secret.invalid:8080'});
 const inspected=await docker.inspectContainer(state.containerId);
 const keys=['HTTP_PROXY','HTTPS_PROXY','FTP_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','ftp_proxy','all_proxy','no_proxy'];
 // Inspect privately: only assertions, never output the effective values.
 assert.equal(inspected.Config.Env.some(value=>value.includes('synthetic-secret')),false);
 for(const key of keys)assert.equal(inspected.Config.Env.includes(key+'='),true);
});
test('missing watchdog fails closed and recovery removes owned runtime while preserving bounded logs',async t=>{
 const {p,workspace,state,root}=await child(t,'environment');p.kill('SIGKILL');process.kill(state.watchdog.pid,'SIGKILL');
 await assert.rejects(api.captureArtifacts(workspace,[{path:'output/result.json',maxBytes:128}]),/watchdog/);
 const recovered=await api.recoverWorkspaces(root+'/state');assert.equal(recovered[0].state,'removed');
 assert.equal(await docker.inspectContainer(state.containerId),null);assert.equal(await docker.inspectVolume(state.volumeName),null);
 assert.ok((await readFile(root+'/state/'+workspace.id+'/stdout.log')).length<=65536);
});

test('setup guardian survives parent SIGKILL and reaps a late stopped create after initial absence',async t=>{
 const {p,workspace,state}=await child(t,'uncertain');p.kill('SIGKILL');
 assert.equal((await api.inspectWorkspace(workspace)).state,'removal_pending');
 const late=await docker.request('POST',`/containers/create?name=${state.importerName}`,{body:docker.containerConfig(state,true),timeoutMs:20000});
 const observed=await docker.inspectContainer(late.Id);if(observed)assert.equal(observed.State.Running,false);
 await waitUntil(async()=>await docker.inspectContainer(late.Id)===null,8000);
 await waitUntil(async()=>(await api.inspectWorkspace(workspace)).state==='removed',5000);
 assert.equal(await docker.inspectVolume(state.volumeName),null);
 await assert.rejects(docker.request('POST',`/containers/${late.Id}/start`),e=>e.statusCode===404);
});
