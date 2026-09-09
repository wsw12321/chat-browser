import { ContractError } from './errors';
import { POLICY } from './policy';

export interface ImageLimits {
  maxBytes?: number;
  maxSide?: number;
  maxPixels?: number;
}
export interface ImageInfo {
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}
const invalid = (): never => {
  throw new ContractError('invalid_image');
};
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function strictBase64(value: string, maxBytes = POLICY.request.imageBytes): Uint8Array {
  if (
    !value ||
    value.length > 4 * Math.ceil(maxBytes / 3) ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    invalid();
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return invalid();
  }
  if (decoded.length > maxBytes || btoa(decoded) !== value) invalid();
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
export function inspectImage(
  bytes: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png',
  limits: ImageLimits = {},
): ImageInfo {
  if (!bytes.length || bytes.length > (limits.maxBytes ?? POLICY.request.imageBytes)) invalid();
  const dimensions = mimeType === 'image/png' ? inspectPng(bytes) : inspectJpeg(bytes);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    Math.max(dimensions.width, dimensions.height) > (limits.maxSide ?? POLICY.request.imageSide) ||
    dimensions.width * dimensions.height > (limits.maxPixels ?? POLICY.request.imagePixels)
  )
    invalid();
  return { ...dimensions, mimeType };
}
function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    width = 0,
    height = 0,
    header = false,
    data = false,
    endedData = false,
    palette = false,
    color = -1,
    dataBytes = 0;
  const zlibHeader: number[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]!.toUpperCase()) invalid();
    if (view.getUint32(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) invalid();
    if (!header && type !== 'IHDR') invalid();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      header = true;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bit = bytes[offset + 16]!;
      color = bytes[offset + 17]!;
      const bits: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !bits[color]?.includes(bit) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20]! > 1
      )
        invalid();
    } else if (type === 'PLTE') {
      if (palette || data || !length || length % 3 || length > 768 || color === 0 || color === 4)
        invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (endedData || (color === 3 && !palette)) invalid();
      data = true;
      dataBytes += length;
      for (let i = 0; i < length && zlibHeader.length < 2; i++)
        zlibHeader.push(bytes[offset + 8 + i]!);
    } else if (type === 'IEND') {
      if (
        !data ||
        dataBytes < 6 ||
        zlibHeader.length !== 2 ||
        (zlibHeader[0]! & 15) !== 8 ||
        zlibHeader[0]! >>> 4 > 7 ||
        ((zlibHeader[0]! << 8) + zlibHeader[1]!) % 31 !== 0 ||
        (zlibHeader[1]! & 32) !== 0 ||
        length !== 0 ||
        end !== bytes.length
      )
        invalid();
      return { width, height };
    } else {
      if (type[0] === type[0]!.toUpperCase()) invalid();
      if (data) endedData = true;
    }
    offset = end;
  }
  return invalid();
}
function inspectJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 255 || bytes[1] !== 216) invalid();
  let offset = 2,
    width = 0,
    height = 0,
    frame = false,
    scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 216) invalid();
    if (marker === 217) {
      if (!frame || !scan || offset !== bytes.length) invalid();
      return { width, height };
    }
    if (marker >= 208 && marker <= 215) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (frame || ![192, 193, 194].includes(marker) || length < 8 || bytes[offset + 2] !== 8)
        invalid();
      const channels = bytes[offset + 7]!;
      if (![1, 3, 4].includes(channels) || length !== 8 + 3 * channels) invalid();
      height = bytes[offset + 3]! * 256 + bytes[offset + 4]!;
      width = bytes[offset + 5]! * 256 + bytes[offset + 6]!;
      frame = true;
    }
    if (marker === 220 || marker === 204) invalid();
    offset += length;
    if (marker === 218) {
      if (!frame || length < 6) invalid();
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) {
          offset++;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) {
          offset += 2;
          continue;
        }
        break;
      }
    }
  }
  return invalid();
}
