import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,link,open,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const api=await import('../../runner/artifacts.mjs');
const bounds={maxArchiveEntries:10,maxArtifactBytes:100,workTmpfsMb:1};
const declarations=[{path:'output/a',maxBytes:10}];
test('full pinned tmpfs scan accepts exact bytes and rejects undeclared aliases, specials and boundedness violations',async t=>{
 assert.equal(typeof api.scanArtifacts,'function','pinned artifact scanning is missing');
 const root=await mkdtemp('/dev/shm/ath-artifacts-');t.after(()=>rm(root,{recursive:true,force:true}));const handle=await open(root);t.after(()=>handle.close());
 await writeFile(root+'/a','ok');assert.equal((await api.scanArtifacts(handle,declarations,bounds,Date.now()+1000))[0].bytes.toString(),'ok');
 await link(root+'/a',root+'/z');await assert.rejects(api.scanArtifacts(handle,declarations,bounds,Date.now()+1000),/link/);await rm(root+'/z');
 await symlink('/etc/passwd',root+'/z');await assert.rejects(api.scanArtifacts(handle,declarations,bounds,Date.now()+1000),/link|ELOOP/);await rm(root+'/z');
 execFileSync('mkfifo',[root+'/z']);await assert.rejects(api.scanArtifacts(handle,declarations,bounds,Date.now()+1000),/special/);await rm(root+'/z');
 await mkdir(root+'/d');await writeFile(root+'/d/b','hidden in subtree');
 await assert.rejects(api.scanArtifacts(handle,declarations,{...bounds,maxArchiveEntries:1},Date.now()+1000),/entries/);
 await assert.rejects(api.scanArtifacts(handle,[{path:'output/a',maxBytes:1}],bounds,Date.now()+1000),/bytes/);
 await assert.rejects(api.scanArtifacts(handle,[{path:'output/missing',maxBytes:10}],bounds,Date.now()+1000),/missing/);
 await assert.rejects(api.scanArtifacts(handle,declarations,bounds,Date.now()-1),/deadline/);
 await writeFile(root+'/huge',Buffer.alloc(1048577));await assert.rejects(api.scanArtifacts(handle,declarations,bounds,Date.now()+1000),/bytes/);
});

test('mount identity validation rejects nested binds even with the same filesystem device',async()=>{
 const {validateMountInfo}=await import('../../runner/container-files.mjs');
 const root='93 83 0:45 / /job/output rw,nosuid,nodev - tmpfs tmpfs rw,size=65536k';
 assert.doesNotThrow(()=>validateMountInfo(root,'93'));
 assert.throws(()=>validateMountInfo(root+'\n94 93 0:45 /sub /job/output/nested rw - tmpfs tmpfs rw','93'),/Nested/);
 assert.throws(()=>validateMountInfo(root,'94'),/identity/);
 assert.throws(()=>validateMountInfo(root.replace(' / /job/output',' /sub /job/output'),'93'),/identity/);
 assert.throws(()=>validateMountInfo(root.replace('tmpfs tmpfs','ext4 disk'),'93'),/identity/);
});
