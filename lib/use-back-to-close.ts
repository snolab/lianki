"use client";

import { useEffect, useRef } from "react";
import { type BackOptions, dropOrphan, openBackToClose } from "./back-to-close";

/**
 * While `open`, the browser's or the phone's back calls `close` instead of
 * leaving the page (lib/back-to-close.ts). Closing it any other way consumes
 * its history entry. Changing what the overlay shows while it stays open adds
 * no entry: only `open` turning true does. `opts` (an overlay pinned in the
 * URL) is read when `open` turns true.
 */
export function useBackToClose(open: boolean, close: () => void, opts?: BackOptions) {
  const onBack = useRef(close);
  onBack.current = close;
  const options = useRef(opts);
  options.current = opts;
  useEffect(() => dropOrphan(window), []);
  useEffect(() => {
    if (!open) return;
    return openBackToClose(window, () => onBack.current(), options.current);
  }, [open]);
}
