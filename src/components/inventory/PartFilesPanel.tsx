import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import type { BusinessContext } from '@/server/context';

/**
 * Photos and documents attached to a part, supplier, purchase order, delivery or return, through the shared document system (private storage, type and
 * size checks, audit). Photos identify parts for people and are not "recognised" by anything. The phone camera opens directly from the uploader.
 */
export function PartFilesPanel({ ctx, resourceType, resourceId, kind = 'all', title }: { ctx: BusinessContext; resourceType: string; resourceId: string; kind?: 'photos' | 'documents' | 'all'; title?: string }) {
  return (
    <DocumentsPanel
      ctx={ctx} resourceType={resourceType} resourceId={resourceId} kind={kind} title={title}
    />
  );
}
