/**
 * Does the page hold something a reload or leaving would throw away?
 * (docs/ui-state.md, "Unsaved work".) Two questions, one answer each:
 *
 * - "reload" (NewVersionNotice: may a debug device pick up a deploy now?):
 *   strict. Also dirty while a field has focus (he is typing), and while the
 *   mic is on.
 * - "leave" (LeaveGuard: may he go to another page or panel without a
 *   confirm?): unsaved content only, so no false alarms. Focus alone, the
 *   chat (its draft is kept across pages), the mic, search boxes and fields
 *   marked `data-dirty="skip"` (filters, inputs that save at once) never count.
 *
 * A text field counts once the user typed in it (a trusted `input` event,
 * seen by trackEdits) and its value differs from what it held before — so a
 * React-controlled field, whose DOM default always equals its value, works,
 * and typing then deleting is clean again. A form's `submit` makes its fields
 * clean; markClean() does so for a save done by a button outside a form.
 * Components add their own checks with registerDirtyCheck (@lianki/ui-state/dirty).
 *
 * Fields inside `data-dirty="persisted"` never count, in either mode: what is
 * typed there is already saved (the chat's draft, kept in sessionStorage by
 * ui-store.ts), so neither a reload nor leaving loses it. The owner's rule,
 * 2026-11-02.
 */
import { type DirtyMode, anyDirtyCheck, notifyDirty, onDirtyNotify } from "@lianki/ui-state/dirty";

export { confirmLeave, notifyDirty, registerDirtyCheck } from "@lianki/ui-state/dirty";
export type { DirtyCheck, DirtyMode } from "@lianki/ui-state/dirty";

/** The slice of an element read here (the DOM's, or a test's fake). */
export type FieldLike = {
  tagName: string;
  type?: string;
  value?: string;
  defaultValue?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  closest?(selector: string): unknown;
  shadowRoot?: { activeElement: FieldLike | null } | null;
  form?: { elements: ArrayLike<unknown> } | null;
  elements?: ArrayLike<unknown>;
};
export type DocLike = {
  activeElement: FieldLike | null;
  querySelectorAll(selector: string): ArrayLike<FieldLike>;
  addEventListener(type: string, f: (e: EventLike) => void, capture?: boolean): void;
  removeEventListener(type: string, f: (e: EventLike) => void, capture?: boolean): void;
};
export type EventLike = { target: unknown; isTrusted?: boolean };

/** Inputs whose text a user types (not buttons, boxes, ranges, files or hidden ones). */
const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
export const FIELDS = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

type Edit = { base: string; edited: boolean };
const KEY = "__lkFieldEdits";
/** Per field: its value before editing, and whether it was typed in. Shared by every copy of this module. */
function edits(): WeakMap<object, Edit> {
  const g = globalThis as unknown as Record<string, WeakMap<object, Edit> | undefined>;
  return (g[KEY] ??= new WeakMap());
}

const editable = (el: FieldLike) =>
  el.tagName === "TEXTAREA" || el.tagName === "INPUT" || !!el.isContentEditable;
const textOf = (el: FieldLike) =>
  el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el.value ?? "") : (el.textContent ?? "");

