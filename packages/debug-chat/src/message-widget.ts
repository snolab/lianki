/**
 * Message widgets (owner, 2026-11-14 23:2x JST: "消息里能带计算器/按钮等组件"):
 * an agent line carries a small interactive piece as data, never as script. The
 * agent writes a fenced block
 *
 *   ```lianki-widget
 *   {"type": "buttons", "title": "Which first?", "options": ["Review", "New words"]}
 *   ```
 *
 * and the page renders it with its own components (MessageWidget.tsx). Nothing
 * in the spec runs: it is parsed as JSON, checked field by field against the
 * shapes below, and anything else shows as the code block it is. A widget only
 * puts text into his reply box; he still sends it himself.
 *
 * Only lines in the html tier (rich-text.ts lineTier: an agent he paired in his
 * own thread) get widgets, behind the flag chat.message-widgets. Script widgets
 * (a sandboxed iframe, granted per lane) are the mini apps' (docs/mini-apps.md).
 */

export const WIDGET_LANG = "lianki-widget";

export type Widget =
  | { type: "buttons"; title?: string; options: string[] }
  | { type: "calc"; title?: string; expr: string }
  | {
      type: "slider";
      title?: string;
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      unit?: string;
    }
  | { type: "table"; title?: string; columns: string[]; rows: string[][] };

const MAX_SPEC = 4000;
const MAX_TEXT = 200;
const MAX_OPTIONS = 8;
const MAX_COLUMNS = 8;
const MAX_ROWS = 30;

const text = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const cell = (v: unknown): string =>
  typeof v === "string" ? v.slice(0, MAX_TEXT) : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A widget spec, or null when it is not one (then the block shows as code). */
export function parseWidget(spec: string): Widget | null {
  if (spec.length > MAX_SPEC) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(spec) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const title = text(v.title);
  const t = title ? { title } : {};
  if (v.type === "buttons") {
    if (!Array.isArray(v.options)) return null;
    const options = v.options
      .map((o) => text(o, 80))
      .filter((o): o is string => !!o)
      .slice(0, MAX_OPTIONS);
    return options.length ? { type: "buttons", ...t, options } : null;
  }
  if (v.type === "calc") {
    const expr = typeof v.expr === "string" ? v.expr.slice(0, MAX_TEXT) : "";
    return { type: "calc", ...t, expr };
  }
  if (v.type === "slider") {
    const label = text(v.label, 80);
    const min = num(v.min);
    const max = num(v.max);
    if (!label || min === undefined || max === undefined || !(max > min)) return null;
    const rawStep = num(v.step);
    const step = rawStep !== undefined && rawStep > 0 && rawStep <= max - min ? rawStep : 1;
    const value = Math.min(max, Math.max(min, num(v.value) ?? min));
    const unit = text(v.unit, 20);
    return { type: "slider", ...t, label, min, max, step, value, ...(unit ? { unit } : {}) };
  }
  if (v.type === "table") {
    if (!Array.isArray(v.columns) || !Array.isArray(v.rows)) return null;
    const columns = v.columns.slice(0, MAX_COLUMNS).map(cell);
    if (!columns.length) return null;
    const rows = v.rows
      .filter(Array.isArray)
      .slice(0, MAX_ROWS)
      .map((r) => columns.map((_, i) => cell((r as unknown[])[i])));
    return { type: "table", ...t, columns, rows };
  }
  return null;
}

/**
 * Arithmetic, read by a small parser (never eval): numbers, + - * / % ^, unary
 * minus, parentheses. Null when it is not one, or not a finite number.
 */
export function calc(expr: string): number | null {
  const src = expr.replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/，/g, ",").replace(/,/g, "");
  if (src.length > MAX_TEXT || !src.trim()) return null;
  let i = 0;
  const ws = () => {
    while (src[i] === " " || src[i] === "\t") i++;
  };
  const peek = () => (ws(), src[i]);
  let depth = 0;
  function primary(): number {
    const c = peek();
    if (c === "(") {
      if (++depth > 32) throw new Error("deep");
      i++;
      const v = sum();
      if (peek() !== ")") throw new Error(")");
      i++;
      depth--;
      return v;
    }
    if (c === "-" || c === "+") {
      i++;
      const v = power();
      return c === "-" ? -v : v;
    }
    const m = /^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) throw new Error("number");
    i += m[0].length;
    return Number(m[0]);
  }
  function power(): number {
    const base = primary();
    if (peek() === "^") {
      i++;
      return base ** power();
    }
    return base;
  }
  function product(): number {
    let v = power();
    for (;;) {
      const c = peek();
      if (c !== "*" && c !== "/" && c !== "%") return v;
      i++;
      const r = power();
      v = c === "*" ? v * r : c === "/" ? v / r : v % r;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") return v;
      i++;
      const r = product();
      v = c === "+" ? v + r : v - r;
    }
  }
  try {
    const v = sum();
    if (peek() !== undefined) return null;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** A result as he reads it: at most 10 significant digits, no float noise. */
export const calcShown = (v: number): string => String(Number(v.toPrecision(10)));

/** What a slider puts in his reply: "Minutes a day: 20 min". */
export const sliderReply = (w: Extract<Widget, { type: "slider" }>, value: number): string =>
  `${w.label}: ${value}${w.unit ? ` ${w.unit}` : ""}`;
