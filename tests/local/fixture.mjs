import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken } from '../../lib/local-auth.mts';
export async function localFixture(options={}){
 const dir=mkdtempSync(join(tmpdir(),'hub-http-'));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const origin=`http://127.0.0.1:${port}`,file=join(dir,'data.sqlite'),db=openDatabase(file);
 const alice=await createAccount(db,{username:'alice',displayName:'Alice Local',password:'synthetic-password'});
 const bob=await createAccount(db,{username:'bob',displayName:'Bob Local',password:'synthetic-password'});
 const aliceToken=await issueToken(db,alice.userId,{kind:'api'}),bobToken=await issueToken(db,bob.userId,{kind:'api'});
 let child,output='';
 const start=async()=>{
 child=spawn(process.execPath,['--experimental-strip-types','scripts/server.mjs',...(options.dev?['--dev']:[]),'--port',String(port)],{env:{...process.env,APP_DB_PATH:file,APP_ORIGIN:origin,APP_SCHEDULER_INTERVAL_MS:'0',...options.env},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 for(let i=0;i<240;i++){
 if(child.exitCode!==null)throw Error(`Local server exited: ${output}`);
 try{const response=await fetch(origin+'/api/session');if(response.status===401)return;}catch{}
 await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error(`Local server did not become ready: ${output}`);
 };
 const stop=async()=>{if(child&&child.exitCode===null){const stopping=child;let timer;stopping.kill('SIGTERM');try{await Promise.race([once(stopping,'exit'),new Promise((_,reject)=>{timer=setTimeout(()=>{stopping.kill('SIGKILL');reject(Error('Server shutdown timed out'));},10000);timer.unref();})]);}finally{clearTimeout(timer);}}};
 try{await start();}catch(error){await stop();db.close();rmSync(dir,{recursive:true,force:true});throw error;}
 return {origin,file,db,alice,bob,aliceToken:aliceToken.token,bobToken:bobToken.token,get output(){return output;},start,stop,async close(){await stop();db.close();rmSync(dir,{recursive:true,force:true});}};
}
