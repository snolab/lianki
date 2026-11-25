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
 * read-only ones. Nothing submits by itself: `"submit": true` is honoured only
 * when his own latest line, from the last minute, asks for it (submitAsked).
 */

export const FILL_LANG = "lianki-fill";

export type FillPatch = { line: string; fields: Record<string, string>; submit: boolean };

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
  return { line: v.line, fields, submit: v.submit === true };
}

export const SUBMIT_WINDOW_MS = 60_000;

/** Anything that turns "submit" into its opposite, a question or a mention: then never. */
const NOT_A_COMMAND =
  /\b(not|don'?t|do\s+not|never|no|without|wait|stop|hold|cancel|explain|what|how|why|which|where|button|later)\b|[?？]|不要|不用|别|不|先别|暂时|等等|等一下|吗|呢|怎么|什么|为什么|按钮|解释/i;
/** The last clause is a bare command to send: "submit", "ok, submit it now", "提交吧", "请发送". */
const SUBMIT_COMMAND = [
  /^(ok(ay)?|yes|yeah|good|great|alright|right|go)?[\s,]*(please\s+)?(submit|send)(\s+(it|this|the\s+form|that))?(\s+(now|please))?[.!]*$/i,
  /^(好|好的|行|可以|对|没问题)?[，,\s]*(请|帮我)?(提交|发送|发出去|送出)(吧|了|一下|表单|它)?[。！!]*$/,
];

/**
 * Did his own latest line, within the last minute, ask to submit? Only a
 * positive command as its last clause ("first name Sam, submit"; "提交吧"),
 * and nothing anywhere in it that negates, questions or merely mentions it
 * ("don't submit", 「不要 提交」, "what does the submit button do?").
 */
export function submitAsked(
  own: { text?: string; at?: number } | null | undefined,
  now: number,
): boolean {
  if (!own?.text || typeof own.at !== "number") return false;
  if (now - own.at > SUBMIT_WINDOW_MS || own.at > now + 5_000) return false;
  const text = own.text.trim();
  if (!text || NOT_A_COMMAND.test(text)) return false;
  const last = text.split(/[,，;；。.、]\s*(?=\S)/).at(-1)!.trim();
  return SUBMIT_COMMAND.some((re) => re.test(last));
}

/** A fill for one form: the patch, its own id, and whether this call is only a flash. */
type Listener = (patch: FillPatch, flashOnly: boolean, patchId: string) => void;

/**
 * Patches by target line, a "flash" for the chip's tap-through, and the one
 * submit each patch may cause. A patch line renders and re-renders, and a form
 * remounts (scrolling, a re-render of the log) and gets the fields again; but
 * its `submit` is a single authorization, used up the first time a form for
 * that line takes it (consumeSubmit), however often the patch replays.
 */
export function makeFillStore() {
  const listeners = new Map<string, Set<Listener>>();
  const applied = new Set<string>();
  const submitted = new Set<string>();
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
    /** The patch's one submit, for its own line: true the first time only. */
    consumeSubmit(patchId: string, line: string): boolean {
      const key = `${patchId}\u0000${line}`;
      if (submitted.has(key)) return false;
      submitted.add(key);
      return true;
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
