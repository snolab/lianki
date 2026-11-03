// The server's copy of a language's lemma file (lib/read/lemma.ts), read once
// per isolate from the Worker's static assets (the ASSETS binding), or from
// public/ in `next dev` and tests. Used where the server matches a book's
// words to the reader's cards: the ring, the pass, the scan's word rows.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { hasLemmas, lemmaPath, lemmaText, parseLemmas, type Lemmas } from "./lemma";
import { foldsOf } from "./words";

const texts = new Map<string, Promise<string | null>>();

type Assets = { fetch: (req: Request) => Promise<Response> };

function workerAssets(): Assets | null {
  try {
    return (getCloudflareContext().env as { ASSETS?: Assets }).ASSETS ?? null;
  } catch {
    return null; // not in a Worker request (next dev, tests)
  }
}

/** A lemma file's text: from the Worker's assets, else from public/; null when neither has it. */
export async function readLemmaFile(
  lang: string,
  assets: Assets | null = workerAssets(),
): Promise<string | null> {
  const path = lemmaPath(lang);
  const r = assets
    ? await assets.fetch(new Request(`https://assets.local${path}`)).catch(() => null)
    : null;
  if (r?.ok) return lemmaText(await r.arrayBuffer());
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const b = await readFile(join(process.cwd(), "public", path)).catch(() => null);
  return b
    ? lemmaText(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
    : null;
}

function lemmaFile(lang: string): Promise<string | null> {
  if (!hasLemmas(lang)) return Promise.resolve(null);
  let p = texts.get(lang);
  if (!p) {
    p = readLemmaFile(lang).catch(() => null);
    // A failed read is tried again on the next request.
    p.then((t) => t === null && texts.delete(lang));
    texts.set(lang, p);
  }
  return p;
}

/** The dictionary entries that a book's words need, or null (no file for the language). */
export async function lemmasForWords(
  lang: string,
  words: Iterable<string>,
): Promise<Lemmas | null> {
  const text = await lemmaFile(lang);
  if (!text) return null;
  const only = new Set<string>();
  for (const w of words) for (const f of foldsOf(w, lang)) only.add(f);
  return parseLemmas(text, only);
}
