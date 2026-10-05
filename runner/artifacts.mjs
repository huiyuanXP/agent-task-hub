import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { relativePath, exact } from './policy.mjs';
import { fdPath, mountId, requireTmpfs } from './container-files.mjs';
export function artifactDeclarations(declarations, policy) {
  if (!Array.isArray(declarations) || declarations.length > 64) throw Error('Invalid artifact declarations');
  let total = 0; const seen = new Set();
  return declarations.map(item => {
    exact(item, ['path', 'maxBytes']);
    const path = relativePath(item.path, 'output');
    if (seen.has(path) || !Number.isSafeInteger(item.maxBytes) || item.maxBytes <= 0) throw Error('Invalid artifact bound');
    total += item.maxBytes; seen.add(path);
    if (total > policy.maxArtifactBytes) throw Error('Artifact bytes exceed policy');
    return { path, maxBytes: item.maxBytes };
  });
}
/** Full frozen-filesystem scan. Reject links anywhere; retain declared bytes only after all entries pass. */
export async function scanArtifacts(output, declarations, policy, deadlineMs) {
  const wanted = artifactDeclarations(declarations, policy), retained = new Map();
  const filesystem = await requireTmpfs(output), root = await output.stat({ bigint: true });
  let entries = 0, total = 0n;
  function deadline() { if (Date.now() >= deadlineMs) throw Error('Artifact capture deadline exceeded'); }
  async function walk(directory, prefix = '', depth = 0) {
    deadline();
    if (depth > 32) throw Error('Artifact depth exceeds limit');
    const dir = await opendir(fdPath(directory));
    for await (const entry of dir) {
      deadline();
      if (++entries > policy.maxArchiveEntries) throw Error('Artifact entries exceed limit');
      if (!entry.isFile() && !entry.isDirectory()) throw Error('Artifact link or special file is forbidden');
      if (Buffer.byteLength(entry.name) > 255 || entry.name.includes('\ufffd')) throw Error('Unsupported artifact filename encoding');
      const path = prefix + entry.name;
      relativePath('output/' + path, 'output');
      // NONBLOCK lets fstat reject FIFOs/devices instead of blocking on open.
      const handle = await open(fdPath(directory) + '/' + entry.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        const stat = await handle.stat({ bigint: true });
        if (stat.dev !== root.dev || await mountId(handle) !== filesystem) throw Error('Nested artifact mount is forbidden');
        if (stat.isDirectory()) { await walk(handle, path + '/', depth + 1); continue; }
        if (!stat.isFile()) throw Error('Artifact special file is forbidden');
        if (stat.nlink !== 1n) throw Error('Artifact hard link is forbidden');
        total += stat.size;
        if (total > BigInt(policy.workTmpfsMb * 1048576)) throw Error('Artifact logical bytes exceed work limit');
        const declaration = wanted.find(item => item.path === path);
        if (declaration) {
          if (stat.size > BigInt(declaration.maxBytes)) throw Error('Artifact bytes exceed declaration');
          const bytes = Buffer.alloc(Number(stat.size) + 1); let offset = 0;
          while (offset < bytes.length) { deadline(); const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
          const after = await handle.stat({ bigint: true });
          if (offset !== Number(stat.size) || after.nlink !== 1n || stat.ino !== after.ino || stat.size !== after.size || stat.ctimeNs !== after.ctimeNs || stat.mtimeNs !== after.mtimeNs) throw Error('Artifact changed during frozen scan');
          const kept = bytes.subarray(0, offset);
          retained.set(path, { path: 'output/' + path, bytes: kept, sha256: createHash('sha256').update(kept).digest('hex') });
        }
      } finally { await handle.close(); }
    }
  }
  await walk(output); deadline();
  return wanted.map(item => { const result = retained.get(item.path); if (!result) throw Error('Declared artifact missing'); return result; });
}
