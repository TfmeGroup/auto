import type { IconName } from './icons';
import type { Permission } from '@/server/permissions/catalog';

/**
 * The one place navigation is defined. A module adds its entry here when it is
 * actually built (Part 2+: Vehicles, Bookings, Jobs, Quotes, Invoices, Payments,
 * Inventory, Suppliers, Employees, Documents, Reports). Entries are filtered by
 * permission on the server, so users never see links they cannot use.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  /** Visible if the user holds ANY of these (omit = everyone). */
  permission?: Permission[];
  /** Pinned to the mobile bottom bar (max 4); the rest live under "More". */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: 'dashboard', primary: true },
  { label: 'My jobs', href: '/my-jobs', icon: 'wrench', permission: ['job.inspect'], primary: true },
  { label: 'Jobs', href: '/jobs', icon: 'jobs', permission: ['job.view'], primary: true },
  { label: 'Bookings', href: '/bookings', icon: 'calendar', permission: ['booking.view'], primary: true },
  { label: 'Customers', href: '/customers', icon: 'customers', permission: ['customer.view'], primary: true },
  { label: 'Vehicles', href: '/vehicles', icon: 'car', permission: ['vehicle.view'] },
  { label: 'Quotes', href: '/quotes', icon: 'quote', permission: ['quote.view'] },
  { label: 'Invoices', href: '/invoices', icon: 'invoice', permission: ['invoice.view'] },
  { label: 'Payments', href: '/payments', icon: 'payment', permission: ['payment.view'] },
  { label: 'Finance', href: '/finance', icon: 'finance', permission: ['finance.view_reports'] },
  { label: 'Reports', href: '/reports', icon: 'finance', permission: ['report.view'] },
  { label: 'Stock', href: '/inventory', icon: 'stock', permission: ['inventory.view'] },
  { label: 'Orders', href: '/purchase-orders', icon: 'cart', permission: ['inventory.purchase', 'inventory.receive'] },
  { label: 'Documents', href: '/documents', icon: 'folder', permission: ['document.view'] },
  { label: 'Messages', href: '/communications', icon: 'message', permission: ['notification.view_history'] },
  { label: 'Team', href: '/team', icon: 'team', permission: ['employee.view'] },
  { label: 'Time', href: '/team/time', icon: 'clock', permission: ['time.record'] },
  { label: 'Audit log', href: '/audit', icon: 'audit', permission: ['audit.view'] },
  { label: 'Admin', href: '/admin', icon: 'settings', permission: ['admin.view'] },
  { label: 'Billing', href: '/settings/billing', icon: 'billing', permission: ['settings.manage_billing'] },
  { label: 'Settings', href: '/settings', icon: 'settings', permission: ['settings.view', 'business.view', 'booking.manage'] },
  { label: 'My account', href: '/account', icon: 'lock' },
];

export interface QuickCreateItem {
  label: string;
  href: string;
  permission: Permission;
}

export const QUICK_CREATE: QuickCreateItem[] = [
  { label: 'New job (walk-in)', href: '/jobs/new', permission: 'job.create' },
  { label: 'New booking', href: '/bookings/new', permission: 'booking.create' },
  { label: 'New customer', href: '/customers/new', permission: 'customer.create' },
  { label: 'New vehicle', href: '/vehicles/new', permission: 'vehicle.create' },
  { label: 'New quote', href: '/quotes/new', permission: 'quote.create' },
  { label: 'New invoice', href: '/invoices/new', permission: 'invoice.create' },
  { label: 'Record payment', href: '/payments/new', permission: 'payment.create' },
  { label: 'Find or scan a part', href: '/inventory/scan', permission: 'inventory.view' },
  { label: 'New purchase order', href: '/purchase-orders/new', permission: 'inventory.purchase' },
];
