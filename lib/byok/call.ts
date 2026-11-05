// One call to the user's own AI, from the browser (docs/byok.md). The key
// goes in a header to the provider's URL and, unless the user turned on the
// relay (below), nowhere else:
//
// - the URL is checked again right before the fetch (lib/byok/config.ts
//   checkBaseUrl): never Lianki's hosts, never the page's own origin, https
//   or this computer only;
// - no cookies (`credentials: "omit"`), no referrer;
// - nothing is logged, and an error carries only its kind and HTTP status —
//   never the provider's message, which can echo part of the key
//   ("Incorrect API key provided: sk-ab***yz").
//
// With 「经 Lianki 转发（不保存）」 on (`backend.relay`, an allowlisted
// preset only), the same call goes to Lianki's relay instead
// (`POST /api/byok/proxy`, lib/byok/proxy-server.ts): the key in
// `Authorization`, the backend and messages as JSON. The relay forwards it
// and forgets both; the answer comes back unchanged.

import { checkBaseUrl, MODEL_RE, type ByokActive } from "./config";

export type ByokMessage = { role: "system" | "user" | "assistant"; content: string };

export type ByokErrorKind =
  /** The URL failed the rules (it is never fetched). */
  | "bad-url"
  /** The browser blocked or could not reach a server on this computer (Ollama: OLLAMA_ORIGINS). */
  | "local"
  /** A network error from a provider that hides a rejected key behind it (OpenAI): check the key. */
  | "opaque-auth"
  /** Blocked by CORS, or the host could not be reached. */
  | "cors"
  /** 401 / 403: the key was refused. */
  | "auth"
  /** Any other HTTP error (status says which). */
  | "http"
  | "timeout"
  /** 200, but no text in the answer. */
  | "empty"
  /** Lianki's relay refused the backend (not on its allowlist, or not a public address). */
  | "relay-refused"
  /** Lianki's relay is busy for this device or account: wait a minute. */
  | "rate"
  /** The request or the answer was over the relay's size cap. */
  | "too-large";

export type ByokResult =
  | { ok: true; text: string }
  | { ok: false; kind: ByokErrorKind; status?: number };

export interface ByokDeps {
  fetch?: typeof fetch;
  /** The page's host (never called). Defaults to location.host. */
  pageHost?: string | null;
  timeoutMs?: number;
}

/** The request for one completion, as fetch takes it. */
export function byokRequest(
  a: ByokActive,
  messages: readonly ByokMessage[],
  opts: { maxTokens: number; temperature?: number },
  pageHost?: string | null,
): { url: string; init: RequestInit } | null {
  const u = checkBaseUrl(a.backend.baseUrl, pageHost);
  if (!u.ok) return null;
  const base: RequestInit = {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  };
  if (a.preset.protocol === "anthropic") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    return {
      url: `${u.url}/messages`,
      init: {
        ...base,
        headers: {
          "content-type": "application/json",
          "x-api-key": a.apiKey,
          "anthropic-version": "2023-06-01",
          // Anthropic refuses a browser call without it (CORS is otherwise off).
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: a.backend.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0.2,
          ...(system.length ? { system: system.join("\n\n") } : {}),
          messages: messages.filter((m) => m.role !== "system"),
        }),
      },
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (a.apiKey) headers.authorization = `Bearer ${a.apiKey}`;
  return {
    url: `${u.url}/chat/completions`,
    init: {
      ...base,
      headers,
      body: JSON.stringify({
        model: a.backend.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
      }),
    },
  };
}

