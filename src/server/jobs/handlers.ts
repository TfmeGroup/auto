import { getEmailTransport, type EmailMessage } from '@/server/notifications/email';
import { runProviderAmountUpdate, runProviderCancel } from '@/server/billing/provider-ops';
import { runDelinquencyPhase, runSubscriptionExpired, runTrialExpired, runTrialReminder } from '@/server/billing/lifecycle';
import { runExport } from '@/server/exports/service';
import { runGenerationJob } from '@/server/documents/generator';
import { runDelivery } from '@/server/notifications/comms';
import { runScheduledReport } from '@/server/reports/schedules';
import { JobTypes } from './types';

export { JobTypes };

export interface JobContext {
  jobId: string;
  attempt: number;
}

export interface JobHandler<P> {
  run: (payload: P, ctx: JobContext) => Promise<void>;
  /** Clear the stored payload after success (e.g. it contains a one-time link). */
  scrubPayloadOnSuccess?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, JobHandler<any>> = {
  [JobTypes.emailSend]: {
    run: async (payload: EmailMessage) => {
      await getEmailTransport().send(payload);
    },
    scrubPayloadOnSuccess: true,
  },
  [JobTypes.providerCancel]: { run: (p) => runProviderCancel(p) },
  [JobTypes.providerUpdateAmount]: { run: (p) => runProviderAmountUpdate(p) },
  [JobTypes.trialReminder]: { run: (p) => runTrialReminder(p) },
  [JobTypes.trialExpired]: { run: (p) => runTrialExpired(p) },
  [JobTypes.billingDelinquency]: { run: (p) => runDelinquencyPhase(p) },
  [JobTypes.subscriptionExpired]: { run: (p) => runSubscriptionExpired(p) },
  [JobTypes.exportGenerate]: { run: (p) => runExport(p) },
  [JobTypes.documentGenerate]: { run: (p, ctx) => runGenerationJob(p, ctx.attempt) },
  [JobTypes.commDeliver]: { run: (p, ctx) => runDelivery(p, ctx) },
  [JobTypes.reportDeliver]: { run: (p, ctx) => runScheduledReport(p, ctx.attempt) },
};
