/**
 * The owner's eval grant, as live config (lib/config.ts, docs/config-store.md):
 * how long one Allow lasts (`debug.evalGrantHours`) and which pages it covers
 * (`debug.evalGrantPages`). lianki-push has no D1, so the hub asks the main
 * Worker over `DebugSessions.config(key)` and reads the answer with these.
 * Anything it cannot use — no binding, an error, a value out of range — gives
 * the code default: 8 hours, the pages the owner ticks. docs/monitoring.md,
 * "Remote eval (owner debug)".
 *
 * Client-safe and free of zod: the hub bundles it.
 */

export const EVAL_GRANT_HOURS_KEY = "debug.evalGrantHours";
export const EVAL_GRANT_PAGES_KEY = "debug.evalGrantPages";

/** The code defaults (the registry's `default`s must equal these; unit/eval-grant-config.test.ts). */
export const EVAL_GRANT_HOURS_DEFAULT = 8;
/** "chosen": the pages ticked in the pairing modal; "all": every page of the owner, now and later. */
export const EVAL_GRANT_PAGES_DEFAULT = "chosen" as const;
export type EvalGrantPages = "chosen" | "all";

/** Bounds: an hour at least, 30 days at most (the renewal chain's cap). */
export const EVAL_GRANT_HOURS_MIN = 1;
export const EVAL_GRANT_HOURS_MAX = 720;

const HOUR_MS = 60 * 60_000;

/** A stored hour count, or the default when it is not a whole number in range. */
export function evalGrantHours(raw: unknown): number {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= EVAL_GRANT_HOURS_MIN &&
    raw <= EVAL_GRANT_HOURS_MAX
    ? raw
    : EVAL_GRANT_HOURS_DEFAULT;
}

/** The grant's length in ms, from a stored hour count. */
export const evalGrantMs = (raw: unknown): number => evalGrantHours(raw) * HOUR_MS;

/** Which pages an Allow covers, from a stored value. */
export function evalGrantPages(raw: unknown): EvalGrantPages {
  return raw === "all" || raw === "chosen" ? raw : EVAL_GRANT_PAGES_DEFAULT;
}

/** What the hub needs at a knock: the grant's length and whether it covers every page. */
export type EvalGrantConf = { ms: number; allPages: boolean };

/**
 * Both values through `read` (the SESSIONS binding's `config`), each falling
 * back to its default on its own when the read throws or there is none.
 */
export async function readEvalGrantConf(
  read: ((key: string) => Promise<unknown>) | undefined,
): Promise<EvalGrantConf> {
  const get = async (key: string) => {
    try {
      return read ? await read(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const [hours, pages] = await Promise.all([get(EVAL_GRANT_HOURS_KEY), get(EVAL_GRANT_PAGES_KEY)]);
  return { ms: evalGrantMs(hours), allPages: evalGrantPages(pages) === "all" };
}
