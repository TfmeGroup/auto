import { Readable } from 'node:stream';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';
import { assertValidKey, StorageNotFoundError, type StorageDriver } from './types';

/**
 * S3-compatible driver (AWS S3, Cloudflare R2, Supabase Storage S3 API, MinIO).
 * The bucket MUST be private; nothing here ever builds a public URL.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const e = env();
    if (!e.S3_BUCKET) throw new Error('S3_BUCKET is required for the s3 storage driver');
    this.bucket = e.S3_BUCKET;
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, opts: { contentType: string }) {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType,
        ServerSideEncryption: undefined, // rely on bucket default encryption
      }),
    );
  }

  async get(key: string) {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new StorageNotFoundError(key);
      return { stream: res.Body as Readable, size: res.ContentLength };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string) {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string, opts: { limit: number }) {
    const out: { key: string; lastModified: Date; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, opts.limit) }));
      for (const o of res.Contents ?? []) if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified, size: o.Size ?? 0 });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && out.length < opts.limit);
    return out.slice(0, opts.limit);
  }

  async exists(key: string) {
    assertValidKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, opts: { expiresInSec: number; filename?: string }) {
    assertValidKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: opts.filename
          ? `attachment; filename*=UTF-8''${encodeURIComponent(opts.filename)}`
          : undefined,
      }),
      { expiresIn: Math.min(opts.expiresInSec, 300) },
    );
  }
}
