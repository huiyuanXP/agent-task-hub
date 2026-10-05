import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openJournal } from '../../runner/journal.mjs';
import { workspaceId } from '../../runner/state.mjs';
test('a failed durable write poisons subsequent reads and admission until restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-journal-'));const journal=await openJournal(root);t.after(async()=>{await journal.release();await rm(root,{recursive:true,force:true});});
 const permit={owner:'synthetic',runId:'journal',attempt:1};const job={backendId:workspaceId(permit),permit,receipts:[]};await journal.transaction(()=>journal.save(job));
 await rename(join(root,'journal'),join(root,'saved'));await writeFile(join(root,'journal'),'not a directory');job.receipts.push({undurable:true});
 await assert.rejects(journal.transaction(()=>journal.save(job)),{status:503});await rm(join(root,'journal'));await rename(join(root,'saved'),join(root,'journal'));
 await assert.rejects(journal.transaction(()=>job.receipts),{status:503});assert.throws(()=>journal.assertAvailable(),{status:503});assert.deepEqual(JSON.parse(await readFile(join(root,'journal',job.backendId+'.json'),'utf8')).receipts,[]);
});
test('the actual singleton lock excludes a second supervisor and loss fails closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-lock-'));const journal=await openJournal(root);t.after(async()=>{await journal.release();await rm(root,{recursive:true,force:true});});await assert.rejects(openJournal(root),/already owns/);
 const rows=execFileSync('ps',['-eo','pid=,ppid=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/));const lock=rows.find(row=>Number(row?.[2])===process.pid&&row[3].includes(join(root,'.supervisor.lock')));assert.ok(lock);const holder=rows.find(row=>row?.[2]===lock[1])?.[1];assert.match(holder,/^\d+$/);process.kill(Number(holder),'SIGTERM');
 const until=Date.now()+2000;let failed=false;while(Date.now()<until){try{journal.assertAvailable();}catch{failed=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(failed,true);await assert.rejects(journal.transaction(()=>true),{status:503});await journal.release();const retry=await openJournal(root);await retry.release();
});
