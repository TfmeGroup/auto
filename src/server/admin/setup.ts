import { env } from '@/lib/env';
import { withTenant } from '@/server/db/client';
import { requirePermission } from '@/server/permissions/authorize';
import { loadFinanceSettings } from '@/server/finance/common';
import { loadConfig } from '@/server/settings/config';
import { loadCommSettings } from '@/server/notifications/settings';
import type { BusinessContext } from '@/server/context';

/**
 * The System Setup Check: a fixed list of questions about how complete the business's configuration is, each answered from the actual
 * saved settings and records. Deterministic: the same data always gives the same answer, and there is nothing to interpret.
 *   COMPLETE         nothing to do
 *   WARNING          works, but a better set-up is possible
 *   ACTION_REQUIRED  something important is missing
 */
export type SetupStatus = 'COMPLETE' | 'WARNING' | 'ACTION_REQUIRED';
export interface SetupItem { key: string; label: string; status: SetupStatus; detail: string; href: string }

export async function getSetupCheck(ctx: BusinessContext): Promise<{ items: SetupItem[]; complete: number; warnings: number; actionRequired: number }> {
  requirePermission(ctx, 'settings.view');
  const bid = ctx.business.id;
  const items: SetupItem[] = [];
  const add = (key: string, label: string, status: SetupStatus, detail: string, href: string) => items.push({ key, label, status, detail, href });

  await withTenant(bid, async (tx) => {
    const b = await tx.business.findUniqueOrThrow({ where: { id: bid } });
    const [finance, comm, config, hours, members, locations, services, bays, technicians, partsCount] = [
      await loadFinanceSettings(tx, bid), await loadCommSettings(tx, bid), await loadConfig(tx, bid),
      await tx.workshopHours.count({ where: { businessId: bid } }), await tx.membership.count({ where: { businessId: bid, status: 'ACTIVE' } }),
      await tx.location.findMany({ where: { businessId: bid, status: 'ACTIVE' }, select: { id: true, docCode: true } }), await tx.serviceType.count({ where: { businessId: bid, status: 'ACTIVE' } }),
      await tx.bay.count({ where: { businessId: bid, status: 'ACTIVE' } }), await tx.technicianProfile.count({ where: { businessId: bid, isTechnician: true, status: 'ACTIVE' } }),
      await tx.part.count({ where: { businessId: bid, status: 'ACTIVE' } }),
    ];

    const missingProfile = [!b.phone && 'phone number', !b.email && 'email address', !b.addressLine1 && 'address', !b.city && 'city'].filter(Boolean) as string[];
    add('profile', 'Business profile', missingProfile.length ? 'ACTION_REQUIRED' : 'COMPLETE', missingProfile.length ? `Add your ${missingProfile.join(', ')}. They appear on quotes, invoices and messages.` : 'Name, phone, email and address are set.', '/settings');
    add('vat', 'VAT settings', b.vatRegistered && !b.vatNumber ? 'ACTION_REQUIRED' : 'COMPLETE', b.vatRegistered ? (b.vatNumber ? `VAT registered, number on file, ${(b.vatRateBps / 100).toFixed(2)}%.` : 'Marked as VAT registered but there is no VAT number.') : 'Not VAT registered: documents carry no VAT.', '/settings');
    add('hours', 'Business hours', hours > 0 ? 'COMPLETE' : 'WARNING', hours > 0 ? 'Opening hours are set; bookings follow them.' : 'No opening hours are set, so bookings are allowed at any time.', '/settings/workshop');
    const enabled = finance.enabledMethods as string[];
    const noInstructions = enabled.includes('EFT') && !finance.paymentInstructions;
    add('payments', 'Payment methods', enabled.length === 0 ? 'ACTION_REQUIRED' : noInstructions ? 'WARNING' : 'COMPLETE', enabled.length === 0 ? 'No payment method is switched on.' : noInstructions ? 'EFT is on but customers are not told where to pay. Add your bank details as payment instructions.' : `${enabled.length} payment method${enabled.length === 1 ? '' : 's'} on.`, '/settings/finance');
    const emailLive = env().EMAIL_DRIVER === 'smtp';
    add('email', 'Email', !emailLive ? 'WARNING' : (comm.replyTo || b.email) ? 'COMPLETE' : 'WARNING', !emailLive ? 'This system is not connected to an email service, so emails are written to a log instead of being sent. Ask whoever runs the system to connect one.' : (comm.replyTo || b.email) ? 'Emails are sent, and replies go to your address.' : 'Emails are sent, but customer replies have nowhere to go. Set a reply-to address.', '/settings/communication');
    add('branding', 'Document branding', b.logoFileId ? 'COMPLETE' : 'WARNING', b.logoFileId ? 'Your logo is on documents.' : 'No logo yet. Add one so documents look like yours.', '/settings');
    const multi = locations.length > 1;
    const uncoded = locations.filter((l) => !l.docCode).length;
    add('numbering', 'Numbering', multi && uncoded > 0 ? 'WARNING' : 'COMPLETE', multi && uncoded > 0 ? `${uncoded} location${uncoded === 1 ? ' has' : 's have'} no document code, so they share one number series.` : 'Each kind of record has its own prefix.', '/settings/numbering');
    add('users', 'Team', members >= 1 ? 'COMPLETE' : 'ACTION_REQUIRED', `${members} active member${members === 1 ? '' : 's'}.`, '/team');
    add('location', 'Locations', locations.length >= 1 ? 'COMPLETE' : 'ACTION_REQUIRED', `${locations.length} active location${locations.length === 1 ? '' : 's'}.`, '/settings/locations');
    add('inventory_location', 'Stock location', locations.length >= 1 ? 'COMPLETE' : 'ACTION_REQUIRED', locations.length >= 1 ? 'Stock is held at your locations.' : 'Stock needs at least one location.', '/settings/inventory');
    add('services', 'Services', services > 0 ? 'COMPLETE' : 'WARNING', services > 0 ? `${services} service${services === 1 ? '' : 's'} in the catalogue.` : 'No services yet. Add the services you sell so bookings and jobs can use them.', '/settings/services');
    add('technicians', 'Technicians', technicians > 0 ? 'COMPLETE' : 'WARNING', technicians > 0 ? `${technicians} technician${technicians === 1 ? '' : 's'}.` : 'No technician is set up, so jobs cannot be assigned.', '/team');
    add('labour', 'Labour rate', finance.defaultLabourRateCentsPerHour ? 'COMPLETE' : 'WARNING', finance.defaultLabourRateCentsPerHour ? 'A default labour rate is set.' : 'No default labour rate. Labour added without a rate will have no price.', '/settings/labour');
    add('bays', 'Service bays', bays > 0 ? 'COMPLETE' : 'WARNING', bays > 0 ? `${bays} bay${bays === 1 ? '' : 's'}.` : 'No bays are set up, so bookings are not limited by bays.', '/settings/workshop');
    add('notifications', 'Notifications', comm.bookingRemindersOn || comm.jobUpdateEvents.length > 0 ? 'COMPLETE' : 'WARNING', comm.bookingRemindersOn || comm.jobUpdateEvents.length > 0 ? 'Customer reminders or job updates are switched on.' : 'No customer reminders or job updates are on. Customers only get the messages they must receive.', '/settings/communication');
    add('stock', 'Parts catalogue', partsCount > 0 ? 'COMPLETE' : 'WARNING', partsCount > 0 ? `${partsCount} part${partsCount === 1 ? '' : 's'} in the catalogue.` : 'No parts yet. Add them, or import a file.', '/inventory');
    add('mfa', 'Two-factor sign-in', b.requireMfa ? 'COMPLETE' : 'WARNING', b.requireMfa ? 'Required for everyone in the business.' : 'Not required. Turning it on protects financial data.', '/settings/security');
    void config;
  });
  const count = (s: SetupStatus) => items.filter((i) => i.status === s).length;
  return { items, complete: count('COMPLETE'), warnings: count('WARNING'), actionRequired: count('ACTION_REQUIRED') };
}
