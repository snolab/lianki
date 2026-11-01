/**
 * The pure rules behind scripts/dev/eval.ts's grant tokens: when to resume
 * with a saved token, when (at most once) to pair, and when to give up
 * instead of prompting the owner again. Unit-tested in unit/dev-eval-grant.test.ts.
 *
 * The rule everywhere: a saved, unexpired token is tried first. Only when
 * there is none, or the hub refused it (4498), may a process pair — once per
 * process, never in a loop, and never with --no-pair.
 */

/** Close code the hub uses for a token it does not know (expired or ended). */
export const GRANT_INVALID = 4498;
/** End on the page (revoke), and Deny. */
export const ENDED = 4401;
export const DENIED = 4403;

/** A token file's body: `{"token","until"}` (until as an ISO date). */
export const grantFileBody = (token: string, until: number) =>
  JSON.stringify({ token, until: new Date(until).toISOString() });

/**
 * The token in a token file's text, if it is there and not expired at `now`.
 * A file without `until` (an older chat token file) counts as unexpired: the
 * hub has the last word.
 */
export function readGrantFile(text: string | undefined, now: number): string | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as { token?: unknown; until?: unknown };
    if (typeof v.token !== "string" || !v.token) return undefined;
    if (typeof v.until === "string") {
      const until = Date.parse(v.until);
      if (Number.isFinite(until) && until <= now) return undefined;
    }
    return v.token;
  } catch {
    return undefined;
  }
}

/**
 * The token in a token file's text, whatever its `until` says. For the eval
 * grant, whose `until` is only a hint: the hub renews it (docs/monitoring.md,
 * "Renewal"), possibly while no socket was there to hear, so the token is
 * tried with the hub, which answers 4498 when it is really gone.
 */
export function readGrantToken(text: string | undefined): string | undefined {
  return readGrantFile(text, -Infinity);
}

/**
 * The hub renewed the eval grant this socket holds ({type:"renewed", until}),
 * or a resume came back with its until ({type:"approved", scope:"eval"}):
 * the token file's new body, when the file holds this same token — so the
 * next run still sees it unexpired and resumes instead of asking the owner.
 * undefined = leave the file alone (another token, or nothing to say).
 */
export function freshenedGrantFile(
  fileText: string | undefined,
  token: string,
  msg: { type?: unknown; scope?: unknown; until?: unknown },
): string | undefined {
  const renewed = msg.type === "renewed" || (msg.type === "approved" && msg.scope === "eval");
  const until = Number(msg.until);
  if (!renewed || !Number.isFinite(until) || !fileText) return undefined;
  try {
    const v = JSON.parse(fileText) as { token?: unknown; until?: unknown };
    if (v.token !== token) return undefined;
    if (typeof v.until === "string" && Date.parse(v.until) >= until) return undefined;
  } catch {
    return undefined;
  }
  return grantFileBody(token, until);
}

export type EvalStep =
  | { kind: "resume"; token: string }
  | { kind: "pair" }
  | { kind: "fail"; error: string };

/**
 * What `serve` or a one-shot eval does to get an approved socket.
 * `token`: the saved eval token (undefined if missing; its file's `until` is
 * only a hint — readGrantToken — since the hub may have renewed it).
 * `rejected`: the hub refused that token (4498) — it is gone now.
 * `paired`: this process has already asked the owner once.
 */
export function evalStep(o: {
  token?: string;
  rejected?: boolean;
  noPair?: boolean;
  paired?: boolean;
}): EvalStep {
  if (o.token && !o.rejected) return { kind: "resume", token: o.token };
  if (o.noPair)
    return { kind: "fail", error: "no valid eval grant, and --no-pair: not asking the owner" };
  if (o.paired)
    return {
      kind: "fail",
      error:
        "no valid eval grant, and this process already asked the owner once: restart it to ask again",
    };
  return { kind: "pair" };
}

/**
 * The chat listener's next connect. `token`: the saved chat grant. `paired`:
 * this listener already asked the owner once (whatever came of it).
 */
export function chatStep(o: { token?: string; paired: boolean }): "resume" | "pair" | "give-up" {
  if (o.token) return "resume";
  return o.paired ? "give-up" : "pair";
}

/**
 * What a closed chat listener socket means:
 *   refused   the saved grant is gone (4498): forget it, then chatStep
 *   ended     End on the page (4401): forget the grant and exit
 *   denied    Deny (4403): exit
 *   closed    anything else (network, deploy, an unanswered pairing):
 *             reconnect — which resumes with a token, and never pairs twice
 */
export function chatClose(code: number): "refused" | "ended" | "denied" | "closed" {
  if (code === GRANT_INVALID) return "refused";
  if (code === ENDED) return "ended";
  if (code === DENIED) return "denied";
  return "closed";
}

/**
 * A `serve` socket closed: End or Deny ends the session; anything else (the
 * pages were away — PAGES_GONE — a network drop, a deploy) leaves it running,
 * to resume with the token on the next command. A friend's preview has no
 * token, so it ends.
 */
export function serveClose(code: number, resumable: boolean): "end" | "lazy" {
  if (code === ENDED || code === DENIED || !resumable) return "end";
  return "lazy";
}
