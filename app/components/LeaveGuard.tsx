"use client";

import { useEffect } from "react";
import { type WinLike, installLeaveGuard } from "@/lib/leave-guard";
import type { DocLike } from "@/lib/page-dirty";

/**
 * Every page's guard against leaving a form with unsaved typing (lib/leave-guard.ts):
 * the browser's prompt on close or reload, a confirm on an in-app link.
 * `message` is the confirm's text (leave-guard.content.ts), from the server.
 */
export function LeaveGuard({ message }: { message: string }) {
  useEffect(
    () => installLeaveGuard(window as unknown as WinLike, document as unknown as DocLike, message),
    [message],
  );
  return null;
}
