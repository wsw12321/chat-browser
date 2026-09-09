import { Inflate } from 'fflate';
import { LIMITS, ReviewError } from './types';
export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  crc: number;
  start: number;
  end: number;
}
export interface ZipLimits {
  entries: number;
  total: number;
  entry: number;
  ratio: number;
}
const defaults: ZipLimits = {
  entries: LIMITS.zipEntries,
  total: LIMITS.zipTotal,
  entry: LIMITS.zipEntry,
  ratio: LIMITS.zipRatio,
};
const bad = (): never => {
  throw new ReviewError('document_unverifiable');
};
const expansion = (): never => {
  throw new ReviewError('archive_expansion_limit');
};
function extraCheck(view: DataView, start: number, length: number): void {
  const end = start + length;
  for (let p = start; p < end;) {
    if (p + 4 > end) bad();
    const id = view.getUint16(p, true),
      size = view.getUint16(p + 2, true);
    p += 4;
    if (p + size > end || id === 0x0001 || id === 0x9901 || id === 0x7075) bad();
    p += size;
  }
}
export function inspectZip(bytes: Uint8Array, limits: ZipLimits = defaults): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    len = bytes.length;
  if (len < 22) bad();
  let eocd = -1;
  for (let p = len - 22; p >= Math.max(0, len - 65557); p--)
    if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === len) {
      eocd = p;
      break;
    }
  if (eocd < 0) bad();
  const count = view.getUint16(eocd + 10, true),
    centralSize = view.getUint32(eocd + 12, true),
    centralStart = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== count ||
    count === 0xffff ||
    centralStart === 0xffffffff ||
    centralSize === 0xffffffff ||
    centralStart + centralSize !== eocd
  )
    bad();
  if (count > limits.entries) expansion();
  const entries: ZipEntry[] = [],
    names = new Set<string>(),
    regions: { start: number; end: number }[] = [];
  let p = centralStart,
    total = 0,
    compressed = 0;
  for (let index = 0; index < count; index++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) bad();
    const made = view.getUint16(p + 4, true),
      needed = view.getUint16(p + 6, true),
      flags = view.getUint16(p + 8, true),
      method = view.getUint16(p + 10, true),
      crc = view.getUint32(p + 16, true),
      comp = view.getUint32(p + 20, true),
      size = view.getUint32(p + 24, true),
      nameLength = view.getUint16(p + 28, true),
      extraLength = view.getUint16(p + 30, true),
      commentLength = view.getUint16(p + 32, true),
      disk = view.getUint16(p + 34, true),
      attrs = view.getUint32(p + 38, true),
      local = view.getUint32(p + 42, true);
    if (flags & (1 | 64 | 8192)) throw new ReviewError('encrypted_document');
    if (
      needed > 20 ||
      flags & ~(8 | 2048 | 2 | 4) ||
      (method !== 0 && method !== 8) ||
      disk !== 0 ||
      size === 0xffffffff ||
      comp === 0xffffffff ||
      local === 0xffffffff ||
      (made >>> 8 === 3 && ((attrs >>> 16) & 0xf000) === 0xa000)
    )
      bad();
    if (p + 46 + nameLength + extraLength + commentLength > eocd || !nameLength) bad();
    const rawName = bytes.subarray(p + 46, p + 46 + nameLength);
    if (!(flags & 2048) && rawName.some((v) => v > 127)) bad();
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      return bad();
    }
    if (
      /^[\/]|[\\:?#\u0000-\u001f\u007f%\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      name
        .split('/')
        .some((part, i, all) => part === '.' || part === '..' || (!part && i !== all.length - 1)) ||
      names.has(name.replace(/\/$/, '').normalize('NFC').toLowerCase())
    )
      bad();
    names.add(name.replace(/\/$/, '').normalize('NFC').toLowerCase());
    if (/\.(?:zip|rar|7z|jar|gz|gzip|bz2|xz|tar|tgz|zst|docx|xlsx|pptx|docm|xlsm)$/i.test(name))
      throw new ReviewError('active_content_not_allowed');
    extraCheck(view, p + 46 + nameLength, extraLength);
    if (size > limits.entry || (size > 0 && (!comp || size / comp > limits.ratio))) expansion();
    total += size;
    compressed += comp;
    if (total > limits.total) expansion();
    if (
      local + 30 > centralStart ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 4, true) !== needed ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      bad();
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true),
      start = local + 30 + localName + localExtra,
      end = start + comp;
    if (
      localName !== nameLength ||
      end > centralStart ||
      bytes.subarray(local + 30, local + 30 + localName).some((v, i) => v !== rawName[i])
    )
      bad();
    extraCheck(view, local + 30 + localName, localExtra);
    const localCrc = view.getUint32(local + 14, true),
      localComp = view.getUint32(local + 18, true),
      localSize = view.getUint32(local + 22, true);
    let regionEnd = end;
    if (flags & 8) {
      if (
        (localCrc !== 0 && localCrc !== crc) ||
        (localComp !== 0 && localComp !== comp) ||
        (localSize !== 0 && localSize !== size)
      )
        bad();
      let d = end;
      if (d + 4 <= centralStart && view.getUint32(d, true) === 0x08074b50) d += 4;
      if (
        d + 12 > centralStart ||
        view.getUint32(d, true) !== crc ||
        view.getUint32(d + 4, true) !== comp ||
        view.getUint32(d + 8, true) !== size
      )
        bad();
      regionEnd = d + 12;
    } else if (localCrc !== crc || localComp !== comp || localSize !== size) bad();
    if (method === 0 && comp !== size) bad();
    regions.push({ start: local, end: regionEnd });
    entries.push({ name, compressedSize: comp, size, method, crc, start, end });
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== eocd || (total > 0 && (!compressed || total / compressed > limits.ratio))) expansion();
  regions.sort((a, b) => a.start - b.start);
  let previous = 0;
  for (const region of regions) {
    if (region.start !== previous) bad();
    previous = region.end;
  }
  if (previous !== centralStart) bad();
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Every entry, including discarded parts, is inflated and checked before a DOCX is accepted. */
export function inflateEntries(
  bytes: Uint8Array,
  entries: ZipEntry[],
  consume: (entry: ZipEntry, chunk: Uint8Array, final: boolean) => void,
  check: () => void = () => {},
  limits: ZipLimits = defaults,
): void {
  let total = 0;
  for (const entry of entries) {
    check();
    let size = 0,
      crc = 0,
      finished = false;
    const emit = (chunk: Uint8Array, final: boolean): void => {
      check();
      size += chunk.length;
      total += chunk.length;
      if (size > entry.size || size > limits.entry || total > limits.total) expansion();
      crc = crc32(chunk, crc);
      consume(entry, chunk, final);
      if (final) finished = true;
    };
    if (entry.method === 0) {
      for (let p = entry.start; p < entry.end; p += 4096)
        emit(bytes.subarray(p, Math.min(p + 4096, entry.end)), p + 4096 >= entry.end);
      if (entry.start === entry.end) emit(new Uint8Array(), true);
    } else {
      const inflater = new Inflate(emit);
      try {
        for (let p = entry.start; p < entry.end; p += 4096)
          inflater.push(bytes.subarray(p, Math.min(p + 4096, entry.end)), p + 4096 >= entry.end);
        if (entry.start === entry.end) bad();
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        bad();
      }
    }
    if (!finished || size !== entry.size || crc !== entry.crc) bad();
  }
}
