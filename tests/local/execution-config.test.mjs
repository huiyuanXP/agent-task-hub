import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('native control server loads private provisioned configuration for the independent signed checkpoint',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-control-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const origin=`http://127.0.0.1:${port}`,target=join(root,'keys');
 const provision=spawnSync(process.execPath,['--experimental-strip-types','scripts/provision-execution.mjs',target,origin,'http://127.0.0.1:4210'],{encoding:'utf8'});assert.equal(provision.status,0,provision.stderr);
 const child=spawn(process.execPath,['--experimental-strip-types','scripts/server.mjs','--execution-config',join(target,'control.json'),'--port',String(port)],{env:{...process.env,APP_DB_PATH:join(root,'data.sqlite'),APP_ORIGIN:origin,APP_SCHEDULER_INTERVAL_MS:'0'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
 let ready=false;
 for(let n=0;n<120;n++){if(child.exitCode!==null)assert.fail(output);try{if((await fetch(origin+'/api/session')).status===401){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
 assert.ok(ready,output);
 assert.equal((await fetch(origin+'/api/execution/checkpoint',{method:'POST',body:'{}'})).status,401,'usable keys reach signed service boundary, not unavailable503');
 const runner=JSON.parse(await readFile(join(target,'runner.json'),'utf8'));
 const {importSigning,importTrust}=await import('../../lib/execution/backend-config.mts');
 const {signRequest,verifyReply}=await import('../../lib/execution/transport.mts');
 const signed=await signRequest(await importSigning(JSON.stringify(runner.transportPrivate)),{direction:'runner-to-control',audience:runner.checkpointAudience,method:'POST',path:'/api/execution/checkpoint',body:'{}'});
 const response=await fetch(origin+'/api/execution/checkpoint',{method:'POST',headers:{'x-execution-signature':JSON.stringify(signed)},body:'{}'});
 const body=await response.text();assert.equal(response.status,503,'synthetic invalid permit crosses real signature boundary and fails domain validation');
 assert.ok(await verifyReply(JSON.parse(response.headers.get('x-execution-signature')),await importTrust(JSON.stringify(runner.controlPublic)),signed,503,body));
 child.kill('SIGTERM');await once(child,'exit');assert.equal(child.exitCode,0);
});

test('malformed private control configuration fails startup before opening SQLite',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-invalid-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'control.json');await writeFile(file,JSON.stringify({APP_DB_PATH:'/should-never-be-loaded'}),{mode:0o600});
 const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/server.mjs','--execution-config',file],{env:{...process.env,APP_DB_PATH:join(root,'unopened.sqlite')},encoding:'utf8'});assert.notEqual(result.status,0);
 const {stat}=await import('node:fs/promises');await assert.rejects(stat(join(root,'unopened.sqlite')),{code:'ENOENT'});
});
