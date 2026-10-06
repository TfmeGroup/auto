'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@/components/ui';

/**
 * Camera barcode scanning as a progressive enhancement. Where the browser offers the BarcodeDetector API and a camera, the video is read and the
 * first code found is handed back; everywhere else (desktop, older browsers, no camera, permission refused) nothing breaks: a hardware scanner or the
 * keyboard types into the normal search box, and this panel says why the camera is not available. No image ever leaves the device.
 */

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: new (opts?: { formats?: string[] }) => Detector }
}

export const cameraScanningSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

export function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function start() {
      if (!cameraScanningSupported()) {
        setError('This browser cannot scan barcodes with the camera. Type or scan the code into the search box instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        setReady(true);
        const detector = new window.BarcodeDetector!({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'itf'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(el);
            const value = found[0]?.rawValue?.trim();
            if (value) { onCode(value); return; }
          } catch {
            // a frame that cannot be read is skipped
          }
          timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site, or type the code instead.' : 'The camera could not be started. Type the code instead.');
      }
    }
    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      {error ? <Alert tone="warn">{error}</Alert> : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video ref={video} muted playsInline className="aspect-[4/3] w-full object-cover" />
          {!ready && <p className="absolute inset-0 grid place-items-center text-sm text-white">Starting camera…</p>}
          <div aria-hidden className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-danger/80" />
        </div>
      )}
      <Button type="button" variant="secondary" onClick={onClose} className="w-full">Close camera</Button>
    </div>
  );
}