/** A field a user can type in: a text input, a textarea or contenteditable, not hidden/readonly/disabled. */
export function isTextField(el: FieldLike): boolean {
  if (el.tagName === "INPUT") {
    if (!TEXT_TYPES.has((el.type ?? "").toLowerCase())) return false;
  } else if (el.tagName !== "TEXTAREA" && !el.isContentEditable) return false;
  if (el.readOnly || el.disabled) return false;
  if (el.getAttribute("hidden") !== null || el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

/** Inside `data-dirty="persisted"`: what is typed is already kept (sessionStorage), never dirty. */
export function isPersisted(el: FieldLike): boolean {
  return !!el.closest?.('[data-dirty="persisted"]');
}

/** A search box or filter, or marked to be skipped: never unsaved work. */
export function isSkipped(el: FieldLike): boolean {
  if ((el.type ?? "").toLowerCase() === "search") return true;
  if (el.getAttribute("role") === "searchbox") return true;
  if (el.getAttribute("enterkeyhint") === "search") return true;
  return !!el.closest?.('[data-dirty="skip"]');
}

/** Typed in and changed from what it held before. */
export function fieldChanged(el: FieldLike): boolean {
  const e = edits().get(el);
  return !!e?.edited && textOf(el) !== e.base;
}

/** The focused element, through open shadow roots. */
function focused(doc: DocLike): FieldLike | null {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

type MicLike = { view(): { state: string; pending?: number } };
/** The mic is on (or transcripts are still out): a reload turns it off, and it needs a tap to come back. */
export function micBusy(g: object = globalThis): boolean {
  const m = (g as Record<string, MicLike | undefined>).__lkMic;
  try {
    const v = m?.view?.();
    return !!v && (v.state !== "off" || (v.pending ?? 0) > 0);
  } catch {
    return false;
  }
}

/** Does the page hold unsaved work? See the file's header for the two modes. */
export function pageIsDirty(
  doc: DocLike,
  mode: DirtyMode = "reload",
  g: object = globalThis,
): boolean {
  const active = focused(doc);
  if (mode === "reload" && active && isTextField(active) && !isPersisted(active)) {
    // A focused search box only counts when something is typed in it.
    if (!isSkipped(active) || textOf(active) !== "") return true;
  }
  const all = doc.querySelectorAll(FIELDS);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isTextField(el) || isPersisted(el)) continue;
    if (isSkipped(el)) {
      // A search box or filter: only a reload loses what is typed in it.
      if (mode === "reload" && fieldChanged(el)) return true;
      continue;
    }
    if (fieldChanged(el)) return true;
  }
  if (anyDirtyCheck(mode)) return true;
  if (mode === "reload" && micBusy(g)) return true;
  return false;
}

/** Forget edits to these fields: a form was saved. */
export function markClean(fields?: ArrayLike<unknown>): void {
  const m = edits();
  if (!fields) {
    (globalThis as Record<string, unknown>)[KEY] = new WeakMap();
  } else for (let i = 0; i < fields.length; i++) m.delete(fields[i] as object);
  notifyDirty();
}

/**
 * Follow what the user types: a field's value is kept on focus (before he
 * types), a trusted `input` marks it edited, a form's `submit` makes its
 * fields clean. Returns the stop.
 */
export function trackEdits(doc: DocLike): () => void {
  const asField = (t: unknown) =>
    t && typeof t === "object" && "tagName" in t && editable(t as FieldLike)
      ? (t as FieldLike)
      : null;
  const onFocus = (e: EventLike) => {
    const el = asField(e.target);
    if (el && !edits().has(el)) edits().set(el, { base: textOf(el), edited: false });
  };
  const onInput = (e: EventLike) => {
    const el = asField(e.target);
    if (!el || e.isTrusted === false) return;
    const have = edits().get(el);
    if (have) have.edited = true;
    else edits().set(el, { base: el.defaultValue ?? "", edited: true });
  };
  const onSubmit = (e: EventLike) => {
    const form = e.target as FieldLike | null;
    if (form?.elements) markClean(form.elements);
  };
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("submit", onSubmit, true);
  return () => {
    doc.removeEventListener("focusin", onFocus, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("submit", onSubmit, true);
  };
}

/** What a debug device does when a new build is pushed. */
export type ReloadDecision = "reload" | "wait" | "button";
/**
 * Debug devices pick up a deploy by themselves — at once on a clean page,
 * else as soon as it is clean — but only once per build (`first`: the
 * reload still served the old build means the push beat the rollout).
 * Everyone else gets the button.
 */
export function reloadDecision(o: {
  debug: boolean;
  first: boolean;
  dirty: boolean;
}): ReloadDecision {
  if (!o.debug || !o.first) return "button";
  return o.dirty ? "wait" : "reload";
}

type Subscribable = { subscribe(f: () => void): () => void };
/**
 * Call `onClean` once, the first time the page is clean (mode "reload"),
 * re-checked on the page's own events — input, change, blur, a submit, the
 * tab hidden or shown, the registry's notify, the chat's store and the mic —
 * never on a timer. Returns the stop.
 */
export function whenClean(
  doc: DocLike & { visibilityState?: string },
  onClean: () => void,
  g: object = globalThis,
): () => void {
  let done = false;
  const offs: (() => void)[] = [];
  const stop = () => {
    done = true;
    for (const f of offs.splice(0)) f();
  };
  const check = () => {
    if (done || pageIsDirty(doc, "reload", g)) return;
    stop();
    onClean();
  };
  // A blur's focus moves after the event: look once it has.
  const later = () => void queueMicrotask(check);
  for (const type of ["input", "change", "focusout", "submit"] as const) {
    doc.addEventListener(type, later, true);
    offs.push(() => doc.removeEventListener(type, later, true));
  }
  doc.addEventListener("visibilitychange", check);
  offs.push(() => doc.removeEventListener("visibilitychange", check));
  offs.push(onDirtyNotify(check));
  const sub = (s: Subscribable | undefined) => {
    if (!s?.subscribe) return;
    let first = true;
    // The mic calls back at once on subscribe: that one is not a change.
    const off = s.subscribe(() => (first ? undefined : check()));
    first = false;
    offs.push(off);
  };
  const r = g as Record<string, unknown>;
  sub(r.__lkMic as Subscribable | undefined);
  return stop;
}
