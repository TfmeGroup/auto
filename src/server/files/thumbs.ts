import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { logger } from '@/lib/logger';
import { getStorage } from '@/server/storage';

/**
 * Thumbnails for photos, so a job with forty pictures does not load forty full-size images. They are derived, private objects in the
 * same store (never public), made from the file's own bytes at upload, with metadata (including GPS) stripped.
 * HEIC photos are stored as uploaded but get no thumbnail (the image library cannot decode them): the screen shows the file icon.
 */
export const THUMBNAILABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SIZE = 360;

export async function makeThumbnail(data: Buffer, mime: string): Promise<Buffer | null> {
  if (!THUMBNAILABLE.has(mime)) return null;
  try {
    return await sharp(data, { limitInputPixels: 60_000_000, failOn: 'error', animated: false })
      .rotate()
      .resize({ width: SIZE, height: SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err: String(err) }, 'thumbnail could not be made');
    return null;
  }
}

/** Store a thumbnail; returns its storage key, or null (no thumbnail is not an error). */
export async function storeThumbnail(businessId: string, data: Buffer, mime: string): Promise<string | null> {
  const thumb = await makeThumbnail(data, mime);
  if (!thumb) return null;
  const key = `${businessId}/${new Date().getUTCFullYear()}/${randomUUID()}`;
  try {
    await getStorage().put(key, thumb, { contentType: 'image/webp' });
    return key;
  } catch (err) {
    logger.warn({ err: String(err) }, 'thumbnail could not be stored');
    return null;
  }
}
