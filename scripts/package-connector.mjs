import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { RUNTIME_FILES, VERSION } from '../connector/common.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'build/connector');
const entries = [];
function field(header, offset, size, value) { header.write(value, offset, Math.min(size, Buffer.byteLength(value)), 'utf8'); }
function octal(header, offset, size, value) { field(header, offset, size, value.toString(8).padStart(size - 1, '0') + '\0'); }
for (const name of RUNTIME_FILES) {
  const body = await readFile(join(root, 'connector', name));
  const header = Buffer.alloc(512);
  field(header, 0, 100, `agent-task-hub-connector/${name}`);
  octal(header, 100, 8, name === 'cli.mjs' ? 0o755 : 0o644);
  octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, body.length); octal(header, 136, 12, 0);
  header.fill(32, 148, 156); field(header, 156, 1, '0'); field(header, 257, 6, 'ustar\0'); field(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  field(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  entries.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
}
entries.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(entries), { level: 9 });
const sha256 = createHash('sha256').update(archive).digest('hex');
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'agent-task-hub-connector.tgz'), archive);
await writeFile(join(destination, 'agent-task-hub-connector.tgz.sha256'), `${sha256}  agent-task-hub-connector.tgz\n`);
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ version: VERSION, sha256, bytes: archive.length, files: RUNTIME_FILES }, null, 2) + '\n');
process.stdout.write(`Connector ${VERSION}: build/connector/agent-task-hub-connector.tgz (${archive.length} bytes)\n`);
