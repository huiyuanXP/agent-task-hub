import { runSupervisor } from '../../../runner/main.mjs';
const server=await runSupervisor(process.argv[2]);
process.send({url:server.url});
process.on('message',async value=>{if(value==='close'){await server.close();process.exit(0);}});
