// Minimal .zip reading using the browser's built-in DecompressionStream (no
// dependencies).

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04; }

function listZip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xFFFF); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014B50) throw new Error('Corrupt zip directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({ name, flags, method, compSize, size, local });
  }
  return { entries, dv };
}

async function readEntry(bytes, dv, entry) {
  if (entry.flags & 1) throw new Error('Encrypted zip entries are not supported');
  const lp = entry.local;
  if (dv.getUint32(lp, true) !== 0x04034B50) throw new Error('Corrupt zip entry');
  const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) return inflate(raw, 'deflate-raw');
  throw new Error(`Unsupported zip compression (method ${entry.method})`);
}

// Every file in the archive, as { name (no folders, lower case) -> bytes }.
// Arcade ROM sets are a zip of the board's individual chips.
export async function extractAll(bytes) {
  const { entries, dv } = listZip(bytes);
  const files = {};
  for (const e of entries) {
    const name = e.name.split('/').pop().toLowerCase();
    if (name.startsWith('.') || !e.size) continue;
    files[name] = await readEntry(bytes, dv, e);
  }
  return files;
}