/** The answer's text, by protocol; "" when there is none. */
export function byokText(protocol: ByokActive["preset"]["protocol"], body: unknown): string {
  const b = body as {
    choices?: { message?: { content?: unknown } }[];
    content?: { type?: string; text?: unknown }[];
  } | null;
  if (protocol === "anthropic")
    return (b?.content ?? [])
      .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
      .join("");
  const c = b?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

/** A URL on this computer (the request's URL has passed checkBaseUrl, so it parses). */
const isLocal = (url: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

/** The relay's request for one completion (`/api/byok/proxy`). */
export function relayRequest(
  a: ByokActive,
  messages: readonly ByokMessage[],
  opts: { maxTokens: number; temperature?: number },
): { url: string; init: RequestInit } {
  return {
    url: "/api/byok/proxy",
    init: {
      method: "POST",
      // Same origin: the session cookie only counts toward the user's own limit.
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({
        provider: a.backend.provider,
        baseUrl: a.backend.baseUrl,
        model: a.backend.model,
        messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
      }),
    },
  };
}

/** The relay's own error, by its `proxyError` kind. */
function relayError(kind: unknown, status?: unknown): ByokResult {
  const s = typeof status === "number" ? status : undefined;
  switch (kind) {
    case "auth":
      return { ok: false, kind: "auth", status: s };
    case "http":
      return { ok: false, kind: "http", status: s };
    case "timeout":
      return { ok: false, kind: "timeout" };
    case "rate":
      return { ok: false, kind: "rate" };
    case "too-large":
      return { ok: false, kind: "too-large" };
    case "network":
      return { ok: false, kind: "cors" };
    case "type":
      return { ok: false, kind: "empty" };
    default:
      return { ok: false, kind: "relay-refused" };
  }
}

async function relayComplete(
  a: ByokActive,
  messages: readonly ByokMessage[],
  opts: { maxTokens: number; temperature?: number },
  deps: ByokDeps,
): Promise<ByokResult> {
  const req = relayRequest(a, messages, opts);
  const f = deps.fetch ?? fetch;
  const ctl = new AbortController();
  // A little longer than the relay's own 30 s, so its timeout answer arrives.
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 35_000);
  let res: Response;
  try {
    res = await f(req.url, { ...req.init, signal: ctl.signal });
  } catch {
    clearTimeout(timer);
    return { ok: false, kind: ctl.signal.aborted ? "timeout" : "cors" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    clearTimeout(timer);
    return res.ok ? { ok: false, kind: "empty" } : { ok: false, kind: "http", status: res.status };
  }
  clearTimeout(timer);
  const err = (body as { proxyError?: unknown; status?: unknown } | null)?.proxyError;
  if (!res.ok || err) return relayError(err, (body as { status?: unknown }).status);
  const text = byokText(a.preset.protocol, body).trim();
  return text ? { ok: true, text } : { ok: false, kind: "empty" };
}

/** One completion. Never throws, never logs. */
export async function byokComplete(
  a: ByokActive,
  messages: readonly ByokMessage[],
  opts: { maxTokens: number; temperature?: number },
  deps: ByokDeps = {},
): Promise<ByokResult> {
  const pageHost =
    deps.pageHost !== undefined
      ? deps.pageHost
      : typeof location === "undefined"
        ? null
        : location.host;
  if (a.backend.relay) return relayComplete(a, messages, opts, deps);
  const req = byokRequest(a, messages, opts, pageHost);
  if (!req) return { ok: false, kind: "bad-url" };
  const f = deps.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await f(req.url, { ...req.init, signal: ctl.signal });
  } catch {
    clearTimeout(timer);
    if (ctl.signal.aborted) return { ok: false, kind: "timeout" };
    if (isLocal(req.url)) return { ok: false, kind: "local" };
    return { ok: false, kind: a.preset.opaqueAuthErrors ? "opaque-auth" : "cors" };
  }
  clearTimeout(timer);
  if (res.status === 401 || res.status === 403)
    return { ok: false, kind: "auth", status: res.status };
  if (!res.ok) return { ok: false, kind: "http", status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "empty" };
  }
  const text = byokText(a.preset.protocol, body).trim();
  return text ? { ok: true, text } : { ok: false, kind: "empty" };
}

/** The settings' Test: one tiny request; ok once the provider answers 200. */
export async function testByok(a: ByokActive, deps: ByokDeps = {}): Promise<ByokResult> {
  const r = await byokComplete(
    a,
    [{ role: "user", content: "Reply with the single word OK." }],
    { maxTokens: 16, temperature: 0 },
    deps,
  );
  // A reasoning model may spend 16 tokens thinking and say nothing: still a working key.
  return !r.ok && r.kind === "empty" ? { ok: true, text: "" } : r;
}

/**
 * The models a provider offers this key, sorted; [] on any failure (the field
 * can always be typed in). Same rules as a completion: the checked URL, no
 * cookies, no referrer, nothing logged.
 */
export async function byokModels(
  backend: ByokActive["backend"],
  apiKey: string,
  preset: ByokActive["preset"],
  deps: ByokDeps = {},
): Promise<string[]> {
  const pageHost =
    deps.pageHost !== undefined
      ? deps.pageHost
      : typeof location === "undefined"
        ? null
        : location.host;
  const u = checkBaseUrl(backend.baseUrl, pageHost);
  if (!u.ok) return [];
  const anthropic = preset.protocol === "anthropic";
  const headers: Record<string, string> = anthropic
    ? {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      }
    : apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await (deps.fetch ?? fetch)(`${u.url}/models${anthropic ? "?limit=1000" : ""}`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers,
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown }[] } | null;
    const ids = (body?.data ?? []).map((m) => m?.id);
    return ids.filter((id): id is string => typeof id === "string" && MODEL_RE.test(id)).sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
