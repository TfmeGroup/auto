import { AppError } from '@/lib/errors';

/**
 * Feature entitlements. Which plan includes which feature is DATA (`plan_features`),
 * not code. Endpoints call requireFeature() themselves — hiding a button is never
 * the control. To gate a new feature: add its key here, add it to the plan catalogue,
 * and call requireFeature(ctx.subscription, key) (or `feature:` on route()).
 */
export const FEATURES = {
  multi_location: 'More than one location',
  advanced_reports: 'Advanced reporting',
  scheduled_reports: 'Scheduled reports',
  advanced_inventory: 'Advanced inventory',
  custom_roles: 'Custom roles',
  advanced_communication: 'Advanced customer communication',
  mfa_enforcement: 'Require MFA for team members',
  data_export: 'Business data export',
  online_payments: 'Online customer payments (payment gateway)',
  payment_reminders: 'Automatic payment reminders',
  financial_reports: 'Financial reports, ageing, analytics and profitability',
  purchase_orders: 'Purchase orders, goods receiving and supplier returns',
  barcode_workflows: 'Barcode scanning workflows',
  technician_management: 'Technician profiles, time tracking and performance',
  bulk_inventory: 'Bulk inventory import and updates',
  inventory_reports: 'Advanced inventory reporting and valuation',
  advanced_documents: 'Advanced document management (versions, custom categories, retention settings)',
  communication_history: 'Customer communication history',
  custom_templates: 'Custom message templates',
  service_reminders: 'Automatic service reminders',
  sms_notifications: 'SMS notifications',
  whatsapp_notifications: 'WhatsApp notifications',
  custom_reports: 'Custom report builder and saved reports',
  advanced_settings: 'Workshop configuration: job statuses, service catalogue, job templates, vehicle rules and labour rounding',
  advanced_admin: 'Advanced administration: security events, archive management and administration search',
  advanced_import: 'Advanced imports (suppliers) and import history',
} as const;

export type FeatureKey = keyof typeof FEATURES;
export const ALL_FEATURES = Object.keys(FEATURES) as FeatureKey[];
export const isFeatureKey = (v: string): v is FeatureKey => v in FEATURES;

interface HasFeatures {
  features: ReadonlySet<FeatureKey>;
  planName: string;
  canWrite?: boolean;
}

export function canUseFeature(sub: HasFeatures, key: FeatureKey): boolean {
  return sub.features.has(key);
}

/** Throws 402 FEATURE_NOT_IN_PLAN. Call from the service/route that actually performs the action. */
export function requireFeature(sub: HasFeatures, key: FeatureKey): void {
  if (!sub.features.has(key)) {
    throw new AppError('FEATURE_NOT_IN_PLAN', 402, `${FEATURES[key]} is not included in your ${sub.planName} plan. Upgrade to use it.`, {
      feature: key,
    });
  }
}
