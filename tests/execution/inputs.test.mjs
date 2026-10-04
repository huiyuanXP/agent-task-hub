import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,link} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {snapshotInputs} from '../../runner/inputs.mjs';
import {normalizePolicy} from '../../runner/policy.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('input manifest limits and special files are enforced before guest access',async t=>{
 const root=await mkdtemp('/tmp/ath-input-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(root+'/input');
 const policy=normalizePolicy({maxInputBytes:4});await writeFile(root+'/input/a','12345');
 await assert.rejects(snapshotInputs(root,[{path:'input/a',bytes:5,sha256:digest('12345')}],policy),/bytes/);
 execFileSync('mkfifo',[root+'/input/fifo']);
 await assert.rejects(snapshotInputs(root,[{path:'input/fifo',bytes:0,sha256:digest('')}],policy),/special/);
 await mkdir(root+'/input/dir');await assert.rejects(snapshotInputs(root,[{path:'input/dir',bytes:0,sha256:digest('')}],policy),/special/);
 await symlink(root+'/input',root+'/alias');await assert.rejects(snapshotInputs(root+'/alias',[],policy),/manifest/);
});
test('pinned source handles reject link swaps and never import outside bytes during parent rename races',async t=>{
 const root=await mkdtemp('/tmp/ath-race-');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/safe/input',{recursive:true});await mkdir(root+'/outside/input',{recursive:true});
 const good=Buffer.alloc(1024*1024,65),bad=Buffer.alloc(1024*1024,66);
 await writeFile(root+'/safe/input/a',good);await writeFile(root+'/outside/input/a',bad);
 const attacker=spawn(process.execPath,['--input-type=module','-e',`import{rename,symlink,unlink}from'node:fs/promises';const root=process.argv[1];for(let i=0;i<1000;i++){try{await rename(root+'/safe/input',root+'/park');await symlink(root+'/outside/input',root+'/safe/input');await unlink(root+'/safe/input');await rename(root+'/park',root+'/safe/input')}catch{}}`,root],{stdio:'ignore'});
 const exit=new Promise(resolve=>attacker.once('exit',resolve));t.after(()=>attacker.kill());
 let safe=0,rejected=0;
 for(let i=0;i<40;i++)try{const files=await snapshotInputs(root+'/safe',[{path:'input/a',bytes:good.length,sha256:digest(good)}],normalizePolicy());assert.deepEqual(files[0].bytes,good);safe++}catch(e){assert.match(e.message,/ENOENT|ENOTDIR|ELOOP|changed|manifest/);rejected++}
 await exit;assert.equal(safe+rejected,40);
 // Deterministic root symlink and regular-file hardlink checks complement the racing case.
 await symlink(root+'/outside',root+'/root-alias');await assert.rejects(snapshotInputs(root+'/root-alias',[{path:'input/a',bytes:bad.length,sha256:digest(bad)}],normalizePolicy()),/ENOTDIR|ELOOP/);
 await link(root+'/outside/input/a',root+'/outside/input/hard');await assert.rejects(snapshotInputs(root+'/outside',[{path:'input/hard',bytes:bad.length,sha256:digest(bad)}],normalizePolicy()),/link/);
});
