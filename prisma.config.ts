import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env on its own.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the real environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Schema-owner connection, used for migrations only. The running app uses
    // DATABASE_URL (restricted role, subject to row-level security).
    url: process.env.MIGRATE_DATABASE_URL ?? '',
  },
});
