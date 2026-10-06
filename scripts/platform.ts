/**
 * Owner-level platform tooling (TFME staff only). Connects as the schema OWNER, which only the
 * platform team holds — the running web app cannot do any of this.
 *
 *   npm run platform -- grant-admin someone@tfme.co.za     (they must have an account; they must then enable MFA)
 *   npm run platform -- revoke-admin someone@tfme.co.za
 *   npm run platform -- list-admins
 *   npm run platform -- set <key> <value>                   e.g. set grace_days 10
 *   npm run platform -- settings                            show effective platform settings
 *
 * Settings keys: trial_reminder_days ("7,3,1"), trial_expiring_days, past_due_retry_days, grace_days,
 *                post_trial_retention_days, closed_business_retention_days, export_retention_days
 */
import pg from 'pg';
import { PLATFORM_DEFAULTS, parseSettings } from '../src/server/settings/platform';

try {
  process.loadEnvFile('.env');
} catch {
  // use the real environment
}

const KEYS = ['trial_reminder_days', 'trial_expiring_days', 'past_due_retry_days', 'grace_days', 'post_trial_retention_days', 'closed_business_retention_days', 'export_retention_days'];

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL (schema owner) is required');
  const [cmd, a, b] = process.argv.slice(2);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    switch (cmd) {
      case 'grant-admin': {
        const r = await db.query('SELECT id FROM users WHERE email = $1', [(a ?? '').toLowerCase()]);
        if (!r.rowCount) throw new Error(`No account with email ${a}`);
        await db.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.rows[0].id]);
        console.log(`${a} is now a platform admin. They must turn on two-factor authentication before platform endpoints will work.`);
        break;
      }
      case 'revoke-admin': {
        await db.query('DELETE FROM platform_admins WHERE user_id = (SELECT id FROM users WHERE email = $1)', [(a ?? '').toLowerCase()]);
        console.log(`${a} is no longer a platform admin.`);
        break;
      }
      case 'list-admins': {
        const r = await db.query('SELECT u.email, u.mfa_enabled, p.created_at FROM platform_admins p JOIN users u ON u.id = p.user_id ORDER BY p.created_at');
        console.table(r.rows);
        break;
      }
      case 'set': {
        if (!a || !KEYS.includes(a) || b === undefined) throw new Error(`Usage: set <${KEYS.join('|')}> <value>`);
        const probe = parseSettings([{ key: a, value: b }]);
        if (JSON.stringify(probe) === JSON.stringify(PLATFORM_DEFAULTS) && b !== '') console.warn('Warning: that value is invalid or equals the default; it will have no effect.');
        await db.query('INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [a, b]);
        console.log(`${a} = ${b} (takes effect within 30 seconds on every instance)`);
        break;
      }
      case 'settings': {
        const rows = (await db.query('SELECT key, value FROM platform_settings')).rows;
        console.log(JSON.stringify(parseSettings(rows), null, 2));
        break;
      }
      default:
        console.log('Commands: grant-admin <email> | revoke-admin <email> | list-admins | set <key> <value> | settings');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
