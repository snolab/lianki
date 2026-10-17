import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildCorpus } from "../scripts/gen-blog-corpus";
import { insertIntoCorpus } from "../lib/blog-corpus-insert";

const serialize = (c: Record<string, string>) => JSON.stringify(c, null, 2) + "\n";

/**
 * The translate route commits translations with this function instead of
 * running gen-blog-corpus. If the two ever disagree, the bot's commits fail the
 * drift test (and auto-merge never lands them), or churn on the next commit.
 */
describe("insertIntoCorpus", () => {
  test("produces exactly what gen-blog-corpus would after adding the file", () => {
    const root = mkdtempSync(join(tmpdir(), "corpusinsert-"));
    try {
      const write = (rel: string, body: string) => {
        mkdirSync(join(root, "blog", rel.split("/")[0]!), { recursive: true });
        writeFileSync(join(root, "blog", rel), body);
      };
      write("en/2025-01-01-a.md", "---\ntitle: A\n---\n");
      write("en/2025-02-01-b.md", "---\ntitle: B\n---\n");
      write("ja/2025-02-01-b.md", "B ja");
      // `.lock.md` sorts before `.md` as a filename but after it as a bare key.
      write("ja/2025-02-01-b.lock.md", "{}");
      write("zh/2025-01-01-a.md", "A zh");

      const before = serialize(buildCorpus(root));

      write("fr/2025-02-01-b.md", 'B fr — « guillemets » "quotes"\n');
      write("ja/2025-01-01-a.md", "A ja");
      const expected = serialize(buildCorpus(root));

      const actual = insertIntoCorpus(
        insertIntoCorpus(before, "fr/2025-02-01-b", 'B fr — « guillemets » "quotes"\n'),
        "ja/2025-01-01-a",
        "A ja",
      );
      expect(actual).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("round-trips the real corpus unchanged", () => {
    const real = readFileSync("lib/blog.corpus.json", "utf-8");
    const [key, content] = Object.entries(JSON.parse(real) as Record<string, string>).at(-1)!;
    expect(insertIntoCorpus(real, key, content)).toBe(real);
  });

  test("replaces an existing entry in place", () => {
    const json = serialize({ "en/a": "x", "fr/a": "old" });
    expect(insertIntoCorpus(json, "fr/a", "new")).toBe(serialize({ "en/a": "x", "fr/a": "new" }));
  });
});
