import { spawnSync } from 'node:child_process';
const packaged=spawnSync(process.execPath,['scripts/package-connector.mjs'],{stdio:'inherit'});
if(packaged.error)throw packaged.error;if(packaged.status!==0)process.exit(packaged.status??1);
const result=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
if(result.error)throw result.error;process.exit(result.status??1);
