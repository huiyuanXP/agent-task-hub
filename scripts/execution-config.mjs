import { open } from 'node:fs/promises';
import { safeCallback } from '../lib/event-transport.mts';
import { backendConfiguration, configuredRegistry } from '../lib/execution/backend-config.mts';

export function localControlOrigin(value) {
  const url = new URL(safeCallback(value));
  if (url.pathname !== '/' || url.search || value !== url.origin) {
    throw Error('Exact loopback control origin required');
  }
  return url;
}

export async function loadExecutionConfiguration(file) {
  const handle = await open(file, 'r');
  let config;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16777216 || (info.mode & 0o077) !== 0) {
      throw Error('Private control configuration file required (mode 0600, at most 16MiB)');
    }
    config = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  const fields = ['APP_ORIGIN', 'EXECUTION_RUNNER_URL', 'EXECUTION_RUNNER_AUDIENCE',
    'EXECUTION_CHECKPOINT_AUDIENCE', 'EXECUTION_REGISTRY', 'EXECUTION_CONTROL_KEY',
    'EXECUTION_RUNNER_KEY', 'EXECUTION_EVIDENCE_KEY'];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).length !== fields.length ||
    fields.some(key => typeof config[key] !== 'string' || !config[key])) {
    throw Error('Invalid private control configuration');
  }
  const origin = localControlOrigin(config.APP_ORIGIN);
  const runner = localControlOrigin(config.EXECUTION_RUNNER_URL);
  if (runner.hostname !== '127.0.0.1' || runner.protocol !== 'http:' || !runner.port) {
    throw Error('Local Runner requires http://127.0.0.1:PORT');
  }
  configuredRegistry(config);
  await backendConfiguration(config);
  Object.assign(process.env, config);
  return origin;
}
