import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as api from '../../../runner/workspaces.mjs';
const root=process.argv[2],mode=process.argv[3];
const w=await api.createWorkspace(root+'/state',{owner:'child',runId:root,attempt:1},{ceilings:{timeoutMs:15000}});
await mkdir(root+'/source/input',{recursive:true});await writeFile(root+'/source/input/a','{}');
await api.importInputs(w,root+'/source',[{path:'input/a',bytes:2,sha256:createHash('sha256').update('{}').digest('hex')}]);
if(mode==='uncertain'){
 const disk=await import('../../../runner/state.mjs');
 await disk.withWorkspace(w,async(state,save)=>{state.state='removal_pending';state.importerId=null;state.creates.importer='intent';await save()});
 process.send({workspace:w,state:await api.inspectWorkspace(w)});await new Promise(()=>{});
}
await api.startWorkspace(w);
if(mode==='running'){
 const e=await api.createExecution(w,['node','-e',"console.log('started');setInterval(()=>{},1000)"]);
 const running=api.startExecution(w,e.id);
 // Poll authoritative daemon state through the separately exposed exec inspect API.
 const {inspectExec}=await import('../../../runner/docker.mjs');
 while(!(await inspectExec(e.id)).Running)await new Promise(resolve=>setTimeout(resolve,10));
 process.send({workspace:w,state:await api.inspectWorkspace(w)});await running;
}else{
 const script="const fs=require('fs');fs.writeFileSync('output/result.json','child proof');"+(mode==='paused'?"for(let i=0;i<4000;i++)fs.writeFileSync('output/f'+i,'')":'');
 const e=await api.createExecution(w,['node','-e',script]);
 await api.startExecution(w,e.id);
 if(mode==='environment'){process.send({workspace:w,state:await api.inspectWorkspace(w)});await new Promise(()=>{});}
 else {let captureFinished=false;const capture=api.captureArtifacts(w,[{path:'output/result.json',maxBytes:128}]).finally(()=>{captureFinished=true});
 while((await api.inspectWorkspace(w)).state!=='frozen')await new Promise(resolve=>setTimeout(resolve,5));
 process.send({workspace:w,state:await api.inspectWorkspace(w),captureFinished});await capture;await new Promise(()=>{});}
}
