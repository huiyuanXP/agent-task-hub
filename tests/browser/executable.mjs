import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

export async function trustedBrowserExecutable(value) {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw Error('TEST_CHROMIUM_EXECUTABLE must be an absolute trusted local path');
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isFile()) throw Error('TEST_CHROMIUM_EXECUTABLE must resolve to a regular executable file');
  await access(resolved, constants.X_OK);
  return resolved;
}
