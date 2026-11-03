"use client";

import { useEffect, useRef } from "react";
import { dropOrphan, openBackToClose } from "./back-to-close";

/**
 * While `open`, the browser's or the phone's back calls `close` instead of
 * leaving the page (lib/back-to-close.ts). Closing it any other way consumes
 * its history entry. Changing what the overlay shows while it stays open adds
 * no entry: only `open` turning true does.
 */
export function useBackToClose(open: boolean, close: () => void) {
  const onBack = useRef(close);
  onBack.current = close;
  useEffect(() => dropOrphan(window), []);
  useEffect(() => {
    if (!open) return;
    return openBackToClose(window, () => onBack.current());
  }, [open]);
}
