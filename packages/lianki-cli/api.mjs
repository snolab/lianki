// The CLI's HTTP core: one call() to lianki.com's API, its errors and exit
// codes. Runtime-neutral (no node: imports, fetch injected through c.deps),
// so the remote MCP Worker (workers/mcp) runs the same calls as `lianki mcp`.
// cli.mjs re-exports everything here.

export const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4, refused: 5 };

/**
 * The settings that follow the account, as lib/prefs/schema.ts listed them
 * when this version was published. A newer server may know more keys: those
 * still work (the server checks every key and value), and `settings list`
 * shows any the server returns. unit/lianki-cli.test.ts checks that none of
 * these has been removed from the server.
 */
export const PREF_KEYS = [
  "words.showAll",
  "words.readAloud",
  "words.serverVoice",
  "words.speakOnSwipe",
  "words.gradeTones",
  "words.voiceMode",
  "words.swipeMirror",
  "swipe.variant",
  "swipe-feel.preset",
  "swipe-feel.tweaks",
  "motion.animations",
  "ui.paper",
  "text-size.ui",
  "text-size.chat",
  "text-size.cards",
  "ui.locale",
  "nav-pins.pinned",
  "home.lang",
  "home.pins",
  "lab.immersionLangs",
  "lab.immersionTranspose",
  "chat-voice.rate",
  "chat-voice.out",
  "chat-voice.speak",
  "chat-voice.cueSend",
  "chat-voice.cueSpeech",
];

export class CliError extends Error {
  constructor(code, exit, message, hint) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

export const LOGIN_HINT = "lianki auth login   (agents: set LIANKI_TOKEN=lk_… or pass --token)";
export const SCOPE_HINT =
  "the token lacks that permission: make one that has it at lianki.com/my/preferences → API tokens, or lianki auth login again";

export async function call(c, token, { method = "GET", path, query, body, headers: extra }) {
  const url = new URL(path, c.base + "/");
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers = { accept: "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let r;
  try {
    r = await c.deps.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch (e) {
    throw new CliError("network", EXIT.server, `cannot reach ${c.site}: ${e?.message ?? e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (r.status >= 200 && r.status < 300 && data !== null) return { status: r.status, data };
  const said = (data && typeof data.error === "string" && data.error) || text.slice(0, 200);
  const detail = said.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (r.status === 401 || r.status === 403)
    throw new CliError(
      "auth_refused",
      EXIT.auth,
      `${c.site} refused the token (${r.status}${/^(unknown|expired|scope|blocked)$/.test(detail) ? `: ${detail}` : ""})`,
      detail === "scope" ? SCOPE_HINT : LOGIN_HINT,
    );
  // The FSRS router answers a missing card with a 500 "Error: note not found".
  if (r.status === 404 || /note not found/i.test(detail))
    throw new CliError("not_found", EXIT.notFound, detail && !/^404$/.test(detail) ? detail : "not found");
  if (r.status === 429) {
    // Passed on as is: how long the server asked us to wait (seconds), if it said.
    const wait = Number(r.headers?.get?.("retry-after"));
    const e = new CliError(
      "rate_limited",
      EXIT.refused,
      `${c.site} refused it (429: too many requests)${wait > 0 ? `; retry after ${wait} s` : ""}`,
    );
    e.retryAfter = wait > 0 ? wait : null;
    throw e;
  }
  if (r.status >= 300 && r.status < 400)
    throw new CliError("server", EXIT.server, `${c.site} redirected (${r.status}); check --api`);
  if (r.status >= 500 || data === null)
    throw new CliError("server", EXIT.server, `${c.site} failed (${r.status})${detail ? `: ${detail}` : ""}`);
  throw new CliError("refused", EXIT.refused, `${c.site} refused it (${r.status})${detail ? `: ${detail}` : ""}`);
}
