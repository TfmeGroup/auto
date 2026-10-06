/**
 * The notification event model: ONE registry of every operational message TFME Auto can send, so message types are never loose
 * strings scattered through the code. Each event says who it is for, which preference category governs it, whether it is
 * mandatory, which channels it may use, which template variables it may reference, and its default wording.
 *
 * TRANSACTIONAL vs MARKETING: everything here is transactional (a booking, a job, a quote, an invoice, a payment, a service
 * reminder). There is no marketing event and no campaign feature. A customer's marketing consent therefore never gates any of
 * these, and giving it unlocks nothing here.
 */
export type CommChannelKey = 'EMAIL' | 'SMS' | 'WHATSAPP';

/** What a customer can switch off. MANDATORY events ignore these switches: a customer cannot turn off their own invoice or receipt. */
export type CommCategory = 'BOOKING' | 'JOB_UPDATES' | 'FINANCIAL' | 'PAYMENT_REMINDERS' | 'SERVICE_REMINDERS' | 'SUPPLIER' | 'MANUAL' | 'REPORTS';

export const CATEGORY_LABEL: Record<CommCategory, string> = {
  BOOKING: 'Bookings', JOB_UPDATES: 'Job updates', FINANCIAL: 'Quotes, invoices and payments', PAYMENT_REMINDERS: 'Payment reminders', SERVICE_REMINDERS: 'Service reminders', SUPPLIER: 'Suppliers', MANUAL: 'Messages from the workshop', REPORTS: 'Scheduled reports',
};

export interface VariableDef {
  description: string;
  /** Representative value used in template previews (never real customer data). */
  sample: string;
}

/** The only things a template may refer to. A template cannot reach into the database or call anything: it can only use these names. */
export const VARIABLES: Record<string, VariableDef> = {
  customer_name: { description: 'The customer\'s name', sample: 'Alex Sample' },
  business_name: { description: 'Your business name', sample: 'Sample Motors' },
  business_phone: { description: 'Your business phone number', sample: '011 555 0100' },
  business_email: { description: 'Your business email address', sample: 'workshop@example.com' },
  location_name: { description: 'The workshop location this concerns', sample: 'Main workshop' },
  vehicle: { description: 'The vehicle, e.g. 2018 Toyota Hilux (CA 123-456)', sample: '2018 Toyota Hilux (CA 123-456)' },
  vehicle_registration: { description: 'The vehicle registration', sample: 'CA 123-456' },
  vehicle_make: { description: 'The vehicle make', sample: 'Toyota' },
  vehicle_model: { description: 'The vehicle model', sample: 'Hilux' },
  job_number: { description: 'The job number', sample: 'JOB-0000123' },
  quote_number: { description: 'The quote number', sample: 'QUO-000045' },
  invoice_number: { description: 'The invoice number', sample: 'INV-000210' },
  receipt_number: { description: 'The receipt number', sample: 'RCT-000087' },
  credit_note_number: { description: 'The credit note number', sample: 'CRN-000004' },
  purchase_order_number: { description: 'The purchase order number', sample: 'PO-000031' },
  payment_amount: { description: 'The amount paid', sample: 'R 1 250,00' },
  quote_total: { description: 'The quote total', sample: 'R 4 800,00' },
  invoice_total: { description: 'The invoice total', sample: 'R 4 800,00' },
  amount_due: { description: 'The amount still outstanding', sample: 'R 3 550,00' },
  credit_note_total: { description: 'The credit note total', sample: 'R 600,00' },
  refund_amount: { description: 'The amount refunded', sample: 'R 600,00' },
  remaining_balance: { description: 'The balance remaining after a payment', sample: 'R 3 550,00' },
  appointment_date: { description: 'The appointment date', sample: 'Tuesday 14 October' },
  appointment_time: { description: 'The appointment time', sample: '08:30' },
  previous_appointment: { description: 'The old appointment time, when it was moved', sample: 'Monday 13 October, 08:30' },
  due_date: { description: 'The due date', sample: '21 October 2026' },
  due_phrase: { description: 'When an invoice is due, in words', sample: 'is due on 21 October 2026' },
  valid_until: { description: 'When a quote is valid until', sample: '28 October 2026' },
  service_name: { description: 'The service or job type', sample: 'Full service' },
  service_due: { description: 'When the next service is due', sample: 'on 1 November 2026 or at 80 000 km' },
  decision: { description: 'The customer\'s decision on a quote', sample: 'approved' },
  reason: { description: 'The reason given', sample: 'Duplicate payment' },
  secure_link: { description: 'A private link for the customer to open this record', sample: 'https://app.example.com/q/abc123' },
  supplier_name: { description: 'The supplier\'s name', sample: 'Sample Parts Wholesale' },
  order_lines: { description: 'The lines of a purchase order', sample: '4 x Oil filter\n2 x Brake pads' },
  order_total: { description: 'The purchase order total', sample: 'R 3 200,00' },
  expected_date: { description: 'The expected delivery date', sample: '16 October 2026' },
  deliver_to: { description: 'Where the order is to be delivered', sample: 'Sample Motors, Main workshop' },
  note: { description: 'A note from the workshop', sample: 'Please call before delivering.' },
  report_name: { description: 'The name of a scheduled report', sample: 'Weekly revenue' },
  report_period: { description: 'The period a report covers', sample: '1 October to 7 October 2026' },
};

