import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import type { BusinessContext } from '@/server/context';

/** Documents and photos on a customer or vehicle: the shared document panel (kept under its old name for the pages that use it). */
export function FilesPanel({ ctx, resourceType, resourceId, archived = false }: { ctx: BusinessContext; resourceType: 'customer' | 'vehicle'; resourceId: string; archived?: boolean }) {
  return <DocumentsPanel ctx={ctx} resourceType={resourceType} resourceId={resourceId} archived={archived} title="Documents & photos" />;
}
