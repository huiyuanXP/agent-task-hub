import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localFixture } from './local/fixture.mjs';
import { runChild } from './harness.mjs';
const out=process.env.TEST_ARTIFACT_DIR;
const fixtures=[],controller=new AbortController();
const onInt=()=>controller.abort(Error('Interrupted by SIGINT')),onTerm=()=>controller.abort(Error('Interrupted by SIGTERM'));
process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
try{
 const dev=await localFixture({dev:true,manageSignals:false});fixtures.push(dev);
 const preview=await localFixture({manageSignals:false});fixtures.push(preview);
 const env={...process.env,TEST_DEV_URL:dev.origin,TEST_PREVIEW_URL:preview.origin};
 await writeFile(join(out,'instances.json'),JSON.stringify(fixtures.map(f=>({file:f.file,origin:f.origin,pid:f.pid})),null,2));
 console.log('NATIVE_INSTANCES '+JSON.stringify(fixtures.map(f=>({file:f.file,origin:f.origin,pid:f.pid}))));
 await runChild('python3',['tests/api.py'],{env,signal:controller.signal,logFile:join(out,'api.log')});
 await runChild(process.execPath,['tests/browser/checks.mjs'],{env,signal:controller.signal,logFile:join(out,'browser.log')});
 const verified={};for(const suite of ['api','browser']){const evidence=JSON.parse(await readFile(join(out,suite+'-evidence.json'),'utf8'));if(evidence.status!=='passed')throw Error(suite+' failed');verified[suite]=evidence;}
 console.log('VERIFIED_EVIDENCE '+JSON.stringify(verified));
}finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);for(const f of fixtures){await f.close();console.log('REAPED_NATIVE '+JSON.stringify({file:f.file,origin:f.origin}));}}
