/**
 * Remote eval for the owner's debug session — the shared, pure pieces: the
 * debug hub (workers/push/src/debug.ts), the page (app/components/DebugEval.tsx)
 * and the sender (scripts/dev/eval.ts). No imports: the push Worker bundles it.
 *
 * Flow and security model: docs/monitoring.md, "Remote eval (owner debug)".
 */

/** Largest `code` accepted, in characters. */
export const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
export const MAX_RESULT = 4000;
/** Largest page or controller label, in characters. */
export const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
export const PENDING_MS = 2 * 60_000;
/** How long an approved controller may send code. */
export const APPROVAL_MS = 60 * 60_000;

/** Messages a controller (the sender CLI) may send to the hub. */
export type ControllerMessage = { type: "eval"; code: string; target?: string };
/** Messages an owner page may send to the hub. */
export type PageMessage =
  | { type: "allow" | "deny" | "revoke"; pair: string }
  | {
      type: "result";
      id: string;
      to: string;
      ok: boolean;
      value?: string;
      error?: string;
      stack?: string;
      ms?: number;
    };

/** What the hub tells pages: the pairing waiting for an answer, and the approved sessions. */
export type PairInfo = { pair: string; code: string; label: string; at: number; until?: number };
export type HubState = { type: "state"; pending: PairInfo | null; sessions: PairInfo[] };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_CODE + 2048) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validate a controller's message; anything else is dropped. */
export function parseControllerMessage(
  raw: unknown,
): { ok: true; value: ControllerMessage } | { ok: false; error: string } {
  const m = parse(raw);
  if (!m || m.type !== "eval") return { ok: false, error: 'expected {"type":"eval","code":"…"}' };
  if (typeof m.code !== "string" || !m.code.trim()) return { ok: false, error: "empty code" };
  if (m.code.length > MAX_CODE) return { ok: false, error: `code over ${MAX_CODE} chars` };
  const target = str(m.target, MAX_LABEL);
  return {
    ok: true,
    value: target ? { type: "eval", code: m.code, target } : { type: "eval", code: m.code },
  };
}

/** Validate an owner page's message; anything else is dropped. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  const m = parse(raw);
  if (!m) return null;
  if (m.type === "allow" || m.type === "deny" || m.type === "revoke") {
    const pair = str(m.pair, 64);
    return pair ? { type: m.type, pair } : null;
  }
  if (m.type === "result") {
    const id = str(m.id, 64);
    const to = str(m.to, 64);
    if (!id || !to) return null;
    return {
      type: "result",
      id,
      to,
      ok: m.ok === true,
      value: str(m.value, MAX_RESULT + 64),
      error: str(m.error, 1000),
      stack: str(m.stack, 2000),
      ms: typeof m.ms === "number" ? m.ms : undefined,
    };
  }
  return null;
}

/** A label shown to the owner: one line, printable, bounded. */
export function cleanLabel(raw: string | null | undefined, max = MAX_LABEL): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

/** The short code the CLI prints and the prompt shows, so the owner can match them. */
export function shortCode(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A socket's label matches when there is no target, or it contains the target (any case). */
export function matchesTarget(label: string, target: string | undefined): boolean {
  if (!target) return true;
  return label.toLowerCase().includes(target.toLowerCase());
}

/**
 * A JSON-serialisable summary of whatever the code returned, at most `max`
 * characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
 * become readable strings instead of throwing.
 */
export function summarize(value: unknown, max = MAX_RESULT): string {
  const seen = new WeakSet<object>();
  let out: string | undefined;
  try {
    out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "symbol") return v.toString();
      if (v === undefined) return "[undefined]";
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        const node = v as { nodeType?: unknown; outerHTML?: unknown; nodeName?: unknown };
        if (typeof node.nodeType === "number")
          return typeof node.outerHTML === "string"
            ? node.outerHTML.slice(0, 500)
            : `[node ${String(node.nodeName)}]`;
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        if (v instanceof Map) return { "[Map]": [...v.entries()] };
        if (v instanceof Set) return { "[Set]": [...v.values()] };
      }
      return v;
    });
  } catch (e) {
    out = `[unserialisable: ${e instanceof Error ? e.message : String(e)}]`;
  }
  out ??= "[undefined]";
  return out.length > max ? `${out.slice(0, max)}…[${out.length - max} more]` : out;
}

/**
 * Compile `code` as an async function. An expression (`document.title`) is
 * returned as is; anything else is a function body, so `return x` works and
 * `await` is allowed in both.
 */
export function compile(code: string): () => Promise<unknown> {
  try {
    return new Function(`return (async () => (\n${code}\n))();`) as () => Promise<unknown>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return new Function(`return (async () => {\n${code}\n})();`) as () => Promise<unknown>;
  }
}
