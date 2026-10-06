import { env } from '@/lib/env';
import { LocalStorageDriver } from './local';
import { S3StorageDriver } from './s3';
import type { StorageDriver } from './types';

let driver: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  if (driver) return driver;
  driver = env().STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver(env().STORAGE_LOCAL_DIR);
  return driver;
}

export function setStorageForTests(d: StorageDriver | undefined) {
  driver = d;
}

export type { StorageDriver } from './types';
