"use client";

import { useSyncExternalStore } from "react";
import { reviewReturnShortcut, type ReviewReturnShortcut } from "@/lib/review-ui";

// The browser platform does not change during this document's lifetime.
const subscribe = () => () => {};
const getShortcut = () => reviewReturnShortcut(navigator.userAgent, navigator.maxTouchPoints);
const serverShortcut = () => null;

export function ReviewOpenHint({ desktop, mobile }: { desktop: string; mobile: string }) {
  const shortcut = useSyncExternalStore<ReviewReturnShortcut | null>(
    subscribe,
    getShortcut,
    serverShortcut,
  );
  if (shortcut === null) return null;
  if (shortcut === "back") return mobile;
  const [before, after] = desktop.split("{shortcut}");
  return (
    <>
      {before}
      <kbd dir="ltr">{shortcut}</kbd>
      {after}
    </>
  );
}
