// The signed permit is binary in transit; decoding each chunk corrupts split UTF-8.
export async function readProxyBody(source) {
  const chunks=[];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}
