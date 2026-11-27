// The CLI's HTTP core: one call() to lianki.com's API, its errors and exit
// codes. Runtime-neutral (no node: imports, fetch injected through c.deps),
// so the remote MCP Worker (workers/mcp) runs the same calls as `lianki mcp`.
// cli.mjs re-exports everything here.

export const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4, refused: 5 };
export const MAX_ERROR_BYTES = 16_384;

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

/** A clock newer than the stored one, so this write wins (docs/prefs-sync.md). */
export function nextHlc(prev, id, now = Date.now()) {
  if (prev && prev.timestamp >= now) return { timestamp: prev.timestamp, counter: prev.counter + 1, deviceId: id };
  return { timestamp: now, counter: 0, deviceId: id };
}

export const LOGIN_HINT ="lianki auth login   (agents: set LIANKI_TOKEN=lk_… or pass --token)";
export const SCOPE_HINT =
  "the token lacks that permission: make one that has it at lianki.com/my/preferences → API tokens, or lianki auth login again";

function buildUrl(c, path, query) {
  const url = new URL(path, c.base + "/");
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  return url;
}

/** @returns {never} */
function throwHttpError(c, r, text, data) {
  const said = (data && typeof data.error === "string" && data.error) || text;
  // Angle brackets dropped, so no markup survives (CodeQL: a tag regex alone is incomplete).
  const detail = said.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim();
  if (r.status === 401 || r.status === 403) {
    const error = new CliError(
      "auth_refused",
      EXIT.auth,
      `${c.site} refused the token (${r.status}${/^(unknown|expired|scope|blocked)$/.test(detail) ? `: ${detail}` : ""})`,
      detail === "scope" ? SCOPE_HINT : LOGIN_HINT,
    );
    // Only public token identities on the canonical approval route; never echo
    // arbitrary server URLs or bearer credentials in command/tool errors.
    if (
      r.status === 403 &&
      detail === "scope" &&
      typeof data?.needScope === "string" &&
      /^[a-z]+(?::[a-z]+)?$/.test(data.needScope) &&
      data.needScope.length <= 64
    ) {
      try {
        const approval = new URL(data.requestUrl);
        if (
          approval.origin === "https://lianki.com" &&
          approval.pathname === "/my/tokens/scopes" &&
          !approval.username &&
          !approval.password &&
          !approval.hash &&
          /^[0-9a-f]{64}$/.test(approval.searchParams.get("token") ?? "") &&
          approval.searchParams.get("scope") === data.needScope &&
          [...approval.searchParams.keys()].length === 2
        ) {
          error.needScope = data.needScope;
          error.requestUrl = approval.toString();
          error.hint = error.requestUrl;
        }
      } catch {}
    }
    throw error;
  }
  // The FSRS router answers a missing card with a 500 "Error: note not found".
  if (r.status === 404 || /note not found/i.test(detail))
    throw new CliError(
      "not_found",
      EXIT.notFound,
      detail && !/^404$/.test(detail) ? detail : "not found",
    );
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
    throw new CliError(
      "server",
      EXIT.server,
      `${c.site} failed (${r.status})${detail ? `: ${detail}` : ""}`,
    );
  throw new CliError(
    "refused",
    EXIT.refused,
    `${c.site} refused it (${r.status})${detail ? `: ${detail}` : ""}`,
  );
}

export async function call(c, token, { method = "GET", path, query, body, headers: extra }) {
  const url = buildUrl(c, path, query);
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
  throw throwHttpError(c, r, text, data);
}

function noop() {}

function abortAndCancel(controller, target) {
  try {
    controller?.abort();
  } catch {}
  try {
    const p = target?.cancel?.();
    if (p && typeof p.then === "function") p.then(noop, noop);
  } catch {}
}

async function readStreamCapped(c, r, maxBytes, { onExceed, controller }) {
  const hasLimit = typeof maxBytes === "number" && maxBytes > 0;
  if (r.body && typeof r.body.getReader === "function") {
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (!chunk.byteLength) continue;
        if (hasLimit && total + chunk.byteLength > maxBytes) {
          abortAndCancel(controller, reader);
          if (onExceed === "throw")
            throw new CliError(
              "server",
              EXIT.server,
              `${c.site} returned more than ${maxBytes} bytes`,
            );
          const keep = maxBytes - total;
          if (keep > 0) {
            chunks.push(chunk.subarray(0, keep));
            total += keep;
          }
          truncated = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {}
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated };
  }
  const raw = new Uint8Array(await r.arrayBuffer());
  if (hasLimit && raw.byteLength > maxBytes) {
    abortAndCancel(controller, null);
    if (onExceed === "throw")
      throw new CliError("server", EXIT.server, `${c.site} returned more than ${maxBytes} bytes`);
    return { bytes: raw.subarray(0, maxBytes), truncated: true };
  }
  return { bytes: raw, truncated: false };
}

export async function callBytes(
  c,
  token,
  { method = "GET", path, query, accept = "*/*", headers: extra, maxBytes },
) {
  const url = buildUrl(c, path, query);
  const headers = { accept, ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let r;
  try {
    r = await c.deps.fetch(url, {
      method,
      headers,
      redirect: "manual",
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (e) {
    throw new CliError("network", EXIT.server, `cannot reach ${c.site}: ${e?.message ?? e}`);
  }
  if (r.status < 200 || r.status >= 300) {
    const { bytes, truncated } = await readStreamCapped(c, r, MAX_ERROR_BYTES, {
      onExceed: "truncate",
      controller,
    });
    const text = new TextDecoder().decode(bytes).trim();
    let data = null;
    if (!truncated) {
      try {
        data = text ? JSON.parse(text) : {};
      } catch {}
    }
    throw throwHttpError(c, r, text, data);
  }
  const len = Number(r.headers?.get?.("content-length"));
  if (maxBytes && Number.isFinite(len) && len > maxBytes) {
    abortAndCancel(controller, r.body);
    throw new CliError("server", EXIT.server, `${c.site} returned more than ${maxBytes} bytes`);
  }
  const { bytes } = await readStreamCapped(c, r, maxBytes, { onExceed: "throw", controller });
  return { status: r.status, bytes, contentType: r.headers?.get?.("content-type") ?? "" };
}
