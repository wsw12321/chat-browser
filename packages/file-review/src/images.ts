import { inspectImage } from '@chat/contracts';
import { LIMITS, ReviewError, type Format, type ParsedArtifact, type TaskContext } from './types';
interface Dimensions {
  width: number;
  height: number;
}
const bad = (): never => {
  throw new ReviewError('file_type_mismatch');
};
export function inspectWebP(bytes: Uint8Array): Dimensions {
  const ascii = (p: number, n: number) => String.fromCharCode(...bytes.subarray(p, p + n));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 20 ||
    ascii(0, 4) !== 'RIFF' ||
    ascii(8, 4) !== 'WEBP' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    bad();
  let p = 12,
    width = 0,
    height = 0,
    extended: Dimensions | undefined,
    image = false;
  while (p < bytes.length) {
    if (p + 8 > bytes.length) bad();
    const type = ascii(p, 4),
      size = view.getUint32(p + 4, true),
      start = p + 8,
      end = start + size;
    if (end > bytes.length) bad();
    if (type === 'ANIM' || type === 'ANMF') throw new ReviewError('unsupported_file_type');
    if (type === 'VP8X') {
      if (p !== 12 || size !== 10 || extended || bytes[start]! & 2)
        throw new ReviewError('unsupported_file_type');
      if (bytes[start]! & 0xc1 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) bad();
      const u24 = (offset: number) =>
        bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16);
      extended = { width: 1 + u24(start + 4), height: 1 + u24(start + 7) };
    } else if (type === 'VP8 ') {
      if (image || size < 10 || bytes[start]! & 1 || ascii(start + 3, 3) !== '\x9d\x01\x2a') bad();
      image = true;
      width = view.getUint16(start + 6, true) & 0x3fff;
      height = view.getUint16(start + 8, true) & 0x3fff;
    } else if (type === 'VP8L') {
      if (image || size < 5 || bytes[start] !== 0x2f) bad();
      const bits = view.getUint32(start + 1, true);
      if (bits >>> 29) bad();
      image = true;
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (!['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) bad();
    p = end + (size & 1);
    if (p > bytes.length) bad();
  }
  if (
    !image ||
    !width ||
    !height ||
    (extended && (extended.width !== width || extended.height !== height))
  )
    bad();
  if (width > LIMITS.imageSide || height > LIMITS.imageSide || width * height > LIMITS.imagePixels)
    throw new ReviewError('image_dimensions_exceeded');
  return { width, height };
}
export function inspectOriginalImage(bytes: Uint8Array, format: Format): Dimensions {
  if (format === 'webp') return inspectWebP(bytes);
  if (format !== 'jpeg' && format !== 'png') return bad();
  // The contract validator also checks CRC, chunk ordering, animation and trailing bytes.
  try {
    return inspectImage(bytes, format === 'jpeg' ? 'image/jpeg' : 'image/png', {
      maxBytes: LIMITS.imageFile,
      maxSide: LIMITS.imageSide,
      maxPixels: LIMITS.imagePixels,
    });
  } catch {
    // Distinguish an authentic, oversized dimension declaration from unrelated malformed input.
    try {
      const dimensions = inspectImage(bytes, format === 'jpeg' ? 'image/jpeg' : 'image/png', {
        maxBytes: LIMITS.imageFile,
        maxSide: 0xffffffff,
        maxPixels: Number.MAX_SAFE_INTEGER,
      });
      if (
        dimensions.width > LIMITS.imageSide ||
        dimensions.height > LIMITS.imageSide ||
        dimensions.width * dimensions.height > LIMITS.imagePixels
      )
        throw new ReviewError('image_dimensions_exceeded');
    } catch (error) {
      if (error instanceof ReviewError) throw error;
    }
    return bad();
  }
}
export async function normalizeImage(
  bytes: Uint8Array,
  format: Format,
  context: TaskContext,
): Promise<ParsedArtifact> {
  const dimensions = inspectOriginalImage(bytes, format);
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined')
    throw new ReviewError('image_normalization_failed');
  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }), {
      imageOrientation: 'from-image',
    });
  } catch {
    throw new ReviewError('image_normalization_failed');
  }
  const release = () => bitmap.close();
  context.resources.add(release);
  try {
    context.check();
    if (!(
      (bitmap.width === dimensions.width && bitmap.height === dimensions.height) ||
      (bitmap.width === dimensions.height && bitmap.height === dimensions.width)
    ))
      throw new ReviewError('file_type_mismatch');
    if (
      bitmap.width * bitmap.height > LIMITS.imagePixels ||
      Math.max(bitmap.width, bitmap.height) > LIMITS.imageSide
    )
      throw new ReviewError('image_dimensions_exceeded');
    const outputMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const attempts =
      outputMime === 'image/png'
        ? [
            { side: 2048, quality: 1 },
            { side: 1536, quality: 1 },
            { side: 1024, quality: 1 },
          ]
        : [
            { side: 2048, quality: 0.9 },
            { side: 2048, quality: 0.8 },
            { side: 1536, quality: 0.7 },
          ];
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!,
        ratio = Math.min(1, attempt.side / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * ratio)),
        height = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(width, height),
        drawing = canvas.getContext('2d');
      if (!drawing) throw new ReviewError('image_normalization_failed');
      drawing.drawImage(bitmap, 0, 0, width, height);
      context.progress('normalizing', index + 1, attempts.length);
      let normalized: Blob;
      try {
        normalized = await canvas.convertToBlob({ type: outputMime, quality: attempt.quality });
      } catch {
        throw new ReviewError('image_normalization_failed');
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }
      context.check();
      if (normalized.size > LIMITS.outputImage) continue;
      try {
        const actual = inspectImage(new Uint8Array(await normalized.arrayBuffer()), outputMime);
        if (actual.width !== width || actual.height !== height) throw new Error();
      } catch {
        throw new ReviewError('image_normalization_failed');
      }
      return {
        normalized,
        mime: outputMime,
        width,
        height,
        metrics: {
          originalWidth: bitmap.width,
          originalHeight: bitmap.height,
          normalizedBytes: normalized.size,
        },
        warnings: [
          '图片已纠正方向、移除元数据并重新编码；请查看实际发送版本，细字不清晰时请裁剪后重新添加。',
        ],
      };
    }
    throw new ReviewError('image_normalization_failed');
  } finally {
    release();
    context.resources.delete(release);
  }
}
