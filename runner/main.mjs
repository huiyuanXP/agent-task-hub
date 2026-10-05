import { pathToFileURL } from 'node:url';
import { safeRead } from './state.mjs';
import { startSupervisor } from './server.mjs';
import { importSigning, importTrust, assertDistinctKeyMaterial } from '../lib/execution/backend-config.mts';
export async function runSupervisor(path){
  const config=JSON.parse((await safeRead(path,16777216)).toString());
  assertDistinctKeyMaterial(JSON.stringify(config.controlPublic),JSON.stringify(config.transportPrivate),JSON.stringify(config.evidencePrivate));
  const [controlTrust,transportKey,evidenceKey]=await Promise.all([importTrust(JSON.stringify(config.controlPublic)),importSigning(JSON.stringify(config.transportPrivate)),importSigning(JSON.stringify(config.evidencePrivate))]);
  if(new Set([controlTrust.keyId,transportKey.keyId,evidenceKey.keyId]).size!==3)throw Error('Separate key roles required');
  return startSupervisor({root:config.root,port:config.port,audience:config.audience,registry:config.registry,sourceRoots:config.sourceRoots,controlTrust,transportKey,evidenceKey,
    checkpoint:{baseUrl:config.controlUrl,audience:config.checkpointAudience,direction:'runner-to-control',signing:transportKey,trust:controlTrust}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(!process.argv[2])throw Error('Usage: node runner/main.mjs PRIVATE_CONFIG');const server=await runSupervisor(process.argv[2]);console.log('Execution supervisor listening on '+server.url);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close().then(()=>process.exit(0),()=>process.exit(1));});
  }catch{console.error('Execution supervisor unavailable; check private configuration and local Docker prerequisites');process.exitCode=1;}
}
