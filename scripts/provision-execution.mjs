import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { REGISTERED_OPERATIONS } from '../lib/execution/registry.mts';
import { localControlOrigin } from './execution-config.mjs';

function shellArgument(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function pair(role) {
  const keys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
  const keyId = role + '-' + randomUUID();
  return {
    private: {keyId, jwk: await webcrypto.subtle.exportKey('jwk', keys.privateKey)},
    public: {keyId, jwk: await webcrypto.subtle.exportKey('jwk', keys.publicKey)},
  };
}

try {
  const [directory, controlUrl, runnerUrl, extra] = process.argv.slice(2);
  if (!directory || !controlUrl || !runnerUrl || extra) {
    throw Error('Usage: node --experimental-strip-types scripts/provision-execution.mjs PRIVATE_DIRECTORY CONTROL_ORIGIN RUNNER_ORIGIN');
  }
  const controlOrigin = localControlOrigin(controlUrl);
  const runnerOrigin = localControlOrigin(runnerUrl);
  if (runnerOrigin.hostname !== '127.0.0.1' || runnerOrigin.protocol !== 'http:' || !runnerOrigin.port) {
    throw Error('Local Runner requires http://127.0.0.1:PORT');
  }
  const root = resolve(directory);
  await mkdir(root, {mode:0o700});
  const [control, runner, evidence] = await Promise.all([pair('control'), pair('runner'), pair('evidence')]);
  const config = {
    APP_ORIGIN: controlOrigin.origin,
    EXECUTION_RUNNER_URL: runnerOrigin.origin,
    EXECUTION_RUNNER_AUDIENCE: 'ath-runner',
    EXECUTION_CHECKPOINT_AUDIENCE: 'ath-control',
    EXECUTION_REGISTRY: JSON.stringify(REGISTERED_OPERATIONS),
    EXECUTION_CONTROL_KEY: JSON.stringify(control.private),
    EXECUTION_RUNNER_KEY: JSON.stringify(runner.public),
    EXECUTION_EVIDENCE_KEY: JSON.stringify(evidence.public),
  };
  const runnerConfig = {
    root: join(root, 'state'), port: Number(runnerOrigin.port),
    audience: config.EXECUTION_RUNNER_AUDIENCE, controlUrl: controlOrigin.origin,
    checkpointAudience: config.EXECUTION_CHECKPOINT_AUDIENCE,
    registry: REGISTERED_OPERATIONS, sourceRoots: {}, controlPublic: control.public,
    transportPrivate: runner.private, evidencePrivate: evidence.private,
  };
  for (const [name, value] of Object.entries({'control.json':config, 'runner.json':runnerConfig})) {
    await writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', {mode:0o600, flag:'wx'});
  }
  console.log('Created private execution configuration in ' + root);
  console.log('Start control server: node --experimental-strip-types scripts/server.mjs --execution-config ' + shellArgument(join(root, 'control.json')));
  console.log('Start Runner: node --experimental-strip-types runner/main.mjs ' + shellArgument(join(root, 'runner.json')));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
