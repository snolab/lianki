/**
 * Voice fill for HTML form widgets (owner, 2026-11-26: "告诉你这两个表单分别填什么
 * 然后你就可以在这个表单上帮我填"). He speaks into the normal mic ("first name
 * Sam, last name Sample"); the agent that posted the form answers with a patch:
 *
 *   ```lianki-fill
 *   {"line": "form-line-id", "fields": {"fname": "Sam", "lname": "Sample"}}
 *   ```
 *
 * The chat applies it to that line's form (HtmlInline.tsx) by field name and
 * shows the patch as a small chip that scrolls to the form and flashes the
 * fields it filled. Only agent lines in his own thread carry patches
 * (rich-text.ts widgetLine), and only widget lines in his own thread have forms
 * to fill. A patch never adds fields and never touches hidden, disabled or
 * read-only ones. A fill never submits: sending is always his own tap on the
 * form's Submit button (a `"submit"` key in a patch is ignored).
 */

export const FILL_LANG = "lianki-fill";

export type FillPatch = { line: string; fields: Record<string, string> };

const MAX_SPEC = 8_000;
const MAX_FIELDS = 30;

/** A patch, or null when it is not one (then the block shows as code). */
export function parseFill(spec: string): FillPatch | null {
  if (spec.length > MAX_SPEC) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(spec) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.line !== "string" || !/^[\w-]{1,64}$/.test(v.line)) return null;
  if (!v.fields || typeof v.fields !== "object" || Array.isArray(v.fields)) return null;
  const fields: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v.fields as Record<string, unknown>).slice(0, MAX_FIELDS)) {
    if (!/^[\w.[\]-]{1,40}$/.test(k)) continue;
    if (typeof raw === "string") fields[k] = raw.slice(0, 500);
    else if (typeof raw === "number" && Number.isFinite(raw)) fields[k] = String(raw);
    else if (typeof raw === "boolean") fields[k] = raw ? "on" : "";
  }
  if (!Object.keys(fields).length) return null;
  return { line: v.line, fields };
}

/** A fill for one form: the patch, its own id, and whether this call is only a flash. */
type Listener = (patch: FillPatch, flashOnly: boolean, patchId: string) => void;

/**
 * Patches by target line and a "flash" for the chip's tap-through. A patch
 * line renders and re-renders, and a form remounts (scrolling, a re-render of
 * the log) and gets the fields again. Nothing here ever submits a form.
 */
export function makeFillStore() {
  const listeners = new Map<string, Set<Listener>>();
  const applied = new Set<string>();
  const last = new Map<string, { patch: FillPatch; id: string }>();
  return {
    /** A patch line was rendered: fill its form (once per patch line). */
    apply(patchId: string, patch: FillPatch) {
      last.set(patch.line, { patch, id: patchId });
      if (applied.has(patchId)) return false;
      applied.add(patchId);
      for (const l of listeners.get(patch.line) ?? []) l(patch, false, patchId);
      return true;
    },
    /** The chip was tapped: show the fields again. */
    flash(line: string) {
      const p = last.get(line);
      if (p) for (const l of listeners.get(line) ?? []) l(p.patch, true, p.id);
    },
    /** A form widget listens for its own line; a patch that came before it mounted fills it now. */
    on(line: string, l: Listener): () => void {
      let set = listeners.get(line);
      if (!set) listeners.set(line, (set = new Set()));
      set.add(l);
      const p = last.get(line);
      if (p) l(p.patch, false, p.id);
      return () => set!.delete(l);
    },
  };
}
export type FillStore = ReturnType<typeof makeFillStore>;
export const fillStore = makeFillStore();

/**
 * Fill a form's controls by name. Hidden, disabled, read-only and file inputs
 * are never touched; a name the form does not have is skipped. Returns the
 * elements it changed (to flash them). Values go in through the native setter
 * and an input event, so uncontrolled React inputs and Android keyboards agree.
 */
export function fillForm(root: ParentNode, fields: Record<string, string>): HTMLElement[] {
  const changed: HTMLElement[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const els = [...root.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"]`)];
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      if (effectivelyDisabled(el) || input.readOnly) continue;
      if (tag === "input") {
        const type = (input.type || "text").toLowerCase();
        if (type === "hidden" || type === "file" || type === "submit" || type === "button" || type === "reset") continue;
        if (type === "checkbox" || type === "radio") {
          const want =
            type === "radio" ? input.value === value : value !== "" && value !== "false" && value !== "0";
          if (input.checked !== want) {
            setChecked(input, want);
            changed.push(input);
          }
          continue;
        }
      } else if (tag !== "textarea" && tag !== "select") continue;
      setValue(el as HTMLInputElement, value);
      changed.push(el);
    }
  }
  return changed;
}

/** Disabled itself, or inside a disabled fieldset (where its own `disabled` is still false). */
function effectivelyDisabled(el: HTMLElement): boolean {
  if ((el as HTMLInputElement).disabled) return true;
  if (el.closest("fieldset[disabled]")) return true;
  try {
    return el.matches(":disabled");
  } catch {
    return false;
  }
}

function setValue(el: HTMLInputElement, v: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set) set.call(el, v);
  else el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setChecked(el: HTMLInputElement, v: boolean) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "checked")?.set;
  if (set) set.call(el, v);
  else el.checked = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
