// Test initialization and loopback transport only. Tools and STDIO are the real project modules.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../lib/database.mts';
import {createAccount} from '../../lib/local-auth.mts';
import {inviteConnector,enrollConnector,authenticateConnector,heartbeatConnector} from '../../lib/connectors/service.mts';
import {handleConnectorMCP} from '../../lib/connectors/mcp.mts';
import {serveMcp} from '../../connector/mcp.mjs';
import {tool,VERSION} from '../../connector/common.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--evidence-dir'))throw Error('Only --evidence-dir DIRECTORY is supported');
const evidence=resolve(args[1]||join(root,'test-results/cloud-model-mcp'));
mkdirSync(evidence,{recursive:true});
const directory=mkdtempSync(join(tmpdir(),'ath-cloud-mcp-'));
for(const name of Object.keys(process.env))if(name.startsWith('APP_')||name.startsWith('EXECUTION_'))delete process.env[name];
process.env.APP_DB_PATH=join(directory,'data.sqlite');
process.env.APP_SCHEDULER_INTERVAL_MS='0';
const db=openDatabase(process.env.APP_DB_PATH,{migrationsPath:join(root,'migrations')});
const session=randomUUID(),calls=[];let owner,closed=false,timer,toolNames=[];
const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'||!['/api/connector/mcp','/api/connector/heartbeat'].includes(req.url)){res.writeHead(404);res.end();return;}
  const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>200000)throw Error('Input limit');chunks.push(chunk);}
  const body=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true}).decode(body);
  const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
  const request=new Request(process.env.APP_ORIGIN+req.url,{method:'POST',headers,body:text});
  let response;
  if(req.url==='/api/connector/mcp'){
   let rpc;try{rpc=JSON.parse(text);}catch{/* Actual handler provides the protocol error. */}
   response=await handleConnectorMCP(db,request);
   const data=await response.clone().json().catch(()=>null);
   calls.push({method:rpc?.method,tool:rpc?.params?.name,status:response.status,accepted:!data?.error&&!data?.result?.isError});
  }else{
   const principal=await authenticateConnector(db,headers);
   response=Response.json(await heartbeatConnector(db,principal,JSON.parse(text)));
  }
  res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"Isolated fixture request rejected"}');}
});
async function close(reason){
 if(closed)return;closed=true;clearTimeout(timer);
 server.closeAllConnections();await new Promise(done=>server.close(done));
 try{
  const rows=owner?(await db.prepare("SELECT id,kind,revision,json_extract(body,'$.title') AS title,json_extract(body,'$.status') AS status,json_extract(body,'$.evidence') AS evidence,json_extract(body,'$.goal') AS goal,json_extract(body,'$.scope') AS scope FROM records WHERE owner=? ORDER BY created").bind(owner).all()).results:[];
  writeFileSync(join(evidence,session+'.json'),JSON.stringify({session,reason,syntheticOnly:true,realToolImplementation:'lib/connectors/mcp.mts and its project modules',realStdio:'connector/mcp.mjs',fixtureOnly:'account, SQLite, enrollment, seed and loopback HTTP initialization',capabilities:['read','submit','plan'],statusUpdateTool:toolNames.includes("update_ticket_status"),toolNames,calls,records:rows},null,2));
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>close(signal).finally(()=>process.exit(0)));
try{
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
 process.env.APP_ORIGIN='http://127.0.0.1:'+server.address().port;
 const user=await createAccount(db,{username:'synthetic-model',displayName:'Synthetic MCP model test',password:randomUUID()});owner=user.userId;
 const invitation=await inviteConnector(db,owner,{action:'invite',project:'Cloud MCP synthetic acceptance',name:'Ephemeral model client',capabilities:['read','submit','plan']});
 const enrolled=await enrollConnector(db,{code:invitation.code,name:'Ephemeral model client',version:VERSION,workspace:'Synthetic test repository'});
 const config={url:process.env.APP_ORIGIN,token:enrolled.token,connectionId:enrolled.connection.id,projectId:enrolled.connection.projectId,project:enrolled.connection.project,installationId:session,workspace:root,runtime:join(root,'connector/cli.mjs')};
 await tool(config,'create_ticket',{request_id:'fixture-seed',title:'Synthetic model read and write acceptance',goal:'Read this synthetic Ticket, compute a result, then update its status and append caller-reported evidence using its current revision.',scope:'Only this temporary project; no real accounts, execution or credentials.',acceptance:'Read list_tickets/get_ticket, write update_ticket_status with current expected_revision, verify stable retry and stale revision rejection. No execution is authorized.'});
 const discovery=await handleConnectorMCP(db,new Request(process.env.APP_ORIGIN+'/api/connector/mcp',{method:'POST',headers:{host:new URL(process.env.APP_ORIGIN).host,authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'fixture-discovery',method:'tools/list',params:{}})}));
 const discovered=await discovery.json();toolNames=(discovered.result?.tools||[]).map(item=>item.name);
 if(!toolNames.includes('update_ticket_status'))throw Error('Required status tool missing from this source fixture');
 process.stderr.write('Portable real MCP ready; fresh SQLite; read/submit/plan only; session='+session+'; stdout JSON-RPC only.\n');
 timer=setTimeout(()=>close('40-minute limit').finally(()=>process.exit(0)),40*60*1000);timer.unref();
 await serveMcp(config);
}finally{await close('STDIO ended');}
