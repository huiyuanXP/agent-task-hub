import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { REGISTERED_OPERATIONS } from '../lib/execution/registry.mts';
async function pair(role){const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const keyId=role+'-'+randomUUID();return {private:{keyId,jwk:await webcrypto.subtle.exportKey('jwk',keys.privateKey)},public:{keyId,jwk:await webcrypto.subtle.exportKey('jwk',keys.publicKey)}};}
try{
 const [directory,controlUrl,runnerUrl]=process.argv.slice(2);if(!directory||!controlUrl||!runnerUrl)throw Error('Usage: node scripts/provision-execution.mjs PRIVATE_DIRECTORY WORKER_ORIGIN RUNNER_ORIGIN');
 const origins=[controlUrl,runnerUrl].map(value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Exact origins required');return u;});
 if(origins[1].hostname!=='127.0.0.1'||origins[1].protocol!=='http:'||(!origins[1].port||Number(origins[1].port)<1))throw Error('Local supervisor requires http://127.0.0.1:PORT');
 const root=resolve(directory);await mkdir(root,{mode:0o700});
 const [control,node,evidence]=await Promise.all([pair('control'),pair('supervisor'),pair('evidence')]);
 const vars={EXECUTION_RUNNER_URL:origins[1].origin,EXECUTION_RUNNER_AUDIENCE:'ath-supervisor',EXECUTION_CHECKPOINT_AUDIENCE:'ath-control',EXECUTION_REGISTRY:JSON.stringify(REGISTERED_OPERATIONS),EXECUTION_CONTROL_KEY:JSON.stringify(control.private),EXECUTION_RUNNER_KEY:JSON.stringify(node.public),EXECUTION_EVIDENCE_KEY:JSON.stringify(evidence.public)};
 const config={root:join(root,'state'),port:Number(origins[1].port),audience:vars.EXECUTION_RUNNER_AUDIENCE,controlUrl:origins[0].origin,checkpointAudience:vars.EXECUTION_CHECKPOINT_AUDIENCE,registry:REGISTERED_OPERATIONS,sourceRoots:{},controlPublic:control.public,transportPrivate:node.private,evidencePrivate:evidence.private};
 for(const [name,value]of Object.entries({'worker.vars.json':JSON.stringify(vars,null,2)+'\n','supervisor.json':JSON.stringify(config,null,2)+'\n','.dev.vars':Object.entries(vars).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n'}))await writeFile(join(root,name),value,{mode:0o600,flag:'wx'});
 console.log('Created private execution configuration in '+root);
}catch(error){console.error(error.message);process.exitCode=1;}
