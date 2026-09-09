import { describe, it, expect, vi, afterEach } from 'vitest';
import { zlibSync } from 'fflate';
import { inspectOriginalImage, inspectWebP, normalizeImage } from '../src/images';
import { crc32 } from '../src/zip';
const enc = new TextEncoder();
function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12),
    view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(enc.encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
  return bytes;
}
function png(width = 1, height = 1, extra?: Uint8Array): Uint8Array {
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(extra ? [extra] : []),
    chunk('IDAT', zlibSync(new Uint8Array([0, 255, 0, 0, 0]))),
    chunk('IEND', new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return bytes;
}
function webp(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(26),
    view = new DataView(bytes.buffer);
  bytes.set(enc.encode('RIFF'));
  view.setUint32(4, 18, true);
  bytes.set(enc.encode('WEBPVP8L'), 8);
  view.setUint32(16, 5, true);
  bytes[20] = 0x2f;
  view.setUint32(21, ((height - 1) << 14) | (width - 1), true);
  return bytes;
}
const context = () => ({
  resources: new Set<() => void | Promise<void>>(),
  progress() {},
  check() {},
});
afterEach(() => vi.unstubAllGlobals());
describe('image pre-decode inspection', () => {
  it('accepts authentic static PNG dimensions and WebP lossless frame headers', () => {
    expect(inspectOriginalImage(png(), 'png')).toMatchObject({ width: 1, height: 1 });
    expect(inspectWebP(webp(320, 200))).toEqual({ width: 320, height: 200 });
  });
  it('checks exact side and total-pixel boundaries before decoding', () => {
    expect(inspectOriginalImage(png(8192, 1), 'png')).toMatchObject({ width: 8192 });
    expect(() => inspectOriginalImage(png(8193, 1), 'png')).toThrow('image_dimensions_exceeded');
    expect(inspectOriginalImage(png(4000, 3000), 'png')).toMatchObject({ height: 3000 });
    expect(() => inspectOriginalImage(png(4001, 3000), 'png')).toThrow('image_dimensions_exceeded');
  });
  it('rejects APNG regardless of otherwise valid IHDR', () => {
    const animation = new Uint8Array(8);
    new DataView(animation.buffer).setUint32(0, 2);
    expect(() => inspectOriginalImage(png(1, 1, chunk('acTL', animation)), 'png')).toThrow(
      'file_type_mismatch',
    );
  });
  it('rejects CRC corruption, MIME contradiction, trailing bytes and bad WebP RIFF lengths', () => {
    const broken = png();
    broken[29] ^= 1;
    expect(() => inspectOriginalImage(broken, 'png')).toThrow('file_type_mismatch');
    expect(() => inspectOriginalImage(png(), 'jpeg')).toThrow('file_type_mismatch');
    expect(() => inspectOriginalImage(new Uint8Array([...png(), 1]), 'png')).toThrow();
    const riff = webp();
    riff[4]++;
    expect(() => inspectWebP(riff)).toThrow('file_type_mismatch');
  });
  it('rejects animated WebP headers and oversized static frames', () => {
    const bytes = new Uint8Array(30),
      view = new DataView(bytes.buffer);
    bytes.set(enc.encode('RIFF'));
    view.setUint32(4, 22, true);
    bytes.set(enc.encode('WEBPVP8X'), 8);
    view.setUint32(16, 10, true);
    bytes[20] = 2;
    expect(() => inspectWebP(bytes)).toThrow('unsupported_file_type');
    expect(() => inspectWebP(webp(8193, 1))).toThrow('image_dimensions_exceeded');
  });
  it('never invokes decoder for a pixel bomb', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(normalizeImage(png(8193, 1), 'png', context())).rejects.toThrow(
      'image_dimensions_exceeded',
    );
    expect(decode).not.toHaveBeenCalled();
  });
  it('checks actual decoded dimensions and releases bitmap on failure', async () => {
    const bitmap = { width: 2, height: 2, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    vi.stubGlobal('OffscreenCanvas', class {});
    const ctx = context();
    await expect(normalizeImage(png(), 'png', ctx)).rejects.toThrow('file_type_mismatch');
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(ctx.resources.size).toBe(0);
  });
  it('revalidates output and uses a finite encoding budget', async () => {
    const bitmap = { width: 1, height: 1, close: vi.fn() },
      convert = vi.fn(async () => new Blob([new Uint8Array(1024 ** 2 + 1)]));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width = 1;
        height = 1;
        getContext() {
          return { drawImage() {} };
        }
        convertToBlob = convert;
      },
    );
    await expect(normalizeImage(png(), 'png', context())).rejects.toThrow(
      'image_normalization_failed',
    );
    expect(convert).toHaveBeenCalledTimes(3);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
