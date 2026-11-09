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
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { refusedResponse } from "@/lib/payments/metered";
import { flagIn, type FlagValues } from "@/lib/flags";
import { checkRateLimit } from "@/lib/rateLimit";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import type { Complete } from "@/lib/read/gloss-server";
import { IMPORT } from "./import-config";
import { ImportRequest, extractSelfIntro, importMessages } from "./import-extract";
import { creditsCover, storedImage } from "@/lib/import/ai-convert";
import { readAnyFile } from "@/lib/import/ai-read";
import { ImportFileError } from "./import-parse";
import { PARTNER_AI_MODEL } from "@/lib/partner-ai-config";
import { promptChars } from "@/lib/read/gloss-server";
import { textHoldUsd } from "@/lib/payments/prices";
import { z as zod } from "zod";
import { FollowupRequest, followupTurn } from "./followup";
import type { z } from "zod";

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
  /** The credit wallet the model call is paid from (lib/payments/metered.ts); null: unmetered. */
  db?: D1WithBatch | null;
  /** One of the user's own stored self-intro files (lib/import/files.ts), its bytes; null if not theirs. */
  readFile?: (
    userId: string,
    id: string,
  ) => Promise<{ name: string; type: string; bytes: Uint8Array } | null>;
  admin?: (email: string | null | undefined) => boolean;
};

/** The import's body: what the user typed, and the ids of their stored files to read. */
export const ImportBody = ImportRequest.extend({
  fileIds: zod
    .array(zod.string().regex(/^[0-9a-f]{20}$/))
    .max(IMPORT.maxFiles)
    .default([]),
});

/** The smallest hold an import can take (a few words, no file): below it, no start button. */
export const minImportHoldUsd = () =>
  textHoldUsd(
    PARTNER_AI_MODEL,
    promptChars(importMessages({ text: "x", images: [] }, "2026-01-01")),
    IMPORT.maxOutputTokens,
  );

/**
 * GET /api/self-intro/import → {on, available, need, have}: may this user
 * start an analysis (the gate, Workers AI, credits for the smallest hold)?
 */
export async function handleImportQuota(deps: ImportDeps): Promise<Response> {
  if (!deps.user) return json({ error: "unauthorized" }, 401);
  if (!selfIntroImportOn(deps.flags, deps.owner) || !deps.configured)
    return json({ on: false, available: false, need: 0, have: 0 });
  const q = await creditsCover(
    deps.user,
    { db: deps.db ?? null, admin: deps.admin },
    minImportHoldUsd(),
  );
  return json({ on: true, ...q });
}

/** The stored files' text and images, merged after what was typed, capped as the import. */
async function readStored(
  userId: string,
  ids: string[],
  deps: ImportDeps,
): Promise<{
  text: string;
  images: string[];
  truncated: boolean;
  failed: { id: string; code: string }[];
}> {
  const blocks: string[] = [];
  const images: string[] = [];
  const failed: { id: string; code: string }[] = [];
  let truncated = false;
  for (const id of ids) {
    const f = deps.readFile ? await deps.readFile(userId, id) : null;
    if (!f) {
      failed.push({ id, code: "not-found" });
      continue;
    }
    try {
      const p = await readAnyFile(
        {
          name: f.name,
          type: f.type,
          size: f.bytes.byteLength,
          arrayBuffer: async () =>
            f.bytes.buffer.slice(
              f.bytes.byteOffset,
              f.bytes.byteOffset + f.bytes.byteLength,
            ) as ArrayBuffer,
        },
        { shrinkImage: storedImage },
      );
      if (p.text.trim()) blocks.push(`--- ${f.name} ---\n${p.text}`);
      images.push(...p.images);
      truncated ||= p.truncated;
    } catch (e) {
      failed.push({ id, code: e instanceof ImportFileError ? e.code : "unreadable" });
    }
  }
  let text = blocks.join("\n\n");
  if (text.length > IMPORT.maxTextChars) {
    text = text.slice(0, IMPORT.maxTextChars);
    truncated = true;
  }
  if (images.length > IMPORT.maxImages) truncated = true;
  return { text, images: images.slice(0, IMPORT.maxImages), truncated, failed };
}

