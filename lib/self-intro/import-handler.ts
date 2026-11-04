/**
 * POST /api/self-intro/import (docs/self-intro-import.md): the import step's
 * one request. The page sends what the user typed, the text its parsers took
 * from the files, and shrunk images; this answers the facts to confirm.
 *
 * Privacy: the body is read into memory, handed to the model, and dropped
 * when the request ends. Nothing is written to D1, R2, the cache or a log
 * (unit/self-intro-import.test.ts checks that no store is touched). The rate
 * limit is in memory, per isolate, like the other self-intro routes.
 */
import { flagIn, type FlagValues } from "@/lib/flags";
import { checkRateLimit } from "@/lib/rateLimit";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import type { Complete } from "@/lib/read/gloss-server";
import { IMPORT } from "./import-config";
import { ImportRequest, extractSelfIntro } from "./import-extract";

/** Who gets the import step: everyone when `self-intro.import` is on, else the owner only. */
export function selfIntroImportOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner || flagIn(flags, IMPORT.flag);
}

export type ImportDeps = {
  user: { id: string; email: string } | null;
  owner: boolean;
  flags: FlagValues;
  configured: boolean;
  complete: Complete;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export async function handleImport(req: Request, deps: ImportDeps): Promise<Response> {
  if (!sameOriginJsonPost(req)) return json({ error: "forbidden" }, 403);
  if (!deps.user) return json({ error: "unauthorized" }, 401);
  if (!selfIntroImportOn(deps.flags, deps.owner)) return json({ error: "not-found" }, 404);

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > IMPORT.maxBodyBytes) return json({ error: "too-large" }, 413);

  const rate = checkRateLimit(`self-intro-import:${deps.user.id}`, IMPORT.rate);
  if (!rate.allowed)
    return json({ error: "rate-limited" }, 429, {
      "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)),
    });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json({ error: "bad-request" }, 400);
  }
  if (raw.length > IMPORT.maxBodyBytes) return json({ error: "too-large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad-request" }, 400);
  }
  const parsed = ImportRequest.safeParse(body);
  if (!parsed.success) {
    // Which rule failed, never the value.
    const tooBig = parsed.error.issues.some((i) => i.code === "too_big");
    return json({ error: tooBig ? "too-large" : "bad-request" }, tooBig ? 413 : 400);
  }
  if (!deps.configured) return json({ error: "not-configured" }, 503);

  const r = await extractSelfIntro(parsed.data, { userId: deps.user.id, complete: deps.complete });
  if (!r.ok) return json({ error: r.error }, r.error === "empty" ? 400 : 502);
  return json({ facts: r.facts });
}
