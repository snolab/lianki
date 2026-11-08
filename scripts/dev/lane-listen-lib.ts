/**
 * The pure half of ./lane-listen.ts (docs/lane-listen.md): where a lane's
 * token comes from (never printed), reading both listeners' JSON lines, and
 * what the lane's agent is handed. Tested in unit/lane-listen.test.ts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RouteLane, routeLine, testText } from "../../lib/lane-route";

/** Where a lane's token is kept on this Mac. */
export const laneTokenDir = (env: Record<string, string | undefined> = process.env) =>
  env.LIANKI_LANE_TOKEN_DIR || join(homedir(), ".config", "lianki", "lanes");
export const laneTokenPath = (lane: string, env?: Record<string, string | undefined>) =>
  join(laneTokenDir(env), `${lane}.token`);

/**
 * The lane's token: LIANKI_TOKEN, else its file. The file must be the owner's
 * alone (no group or other bits) and hold one lk_ token. Never logged.
 */
export function laneToken(
  lane: string | undefined,
  env: Record<string, string | undefined> = process.env,
): { token: string; from: "env" | "file" } | { token?: undefined; from: "none"; why: string } {
  const e = env.LIANKI_TOKEN?.trim();
  if (e) return { token: e, from: "env" };
  if (!lane || !/^[A-Za-z0-9._-]{1,40}$/.test(lane) || lane.includes(".."))
    return { from: "none", why: "no lane (--as) to look a token up for" };
  const path = laneTokenPath(lane, env);
  if (!existsSync(path)) return { from: "none", why: `no token file ${path}` };
  if (statSync(path).mode & 0o077)
    return { from: "none", why: `${path} is readable by others: chmod 600 it` };
  const t = readFileSync(path, "utf8").trim();
  if (!/^lk_[A-Za-z0-9_-]{16,}$/.test(t))
    return { from: "none", why: `${path} does not hold an lk_ token` };
  return { token: t, from: "file" };
}

/** What the owner makes at lianki.com/preferences → API tokens for `lane`. */
export const tokenNeeded = (lane: string, env?: Record<string, string | undefined>) =>
  `a lane token for ${lane}: lianki.com/preferences → API tokens → name "${lane}", permissions chat:read chat:write chat:ask (nothing else), an expiry; saved at ${laneTokenPath(lane, env)} (chmod 600) or passed as LIANKI_TOKEN`;

/** A chat line from either listener's JSON (eval.ts chat, or `lianki chat listen --json`). */
export type Line = { id: string; thread: string; from: string; text: string; at?: string };
export function lineOf(raw: string): (Line & { history: boolean }) | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || v.type !== "chat") return null;
  const m = (v.message && typeof v.message === "object" ? v.message : v) as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.text !== "string") return null;
  return {
    id: m.id,
    thread: typeof m.thread === "string" ? m.thread : "owner",
    from: typeof m.from === "string" ? m.from : "",
    text: m.text,
    ...(m.at !== undefined
      ? { at: String(typeof m.at === "number" ? new Date(m.at).toISOString() : m.at) }
      : {}),
    history: v.history === true,
  };
}

/** HH:MM in JST. */
export const jst = (at?: string) => {
  const d = at ? new Date(at) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Date(t.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
};

/** What the lane's agent is handed: his words, and how to answer as itself. */
export function handoff(lane: RouteLane, l: Line, repo: string): string {
  const test = testText(l);
  const words = test ?? l.text;
  const said = routeLine(words);
  const reply = `bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`;
  return [
    test === null
      ? `【owner → ${lane}】(${jst(l.at)} JST, Li chat) ${words}`
      : `【lane-test → ${lane}】(${jst(l.at)} JST) ${words}`,
    "",
    test === null
      ? `He addressed this to you by name; only you got it, the other lanes stay silent. Answer once, yourself, short, in his language${said.text ? "" : " (he only said your name: ask what he needs)"}:`
      : 'This is a routing TEST, not the owner. Answer once, starting "[lane-test] ", one short line, so the test sees you heard it:',
    `  ${reply}`,
    "It posts as your lane (your name, mark and voice) with your own lane token; never read or print the token. Do not hand this to another lane.",
  ].join("\n");
}
