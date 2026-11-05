// Lianki's BYOK relay (`POST /api/byok/proxy`, docs/byok.md "The relay"):
// a stateless forwarder for a user's own key to an ALLOWLISTED provider
// (lib/byok/presets.ts `relay`). The browser sends the key in
// `Authorization: Bearer …` and the backend + messages as JSON; we forward
// one call and forget both. Nothing is stored, cached or charged.
//
// What may be logged: one line per call — provider id, outcome, HTTP status,
// hops, latency, bytes. Never the key, any header, the URL, the request or
// response body, or the provider's error text (which can echo the key).
//
// Every dependency is injected so the guards are tested without a network
// (unit/byok-proxy.test.ts); app/api/byok/proxy/route.ts wires the real ones.

import { sameOriginJson } from "@/lib/security/same-origin";
import {
  checkBackend,
  checkRedirect,
  keyOf,
  parseInput,
  PROXY_LIMITS,
  PROXY_RATE,
  type ProxyInput,
  type RefuseReason,
  type Resolve,
} from "./proxy-guard";
import type { ByokPreset } from "./presets";

export type ProxyErrorKind =
  | "origin" // not a same-origin JSON POST
  | "too-large" // request or answer over the cap
  | "input" // the JSON is not what the relay takes
  | "key" // no / malformed key header
  | RefuseReason // the target is not allowlisted, or resolves privately
  | "rate" // rate limited (ours, not the provider's)
  | "timeout"
  | "network" // the provider could not be reached
  | "auth" // the provider refused the key (401/403)
  | "http" // any other provider error (status says which)
  | "type"; // the provider answered something other than JSON

export interface RateHit {
  (
    key: string,
    limit: { max: number; windowMs: number },
  ): Promise<{
    allowed: boolean;
    retryAfterMs: number;
  }>;
}

export interface ProxyDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  resolve: Resolve;
  hit: RateHit;
  ip: string;
  userId: string | null;
  /** One line of counts per call; defaults to console.log of JSON. */
  log?: (line: Record<string, string | number>) => void;
  now?: () => number;
  /** Tests only; PROXY_LIMITS.timeoutMs otherwise. */
  timeoutMs?: number;
}

const NO_STORE = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
};

function fail(kind: ProxyErrorKind, status: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ proxyError: kind, ...extra }), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}

/** Discard a body we will not pass on (never read, never logged). */
async function drop(body: ReadableStream | null | undefined) {
  try {
    await body?.cancel();
  } catch {}
}

/** Read at most `max` bytes of a request body; null when over. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {}
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The provider request, built here from the checked fields only. */
export function upstreamInit(
  preset: ByokPreset,
  input: ProxyInput,
  key: string,
  signal: AbortSignal,
): RequestInit {
  const base: RequestInit = {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    signal,
  };
  if (preset.protocol === "anthropic") {
    const system = input.messages.filter((m) => m.role === "system").map((m) => m.content);
    return {
      ...base,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        ...(system.length ? { system: system.join("\n\n") } : {}),
        messages: input.messages.filter((m) => m.role !== "system"),
      }),
    };
  }
  return {
    ...base,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
    }),
  };
}

/** Pass a body through, erroring once it goes over `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number, onEnd: (bytes: number) => void) {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        total += chunk.byteLength;
        if (total > max) {
          onEnd(total);
          ctl.error(new Error("too-large"));
          return;
        }
        ctl.enqueue(chunk);
      },
      flush() {
        onEnd(total);
      },
    }),
  );
}

export async function handleProxy(req: Request, deps: ProxyDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log =
    deps.log ?? ((line: Record<string, string | number>) => console.log(JSON.stringify(line)));
  let provider = "-";
  const done = (outcome: string, status: number, extra: Record<string, number> = {}) =>
    log({ event: "byok.proxy", provider, outcome, status, ms: now() - started, ...extra });

  if (req.method !== "POST" || !sameOriginJson(req)) {
    done("origin", 403);
    return fail("origin", 403);
  }

  // Rate limits before anything else is read: per IP, per user, and global.
  const checks = [deps.hit("byok-proxy:global", PROXY_RATE.global)];
  if (deps.ip && deps.ip !== "unknown")
    checks.push(deps.hit(`byok-proxy:ip:${deps.ip}`, PROXY_RATE.ip));
  if (deps.userId) checks.push(deps.hit(`byok-proxy:user:${deps.userId}`, PROXY_RATE.user));
  let rate: Awaited<ReturnType<RateHit>>[] | null = null;
  try {
    rate = await Promise.all(checks);
  } catch {}
  const refused = rate?.filter((r) => !r.allowed) ?? [];
  if (!rate || refused.length) {
    const retry = Math.ceil(Math.max(1000, ...refused.map((r) => r.retryAfterMs)) / 1000);
    done("rate", 429);
    const res = fail("rate", 429);
    res.headers.set("retry-after", String(retry));
    return res;
  }

  const key = keyOf(req.headers);
  let raw: string | null = null;
  try {
    raw = await readCapped(req, PROXY_LIMITS.maxBodyBytes);
  } catch {}
  if (raw === null) {
    done("too-large", 413);
    return fail("too-large", 413);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const input = parseInput(parsed);
  if (!input) {
    done("input", 400);
    return fail("input", 400);
  }
  if (!key) {
    done("key", 400);
    return fail("key", 400);
  }
  let target = checkBackend(input.provider, input.baseUrl);
  if (!target.ok) {
    done(target.reason, 403);
    return fail(target.reason, 403);
  }
  provider = target.preset.id;
  const preset = target.preset;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? PROXY_LIMITS.timeoutMs);
  const stop = () => clearTimeout(timer);
  let hops = 0;
  let res: Response;
  for (;;) {
    const host = new URL(target.url).hostname;
    let dns: { ok: boolean } = { ok: false };
    try {
      dns = await deps.resolve(host);
    } catch {}
    if (!dns.ok) {
      stop();
      done("dns", 403, { hops });
      return fail("dns", 403);
    }
    try {
      res = await deps.fetch(target.url, upstreamInit(preset, input, key, ctl.signal));
    } catch {
      stop();
      const kind = ctl.signal.aborted ? "timeout" : "network";
      done(kind, 504, { hops });
      return fail(kind, 504);
    }
    if (res.status < 300 || res.status > 399) break;
    const next = checkRedirect(res.status, res.headers.get("location"), target.url, preset, hops);
    await drop(res.body);
    if (!next.ok) {
      stop();
      done("redirect", 502, { hops, upstream: res.status });
      return fail("redirect", 502);
    }
    target = next;
    hops++;
  }

  if (!res.ok) {
    // Never the provider's body: an error message can echo part of the key.
    await drop(res.body);
    stop();
    const kind = res.status === 401 || res.status === 403 ? "auth" : "http";
    done(kind, 502, { hops, upstream: res.status });
    return fail(kind, 502, { status: res.status });
  }
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const len = Number(res.headers.get("content-length") ?? "0");
  if (type !== "application/json" || !res.body) {
    await drop(res.body);
    stop();
    done("type", 502, { hops, upstream: res.status });
    return fail("type", 502);
  }
  if (len > PROXY_LIMITS.maxResponseBytes) {
    await drop(res.body);
    stop();
    done("too-large", 502, { hops, upstream: res.status });
    return fail("too-large", 502);
  }
  const upstream = res.status;
  const body = capped(res.body, PROXY_LIMITS.maxResponseBytes, (bytes) => {
    stop();
    done(bytes > PROXY_LIMITS.maxResponseBytes ? "too-large" : "ok", upstream, { hops, bytes });
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}