const GLOBAL_VARS = ['customer_name', 'business_name', 'business_phone', 'business_email', 'location_name'] as const;

interface ChannelText {
  subject?: string;
  body: string;
}

export interface EventDef {
  key: string;
  label: string;
  category: CommCategory;
  /** Sent regardless of the customer's optional-message switches. */
  mandatory: boolean;
  audience: 'customer' | 'supplier' | 'staff';
  /** Channels the event may use besides email. */
  channels: CommChannelKey[];
  /** Variables beyond the global ones. */
  vars: string[];
  /** Gets a secure link to the customer-facing view of the record. */
  withLink: boolean;
  defaults: Partial<Record<CommChannelKey, ChannelText>>;
}

const BOOKING_VARS = ['vehicle', 'vehicle_registration', 'vehicle_make', 'vehicle_model', 'service_name', 'appointment_date', 'appointment_time'];
const JOB_VARS = ['vehicle', 'vehicle_registration', 'vehicle_make', 'vehicle_model', 'job_number', 'service_name', 'secure_link'];

const def = (e: EventDef): EventDef => e;

export const EVENTS = {
  // ── bookings ──
  BOOKING_CONFIRMED: def({
    key: 'BOOKING_CONFIRMED', label: 'Booking confirmation', category: 'BOOKING', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: BOOKING_VARS, withLink: false,
    defaults: {
      EMAIL: { subject: 'Your booking at {{business_name}} is confirmed', body: 'Your {{service_name}} appointment for {{vehicle}} is booked for {{appointment_date}} at {{appointment_time}}.\n\nIf you need to change it, please contact {{business_name}} on {{business_phone}}.' },
      SMS: { body: '{{business_name}}: your {{service_name}} is booked for {{appointment_date}} at {{appointment_time}}. Questions? {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: your {{service_name}} for {{vehicle}} is booked for {{appointment_date}} at {{appointment_time}}. Questions? {{business_phone}}' },
    },
  }),
  BOOKING_REMINDER: def({
    key: 'BOOKING_REMINDER', label: 'Booking reminder', category: 'BOOKING', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: BOOKING_VARS, withLink: false,
    defaults: {
      EMAIL: { subject: 'Reminder: your appointment at {{business_name}}', body: 'This is a reminder of your {{service_name}} appointment for {{vehicle}} on {{appointment_date}} at {{appointment_time}}.\n\nIf you cannot make it, please contact {{business_name}} on {{business_phone}}.' },
      SMS: { body: 'Reminder from {{business_name}}: {{service_name}} on {{appointment_date}} at {{appointment_time}}. Cannot make it? {{business_phone}}' },
      WHATSAPP: { body: 'Reminder from {{business_name}}: your {{service_name}} for {{vehicle}} is on {{appointment_date}} at {{appointment_time}}. Cannot make it? {{business_phone}}' },
    },
  }),
  BOOKING_RESCHEDULED: def({
    key: 'BOOKING_RESCHEDULED', label: 'Booking moved', category: 'BOOKING', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: [...BOOKING_VARS, 'previous_appointment'], withLink: false,
    defaults: {
      EMAIL: { subject: 'Your booking at {{business_name}} was moved', body: 'Your {{service_name}} appointment for {{vehicle}} was moved from {{previous_appointment}} to {{appointment_date}} at {{appointment_time}}.\n\nIf this time does not suit you, please contact {{business_name}}.' },
      SMS: { body: '{{business_name}}: your {{service_name}} was moved to {{appointment_date}} at {{appointment_time}}. Does not suit? {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: your {{service_name}} for {{vehicle}} was moved from {{previous_appointment}} to {{appointment_date}} at {{appointment_time}}. Does not suit? {{business_phone}}' },
    },
  }),
  BOOKING_CANCELLED: def({
    key: 'BOOKING_CANCELLED', label: 'Booking cancelled', category: 'BOOKING', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: BOOKING_VARS, withLink: false,
    defaults: {
      EMAIL: { subject: 'Your booking at {{business_name}} was cancelled', body: 'Your {{service_name}} appointment for {{vehicle}} on {{appointment_date}} was cancelled.\n\nPlease contact {{business_name}} if you would like to book another time.' },
      SMS: { body: '{{business_name}}: your {{service_name}} on {{appointment_date}} was cancelled. To rebook: {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: your {{service_name}} for {{vehicle}} on {{appointment_date}} was cancelled. To rebook: {{business_phone}}' },
    },
  }),
  BOOKING_NO_SHOW: def({
    key: 'BOOKING_NO_SHOW', label: 'Missed appointment', category: 'BOOKING', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: BOOKING_VARS, withLink: false,
    defaults: {
      EMAIL: { subject: 'We missed you at {{business_name}}', body: 'You did not arrive for your {{service_name}} appointment on {{appointment_date}}.\n\nPlease contact {{business_name}} on {{business_phone}} if you would like to book a new time.' },
      SMS: { body: '{{business_name}}: we missed you on {{appointment_date}}. To rebook: {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: we missed you for your {{service_name}} on {{appointment_date}}. To rebook: {{business_phone}}' },
    },
  }),

  // ── job updates (each one is switched on by the business) ──
  JOB_CHECKED_IN: def({
    key: 'JOB_CHECKED_IN', label: 'Vehicle checked in', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Your {{vehicle}} has been checked in', body: '{{business_name}} has checked in your {{vehicle}} (job {{job_number}}). We will keep you updated.\n\nYou can follow the job here: {{secure_link}}' },
      SMS: { body: '{{business_name}}: your {{vehicle}} is checked in (job {{job_number}}). Follow it: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: your {{vehicle}} is checked in (job {{job_number}}). Follow it: {{secure_link}}' },
    },
  }),
  JOB_DIAGNOSIS_COMPLETE: def({
    key: 'JOB_DIAGNOSIS_COMPLETE', label: 'Diagnosis complete', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Diagnosis complete for your {{vehicle}}', body: 'The diagnosis for your {{vehicle}} (job {{job_number}}) is complete. {{business_name}} will be in touch about the next steps.\n\nView the report: {{secure_link}}' },
      SMS: { body: '{{business_name}}: diagnosis complete for your {{vehicle}}. Details: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: diagnosis complete for your {{vehicle}}. Details: {{secure_link}}' },
    },
  }),
  JOB_WORK_APPROVED: def({
    key: 'JOB_WORK_APPROVED', label: 'Work approved', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'We have your go-ahead for the {{vehicle}}', body: 'Thank you. {{business_name}} has recorded your approval for the work on your {{vehicle}} (job {{job_number}}) and will get started.' },
      SMS: { body: '{{business_name}}: thank you, work approved on your {{vehicle}} (job {{job_number}}).' },
      WHATSAPP: { body: '{{business_name}}: thank you, work approved on your {{vehicle}} (job {{job_number}}).' },
    },
  }),
  JOB_WORK_STARTED: def({
    key: 'JOB_WORK_STARTED', label: 'Work started', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Work has started on your {{vehicle}}', body: '{{business_name}} has started work on your {{vehicle}} (job {{job_number}}).\n\nFollow progress: {{secure_link}}' },
      SMS: { body: '{{business_name}}: work has started on your {{vehicle}}. Follow it: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: work has started on your {{vehicle}}. Follow it: {{secure_link}}' },
    },
  }),
  JOB_AWAITING_PARTS: def({
    key: 'JOB_AWAITING_PARTS', label: 'Waiting for parts', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Waiting for parts: your {{vehicle}}', body: 'The work on your {{vehicle}} (job {{job_number}}) is waiting for parts to arrive. {{business_name}} will let you know as soon as work continues.' },
      SMS: { body: '{{business_name}}: your {{vehicle}} is waiting for parts. We will update you when work continues.' },
      WHATSAPP: { body: '{{business_name}}: your {{vehicle}} is waiting for parts. We will update you when work continues.' },
    },
  }),
  JOB_READY_FOR_COLLECTION: def({
    key: 'JOB_READY_FOR_COLLECTION', label: 'Ready for collection', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Your {{vehicle}} is ready for collection', body: 'Good news: your {{vehicle}} (job {{job_number}}) is ready for collection from {{business_name}}.\n\nQuestions? Call {{business_phone}}.\n\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: your {{vehicle}} is ready for collection. Questions? {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: your {{vehicle}} is ready for collection. Questions? {{business_phone}}' },
    },
  }),
  JOB_COMPLETED: def({
    key: 'JOB_COMPLETED', label: 'Job completed', category: 'JOB_UPDATES', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: JOB_VARS, withLink: true,
    defaults: {
      EMAIL: { subject: 'Job {{job_number}} is complete', body: 'The work on your {{vehicle}} (job {{job_number}}) is complete. Thank you for choosing {{business_name}}.\n\nYour job summary: {{secure_link}}' },
      SMS: { body: '{{business_name}}: the work on your {{vehicle}} is complete. Summary: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: the work on your {{vehicle}} is complete. Summary: {{secure_link}}' },
    },
  }),

  // ── money ──
  QUOTE_SENT: def({
    key: 'QUOTE_SENT', label: 'Quote sent', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['quote_number', 'quote_total', 'valid_until', 'secure_link'], withLink: true,
    defaults: {
      EMAIL: { subject: 'Quote {{quote_number}} from {{business_name}}', body: '{{business_name}} has sent you quote {{quote_number}} for {{quote_total}}. It is valid until {{valid_until}}.\n\nYou can review it and approve, decline or ask for changes online:\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: quote {{quote_number}} for {{quote_total}}. Review: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: quote {{quote_number}} for {{quote_total}}. Review and respond: {{secure_link}}' },
    },
  }),
  QUOTE_DECISION: def({
    key: 'QUOTE_DECISION', label: 'Quote decision received', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: [], vars: ['quote_number', 'decision'], withLink: false,
    defaults: { EMAIL: { subject: 'Quote {{quote_number}}: {{decision}}', body: 'We recorded that your response to quote {{quote_number}} from {{business_name}} is: {{decision}}.\n\nIf that is not right, please contact {{business_name}} on {{business_phone}}.' } },
  }),
  QUOTE_EXPIRING: def({
    key: 'QUOTE_EXPIRING', label: 'Quote expiring', category: 'PAYMENT_REMINDERS', mandatory: false, audience: 'customer', channels: ['SMS'], vars: ['quote_number', 'quote_total', 'valid_until', 'secure_link'], withLink: true,
    defaults: {
      EMAIL: { subject: 'Quote {{quote_number}} expires soon', body: 'Quote {{quote_number}} from {{business_name}} ({{quote_total}}) is valid until {{valid_until}}.\n\nTo go ahead, or to ask for changes:\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: quote {{quote_number}} expires {{valid_until}}. {{secure_link}}' },
    },
  }),
  INVOICE_SENT: def({
    key: 'INVOICE_SENT', label: 'Invoice sent', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['invoice_number', 'invoice_total', 'due_date', 'secure_link'], withLink: true,
    defaults: {
      EMAIL: { subject: 'Invoice {{invoice_number}} from {{business_name}}', body: '{{business_name}} has sent you invoice {{invoice_number}} for {{invoice_total}}, due {{due_date}}.\n\nYou can view it, download the PDF and see how to pay online:\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: invoice {{invoice_number}} for {{invoice_total}}, due {{due_date}}. View: {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: invoice {{invoice_number}} for {{invoice_total}}, due {{due_date}}. View and pay: {{secure_link}}' },
    },
  }),
  INVOICE_REMINDER: def({
    key: 'INVOICE_REMINDER', label: 'Invoice reminder', category: 'PAYMENT_REMINDERS', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['invoice_number', 'amount_due', 'due_date', 'due_phrase', 'secure_link'], withLink: true,
    defaults: {
      EMAIL: { subject: 'Reminder: invoice {{invoice_number}} {{due_phrase}}', body: 'Invoice {{invoice_number}} from {{business_name}} ({{amount_due}} outstanding) {{due_phrase}}.\n\nIf you have already paid, thank you; please ignore this message.\n\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: invoice {{invoice_number}} ({{amount_due}}) {{due_phrase}}. {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: invoice {{invoice_number}} ({{amount_due}}) {{due_phrase}}. {{secure_link}}' },
    },
  }),
  INVOICE_OVERDUE: def({
    key: 'INVOICE_OVERDUE', label: 'Invoice overdue', category: 'PAYMENT_REMINDERS', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['invoice_number', 'amount_due', 'due_date', 'secure_link'], withLink: true,
    defaults: {
      EMAIL: { subject: 'Invoice {{invoice_number}} is overdue', body: 'Invoice {{invoice_number}} from {{business_name}} was due on {{due_date}} and {{amount_due}} is still outstanding.\n\nIf you have already paid, thank you; please ignore this message.\n\n{{secure_link}}' },
      SMS: { body: '{{business_name}}: invoice {{invoice_number}} is overdue ({{amount_due}}). {{secure_link}}' },
      WHATSAPP: { body: '{{business_name}}: invoice {{invoice_number}} is overdue ({{amount_due}}). {{secure_link}}' },
    },
  }),
  PAYMENT_RECEIVED: def({
    key: 'PAYMENT_RECEIVED', label: 'Payment received', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['payment_amount', 'receipt_number', 'invoice_number', 'remaining_balance'], withLink: false,
    defaults: {
      EMAIL: { subject: 'Payment received by {{business_name}}', body: '{{business_name}} received your payment of {{payment_amount}}. Receipt {{receipt_number}} has been issued.' },
      SMS: { body: '{{business_name}}: payment of {{payment_amount}} received. Receipt {{receipt_number}}. Thank you.' },
      WHATSAPP: { body: '{{business_name}}: payment of {{payment_amount}} received. Receipt {{receipt_number}}. Thank you.' },
    },
  }),
  PAYMENT_FAILED: def({
    key: 'PAYMENT_FAILED', label: 'Payment did not go through', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: [], vars: ['invoice_number', 'secure_link'], withLink: true,
    defaults: { EMAIL: { subject: 'Your payment for invoice {{invoice_number}} did not go through', body: 'Your online payment to {{business_name}} for invoice {{invoice_number}} was not completed. No money has been taken. You can try again or pay another way.\n\n{{secure_link}}' } },
  }),
  CREDIT_NOTE_ISSUED: def({
    key: 'CREDIT_NOTE_ISSUED', label: 'Credit note issued', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: [], vars: ['credit_note_number', 'invoice_number', 'credit_note_total'], withLink: false,
    defaults: { EMAIL: { subject: 'Credit note {{credit_note_number}} from {{business_name}}', body: '{{business_name}} has issued credit note {{credit_note_number}} for {{credit_note_total}} against invoice {{invoice_number}}.' } },
  }),
  REFUND_PROCESSED: def({
    key: 'REFUND_PROCESSED', label: 'Refund processed', category: 'FINANCIAL', mandatory: true, audience: 'customer', channels: [], vars: ['refund_amount', 'reason'], withLink: false,
    defaults: { EMAIL: { subject: 'Refund from {{business_name}}', body: '{{business_name}} has recorded a refund of {{refund_amount}} to you. Reason: {{reason}}.' } },
  }),

  // ── service reminders ──
  SERVICE_REMINDER: def({
    key: 'SERVICE_REMINDER', label: 'Service reminder', category: 'SERVICE_REMINDERS', mandatory: false, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['vehicle', 'vehicle_registration', 'vehicle_make', 'vehicle_model', 'service_name', 'service_due'], withLink: false,
    defaults: {
      EMAIL: { subject: 'Service due for your {{vehicle}}', body: 'Your {{vehicle}} is due for its {{service_name}} {{service_due}}.\n\nTo book, contact {{business_name}} on {{business_phone}}.' },
      SMS: { body: '{{business_name}}: your {{vehicle}} is due for its {{service_name}} {{service_due}}. To book: {{business_phone}}' },
      WHATSAPP: { body: '{{business_name}}: your {{vehicle}} is due for its {{service_name}} {{service_due}}. To book: {{business_phone}}' },
    },
  }),

  // ── suppliers ──
  PURCHASE_ORDER_SENT: def({
    key: 'PURCHASE_ORDER_SENT', label: 'Purchase order to supplier', category: 'SUPPLIER', mandatory: true, audience: 'supplier', channels: [], vars: ['purchase_order_number', 'supplier_name', 'order_lines', 'order_total', 'expected_date', 'deliver_to', 'note'], withLink: false,
    defaults: { EMAIL: { subject: 'Purchase order {{purchase_order_number}} from {{business_name}}', body: '{{business_name}} would like to order the following (purchase order {{purchase_order_number}}):\n\n{{order_lines}}\n\nOrder total: {{order_total}}\nDeliver to: {{deliver_to}}. Expected by {{expected_date}}.\n\n{{note}}\n\nThe purchase order is attached as a PDF. Please quote the purchase order number on your delivery note and invoice.' } },
  }),

  // ── scheduled reports (to staff, by email, with the report attached) ──
  REPORT_DELIVERY: def({
    key: 'REPORT_DELIVERY', label: 'Scheduled report', category: 'REPORTS', mandatory: true, audience: 'staff', channels: [], vars: ['report_name', 'report_period'], withLink: false,
    defaults: { EMAIL: { subject: '{{report_name}} from {{business_name}}', body: 'Your scheduled report "{{report_name}}" for {{report_period}} is attached.\n\nIt only contains what your role in {{business_name}} lets you see. To change or stop this schedule, open Reports in TFME Auto.' } },
  }),

  // ── written by a person ──
  MANUAL_MESSAGE: def({
    key: 'MANUAL_MESSAGE', label: 'Message from the workshop', category: 'MANUAL', mandatory: true, audience: 'customer', channels: ['SMS', 'WHATSAPP'], vars: ['vehicle', 'job_number', 'quote_number', 'invoice_number'], withLink: false,
    defaults: {
      EMAIL: { subject: 'A message from {{business_name}}', body: '{{note}}' },
      SMS: { body: '{{business_name}}: {{note}}' },
      WHATSAPP: { body: '{{business_name}}: {{note}}' },
    },
  }),
} as const satisfies Record<string, EventDef>;

