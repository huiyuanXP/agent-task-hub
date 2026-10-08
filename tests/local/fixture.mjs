import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken } from '../../lib/local-auth.mts';
import { freePort } from '../harness.mjs';

const ownedFixtures=new Set();
let interrupting;
function interrupted(code){
 if(interrupting)return;
 interrupting=Promise.allSettled([...ownedFixtures].map(close=>close())).then(()=>process.exit(code));
}
const onInt=()=>interrupted(130),onTerm=()=>interrupted(143);
function own(close){
 if(ownedFixtures.size===0){process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);}
 ownedFixtures.add(close);
}
function release(close){
 ownedFixtures.delete(close);
 if(ownedFixtures.size===0){process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);}
}

export function fixtureEnvironment(settings = {}) {
  const allowed = new Set(['APP_SCHEDULER_INTERVAL_MS', 'UV_THREADPOOL_SIZE', 'EXECUTION_REGISTRY', 'EXECUTION_RUNNER_URL', 'EXECUTION_RUNNER_AUDIENCE', 'EXECUTION_CHECKPOINT_AUDIENCE', 'EXECUTION_CONTROL_KEY', 'EXECUTION_RUNNER_KEY', 'EXECUTION_EVIDENCE_KEY']);
  for (const name of Object.keys(settings)) if (!allowed.has(name)) throw Error(`Unsupported fixture setting: ${name}`);
  const env = Object.fromEntries(['PATH','HOME','USER','LANG','LC_ALL','TMPDIR','CI'].filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]]));
  return {...env,NEXT_TELEMETRY_DISABLED:'1',APP_SCHEDULER_INTERVAL_MS:'0',...settings};
}

export async function localFixture(options = {}) {
  const env = fixtureEnvironment(options.env);
  const dir = mkdtempSync(join(tmpdir(), 'hub-http-'));
  let db, child, output = '', closed = false, closing;
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, file = join(dir, 'data.sqlite');
  const signalGroup = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = async () => {
    if (!child) return;
    const stopping = child;
    signalGroup('SIGTERM');
    let timer;
    try {
      if (stopping.exitCode === null && stopping.signalCode === null) {
        await Promise.race([once(stopping, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
      }
      // Descendants can outlive their parent: always kill the owned group.
      signalGroup('SIGKILL');
      if (stopping.exitCode === null && stopping.signalCode === null) await once(stopping, 'exit');
    } finally { clearTimeout(timer); child = undefined; }
  };
  const start = async () => {
    if (closed || child) throw Error('Fixture is closed or already running');
    child = spawn(process.execPath, ['--experimental-strip-types','scripts/server.mjs',...(options.dev ? ['--dev'] : []),'--port',String(port)], {
      cwd: options.cwd ?? process.cwd(), detached: true,
      env: {...env,APP_HOST:'127.0.0.1',APP_PORT:String(port),APP_DB_PATH:file,APP_ORIGIN:origin}, stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data', chunk => {output += chunk;}); child.stderr.on('data', chunk => {output += chunk;});
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Local server exited: ${output}`);
      try { if ((await fetch(origin+'/api/session', {signal:AbortSignal.timeout(1000)})).status === 401) return; } catch {}
      await new Promise(resolve => setTimeout(resolve,250));
    }
    throw Error(`Local server did not become ready: ${output}`);
  };
  function close() {
    if(closing)return closing;
    closed=true;
    closing=(async()=>{try{await stop();}finally{db?.close();rmSync(dir,{recursive:true,force:true});release(close);}})();
    return closing;
  }
  if(options.manageSignals!==false)own(close);
  try {
    db = openDatabase(file);
    const alice = await createAccount(db,{username:'alice',displayName:options.aliceName ?? 'Alice Local',password:'synthetic-password'});
    const bob = await createAccount(db,{username:'bob',displayName:options.bobName ?? 'Bob Local',password:'synthetic-password'});
    const aliceToken = await issueToken(db,alice.userId,{kind:'api'}), bobToken = await issueToken(db,bob.userId,{kind:'api'});
    await start();
    return {origin,file,dir,db,alice,bob,aliceToken:aliceToken.token,bobToken:bobToken.token,get pid(){return child?.pid;},get output(){return output;},start,stop,close};
  } catch (error) {await close(); throw error;}
}
