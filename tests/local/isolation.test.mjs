import test from 'node:test';
import assert from 'node:assert/strict';
import { localFixture } from './fixture.mjs';
test('native fixtures do not inherit execution credentials or registry settings', async t => {
 const previous=process.env.EXECUTION_REGISTRY; process.env.EXECUTION_REGISTRY='{private-invalid-registry';
 t.after(()=>{if(previous===undefined)delete process.env.EXECUTION_REGISTRY;else process.env.EXECUTION_REGISTRY=previous;});
 const f=await localFixture();t.after(()=>f.close());
 const headers={authorization:'Bearer '+f.aliceToken,origin:f.origin,'content-type':'application/json'};
 const ticket=await (await fetch(f.origin+'/api/records',{method:'POST',headers,body:JSON.stringify({kind:'ticket',title:'Synthetic isolation',status:'todo'})})).json();
 const catalog=await fetch(f.origin+`/api/authorization?ticketId=${ticket.id}&expectedRevision=1`,{headers});
 assert.equal(catalog.status,200,await catalog.text());
});

test('independent native invocations retain separate files, accounts, ports and reap actual interrupted groups',async()=>{
 const {spawn}=await import('node:child_process');
 const {once}=await import('node:events');
 const {access}=await import('node:fs/promises');
 const {createServer}=await import('node:net');
 const children=[];
 const launch=async title=>{
  const child=spawn(process.execPath,['--experimental-strip-types','tests/local/fixtures/instance.mjs',title],{env:{...process.env,APP_HOST:'127.0.0.2',APP_DB_PATH:'/must-not-use/private.sqlite',APP_ORIGIN:'https://foreign.invalid',EXECUTION_CONTROL_KEY:'private-inherited-key'},stdio:['ignore','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);children.push(child);
  const data=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw Error('Instance exited: '+output);})]);return {child,data};
 };
 let first,second;
 try{
  [first,second]=await Promise.all([launch('First isolated invocation'),launch('Second isolated invocation')]);
  assert.notEqual(first.data.file,second.data.file);assert.notEqual(first.data.origin,second.data.origin);assert.notEqual(first.data.owner,second.data.owner);
  assert.deepEqual(first.data.titles,['First isolated invocation']);assert.deepEqual(second.data.titles,['Second isolated invocation']);
  console.log('INDEPENDENT_NATIVE_EVIDENCE '+JSON.stringify([first.data,second.data]));
  const interrupted=once(first.child,'exit');first.child.kill('SIGTERM');const [code]=await interrupted;assert.equal(code,143);
  await assert.rejects(access(first.data.dir),{code:'ENOENT'});assert.throws(()=>process.kill(first.data.pid,0),{code:'ESRCH'});
  assert.equal((await fetch(second.data.origin+'/api/session')).status,401,'Other process remains alive after interruption');
  const exited=once(second.child,'exit');second.child.send('close');await exited;
  await assert.rejects(access(second.data.dir),{code:'ENOENT'});assert.throws(()=>process.kill(second.data.pid,0),{code:'ESRCH'});
  for(const {data}of[first,second]){
   const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(data.origin).port),'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));
  }
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
 }
});