export type EventKey = keyof typeof EVENTS;
export const EVENT_KEYS = Object.keys(EVENTS) as EventKey[];
export const isEventKey = (k: string): k is EventKey => Object.prototype.hasOwnProperty.call(EVENTS, k);

/** The variables an event's templates may use. */
export function allowedVariables(key: EventKey): string[] {
  const e = EVENTS[key] as EventDef;
  const extra = key === 'MANUAL_MESSAGE' ? ['note'] : [];
  return [...new Set([...GLOBAL_VARS, ...e.vars, ...extra, ...(e.withLink ? ['secure_link'] : [])])];
}

/** Customer-facing job updates a business can switch on. */
export const JOB_UPDATE_EVENTS = EVENT_KEYS.filter((k) => EVENTS[k].category === 'JOB_UPDATES');

// ───────── internal (staff) notification events ─────────

/** In-app notification types: one consistent model instead of strings scattered through the code. */
export const NotificationTypes = {
  JOB_ASSIGNED: 'JOB_ASSIGNED',
  JOB_STATUS_CHANGED: 'JOB_STATUS_CHANGED',
  QUOTE_APPROVED: 'QUOTE_APPROVED',
  QUOTE_DECLINED: 'QUOTE_DECLINED',
  QUOTE_CHANGES_REQUESTED: 'QUOTE_CHANGES_REQUESTED',
  INVOICE_PAID: 'INVOICE_PAID',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_CHANGED: 'BOOKING_CHANGED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  LOW_STOCK: 'LOW_STOCK',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  PO_APPROVED: 'PO_APPROVED',
  PO_RECEIVED: 'PO_RECEIVED',
  PO_PARTIALLY_RECEIVED: 'PO_PARTIALLY_RECEIVED',
  PO_DAMAGED: 'PO_DAMAGED',
  PO_LATE: 'PO_LATE',
  EMPLOYEE_INVITED: 'EMPLOYEE_INVITED',
  EMPLOYEE_ROLE_CHANGED: 'EMPLOYEE_ROLE_CHANGED',
  SERVICE_REMINDER: 'SERVICE_REMINDER',
  SECURITY_ALERT: 'SECURITY_ALERT',
  TRIAL_ENDING: 'TRIAL_ENDING',
  SUBSCRIPTION_PAYMENT_FAILED: 'SUBSCRIPTION_PAYMENT_FAILED',
  JOB_UNASSIGNED: 'JOB_UNASSIGNED',
  JOB_PART_UNAVAILABLE: 'JOB_PART_UNAVAILABLE',
  PO_NEEDS_APPROVAL: 'PO_NEEDS_APPROVAL',
  PO_REJECTED: 'PO_REJECTED',
  TRANSFER_REQUESTED: 'TRANSFER_REQUESTED',
  TRANSFER_APPROVED: 'TRANSFER_APPROVED',
  TRANSFER_SHIPPED: 'TRANSFER_SHIPPED',
  TRANSFER_RECEIVED: 'TRANSFER_RECEIVED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  TECHNICIAN_DEACTIVATED: 'TECHNICIAN_DEACTIVATED',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  SUBSCRIPTION_STATUS_CHANGED: 'SUBSCRIPTION_STATUS_CHANGED',
  DOCUMENT_READY: 'DOCUMENT_READY',
  MESSAGE_FAILED: 'MESSAGE_FAILED',
  REPORT_FAILED: 'REPORT_FAILED',
  IMPORT_FINISHED: 'IMPORT_FINISHED',
} as const;
export type NotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes];

