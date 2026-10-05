import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createWorkspace, importInputs, startWorkspace, createExecution, startExecution, captureArtifacts, cleanupWorkspace, recoverWorkspaces } from './workspaces.mjs';
import { workspaceId, safeRead } from './state.mjs';
import { inspectExec } from './docker.mjs';
import { stageInputs, validatePermit } from './registry.mjs';
import { canonical, signedFetch } from '../lib/execution/transport.mts';
import { sha256 } from '../lib/execution/evidence.mts';
import { makeReceipt, streamEvidence } from './receipts.mjs';
async function retainedBytes(path,maxBytes){try{return await safeRead(path,maxBytes);}catch{throw errorStatus('Retained content unavailable',503);}}
const errorStatus=(message,status=409)=>Object.assign(Error(message),{status});
export async function createExecutor(journal,config,registry) {
  const tasks=new Map();let closing=false;
  const save=job=>journal.transaction(()=>journal.save(job));
  async function attest(job,purpose,changes){if(job.receipts.some(r=>r.claims.purpose===purpose))return;const receipt=await makeReceipt(job,purpose,config.evidenceKey,changes);await journal.transaction(async()=>{if(!job.receipts.some(r=>r.claims.purpose===purpose))job.receipts.push(receipt);await journal.save(job);});}
  async function checkpoint(job){const p=job.permit;const result=await signedFetch(config.checkpoint,'/api/execution/checkpoint',{permitId:p.permitId,permitSha256:await sha256(canonical(p)),deadlineMs:p.deadlineMs});
    if(result.status!==200||result.data.allowed!==true||result.data.deadlineMs!==p.deadlineMs)throw Error('Checkpoint denied');}
  function guard(job){if(job.fenced||closing)throw Error('Cancelled');if(Date.now()>=job.permit.deadlineMs)throw Error('Deadline exceeded');}
  async function cleanup(job){
    if(!job.workspace){await attest(job,'stop',{status:'stopped',closure:'never_admitted'});job.phase='closed';await save(job);return;}
    const result=await cleanupWorkspace(job.workspace);
    if(result.state==='removed'){await attest(job,'stop',{status:'stopped',closure:'removed'});job.phase='closed';}
    else job.phase='cleanup_pending';
    await save(job);
  }
  async function execute(job){
    let interval,checking=false,lastGood=Date.now();
    const stage=join(journal.root,job.backendId+'-input');
    try{
      guard(job);await checkpoint(job);guard(job);
      job.phase='setup';await save(job);
      job.workspace=await createWorkspace(join(journal.root,'state'),{owner:job.permit.owner,runId:job.permit.runId,attempt:job.permit.attempt,deadlineMs:job.permit.deadlineMs},{...job.permit.operation.policy,ceilings:job.permit.budget},job.permit.operation.image);await save(job);
      guard(job);await stageInputs(stage,job.permit,registry);guard(job);await importInputs(job.workspace,stage,job.permit.operation.inputs);guard(job);
      const started=await startWorkspace(job.workspace);job.process={containerId:started.containerId,execId:null};await save(job);guard(job);
      await checkpoint(job);guard(job);lastGood=Date.now();
      const exec=await createExecution(job.workspace,job.permit.operation.argv);job.process.execId=exec.id;job.phase='registered';await save(job);
      await checkpoint(job);guard(job);
      interval=setInterval(async()=>{if(checking)return;checking=true;try{await checkpoint(job);lastGood=Date.now();}catch{if(Date.now()-lastGood>=3000){job.fenced=true;job.cancelReason='checkpoint_unavailable';await save(job);await cleanupWorkspace(job.workspace);}}finally{checking=false;}},1000);
      // The fence and this admission intent serialize; cancellation then waits for
      // this already-admitted attempt to close before asserting physical stop.
      await journal.transaction(async()=>{guard(job);job.phase='start_intent';await journal.save(job);});
      const output=await startExecution(job.workspace,exec.id,async at=>{job.startedAt=at;job.phase='running';await save(job);});
      job.endedAt=Date.now();job.exitCode=output.exitCode;job.stdout=streamEvidence(output.stdout,output.stdoutTruncated);job.stderr=streamEvidence(output.stderr,output.stderrTruncated);await save(job);
      guard(job);
      if(output.exitCode===0){const artifacts=await captureArtifacts(job.workspace,job.permit.operation.artifacts);job.artifacts=artifacts.map(a=>({path:a.path,sha256:a.sha256,bytes:a.bytes.length}));job.capturedAt=Date.now();guard(job);await save(job);await attest(job,'result',{status:'succeeded'});}
      else await attest(job,'result',{status:'command_failed'});
    }catch(error){
      if(error.output){job.stdout=streamEvidence(error.output.stdout,error.output.stdoutTruncated);job.stderr=streamEvidence(error.output.stderr,error.output.stderrTruncated);}
      job.failure={phase:job.phase,message:String(error.message).slice(0,500)};await save(job);
      const status=job.fenced||closing?'cancelled':Date.now()>=job.permit.deadlineMs?'timed_out':job.startedAt!==null||job.phase==='start_intent'?'evidence_unavailable':'startup_failed';
      await attest(job,'result',{status, ...(status==='startup_failed'?{startedAt:null,exitCode:null}: {})});
    }finally{
      clearInterval(interval);while(checking)await new Promise(r=>setTimeout(r,10));await rm(stage,{recursive:true,force:true});await cleanup(job);
    }
  }
  function schedule(job){const task=execute(job).catch(error=>{job.failure={phase:job.phase,message:String(error.message).slice(0,500)};job.phase='cleanup_pending';return save(job).catch(()=>{});}).finally(()=>tasks.delete(job.backendId));tasks.set(job.backendId,task);}
  // Recovery never starts/restarts an uncertain process. Query only its durable
  // exec ID, retain uncertainty, and close all previously admitted work.
  const recovered=await recoverWorkspaces(join(journal.root,'state'));
  for(const job of journal.jobs.values()){
    if(job.phase==='closed')continue;
    const state=recovered.find(s=>s.id===job.backendId);
    if(!job.workspace&&state)job.workspace={root:join(journal.root,'state'),id:state.id,owner:state.owner,runId:state.runId,attempt:state.attempt};
    if(job.process?.execId){try{await inspectExec(job.process.execId);}catch{/* Absence cannot invent an actual start/exit. */}}
    job.fenced=true;await save(job);
    await rm(join(journal.root,job.backendId+'-input'),{recursive:true,force:true});
    await attest(job,'result',{status:Date.now()>=job.permit.deadlineMs?'timed_out':'evidence_unavailable'});await cleanup(job);
  }
  async function resolve(input,newStart=false){const permit=await validatePermit(input,registry,newStart);const id=workspaceId(permit);const job=journal.jobs.get(id);if(job&&canonical(job.permit)!==canonical(permit))throw errorStatus('Execution identity payload conflict');return {permit,id,job};}
  const freshJob=(permit,id)=>({version:1,backendId:id,permit,phase:'accepted',fenced:false,cancelReason:null,workspace:null,process:null,startedAt:null,endedAt:null,capturedAt:null,exitCode:null,stdout:null,stderr:null,artifacts:[],receipts:[]});
  return {
    async start(input) {
      const { permit, id } = await resolve(input, false);
      let launch = false;
      const job = await journal.transaction(async () => {
        const current = journal.jobs.get(id);
        if (current) {
          if (canonical(current.permit) !== canonical(permit)) throw errorStatus('Execution identity payload conflict');
          if (current.fenced) throw errorStatus('Execution identity cancelled');
          return current;
        }
        const activeJobs = [...journal.jobs.values()].filter(job => job.phase !== 'closed').length;
        if (closing || journal.jobs.size >= 64 || activeJobs >= 8) throw errorStatus('Admission capacity unavailable', 503);
        await validatePermit(permit, registry, true);
        const created = freshJob(permit, id);
        journal.jobs.set(id, created);
        await journal.save(created);
        launch = true;
        return created;
      });
      if (launch) schedule(job);
      return { backendId: id, phase: job.phase };
    },
    async cancel(input) {
      const { permit, id } = await resolve(input);
      const job = await journal.transaction(async () => {
        let current = journal.jobs.get(id);
        if (current && canonical(current.permit) !== canonical(permit)) throw errorStatus('Execution identity payload conflict');
        if (!current) {
          if (journal.jobs.size >= 64) throw errorStatus('Fence capacity unavailable', 503);
          current = freshJob(permit, id);
          journal.jobs.set(id, current);
        }
        current.fenced = true;
        current.cancelReason = 'requested';
        await journal.save(current);
        return current;
      });
      await attest(job, 'cancel_fence', { status: 'cancelled' });
      if (!tasks.has(id)) await cleanup(job);
      else if (job.workspace) await cleanupWorkspace(job.workspace);
      return journal.transaction(() => structuredClone({ backendId: id, receipts: job.receipts }));
    },
    async result(input) {
      const { job } = await resolve(input);
      if (!job) throw errorStatus('Execution not admitted', 404);
      if (job.phase === 'cleanup_pending' && !tasks.has(job.backendId)) await cleanup(job);
      return journal.transaction(() => structuredClone({ backendId: job.backendId, phase: job.phase, receipts: job.receipts }));
    },
    async content(input,kind,path){const {job}=await resolve(input);if(!job?.workspace)throw errorStatus('Retained content unavailable',404);const receipt=await journal.transaction(()=>structuredClone(job.receipts.find(r=>r.claims.purpose==='result')));if(!receipt)throw errorStatus('Result not retained',404);
      let bytes,expected;
      if(kind==='stdout'||kind==='stderr'){if(path!==undefined)throw errorStatus('Unexpected stream selector',400);expected=receipt.claims[kind];if(!expected)throw errorStatus('Retained content unavailable',404);bytes=await retainedBytes(join(job.workspace.root,job.workspace.id,kind+'.log'),65536);}
      else if(kind==='artifact'){expected=receipt.claims.artifacts.find(a=>a.path===path);if(!expected)throw errorStatus('Undeclared artifact',400);const all=JSON.parse((await retainedBytes(join(job.workspace.root,job.workspace.id,'artifacts.json'))).toString());const item=all.find(a=>a.path===path);if(!item)throw errorStatus('Retained content unavailable',404);bytes=Buffer.from(item.bytes,'base64');}
      else throw errorStatus('Unknown content selector',400);
      const actual=streamEvidence(bytes);if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw errorStatus('Retained content verification failed',503);return {base64:bytes.toString('base64'),sha256:actual.sha256,bytes:actual.bytes};},
    async close(){closing=true;for(const job of journal.jobs.values())if(tasks.has(job.backendId)){job.fenced=true;await save(job).catch(()=>{});if(job.workspace)await cleanupWorkspace(job.workspace).catch(()=>{});}await Promise.allSettled([...tasks.values()]);},
  };
}
