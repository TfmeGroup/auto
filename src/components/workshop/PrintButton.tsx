'use client';

import { Button } from '@/components/ui';

export function PrintButton({ label = 'Print or save as PDF' }: { label?: string }) {
  return <Button type="button" variant="secondary" onClick={() => window.print()}>{label}</Button>;
}