export interface InternalEventDef {
  type: NotificationType;
  label: string;
  /** Who is told by default: people holding this permission. */
  permission: import('@/server/permissions/catalog').Permission;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  /** Repetitive low-priority events of this kind fold into one notification instead of piling up. */
  group: boolean;
}

/** The internal events a business can tune (who hears about them). Security and billing alerts are not here: nobody can switch them off. */
export const INTERNAL_EVENTS: Partial<Record<NotificationType, InternalEventDef>> = {
  LOW_STOCK: { type: 'LOW_STOCK', label: 'Low stock', permission: 'inventory.edit', priority: 'NORMAL', group: true },
  OUT_OF_STOCK: { type: 'OUT_OF_STOCK', label: 'Out of stock', permission: 'inventory.purchase', priority: 'HIGH', group: false },
  PO_APPROVED: { type: 'PO_APPROVED', label: 'Purchase order approved', permission: 'inventory.purchase', priority: 'NORMAL', group: false },
  PO_RECEIVED: { type: 'PO_RECEIVED', label: 'Delivery received', permission: 'inventory.purchase', priority: 'NORMAL', group: false },
  PO_LATE: { type: 'PO_LATE', label: 'Purchase order late', permission: 'inventory.purchase', priority: 'NORMAL', group: true },
  QUOTE_APPROVED: { type: 'QUOTE_APPROVED', label: 'Quote approved', permission: 'quote.view', priority: 'HIGH', group: false },
  QUOTE_DECLINED: { type: 'QUOTE_DECLINED', label: 'Quote declined', permission: 'quote.view', priority: 'NORMAL', group: false },
  INVOICE_PAID: { type: 'INVOICE_PAID', label: 'Invoice paid', permission: 'payment.view', priority: 'NORMAL', group: false },
  PAYMENT_FAILED: { type: 'PAYMENT_FAILED', label: 'Customer payment failed', permission: 'payment.view', priority: 'HIGH', group: false },
  BOOKING_CREATED: { type: 'BOOKING_CREATED', label: 'New booking', permission: 'booking.manage', priority: 'NORMAL', group: true },
  BOOKING_CHANGED: { type: 'BOOKING_CHANGED', label: 'Booking changed', permission: 'booking.manage', priority: 'NORMAL', group: true },
  BOOKING_CANCELLED: { type: 'BOOKING_CANCELLED', label: 'Booking cancelled', permission: 'booking.manage', priority: 'NORMAL', group: false },
  JOB_STATUS_CHANGED: { type: 'JOB_STATUS_CHANGED', label: 'Job status changed', permission: 'job.assign', priority: 'LOW', group: true },
  MESSAGE_FAILED: { type: 'MESSAGE_FAILED', label: 'A customer message failed', permission: 'notification.view_history', priority: 'HIGH', group: true },
};
