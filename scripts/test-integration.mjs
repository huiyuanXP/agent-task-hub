import { mkdir, mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { trustedBrowserExecutable } from '../tests/browser/executable.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspace, runChild } from '../tests/harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
let workspace, artifacts, failure;
const interrupted = signal => controller.abort(new Error(`Interrupted by ${signal}`));
const onInt = () => interrupted('SIGINT');
const onTerm = () => interrupted('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);

// Do not pass provider credentials or checkout-specific runtime switches to children.
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH', 'TEST_CHROMIUM_EXECUTABLE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env,{NEXT_TELEMETRY_DISABLED:'1',NO_COLOR:'1'});
try {
  if (env.TEST_CHROMIUM_EXECUTABLE !== undefined) env.TEST_CHROMIUM_EXECUTABLE = await trustedBrowserExecutable(env.TEST_CHROMIUM_EXECUTABLE);
  await mkdir(join(root, 'test-results'), { recursive: true });
  artifacts = await mkdtemp(join(root, 'test-results/run-'));
  await access(join(root, 'tests/browser/node_modules/playwright/index.mjs'));
  workspace = await createWorkspace(root);
  Object.assign(env,{TEST_ARTIFACT_DIR:artifacts,TEST_PLAYWRIGHT_MODULE:pathToFileURL(join(root,'tests/browser/node_modules/playwright/index.mjs')).href});
  console.log(`Isolated workspace: ${workspace}\nArtifacts: ${artifacts}`);
  await writeFile(join(artifacts,'run.json'),JSON.stringify({workspace,status:'running'},null,2)+'\n');
  const command = async (label, executable, args) => {
    controller.signal.throwIfAborted();
    console.log(`Running ${label}`);
    await runChild(executable, args, { cwd: workspace, env, signal: controller.signal, logFile: join(artifacts, label + '.log'),graceMs:15000 });
    console.log(`PASS: ${label}`);
  };
  await command('install', 'npm', ['run', 'install:ci']);
  await command('build', 'npm', ['run', 'build']);
  await command('native',process.execPath,['--experimental-strip-types','tests/integration.mjs']);
  const records=(await readFile(join(artifacts,'native.log'),'utf8')).split('\n').filter(line=>/^(?:VERIFIED_EVIDENCE|NATIVE_INSTANCES|REAPED_NATIVE) /.test(line));
  if(records.filter(line=>line.startsWith('VERIFIED_EVIDENCE ')).length!==1||records.filter(line=>line.startsWith('REAPED_NATIVE ')).length!==2)throw Error('Missing native verification or cleanup evidence');
  if(Buffer.byteLength(records.join('\n'))>65536)throw Error('Native evidence exceeds its bound');
  for(const line of records)console.log(line);
} catch (error) {
  failure = error;
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(error => {
    failure ??= error;
    console.error('Workspace cleanup failed:', error);
    process.exitCode = 1;
  });
  if (artifacts) {
    if (failure) {
      await writeFile(join(artifacts, 'failure.log'), String(failure.stack ?? failure) + '\n');
      console.error(`Failure logs/evidence retained: ${artifacts}`);
    } else await rm(artifacts, { recursive: true, force: true });
  }
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
  console.log(`Cleanup complete: ${workspace ?? 'no workspace'} (servers reaped)`);
}
if (!failure) console.log('PASS: isolated API/MCP/browser regression');
