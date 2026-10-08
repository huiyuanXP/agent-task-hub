import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// Ignoring the configured module, silently skipping Chromium or allocating a
// runtime before resolving prerequisites breaks these process/cleanup assertions.
test('browser harness missing tooling fails with setup instructions before creating runtime state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'authorization-prerequisites-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = join(directory, 'state'); mkdirSync(state);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'tests/execution/authorization-native.mjs'], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: state, EXECUTION_PLAYWRIGHT_MODULE: join(directory, 'missing-playwright.mjs') }, timeout: 60000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Browser acceptance prerequisites unavailable/);
  assert.match(result.stderr, /EXECUTION_PLAYWRIGHT_MODULE/);
  assert.match(result.stderr, /npm ci --prefix tests\/browser/);
  assert.doesNotMatch(result.stdout, /Next\/SQLite ready/);
  assert.deepEqual(readdirSync(state), []);
});
