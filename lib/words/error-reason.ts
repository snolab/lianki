/**
 * What a failed /words request tells the learner: one of four short reasons
 * (words-status.content.ts `reason*`), never the server's error code, an HTTP
 * status or the browser's own text ("Failed to fetch"). The raw failure goes to
 * the dev log only (lib/debug-client.ts devLog).
 */
import { devLog } from "@/lib/debug-client";

/** A request the server answered with an error: its status and `error` code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code || `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/** The request never reached the server: no network. */
export class OfflineError extends Error {
  constructor() {
    super("offline");
    this.name = "OfflineError";
  }
}

export type ErrorReason = "offline" | "signIn" | "notFound" | "tryAgain";

/** The reason a failure shows as; logs the raw failure for developers. */
export function reasonOf(e: unknown, where = "words"): ErrorReason {
  const reason = classify(e);
  devLog({
    ev: "words.error",
    where,
    reason,
    ...(e instanceof ApiError ? { status: e.status, code: e.code } : {}),
    message: String((e as Error)?.message ?? e).slice(0, 200),
  });
  return reason;
}

function classify(e: unknown): ErrorReason {
  if (e instanceof OfflineError) return "offline";
  if (e instanceof ApiError) {
    if (e.status === 401) return "signIn";
    if (e.status === 404) return "notFound";
    return "tryAgain";
  }
  // fetch() itself failed: a TypeError ("Failed to fetch", "Load failed").
  if (e instanceof TypeError) return "offline";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return "tryAgain";
}

/** The dictionary keys of the reasons (words-status.content.ts). */
export const REASON_KEY = {
  offline: "reasonOffline",
  signIn: "reasonSignIn",
  notFound: "reasonNotFound",
  tryAgain: "reasonTryAgain",
} as const satisfies Record<ErrorReason, string>;

/** A reason as text, from the words-status dictionary (useIntlayer or getIntlayer). */
export function reasonText(
  text: Record<(typeof REASON_KEY)[ErrorReason], { value: string } | string>,
  reason: ErrorReason,
): string {
  const v = text[REASON_KEY[reason]];
  return typeof v === "string" ? v : v.value;
}
