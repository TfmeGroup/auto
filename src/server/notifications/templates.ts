import type { EmailMessage } from './email';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(title: string, bodyHtml: string, ctaLabel?: string, ctaUrl?: string): string {
  const cta =
    ctaLabel && ctaUrl
      ? `<p style="margin:24px 0"><a href="${esc(ctaUrl)}" style="background:#0f4c81;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(ctaLabel)}</a></p><p style="color:#555;font-size:13px">Or copy this link into your browser:<br>${esc(ctaUrl)}</p>`
      : '';
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px">${esc(title)}</h2>${bodyHtml}${cta}<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0 12px"><p style="color:#777;font-size:12px">TFME Auto</p></body></html>`;
}

/** Build a plain-text + HTML pair from paragraphs. Every template goes through here so they stay consistent. */
function mail(to: string, subject: string, name: string, paragraphs: string[], cta?: { label: string; url: string }): EmailMessage {
  const text = [`Hi ${name},`, '', ...paragraphs.flatMap((p) => [p, '']), ...(cta ? [`${cta.label}: ${cta.url}`, ''] : []), '— TFME Auto'].join('\n');
  const html = layout(subject, `<p>Hi ${esc(name)},</p>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}`, cta?.label, cta?.url);
  return { to, subject, text, html };
}

export const templates = {
  // ── account ──
  verifyEmail: (to: string, name: string, url: string) =>
    mail(to, 'Verify your TFME Auto email address', name, ['Confirm your email address to finish setting up TFME Auto. This link expires in 24 hours and works once.', 'If you did not create an account, ignore this email.'], { label: 'Verify email', url }),
  accountExists: (to: string, name: string, resetUrl: string) =>
    mail(to, 'Someone tried to register with your email', name, ['An attempt was made to create a TFME Auto account with this email address, but you already have one.', 'If this was you, you can reset your password. If not, ignore this email.'], { label: 'Reset password', url: resetUrl }),
  passwordReset: (to: string, name: string, url: string) =>
    mail(to, 'Reset your TFME Auto password', name, ['Use this link to choose a new password. It expires in 1 hour and can only be used once.', 'If you did not ask for this, ignore this email — your password has not changed.'], { label: 'Choose a new password', url }),

  // ── security alerts (always sent) ──
  passwordChanged: (to: string, name: string) =>
    mail(to, 'Your TFME Auto password was changed', name, ['Your password was just changed and your other sessions were signed out.', "If this wasn't you, reset your password immediately and contact your business owner."]),
  newLogin: (to: string, name: string, d: { device: string; ip?: string; at: string }) =>
    mail(to, 'New sign-in to your TFME Auto account', name, [`We noticed a sign-in from a device we have not seen before: ${d.device}${d.ip ? ` (IP ${d.ip})` : ''} at ${d.at}.`, "If this was you, no action is needed. If not, change your password and sign out other sessions from your account security page."]),
  emailChangeConfirm: (to: string, name: string, url: string) =>
    mail(to, 'Confirm your new TFME Auto email address', name, ['Confirm this address to use it for your TFME Auto account. Until you do, your old address stays in use. The link expires in 24 hours.'], { label: 'Confirm new email', url }),
  emailChangeRequested: (to: string, name: string, newEmail: string) =>
    mail(to, 'A change of email address was requested', name, [`A request was made to change your TFME Auto email address to ${newEmail}.`, "If this wasn't you, change your password now. Nothing changes until the new address is confirmed."]),
  emailChanged: (to: string, name: string, newEmail: string) =>
    mail(to, 'Your TFME Auto email address was changed', name, [`Your account email was changed to ${newEmail}. All sessions were signed out.`, "If this wasn't you, contact your business owner and TFME support immediately."]),
  mfaEnabled: (to: string, name: string) =>
    mail(to, 'Two-factor authentication turned on', name, ['Two-factor authentication is now enabled on your TFME Auto account.', "If this wasn't you, change your password immediately."]),
  mfaDisabled: (to: string, name: string) =>
    mail(to, 'Two-factor authentication turned off', name, ['Two-factor authentication was turned off on your TFME Auto account.', "If this wasn't you, change your password immediately and turn it back on."]),
  recoveryCodesRegenerated: (to: string, name: string) =>
    mail(to, 'New recovery codes generated', name, ['New two-factor recovery codes were generated. Your old codes no longer work.', "If this wasn't you, change your password immediately."]),
  accountDeactivated: (to: string, name: string) =>
    mail(to, 'Your TFME Auto account was deactivated', name, ['Your account has been deactivated and you were signed out everywhere. Your history in any business you worked in is kept.', 'Contact support if you need it reactivated.']),

  // ── bookings (to the workshop's customers) ──
  bookingRescheduled: (to: string, name: string, business: string, d: { service: string; vehicle: string; from: string; to: string }) =>
    mail(to, `Your booking at ${business} was moved`, name, [`Your ${d.service} appointment for ${d.vehicle} was moved from ${d.from} to ${d.to}.`, `If this time does not suit you, please contact ${business}.`]),
  bookingCancelled: (to: string, name: string, business: string, d: { service: string; vehicle: string; at: string }) =>
    mail(to, `Your booking at ${business} was cancelled`, name, [`Your ${d.service} appointment for ${d.vehicle} on ${d.at} was cancelled.`, `Please contact ${business} if you would like to book another time.`]),

// ── money (to the workshop's customers; transactional, never marketing) ──
  quoteSent: (to: string, name: string, business: string, d: { number: string; total: string; validUntil?: string; url: string }) =>
    mail(to, `Quote ${d.number} from ${business}`, name, [`${business} has sent you quote ${d.number} for ${d.total}.${d.validUntil ? ` It is valid until ${d.validUntil}.` : ''}`, 'You can review it and approve, decline or ask for changes online.'], { label: 'Review quote', url: d.url }),
  quoteDecisionConfirmation: (to: string, name: string, business: string, d: { number: string; decision: 'approved' | 'declined' | 'changes requested' }) =>
    mail(to, `Quote ${d.number}: ${d.decision}`, name, [d.decision === 'changes requested' ? `We have passed your request for changes to quote ${d.number} on to ${business}. They will send you a revised quote.` : `We recorded that you ${d.decision} quote ${d.number} from ${business}.`]),
  staffQuoteDecision: (to: string, name: string, business: string, d: { number: string; customer: string; decision: 'approved' | 'declined' | 'changes requested'; comment?: string; url: string }) =>
    mail(to, `Quote ${d.number} ${d.decision} by ${d.customer}`, name, [`${d.customer} ${d.decision === 'changes requested' ? 'asked for changes to' : d.decision} quote ${d.number}.${d.comment ? ` Their comment: "${d.comment}"` : ''}`], { label: 'Open quote', url: d.url }),
  invoiceSent: (to: string, name: string, business: string, d: { number: string; total: string; due: string; url: string }) =>
    mail(to, `Invoice ${d.number} from ${business}`, name, [`${business} has sent you invoice ${d.number} for ${d.total}, due ${d.due}.`, 'You can view it, download the PDF and see how to pay online.'], { label: 'View invoice', url: d.url }),
  paymentReceived: (to: string, name: string, business: string, d: { amount: string; receipt: string; invoice?: string; remaining?: string; url?: string }) =>
    mail(to, `Payment received by ${business}`, name, [`${business} received your payment of ${d.amount}${d.invoice ? ` for invoice ${d.invoice}` : ''}. Receipt ${d.receipt} has been issued.${d.remaining !== undefined ? ` Remaining balance: ${d.remaining}.` : ''}`], d.url ? { label: 'View receipt', url: d.url } : undefined),
  customerPaymentFailed: (to: string, name: string, business: string, d: { invoice: string; url: string }) =>
    mail(to, `Your payment for invoice ${d.invoice} did not go through`, name, [`Your online payment to ${business} for invoice ${d.invoice} was not completed. No money has been taken. You can try again or pay another way.`], { label: 'Open invoice', url: d.url }),
  paymentReminder: (to: string, name: string, business: string, d: { number: string; outstanding: string; due: string; when: 'before' | 'today' | 'overdue'; url: string }) =>
    mail(to, d.when === 'overdue' ? `Invoice ${d.number} is overdue` : `Reminder: invoice ${d.number} ${d.when === 'today' ? 'is due today' : 'is due soon'}`, name, [d.when === 'overdue' ? `Invoice ${d.number} from ${business} was due on ${d.due} and ${d.outstanding} is still outstanding.` : `Invoice ${d.number} from ${business} (${d.outstanding} outstanding) is due ${d.when === 'today' ? 'today' : 'on ' + d.due}.`, 'If you have already paid, thank you; please ignore this message.'], { label: 'View invoice', url: d.url }),
  creditNoteIssued: (to: string, name: string, business: string, d: { number: string; invoice: string; total: string }) =>
    mail(to, `Credit note ${d.number} from ${business}`, name, [`${business} has issued credit note ${d.number} for ${d.total} against invoice ${d.invoice}.`]),
  refundIssued: (to: string, name: string, business: string, d: { amount: string; reason: string }) =>
    mail(to, `Refund from ${business}`, name, [`${business} has recorded a refund of ${d.amount} to you. Reason: ${d.reason}.`]),

  // ── inventory & purchasing (to the workshop's own people and its suppliers; operational, never marketing) ──
  inventoryNotice: (to: string, name: string, business: string, subject: string, message: string, cta?: { label: string; url: string }) =>
    mail(to, subject, name, [message, `This message is about stock and purchasing at ${business}.`], cta),
  purchaseOrderToSupplier: (to: string, supplier: string, business: string, d: { number: string; expected?: string; deliverTo: string; lines: string[]; total?: string; note?: string }) =>
    mail(to, `Purchase order ${d.number} from ${business}`, supplier, [
      `${business} would like to order the following (purchase order ${d.number}).`,
      ...d.lines,
      ...(d.total ? [`Order total: ${d.total}`] : []),
      `Deliver to: ${d.deliverTo}.${d.expected ? ` Expected by ${d.expected}.` : ''}`,
      ...(d.note ? [d.note] : []),
      'The purchase order is attached as a PDF. Please quote the purchase order number on your delivery note and invoice.',
    ]),

  // ── business / membership ──
  invitation: (to: string, businessName: string, inviterName: string, roleName: string, url: string) =>
    mail(to, `${inviterName} invited you to ${businessName} on TFME Auto`, 'there', [`${inviterName} invited you to join ${businessName} as ${roleName}. The invitation expires in 7 days.`, 'Sign in (or create an account with this email address) and accept the invitation.'], { label: 'Accept invitation', url }),
  membershipChanged: (to: string, name: string, business: string, change: string) =>
    mail(to, `Your access to ${business} changed`, name, [`${change}`, 'If you did not expect this, speak to your business owner.']),
  ownershipTransferred: (to: string, name: string, business: string, role: 'new owner' | 'previous owner') =>
    mail(to, `Ownership of ${business} was transferred`, name, [role === 'new owner' ? `You are now the Owner of ${business}.` : `You are no longer the Owner of ${business}; you now have the Admin role.`]),
  businessClosed: (to: string, name: string, business: string) =>
    mail(to, `${business} was closed`, name, [`${business} was closed by its owner. Nobody can sign in to it any more. The data is retained according to TFME's retention policy.`]),
  roleChanged: (to: string, name: string, business: string, role: string) =>
    mail(to, `The ${role} role changed in ${business}`, name, [`The permissions of the "${role}" role were changed. This affects your access in ${business}.`]),

  // ── trial & billing ──
  trialReminder: (to: string, name: string, business: string, days: number, url: string) =>
    mail(to, `${days} day${days === 1 ? '' : 's'} left in your free trial`, name, [`The free trial for ${business} ends in ${days} day${days === 1 ? '' : 's'}. Choose a plan to keep using TFME Auto without interruption. Nothing is deleted if you do not.`], { label: 'Choose a plan', url }),
  trialExpired: (to: string, name: string, business: string, url: string) =>
    mail(to, `Your free trial for ${business} has ended`, name, [`${business} is now read-only: you can still view everything, but changes are paused. Your data is safe. Choose a plan to continue.`], { label: 'Choose a plan', url }),
  paymentSucceeded: (to: string, name: string, business: string, amount: string, invoice: string) =>
    mail(to, `Payment received for ${business}`, name, [`We received your payment of ${amount} for ${business}. Tax invoice ${invoice} is available on your billing page. Thank you.`]),
  paymentFailed: (to: string, name: string, business: string, url: string, detail: string) =>
    mail(to, `Payment failed for ${business}`, name, [`A subscription payment for ${business} did not go through. ${detail}`, 'Nothing has been deleted and everything keeps working for now.'], { label: 'Review billing', url }),
  gracePeriod: (to: string, name: string, business: string, url: string, daysLeft: number) =>
    mail(to, `Action needed: ${business} is in its grace period`, name, [`Payment for ${business} is still outstanding. Everything still works, but it becomes read-only in about ${daysLeft} day${daysLeft === 1 ? '' : 's'} if the payment is not resolved.`], { label: 'Fix billing', url }),
  suspended: (to: string, name: string, business: string, url: string) =>
    mail(to, `${business} is suspended for non-payment`, name, [`${business} is now read-only because payment is outstanding. Your data is preserved. Paying restores full access immediately.`], { label: 'Restore access', url }),
  subscriptionChanged: (to: string, name: string, business: string, detail: string) =>
    mail(to, `Subscription updated for ${business}`, name, [detail]),
  cancellation: (to: string, name: string, business: string, endsOn: string) =>
    mail(to, `Subscription cancelled for ${business}`, name, [`The subscription for ${business} was cancelled. You keep full access until ${endsOn}; after that the business becomes read-only. Your data is preserved.`]),

  // ── data ──
  exportReady: (to: string, name: string, business: string, url: string, days: number) =>
    mail(to, `Your ${business} data export is ready`, name, [`Your export is ready to download. The link works for ${days} days and requires you to be signed in.`], { label: 'Download export', url }),
};

/** Bump when the wording of a money template changes; recorded with every message sent. */
export const FINANCE_TEMPLATE_VERSION = 1;
