"use client";

import { useEffect } from "react";
import { useSignedIn } from "./BoxApiBridge";

/**
 * Keeps this device's settings in step with the account (docs/prefs-sync.md).
 * Renders nothing. Signed out, it does nothing: the settings stay on the
 * device as before, and the first sign-in carries them over.
 */
export function PrefSync({ signedIn: server }: { signedIn: boolean }) {
  const signedIn = useSignedIn(server);
  useEffect(() => {
    // Text size applies on every page, signed in or not, and follows a change
    // made in another tab (lib/text-size.ts).
    void import("@/lib/text-size");
    if (!signedIn) return;
    void import("@/lib/prefs/client").then((m) => m.startPrefSync());
  }, [signedIn]);
  return null;
}
