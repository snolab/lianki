import { DEV_BRIDGE_HEADER, DEV_BRIDGE_MIN_LENGTH } from "@/lib/dev-bridge";

/**
 * The owner's preview server (docs/dev-whole-page.md) and his recordings
 * (docs/recordings.md, "On the preview"). Clips are sealed with a key derived
 * from production's AUTH_SECRET, which the preview never holds (owner decision
 * 2026-11-14 21:48 JST, "走 A"). So once the preview has checked his session,
 * it hands /api/my/recordings to lianki.com with the dev bridge header, and
 * lianki.com — which has the key — answers as him (lib/dev-bridge-user.ts).
 */
export const RECORDINGS_UPSTREAM = "https://lianki.com/api/my/recordings";

/**
 * Response headers passed back from lianki.com; nothing else (no cookies). Not
 * content-length: fetch may have decompressed the body.
 */
const PASSED = ["content-type", "content-disposition"];

/**
 * The bridge secret to send, only on the whole-page preview server, where
 * `serve` puts the `.dev-whole-page.json` copy in LIANKI_DEV_BRIDGE_SECRET.
 * Anywhere else, or unset/short: null, and the route serves itself as before.
 */
export function recordingsBridgeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LIANKI_DEV_WHOLE_PAGE !== "1") return null;
  const s = env.LIANKI_DEV_BRIDGE_SECRET;
  return s && s.length >= DEV_BRIDGE_MIN_LENGTH ? s : null;
}

/**
 * Forward one /api/my/recordings request to lianki.com: same method, query and
 * body; no cookie, no Authorization — only the bridge header. The answer comes
 * back streamed with its status and the content headers. An unreachable
 * lianki.com is a 502 that names nothing (never the secret or the error text).
 */
export async function forwardRecordings(
  req: Request,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = RECORDINGS_UPSTREAM + new URL(req.url).search;
  const headers: Record<string, string> = { [DEV_BRIDGE_HEADER]: secret };
  const type = req.headers.get("content-type");
  if (type) headers["content-type"] = type;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let up: Response;
  try {
    up = await fetchImpl(url, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      signal: req.signal,
    });
  } catch {
    console.error("[recordings-bridge] lianki.com unreachable");
    return Response.json(
      { error: "bridge-unreachable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
  const out = new Headers({ "cache-control": "no-store" });
  for (const h of PASSED) {
    const v = up.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  return new Response(up.body, { status: up.status, headers: out });
}
