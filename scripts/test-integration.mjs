import { mkdir, mkdtemp, readdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspace, freePort, loopbackUrl, startChild, runChild, stopChild, waitForHttp } from '../tests/harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const controller = new AbortController();
const servers = [];
let workspace, artifacts, failure;
const interrupted = signal => controller.abort(new Error(`Interrupted by ${signal}`));
const onInt = () => interrupted('SIGINT');
const onTerm = () => interrupted('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);

// Do not pass provider credentials or checkout-specific runtime switches to children.
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, { CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', NO_COLOR: '1' });
try {
  await mkdir(join(root, 'test-results'), { recursive: true });
  artifacts = await mkdtemp(join(root, 'test-results/run-'));
  await access(join(root, 'tests/browser/node_modules/playwright/index.mjs'));
  workspace = await createWorkspace(root);
  const dev = loopbackUrl(`http://127.0.0.1:${await freePort()}`).origin;
  let preview;
  do { preview = loopbackUrl(`http://127.0.0.1:${await freePort()}`).origin; } while (preview === dev);
  Object.assign(env, { TEST_DEV_URL: dev, TEST_PREVIEW_URL: preview, TEST_ARTIFACT_DIR: artifacts, TEST_PLAYWRIGHT_MODULE: pathToFileURL(join(root, 'tests/browser/node_modules/playwright/index.mjs')).href });
  console.log(`Isolated workspace: ${workspace}\nDev: ${dev}\nPreview: ${preview}\nArtifacts: ${artifacts}`);
  await writeFile(join(artifacts, 'run.json'), JSON.stringify({ workspace, dev, preview, status: 'running' }, null, 2) + '\n');
  const command = async (label, executable, args) => {
    controller.signal.throwIfAborted();
    console.log(`Running ${label}`);
    await runChild(executable, args, { cwd: workspace, env, signal: controller.signal, logFile: join(artifacts, label + '.log') });
    console.log(`PASS: ${label}`);
  };
  await command('install', 'npm', ['run', 'install:ci']);
  await command('build', 'npm', ['run', 'build']);
  const migrations = (await readdir(join(workspace, 'drizzle'))).filter(name => name.endsWith('.sql')).sort();
  if (!migrations.length) throw new Error('No SQL migrations found');
  for (const file of migrations) await command('migration-' + file, process.execPath, [
    '--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js',
    'd1', 'execute', 'DB', '--local', '--config', 'dist/server/wrangler.json',
    '--persist-to', '.wrangler/state', '--file', join('drizzle', file),
  ]);
  controller.signal.throwIfAborted();
  servers.push(startChild('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', new URL(dev).port], { cwd: workspace, env, logFile: join(artifacts, 'dev.log') }));
  // npm start already fixes --local and --ip 127.0.0.1; Wrangler rejects duplicate --ip values.
  servers.push(startChild('npm', ['start', '--', '--port', new URL(preview).port], { cwd: workspace, env, logFile: join(artifacts, 'preview.log') }));
  await Promise.all([dev, preview].map(url => waitForHttp(url, servers, { signal: controller.signal })));
  console.log('PASS: both loopback servers ready');
  await command('api', 'python3', ['tests/api.py']);
  await command('browser', process.execPath, ['tests/browser/checks.mjs']);
  for (const child of servers) if (child.result) throw new Error(`Server exited during checks: ${JSON.stringify(child.result)}`);
  for (const suite of ['api', 'browser']) {
    const evidence = JSON.parse(await readFile(join(artifacts, suite + '-evidence.json'), 'utf8'));
    if (evidence.status !== 'passed') throw new Error(`${suite} evidence did not pass`);
    for (const check of evidence.checks) console.log(`PASS: ${check}`);
  }
} catch (error) {
  failure = error;
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(servers.map(stopChild));
  for (const result of cleanup) if (result.status === 'rejected') {
    failure ??= result.reason;
    console.error('Server cleanup failed:', result.reason);
    process.exitCode = 1;
  }
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
