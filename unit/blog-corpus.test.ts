import { describe, expect, test } from "bun:test";
import { buildCorpus, writeCorpus, CORPUS_PATH } from "../scripts/gen-blog-corpus";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import corpus from "../lib/blog.corpus.json";
import { getAllSlugs, getPost, getRawPost, getRawPostWithFallback } from "../lib/blog";

/**
 * lib/blog.corpus.json is generated from blog/. If it drifts, the site serves
 * stale or missing posts — and on Workers that is the ONLY copy of the content,
 * because there is no filesystem to fall back to. The failure mode is a page
 * that renders empty with a 200, so nothing else would catch it.
 */
describe("blog corpus", () => {
  test("is in sync with blog/ on disk", () => {
    expect(corpus as Record<string, string>).toEqual(buildCorpus());
  });

  test("carries every English post, and getAllSlugs agrees", async () => {
    const enKeys = Object.keys(corpus).filter((k) => k.startsWith("en/"));
    expect(enKeys.length).toBeGreaterThan(0);
    expect((await getAllSlugs()).length).toBe(enKeys.length);
  });

  test("reads a real post without touching the filesystem", async () => {
    const slug = (await getAllSlugs())[0]!;
    expect(await getRawPost("en", slug)).toContain("---");
    const post = await getPost("en", slug);
    expect(post?.slug).toBe(slug);
    expect(post?.contentHtml.length).toBeGreaterThan(0);
  });

  test("an unknown post is null, not a throw", async () => {
    expect(await getRawPost("en", "no-such-post-xyz")).toBeNull();
    expect(await getPost("en", "no-such-post-xyz")).toBeNull();
  });

  test("falls back to English when a locale lacks the post", async () => {
    const enOnly = Object.keys(corpus)
      .filter((k) => k.startsWith("en/"))
      .map((k) => k.slice(3))
      .find((slug) => !(`zz/${slug}` in corpus))!;
    expect(enOnly).toBeDefined();
    // A locale that does not exist at all must still resolve via English.
    expect(await getRawPostWithFallback("zz", enOnly)).toBe(await getRawPost("en", enOnly));
    // English itself has no further fallback.
    expect(await getRawPostWithFallback("en", "no-such-post-xyz")).toBeNull();
    // A locale that does have the post gets its own copy, not English.
    const ja = Object.keys(corpus).find((k) => k.startsWith("ja/"));
    if (ja) {
      const slug = ja.slice(3);
      expect(await getRawPostWithFallback("ja", slug)).toBe(await getRawPost("ja", slug));
    }
  });
});

describe("gen-blog-corpus", () => {
  test("writes the corpus, reports drift, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "blogcorpus-"));
    try {
      mkdirSync(join(root, "blog", "en"), { recursive: true });
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "blog", "en", "a-post.md"), "---\ntitle: A\n---\nbody");
      writeFileSync(join(root, "blog", "en", "notes.txt"), "ignored — not markdown");

      const first = writeCorpus(root);
      expect(first.changed).toBe(true);
      expect(first.count).toBe(1);

      const written = JSON.parse(readFileSync(join(root, CORPUS_PATH), "utf-8"));
      expect(Object.keys(written)).toEqual(["en/a-post"]);

      // Unchanged input must not rewrite the file — otherwise every commit churns.
      expect(writeCorpus(root).changed).toBe(false);

      writeFileSync(join(root, "blog", "en", "b-post.md"), "---\ntitle: B\n---\n");
      expect(writeCorpus(root).changed).toBe(true);
      expect(buildCorpus(root)["en/b-post"]).toContain("title: B");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
