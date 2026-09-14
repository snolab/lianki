/**
 * Generates lib/blog.corpus.json from blog/<locale>/<slug>.md.
 *
 * Why this exists: lib/blog.ts used to read the markdown off disk with
 * fs.readFile(process.cwd()...). That works on Vercel and returns nothing on
 * Cloudflare Workers, which has no filesystem — and because the reads are
 * wrapped in catch, it fails by rendering an empty page with a 200 rather than
 * erroring. Every route is dynamically rendered (the root layout awaits
 * headers()/cookies()), so there is no prerendered copy to fall back on: the
 * blog is empty on the very first request.
 *
 * Bundling is therefore not an optimisation, it is the only way the content
 * reaches the Worker at all. ~460 KB of markdown, inlined by the bundler.
 *
 * Run by scripts/pre-commit.ts, the same way lib/userscript-version.ts is kept
 * in sync. unit/blog-corpus.test.ts fails if the two ever drift.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export const BLOG_DIR = "blog";
export const CORPUS_PATH = "lib/blog.corpus.json";

/** `{ "en/2025-01-01-introduction": "---\ntitle: ...", ... }`, sorted for a stable diff. */
export function buildCorpus(root = process.cwd()): Record<string, string> {
  const blogRoot = join(root, BLOG_DIR);
  const out: Record<string, string> = {};
  for (const locale of readdirSync(blogRoot).sort()) {
    const dir = join(blogRoot, locale);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // not a directory (e.g. a stray file at the blog root)
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".md")) continue;
      out[`${locale}/${file.replace(/\.md$/, "")}`] = readFileSync(join(dir, file), "utf-8");
    }
  }
  return out;
}

export function writeCorpus(root = process.cwd()): {
  path: string;
  changed: boolean;
  count: number;
} {
  const corpus = buildCorpus(root);
  const path = join(root, CORPUS_PATH);
  const next = JSON.stringify(corpus, null, 2) + "\n";
  const prev = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (prev !== next) writeFileSync(path, next);
  return { path, changed: prev !== next, count: Object.keys(corpus).length };
}

if (import.meta.main) {
  const r = writeCorpus();
  console.log(`${r.changed ? "updated" : "up to date"}: ${CORPUS_PATH} (${r.count} posts)`);
}
