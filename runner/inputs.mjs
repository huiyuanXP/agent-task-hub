import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exact, relativePath } from './policy.mjs';
/** Linux dirfd traversal: pin every directory; never resolve a later component through its old host name. */
async function directory(path) {
  const handles = [await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) handles.push(await open(`/proc/self/fd/${handles.at(-1).fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const last = handles.pop();
    return last;
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}
export async function snapshotInputs(sourceRoot, manifests, policy) {
  if (!Array.isArray(manifests) || !manifests.length || manifests.length > 1024) throw Error('Invalid input manifest');
  manifests = manifests.map(item => { exact(item, ['path', 'sha256', 'bytes']); return { ...item }; });
  let total = 0; const seen = new Set();
  for (const item of manifests) {
    relativePath(item.path, 'input');
    if (seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid input manifest');
    seen.add(item.path); total += item.bytes;
  }
  if (total > policy.maxInputBytes) throw Error('Input manifest bytes exceed limit');
  const root = await directory(sourceRoot);
  try {
    const files = [];
    for (const item of manifests) {
      const handles = []; let parent = root;
      try {
        const parts = item.path.split('/');
        for (const part of parts.slice(0, -1)) { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); }
        // NONBLOCK avoids hanging on FIFOs before fstat can reject them.
        const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        handles.push(file);
        const before = await file.stat({ bigint: true });
        if (!before.isFile()) throw Error('Input special file is forbidden');
        if (before.nlink !== 1n) throw Error('Input hard link is forbidden');
        if (before.size !== BigInt(item.bytes)) throw Error('Input manifest bytes mismatch');
        const bytes = Buffer.alloc(item.bytes + 1); let offset = 0;
        while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await file.stat({ bigint: true });
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || offset !== item.bytes) throw Error('Input changed during pinned read');
        const snapshot = bytes.subarray(0, offset);
        if (createHash('sha256').update(snapshot).digest('hex') !== item.sha256) throw Error('Input manifest hash mismatch');
        files.push({ path: relativePath(item.path, 'input'), bytes: snapshot });
      } finally { await Promise.all(handles.map(handle => handle.close())); }
    }
    return files;
  } finally { await root.close(); }
}
