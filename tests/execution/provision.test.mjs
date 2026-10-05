import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backendConfiguration } from '../../lib/execution/backend-config.mts';
test('fresh provisioning creates three usable separate keypairs in private files and refuses overwrite',async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-provision-'));t.after(()=>rm(root,{recursive:true,force:true}));const target=join(root,'keys');
 const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',target,'http://127.0.0.1:3000','http://127.0.0.1:4210'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 assert.deepEqual((await readdir(target)).sort(),['control.json','runner.json']);
 const env=JSON.parse(await readFile(join(target,'control.json'),'utf8'));const config=await backendConfiguration(env);assert.equal(config.transport.signing.privateKey.type,'private');assert.equal(config.evidenceTrust.key.type,'public');
 const node=JSON.parse(await readFile(join(target,'runner.json'),'utf8'));assert.equal(node.controlPublic.jwk.d,undefined);assert.equal(typeof node.evidencePrivate.jwk.d,'string');
 for(const file of ['control.json','runner.json'])assert.equal((await stat(join(target,file))).mode&0o077,0);
 assert.equal((await stat(target)).mode&0o077,0);assert.equal(result.stdout.includes(node.evidencePrivate.jwk.d),false);
 assert.notEqual(spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',target,'http://127.0.0.1:3000','http://127.0.0.1:4210']).status,0);
});
test('distinct labels cannot disguise reused transport/evidence signing material',async()=>{
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const priv=await crypto.subtle.exportKey('jwk',pair.privateKey),pub=await crypto.subtle.exportKey('jwk',pair.publicKey);
 await assert.rejects(backendConfiguration({EXECUTION_RUNNER_URL:'http://127.0.0.1:4321',EXECUTION_RUNNER_AUDIENCE:'runner',EXECUTION_CONTROL_KEY:JSON.stringify({keyId:'control',jwk:priv}),EXECUTION_RUNNER_KEY:JSON.stringify({keyId:'node',jwk:pub}),EXECUTION_EVIDENCE_KEY:JSON.stringify({keyId:'evidence',jwk:pub})}));
});
test('provisioning rejects an unusable ephemeral supervisor port',async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-port-'));t.after(()=>rm(root,{recursive:true,force:true}));const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',join(root,'keys'),'http://127.0.0.1:3000','http://127.0.0.1:0'],{encoding:'utf8'});assert.notEqual(result.status,0);
});
test('private configuration can represent all 32 accepted escaped-argv registry entries',async t=>{
 const {writeFile}=await import('node:fs/promises');const {runSupervisor}=await import('../../runner/main.mjs');const root=await mkdtemp(join(tmpdir(),'execution-registry-config-'));t.after(()=>rm(root,{recursive:true,force:true}));const target=join(root,'keys');const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',target,'http://127.0.0.1:3000','http://127.0.0.1:4210'],{encoding:'utf8'});assert.equal(result.status,0);
 const file=join(target,'runner.json');const config=JSON.parse(await readFile(file,'utf8'));config.port=0;config.registry=Array.from({length:32},(_,i)=>({...config.registry[0],operationId:'wide.'+i,argv:['node','-e','','\u0001'.repeat(12000),'\u0001'.repeat(12000)],inputs:[],artifacts:[]}));const bytes=JSON.stringify(config);assert.ok(Buffer.byteLength(bytes)>262144);assert.ok(Buffer.byteLength(bytes)<16777216);await writeFile(file,bytes,{mode:0o600});const server=await runSupervisor(file);await server.close();
});

test('control provisioning rejects public and normalized loopback origins before creating files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-origin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [i,origin] of ['https://example.com','http://127.1:3000','http://2130706433:3000','http://localhost:0','http://localhost:3000/#'].entries()){
  const target=join(root,'keys-'+i);const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',target,origin,'http://127.0.0.1:4210'],{encoding:'utf8'});assert.notEqual(result.status,0,origin);await assert.rejects(stat(target),{code:'ENOENT'});
 }
});
