import { prisma, type Db } from '@/server/db/client';

/**
 * Platform-wide tunables. Defaults live here; the `platform_settings` table overrides
 * them (changed by the platform team with owner-level tooling, never by a tenant).
 * Nothing about timing is hard-coded in billing or notification logic: it all reads this.
 */
export interface PlatformSettings {
  /** Send a trial reminder when this many days (or fewer) remain; each window sends once. */
  trialReminderDays: number[];
  /** A trial is labelled "expiring" in the UI once this many days or fewer remain. */
  trialExpiringDays: number;
  /** After a failed/lapsed payment: full access, provider retries (PAST_DUE). */
  pastDueRetryDays: number;
  /** After the retry window: still working, with warnings (GRACE_PERIOD). Then SUSPENDED (read-only). */
  graceDays: number;
  /** How long an unconverted, expired trial's data is retained before the platform may purge it. Not auto-purged. */
  postTrialRetentionDays: number;
  /** How long a closed business's data is retained. Not auto-purged. */
  closedBusinessRetentionDays: number;
  /** How long a generated data export stays downloadable. */
  exportRetentionDays: number;
}

export const PLATFORM_DEFAULTS: PlatformSettings = {
  trialReminderDays: [7, 3, 1],
  trialExpiringDays: 3,
  pastDueRetryDays: 3,
  graceDays: 7,
  postTrialRetentionDays: 90,
  closedBusinessRetentionDays: 365,
  exportRetentionDays: 7,
};

const KEYS = {
  trial_reminder_days: 'trialReminderDays',
  trial_expiring_days: 'trialExpiringDays',
  past_due_retry_days: 'pastDueRetryDays',
  grace_days: 'graceDays',
  post_trial_retention_days: 'postTrialRetentionDays',
  closed_business_retention_days: 'closedBusinessRetentionDays',
  export_retention_days: 'exportRetentionDays',
} as const;

const TTL_MS = 30_000;
let cache: { at: number; value: PlatformSettings } | null = null;

export function clearPlatformSettingsCache() {
  cache = null;
}

export function parseSettings(rows: { key: string; value: string }[]): PlatformSettings {
  const out: PlatformSettings = { ...PLATFORM_DEFAULTS, trialReminderDays: [...PLATFORM_DEFAULTS.trialReminderDays] };
  for (const { key, value } of rows) {
    const field = KEYS[key as keyof typeof KEYS];
    if (!field) continue;
    if (field === 'trialReminderDays') {
      const days = value.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 90);
      if (days.length) out.trialReminderDays = [...new Set(days)].sort((a, b) => b - a);
    } else {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0 && n <= 3650) out[field] = n;
    }
  }
  return out;
}

export async function getPlatformSettings(db: Db = prisma()): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await db.platformSetting.findMany();
  const value = parseSettings(rows);
  cache = { at: Date.now(), value };
  return value;
}
