/** `npm run db:migrate` — apply migrations + sync reference data. Uses MIGRATE_DATABASE_URL and DATABASE_URL. */
import { migrateDatabase } from './lib/migrate-db';

try {
  process.loadEnvFile('.env');
} catch {
  // use the real environment
}

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('MIGRATE_DATABASE_URL and DATABASE_URL must both be set (see .env.example).');
  process.exit(1);
}

migrateDatabase({ ownerUrl, appUrl })
  .then(() => console.log('Database is up to date.'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
