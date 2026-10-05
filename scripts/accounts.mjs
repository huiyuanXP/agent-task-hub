import { database, closeDatabases } from '../lib/local-store.mts';
import { createAccount, resetPassword, issueToken, revokeToken } from '../lib/local-auth.mts';
async function secret(prompt){
 if(!process.stdin.isTTY){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>4096)throw Error('Secret too long');}return value.replace(/\r?\n$/,'');}
 process.stderr.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
 return new Promise((resolve,reject)=>{
  let value='';const finish=(error)=>{process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');if(error)reject(error);else resolve(value);};
  const read=chunk=>{for(const c of chunk){if(c==='\u0003'){finish(Error('Cancelled'));return;}if(c==='\r'||c==='\n'){finish();return;}if(c==='\u007f'){value=value.slice(0,-1);continue;}value+=c;if(value.length>4096){finish(Error('Secret too long'));return;}}};process.stdin.on('data',read);
 });
}
try{
 const [command,...args]=process.argv.slice(2);
 if(!['create','reset','token','revoke'].includes(command)||args.some(arg=>arg.startsWith('--'))||
   (command==='create'&&(args.length<1||args.length>2))||(['reset','token'].includes(command)&&args.length!==1)||(command==='revoke'&&args.length!==0))throw Error('Usage: accounts create USER [DISPLAY_NAME] | reset USER | token USER | revoke (secrets via stdin or prompt)');
 const db=database();
 if(command==='create'){const user=await createAccount(db,{username:args[0],displayName:args[1]??args[0],password:await secret('Password: ')});process.stdout.write(JSON.stringify(user)+'\n');}
 if(command==='reset'){await resetPassword(db,args[0],await secret('New password: '));process.stdout.write('Password reset; sessions revoked.\n');}
 if(command==='token'){const user=await db.prepare('SELECT id FROM local_users WHERE username=?').bind(args[0].toLowerCase()).first();if(!user)throw Error('Account not found');process.stdout.write((await issueToken(db,user.id,{kind:'api'})).token+'\n');}
 if(command==='revoke'){await revokeToken(db,await secret('API token: '));process.stdout.write('Token revoked.\n');}
}catch(error){process.stderr.write((error instanceof Error?error.message:'Account operation failed')+'\n');process.exitCode=1;}finally{closeDatabases();}
