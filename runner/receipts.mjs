import { createHash } from 'node:crypto';
import { canonical, signClaims } from '../lib/execution/transport.mts';
import { sha256 } from '../lib/execution/evidence.mts';
export function streamEvidence(bytes,truncated=false){return {sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,truncated};}
export async function makeReceipt(job,purpose,key,changes={}) {
  const p=job.permit;
  return signClaims(key,{version:2,purpose,audience:'control-plane',keyId:key.keyId,owner:p.owner,runId:p.runId,ticketId:p.ticketId,ticketRevision:p.ticketRevision,attempt:p.attempt,
    authorizationId:p.authorizationId,contractSha256:p.contractSha256,permitId:p.permitId,permitSha256:await sha256(canonical(p)),operationId:p.operation.operationId,definitionHash:p.operation.definitionHash,
    deadlineMs:p.deadlineMs,backendId:job.backendId,status:'evidence_unavailable',process:job.process,exitCode:job.exitCode,startedAt:job.startedAt,endedAt:job.endedAt,capturedAt:job.capturedAt,observedAt:Date.now(),artifacts:job.artifacts,stdout:job.stdout,stderr:job.stderr,closure:null,...changes});
}
