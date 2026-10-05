import { withWorkspace } from '../../../runner/state.mjs';
await withWorkspace(JSON.parse(process.argv[2]), async () => {
  process.send({ locked: true });
  await new Promise(resolve => process.once('message', resolve));
});
