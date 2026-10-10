import { spawnSync } from 'node:child_process';
if(!process.env.npm_execpath)throw Error('Run npm run install:ci');
const result=spawnSync(process.execPath,[process.env.npm_execpath,'ci','--include=dev','--include=optional','--no-audit','--no-fund'],{stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
if(result.error)throw result.error;process.exit(result.status??1);
