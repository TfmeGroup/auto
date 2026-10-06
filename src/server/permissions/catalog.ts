/**
 * The permission catalogue is the single source of truth for what can be
 * authorised. Authorization checks always use a permission key — never a role
 * name. Roles are named sets of permissions stored in the database, which is
 * what makes custom roles a data feature rather than a refactor.
 *
 * To add a permission: add it here, decide which system roles get it below, and
 * run `npm run db:migrate` (syncs system roles). Nothing else changes.
 */

export const PERMISSIONS = {
  // Customers
  'customer.view': 'View customers',
  'customer.create': 'Create customers',
  'customer.edit': 'Edit customers',
  'customer.archive': 'Archive customers',
  'customer.delete': 'Delete customers',
  // Vehicles
  'vehicle.view': 'View vehicles',
  'vehicle.create': 'Create vehicles',
  'vehicle.edit': 'Edit vehicles',
  'vehicle.archive': 'Archive vehicles',
  'vehicle.correct_mileage': 'Correct recorded mileage',
  // Jobs
  'job.view': 'View jobs',
  'job.create': 'Create jobs',
  'job.edit': 'Edit jobs',
  'job.assign': 'Assign jobs',
  'job.complete': 'Complete jobs',
  'job.cancel': 'Cancel jobs',
  'job.change_status': 'Move jobs through the workflow',
  'job.override_status': 'Override the job workflow',
  'job.inspect': 'Record inspections, diagnosis and recommended work',
  'job.quality_check': 'Record quality checks',
  'job.approve_work': 'Record customer approval of recommended work',
  'job.view_pricing': 'See part costs, prices and labour rates on jobs',
  // Bookings
  'booking.view': 'View bookings',
  'booking.create': 'Create bookings',
  'booking.edit': 'Edit bookings',
  'booking.cancel': 'Cancel bookings',
  'booking.reschedule': 'Reschedule bookings',
  'booking.manage': 'Manage the booking calendar',
  // Quotes
  'quote.view': 'View quotes',
  'quote.create': 'Create quotes',
  'quote.edit': 'Edit quotes',
  'quote.send': 'Send quotes',
  'quote.approve': 'Approve quotes',
  'quote.cancel': 'Cancel quotes',
  // Invoices
  'invoice.view': 'View invoices',
  'invoice.create': 'Create invoices',
  'invoice.edit': 'Edit invoices',
  'invoice.send': 'Send invoices',
  'invoice.cancel': 'Cancel invoices',
  'invoice.finalise': 'Finalise (issue) invoices',
  'invoice.write_off': 'Write off invoices',
  // Payments
  'payment.view': 'View payments',
  'payment.create': 'Record payments',
  'payment.refund': 'Issue refunds',
  'payment.apply_credit': 'Apply customer credit to invoices',
  'payment.reconcile': 'Reconcile payments',
  // Credit notes
  'credit_note.view': 'View credit notes',
  'credit_note.create': 'Create credit notes',
  'credit_note.authorise': 'Authorise credit notes',
  // Financial reporting and settings
  'finance.view_reports': 'View financial reports',
  'finance.view_costs': 'See costs and profit',
  'finance.export': 'Export financial data',
  'finance.manage_settings': 'Manage payment and document settings',
  // Inventory
  'inventory.view': 'View inventory',
  'inventory.create': 'Add inventory items',
  'inventory.edit': 'Edit inventory',
  'inventory.adjust': 'Adjust stock',
  'inventory.purchase': 'Create purchase orders',
  'inventory.receive': 'Receive stock',
  'inventory.return': 'Return stock to suppliers',
  'inventory.manage_suppliers': 'Add and edit suppliers',
  'inventory.view_costs': 'See part costs, supplier costs and margins',
  'inventory.approve_purchase': 'Approve purchase orders',
  'inventory.transfer': 'Transfer stock between locations',
  'inventory.import': 'Import parts from a file',
  'inventory.export': 'Export inventory data',
  'inventory.manage_settings': 'Manage inventory settings',
  'inventory.negative_stock': 'Allow stock to go below zero',
  // Employees
  'employee.view': 'View team members',
  'employee.invite': 'Invite team members',
  'employee.edit': 'Edit team members',
  'employee.suspend': 'Suspend team members',
  'employee.manage_roles': 'Manage roles and assignments',
  'employee.manage_technicians': 'Manage technician settings, skills and availability',
  'employee.view_reports': 'View technician workload and performance',
  // Labour and time
  'labour.view_rates': 'See labour rates charged to customers',
  'labour.view_costs': 'See what staff time costs the business',
  'labour.manage_rates': 'Change labour rates',
  'time.record': 'Record own time on jobs',
  'time.edit': 'Edit and void time entries',
  'time.view_all': 'View everyone\'s time entries',
  'time.approve': 'Approve time entries',
  // Documents
  'document.view': 'View documents and photos',
  'document.upload': 'Upload documents and photos',
  'document.edit': 'Edit document details',
  'document.delete': 'Remove documents and photos',
  'document.export': 'Export documents',
  'document.download': 'Download and preview documents and photos',
  'document.share': 'Make documents visible to customers',
  'document.view_restricted': 'View documents marked restricted',
  'document.manage': 'Manage business documents, document categories and retention settings',
  'document.manage_employee': 'View and manage employee documents',
  'document.purge': 'Permanently delete documents from the trash',
  // Communication
  'notification.view_history': 'View customer communication history',
  'notification.send': 'Send operational messages to customers',
  'notification.manage_templates': 'Manage message templates',
  'notification.manage_settings': 'Manage communication and notification settings',
  'notification.manage_preferences': 'Manage customer communication preferences',
  // Reports
  'report.view': 'View reports',
  'report.export': 'Export reports',
  'report.manage': 'Manage reports and share them business-wide',
  'report.create_custom': 'Create custom reports',
  'report.manage_scheduled': 'Schedule reports',
  // Settings
  'settings.view': 'View settings',
  'settings.edit': 'Edit settings',
  'settings.manage_security': 'Manage business security settings',
  'settings.manage_billing': 'Manage billing and subscription',
  'settings.manage_workshop': 'Manage job, service, vehicle, numbering, labour and booking configuration',
  'location.manage': 'Create, edit and archive locations',
  'data.import': 'Import data from files',
  'security.view_events': 'View security events',
  'admin.view': 'View the administration area',
  // Business
  'business.view': 'View business profile',
  'business.edit': 'Edit business profile',
  'business.export': 'Export business data',
  'business.close': 'Close the business',
  'business.transfer_ownership': 'Transfer ownership',
  // Audit
  'audit.view': 'View audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const isPermission = (v: string): v is Permission => v in PERMISSIONS;

/** Permissions grouped by area ("customer", "invoice", …) for display. */
export function permissionGroups(): Record<string, Permission[]> {
  const out: Record<string, Permission[]> = {};
  for (const p of ALL_PERMISSIONS) (out[p.split('.')[0]!] ??= []).push(p);
  return out;
}

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const group = (prefix: string, except: string[] = []) =>
  ALL_PERMISSIONS.filter((p) => p.startsWith(`${prefix}.`) && !except.includes(p.split('.')[1]!));
const only = (prefix: string, actions: string[]) => actions.map((a) => `${prefix}.${a}` as Permission);

export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control of the business, including billing, security, ownership transfer and closure.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Runs the business day to day, including users and billing. Cannot transfer ownership or close the business.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'business.close' && p !== 'business.transfer_ownership'),
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Oversees the workshop: jobs, bookings, quotes, stock, reports and people.',
    permissions: [
      ...group('customer', ['delete']), ...group('vehicle'), ...group('job'), ...group('booking'),
      ...group('quote'), ...only('invoice', ['view', 'create', 'edit', 'send', 'finalise']), ...only('payment', ['view']),
      ...only('credit_note', ['view', 'create']), 'finance.view_reports',
      ...group('inventory', ['negative_stock']), ...only('employee', ['view', 'invite', 'edit', 'manage_technicians', 'view_reports']),
      ...group('labour', ['manage_rates']), ...group('time'),
      ...group('document', ['purge', 'manage_employee']), ...group('notification'), ...only('report', ['view', 'export', 'create_custom', 'manage_scheduled']),
      'settings.view', 'settings.manage_workshop', 'admin.view', 'business.view', 'audit.view',
    ],
  },
  {
    key: 'technician',
    name: 'Technician',
    description: 'Works on assigned jobs: vehicle details, inspections, diagnosis, parts, labour and photos.',
    permissions: [
      'customer.view', 'vehicle.view', 'vehicle.edit', 'booking.view',
      'job.view', 'job.edit', 'job.complete', 'job.change_status', 'job.inspect', 'inventory.view', 'time.record', 'document.view', 'document.upload', 'document.download',
    ],
  },
  {
    key: 'service_advisor',
    name: 'Service Advisor / Reception',
    description: 'Front desk: customers, vehicles, bookings, jobs, quotes, invoices and taking payments.',
    permissions: [
      ...only('customer', ['view', 'create', 'edit']), ...only('vehicle', ['view', 'create', 'edit']),
      ...group('booking'), ...only('job', ['view', 'create', 'edit', 'assign', 'change_status', 'approve_work', 'view_pricing', 'complete']),
      ...only('quote', ['view', 'create', 'edit', 'send']), ...only('invoice', ['view', 'create', 'edit', 'send']),
      ...only('payment', ['view', 'create']), 'inventory.view', 'labour.view_rates', 'time.record', 'document.view', 'document.upload', 'document.download', 'document.share',
      'notification.view_history', 'notification.send', 'notification.manage_preferences',
    ],
  },
  {
    key: 'inventory_staff',
    name: 'Inventory Staff',
    description: 'Parts, stock, suppliers, purchase orders, receiving and returns.',
    permissions: [...group('inventory', ['negative_stock', 'approve_purchase', 'manage_settings']), 'job.view', 'document.view', 'document.upload', 'document.download'],
  },
  {
    key: 'accounts',
    name: 'Accounts',
    description: 'Quotes, invoices, payments, refunds, financial records and reports.',
    permissions: [
      'customer.view', 'vehicle.view', 'job.view', 'job.view_pricing', ...only('quote', ['view', 'create', 'edit', 'send', 'approve']),
      ...group('invoice'), ...group('payment'), ...group('credit_note'), ...only('report', ['view', 'export']),
      'finance.view_reports', 'finance.view_costs', 'finance.export',
      'inventory.view', 'inventory.view_costs', 'inventory.export', 'labour.view_rates', 'labour.view_costs',
      'document.view', 'document.upload', 'document.download', 'document.share', 'document.export', 'business.view',
      'notification.view_history', 'notification.send',
    ],
  },
];

export const OWNER_ROLE_KEY = 'owner';
