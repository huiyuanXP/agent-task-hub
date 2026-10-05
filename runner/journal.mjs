import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { atomicWrite, safeRead, secureRoot, syncDirectory, workspaceId, cleanTemps } from './state.mjs';
import { canonical } from '../lib/execution/transport.mts';
export async function openJournal(root) {
  root=await secureRoot(root);
  const lock=spawn('/usr/bin/flock',['--exclusive','--nonblock',join(root,'.supervisor.lock'),process.execPath,'-e',"process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','ignore']});
  await new Promise((resolve,reject)=>{lock.once('error',reject);lock.once('exit',()=>reject(Error('Supervisor already owns journal')));lock.stdout.once('data',resolve);});
  let failure=null,releasing=false;
  const unavailable=()=>Object.assign(Error('Durable journal unavailable'),{status:503});
  const assertAvailable=()=>{if(failure)throw unavailable();};
  lock.on('exit',()=>{if(!releasing)failure=unavailable();});
  const release=async()=>{releasing=true;lock.stdin.end();await new Promise(r=>{if(lock.exitCode!==null)r();else lock.once('exit',r);});};
  try {
    const directory=join(root,'journal');await mkdir(directory,{mode:0o700,recursive:true});await secureRoot(directory);await syncDirectory(root);
    let serial=Promise.resolve();const jobs=new Map();
    await cleanTemps(directory);const names=await readdir(directory);if(names.length>128)throw Error('Journal capacity exceeded');
    for(const name of names){if(name.startsWith('.tmp-'))continue;if(!/^ath-[a-f0-9]{40}\.json$/.test(name))throw Error('Unexpected journal entry');
      const job=JSON.parse((await safeRead(join(directory,name))).toString());if(job.backendId!==workspaceId(job.permit)||name!==job.backendId+'.json')throw Error('Journal identity mismatch');jobs.set(job.backendId,job);}
    return {root,jobs,release,assertAvailable,async transaction(fn){const next=serial.then(()=>{assertAvailable();return fn();});serial=next.catch(()=>{});return next;},async save(job){assertAvailable();try{await atomicWrite(directory,job.backendId+'.json',Buffer.from(canonical(job)));}catch(error){failure=error;throw unavailable();}}};
  }catch(e){await release();throw e;}
}
