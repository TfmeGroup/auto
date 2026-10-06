-- In-app notifications now use one registry of types (src/server/notifications/events.ts) instead of free-text strings.
UPDATE notifications SET type = CASE type
  WHEN 'inventory.low_stock' THEN 'LOW_STOCK' WHEN 'purchase_order.late' THEN 'PO_LATE' WHEN 'purchase_order.needs_approval' THEN 'PO_NEEDS_APPROVAL'
  WHEN 'purchase_order.received' THEN 'PO_RECEIVED' WHEN 'purchase_order.partially_received' THEN 'PO_PARTIALLY_RECEIVED' WHEN 'purchase_order.approved' THEN 'PO_APPROVED' WHEN 'purchase_order.rejected' THEN 'PO_REJECTED' WHEN 'stock_transfer.requested' THEN 'TRANSFER_REQUESTED'
  WHEN 'stock_transfer.approved' THEN 'TRANSFER_APPROVED' WHEN 'stock_transfer.shipped' THEN 'TRANSFER_SHIPPED' WHEN 'stock_transfer.received' THEN 'TRANSFER_RECEIVED'
  WHEN 'inventory.job_part_unavailable' THEN 'JOB_PART_UNAVAILABLE' WHEN 'job.assigned' THEN 'JOB_ASSIGNED' WHEN 'job.unassigned' THEN 'JOB_UNASSIGNED'
  WHEN 'member.invite_expired' THEN 'INVITATION_EXPIRED' WHEN 'technician.deactivated' THEN 'TECHNICIAN_DEACTIVATED' WHEN 'quote.expired' THEN 'QUOTE_EXPIRED'
  WHEN 'quote.approve' THEN 'QUOTE_APPROVED' WHEN 'quote.decline' THEN 'QUOTE_DECLINED' WHEN 'quote.request_changes' THEN 'QUOTE_CHANGES_REQUESTED'
  ELSE type END
WHERE type IN ('inventory.low_stock', 'purchase_order.received', 'purchase_order.partially_received', 'purchase_order.late', 'purchase_order.needs_approval', 'purchase_order.approved', 'purchase_order.rejected', 'stock_transfer.requested',
  'stock_transfer.approved', 'stock_transfer.shipped', 'stock_transfer.received', 'inventory.job_part_unavailable', 'job.assigned', 'job.unassigned', 'member.invite_expired',
  'technician.deactivated', 'quote.expired', 'quote.approve', 'quote.decline', 'quote.request_changes');