/** The user pays: their wallet, their email (an admin is free). */
const payer = (userId: string, deps: ImportDeps) => ({
  userId,
  email: deps.user?.email ?? null,
  db: deps.db ?? null,
  complete: deps.complete,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * The checks both routes share, cheapest first: same-origin JSON POST, signed
 * in, the flag, the size, the rate, then the body against its schema. Either
 * the parsed body and the user, or the error response.
 */
async function readChecked<T>(
  req: Request,
  deps: ImportDeps,
  opts: {
    key: string;
    maxBytes: number;
    rate: { windowMs: number; max: number };
    schema: z.ZodType<T>;
  },
): Promise<{ body: T; userId: string } | Response> {
  if (!sameOriginJsonPost(req)) return json({ error: "forbidden" }, 403);
  if (!deps.user) return json({ error: "unauthorized" }, 401);
  if (!selfIntroImportOn(deps.flags, deps.owner)) return json({ error: "not-found" }, 404);

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > opts.maxBytes) return json({ error: "too-large" }, 413);

  const rate = checkRateLimit(`${opts.key}:${deps.user.id}`, opts.rate);
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
  if (raw.length > opts.maxBytes) return json({ error: "too-large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad-request" }, 400);
  }
  const parsed = opts.schema.safeParse(body);
  if (!parsed.success) {
    // Which rule failed, never the value.
    const tooBig = parsed.error.issues.some((i) => i.code === "too_big");
    return json({ error: tooBig ? "too-large" : "bad-request" }, tooBig ? 413 : 400);
  }
  if (!deps.configured) return json({ error: "not-configured" }, 503);
  return { body: parsed.data, userId: deps.user.id };
}

export async function handleImport(req: Request, deps: ImportDeps): Promise<Response> {
  const c = await readChecked(req, deps, {
    key: "self-intro-import",
    maxBytes: IMPORT.maxBodyBytes,
    rate: IMPORT.rate,
    schema: ImportBody,
  });
  if (c instanceof Response) return c;
  // The user's own stored files are read here, on the server, into this request only.
  const stored = c.body.fileIds.length
    ? await readStored(c.userId, c.body.fileIds, deps)
    : { text: "", images: [], truncated: false, failed: [] };
  const typed = c.body.text.trim();
  const text = [typed, stored.text].filter(Boolean).join("\n\n").slice(0, IMPORT.maxTextChars);
  const request: ImportRequest = {
    text,
    images: [...c.body.images, ...stored.images].slice(0, IMPORT.maxImages),
    locale: c.body.locale,
  };
  const r = await extractSelfIntro(request, payer(c.userId, deps));
  if (!r.ok) {
    const refused = refusedResponse(r);
    if (refused) return refused;
    return json(
      { error: r.error, ...(stored.failed.length ? { fileErrors: stored.failed } : {}) },
      r.error === "empty" ? 400 : 502,
    );
  }
  return json({
    facts: r.facts,
    ...(stored.truncated ? { truncated: true } : {}),
    ...(stored.failed.length ? { fileErrors: stored.failed } : {}),
  });
}

/** POST /api/self-intro/followup -> {facts, question}: one turn of the Learning Partner's questions. */
export async function handleFollowup(req: Request, deps: ImportDeps): Promise<Response> {
  const c = await readChecked(req, deps, {
    key: "self-intro-followup",
    maxBytes: IMPORT.followup.maxBodyBytes,
    rate: IMPORT.followup.rate,
    schema: FollowupRequest,
  });
  if (c instanceof Response) return c;
  const r = await followupTurn(c.body, payer(c.userId, deps));
  if (!r.ok) return refusedResponse(r) ?? json({ error: r.error }, 502);
  return json({ facts: r.facts, question: r.question });
}
