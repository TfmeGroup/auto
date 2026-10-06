import type { Db } from '@/server/db/client';
import { ALL_FEATURES, type FeatureKey } from './features';

/**
 * Plan catalogue: Solo, Team, Business and Custom (+ the internal trial plan).
 * Limits and features are DATA, synced to the database by `npm run db:migrate`
 * and read from there — no plan name is compared anywhere in application logic.
 *
 * PRICES ARE NOT SET (null): the specification leaves pricing to be configured later.
 * An unpriced plan cannot be bought online (checkout refuses) until a price is set
 * here and synced. Prices are monthly, VAT-exclusive, in cents.
 *
 * Feature/limit allocations below are sensible defaults to CONFIRM with the business.
 */
export interface PlanDef {
  key: string;
  name: string;
  priceCents: number | null;
  billingInterval: 'MONTHLY' | 'ANNUAL';
  maxMembers: number;
  maxLocations: number;
  maxStorageMb: number;
  isCustom: boolean;
  isPublic: boolean;
  sortOrder: number;
  features: FeatureKey[];
}

export const TRIAL_PLAN_KEY = 'trial';
export const CUSTOM_PLAN_KEY = 'custom';
const GB = 1024;

export const PLAN_CATALOG: PlanDef[] = [
  // Internal: every business starts here for 14 days with full access.
  { key: TRIAL_PLAN_KEY, name: 'Free trial', priceCents: 0, billingInterval: 'MONTHLY', maxMembers: 10, maxLocations: 3, maxStorageMb: 5 * GB, isCustom: false, isPublic: false, sortOrder: 0, features: ALL_FEATURES },
  { key: 'solo', name: 'Solo', priceCents: null, billingInterval: 'MONTHLY', maxMembers: 1, maxLocations: 1, maxStorageMb: 2 * GB, isCustom: false, isPublic: true, sortOrder: 1, features: ['data_export'] },
  { key: 'team', name: 'Team', priceCents: null, billingInterval: 'MONTHLY', maxMembers: 10, maxLocations: 1, maxStorageMb: 10 * GB, isCustom: false, isPublic: true, sortOrder: 2, features: ['data_export', 'advanced_inventory', 'advanced_communication', 'mfa_enforcement', 'online_payments', 'payment_reminders', 'financial_reports', 'purchase_orders', 'barcode_workflows', 'technician_management', 'advanced_documents', 'communication_history', 'custom_templates', 'service_reminders', 'sms_notifications', 'advanced_reports', 'advanced_settings'] },
  { key: 'business', name: 'Business', priceCents: null, billingInterval: 'MONTHLY', maxMembers: 35, maxLocations: 10, maxStorageMb: 50 * GB, isCustom: false, isPublic: true, sortOrder: 3, features: ALL_FEATURES },
  // 36+ users / enterprise. Assigned by the platform team; real limits come from the subscription's overrides.
  { key: CUSTOM_PLAN_KEY, name: 'Custom', priceCents: null, billingInterval: 'MONTHLY', maxMembers: 36, maxLocations: 50, maxStorageMb: 500 * GB, isCustom: true, isPublic: true, sortOrder: 4, features: ALL_FEATURES },
];

export async function syncPlans(db: Db): Promise<void> {
  const keep = PLAN_CATALOG.map((p) => p.key);
  for (const p of PLAN_CATALOG) {
    const { features, ...cols } = p;
    const row = await db.plan.upsert({
      where: { key: p.key },
      create: { ...cols, status: 'ACTIVE' },
      update: { ...cols, status: 'ACTIVE' },
    });
    await db.planFeature.deleteMany({ where: { planId: row.id, featureKey: { notIn: features } } });
    await db.planFeature.createMany({
      data: features.map((featureKey) => ({ planId: row.id, featureKey, enabled: true })),
      skipDuplicates: true,
    });
  }
  // Plans no longer in the catalogue are archived (existing subscribers keep working).
  await db.plan.updateMany({ where: { key: { notIn: keep } }, data: { status: 'ARCHIVED', isPublic: false } });
}
