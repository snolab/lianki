// When the reader offers to tidy a raw transcript, and where his answers are
// kept (docs/books-plan.md, "Import pipeline", step 3; docs/prefs-sync.md).
// Pure, apart from the storage helpers at the end.
//
// Owner, 2026-11-06: "dont show", and "when we are still in meeting". The offer
// is a question, so it waits until nothing is being written, and a no sticks:
// for this text on every device, or for all of them from /preferences. The
// action itself stays in the contents sheet, whatever the offer does.
import { notePrefWrite } from "@lianki/ui-state/account";
import type { BookMeta, BookSource } from "./book";

/** On the account (lib/prefs/bindings.ts): "0" turns the offer off everywhere. */
export const OFFER_KEY = "lk:read-polish-offer";
/** On the account: the materials he said no to, oldest first. */
export const SKIPS_KEY = "lk:read-polish-skips";
/** The newest kept (a uuid is about 40 bytes here; the pref's cap is 2 KB). */
export const SKIPS_MAX = 40;
/**
 * A no on this device, one key per material. Still written: it has no cap, so
 * a text that fell off the account's list stays quiet here.
 */
export const deviceSkipKey = (id: string) => `lk:read-polish-skip:${id}`;

/**
 * Sources whose text is never offered the tidy, however it is opened: a /vibe
 * conversation (docs/vibe.md) is private speech, and the tidy sends it to a
 * model. The routes refuse it too (`polishRefused`).
 */
const NEVER_OFFERED = new Set<BookSource>(["vibe"]);

/** The polish routes' check: this text is never sent to the tidy. */
export function polishRefused(book: Pick<BookMeta, "source"> | null | undefined): boolean {
  return !!book && NEVER_OFFERED.has(book.source);
}

export interface OfferState {
  book: Pick<BookMeta, "source" | "shape" | "polished"> | null | undefined;
  /**
   * The page's stream (reader-stream.tsx), null when it follows none. No state
   * means the writing ended: "live" and "connecting" are this page's socket
   * and say nothing about the writer, and "offline" is a socket lost, with the
   * doc perhaps still being written. The stream sends no end, so a page
   * following one never offers, and the next open without it can.
   */
  stream: "connecting" | "live" | "offline" | null;
  /** The /preferences switch. */
  offerOn: boolean;
  /** He said no to this text. */
  skipped: boolean;
}

/** Show the question? Only the detector's verdict calls it a transcript. */
export function offerShown({ book, stream, offerOn, skipped }: OfferState): boolean {
  if (!book?.shape?.raw || book.polished) return false;
  if (NEVER_OFFERED.has(book.source)) return false;
  return stream === null && offerOn && !skipped;
}

/**
 * The sheet's action, offer or no offer, stream or no stream: a text the
 * detector called raw, or any Google Doc (the detector's majorities can miss a
 * transcript he knows is one). Never an edited book, never twice.
 */
export function polishActionShown(book: OfferState["book"]): boolean {
  if (!book || book.polished || NEVER_OFFERED.has(book.source)) return false;
  return !!book.shape?.raw || book.source === "gdoc";
}

/** A stored list (untrusted): the ids that look like ids, the newest SKIPS_MAX. */
export function checkSkips(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x))
    .slice(-SKIPS_MAX);
}

/** The list with this id as the newest, unless it is on it. */
export const withSkip = (skips: readonly string[], id: string): string[] =>
  skips.includes(id) ? [...skips] : [...skips, id].slice(-SKIPS_MAX);

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function put(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    notePrefWrite();
  } catch {
    // a private window: for this visit only
  }
}

export const readOfferOn = () => get(OFFER_KEY) !== "0";
export const writeOfferOn = (on: boolean) => put(OFFER_KEY, on ? "1" : "0");

function readSkips(): string[] {
  try {
    return checkSkips(JSON.parse(get(SKIPS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export const readSkipped = (id: string) =>
  readSkips().includes(id) || get(deviceSkipKey(id)) === "1";

export function writeSkip(id: string) {
  put(deviceSkipKey(id), "1");
  put(SKIPS_KEY, JSON.stringify(withSkip(readSkips(), id)));
}

/** A no said on this device before it followed the account: now it does. */
export function carryDeviceSkip(id: string) {
  if (get(deviceSkipKey(id)) === "1" && !readSkips().includes(id)) writeSkip(id);
}
