/** Small ustar encoder, only for already validated, bounded host input bytes. */
export function packInputs(files) {
  const chunks = [], dirs = new Set();
  function member(name, bytes, directory = false) {
    if (Buffer.byteLength(name) > 99) throw Error('Input path exceeds supported tar name limit');
    const b = Buffer.alloc(512);
    b.write(name, 0, 100); b.write(directory ? '0000755\0' : '0000400\0', 100); b.write('0001750\0', 108); b.write('0001750\0', 116);
    b.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); b.write('00000000000\0', 136); b.fill(32, 148, 156); b.write(directory ? '5' : '0', 156); b.write('ustar\0', 257); b.write('00', 263);
    let sum = 0; for (const v of b) sum += v;
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(b, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join('/') + '/';
      if (!dirs.has(name)) { member(name, Buffer.alloc(0), true); dirs.add(name); }
    }
    member(file.path, file.bytes);
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
