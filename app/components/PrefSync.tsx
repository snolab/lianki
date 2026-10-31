"use client";

import { useEffect } from "react";

/**
 * Keeps this device's settings in step with the account (docs/prefs-sync.md).
 * Renders nothing. Signed out, it does nothing: the settings stay on the
 * device as before, and the first sign-in carries them over.
 */
export function PrefSync({ signedIn }: { signedIn: boolean }) {
  useEffect(() => {
    if (!signedIn) return;
    void import("@/lib/prefs/client").then((m) => m.startPrefSync());
  }, [signedIn]);
  return null;
}
