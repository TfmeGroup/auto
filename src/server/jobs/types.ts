/** Job type names. Constants only (no imports) so any module can enqueue without import cycles. */
export const JobTypes = {
  emailSend: 'email.send',
  providerCancel: 'billing.provider_cancel',
  providerUpdateAmount: 'billing.provider_update_amount',
  trialReminder: 'billing.trial_reminder',
  trialExpired: 'billing.trial_expired',
  billingDelinquency: 'billing.delinquency_phase',
  subscriptionExpired: 'billing.subscription_expired',
  exportGenerate: 'export.generate',
  documentGenerate: 'document.generate',
  commDeliver: 'comm.deliver',
  reportDeliver: 'report.deliver',
} as const;
