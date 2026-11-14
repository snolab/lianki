import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublishFile, readPublishInput } from "../packages/lianki-cli/app-publish.mjs";

test("bounded publish inputs validate before upload and close handles on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-input-"));
  try {
    const manifest = join(dir, "manifest.json"),
      html = join(dir, "app.html");
    await writeFile(manifest, JSON.stringify({ slug: "clock", name: "时钟" }));
    await writeFile(html, "<p>时钟</p>");
    expect(await readPublishInput(manifest, html)).toEqual({
      manifest: { slug: "clock", name: "时钟" },
      html: "<p>时钟</p>",
    });
    await expect(readPublishFile(html, 2)).rejects.toThrow("memory bound");
    await expect(readPublishFile(dir, 20)).rejects.toThrow("regular file");
    await expect(readPublishFile(join(dir, "missing"), 20)).rejects.toThrow();
    for (const text of ["[]", "null", "true", "bad json"]) {
      await writeFile(manifest, text);
      await expect(readPublishInput(manifest, html)).rejects.toThrow();
    }
    await writeFile(manifest, "{}");
    await writeFile(html, "   ");
    await expect(readPublishInput(manifest, html)).rejects.toThrow("empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
