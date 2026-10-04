import { rm } from 'node:fs/promises';
import { recoverWorkspaces } from '../../../runner/workspaces.mjs';

/** Test roots contain live cleanup obligations, not disposable scratch alone. */
export async function cleanupFixture(root) {
  for (let attempt = 0; ; attempt++) {
    const states = await recoverWorkspaces(root + '/state');
    if (states.every(state => state.state === 'removed')) break;
    if (attempt === 2) throw Error('Fixture cleanup pending; preserving owned state root: ' + root);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await rm(root, {recursive:true, force:true});
}
