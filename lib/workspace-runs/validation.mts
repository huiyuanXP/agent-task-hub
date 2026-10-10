import type { WorkspaceResult } from './types.mts';
export class WorkspaceError extends Error {
 readonly status:number;readonly code:string;
 constructor(status:number,message:string,code='WORKSPACE_CONFLICT'){super(message);this.name='WorkspaceError';this.status=status;this.code=code;}
}
export function invalid(message='Invalid workspace request'):never {throw new WorkspaceError(400,message,'INVALID_INPUT');}
export function object(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)))invalid();
}
export function text(value:unknown,max=200,label='identifier'):asserts value is string {
 if(typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u001f\u007f]/.test(value))invalid(`Invalid ${label}`);
}
export function logText(value:unknown,max:number,label:string):asserts value is string {
 if(typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))invalid(`Invalid ${label}`);
}
export function integer(value:unknown,min:number,max:number,label='integer'):asserts value is number {
 if(typeof value!=='number' || !Number.isSafeInteger(value) || value<min || value>max)invalid(`Invalid ${label}`);
}
export function evidence(value:unknown):WorkspaceResult {
 object(value,['summary','diff','files','tests','worktree','agentSession']);
 logText(value.summary,10000,'summary');text(value.worktree,2000,'worktree');
 if(value.agentSession!==undefined)text(value.agentSession,200,'agent session');
 if(typeof value.diff!=='string' || !value.diff.trim() || value.diff.length>750000 || !/^diff --git /m.test(value.diff))invalid('A real nonempty Git diff is required');
 if(!Array.isArray(value.files) || value.files.length<1 || value.files.length>500)invalid('Changed files are required');
 for(const file of value.files){
  text(file,1000,'changed file');
  if(file.startsWith('/') || file.includes('\\') || /^[A-Za-z]:/.test(file) || file.split('/').some(part=>part==='..' || part===''))invalid('Changed files must be relative paths');
 }
 if(new Set(value.files).size!==value.files.length)invalid('Duplicate changed files');
 if(!Array.isArray(value.tests) || value.tests.length<1 || value.tests.length>50)invalid('Actual successful test receipts are required');
 for(const test of value.tests){
  object(test,['command','exitCode','output']);logText(test.command,4000,'test command');
  if(test.exitCode!==0 || typeof test.output!=='string' || test.output.length>100000)invalid('Tests must include successful command/exit/output receipts');
 }
 const copied=JSON.parse(JSON.stringify(value)) as WorkspaceResult;
 if(Buffer.byteLength(JSON.stringify(copied),'utf8')>1000000)throw new WorkspaceError(413,'Result evidence is too large','BODY_TOO_LARGE');
 return copied;
}
