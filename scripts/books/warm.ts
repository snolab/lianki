#!/usr/bin/env bun
// Pre-warm the /books source cache: fetch a catalogue book's source file the
// same way the server does (lib/books/source.ts: allowed hosts, size cap) and
// put it in R2 `lianki-blobs` under the key the server reads, so the first
// import is as fast as every later one. Imports nothing into any account.
//
//   bun scripts/books/warm.ts fr/histoires-ou-contes-du-temps-passé   # one book
//   bun scripts/books/warm.ts --all                                   # every entry
//
// Needs wrangler logged in to the Cloudflare account (it writes with
// `wrangler r2 object put --remote`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE, bookKey, catalogueBook } from "@/lib/books/catalogue";
import { fetchSourceFile, sourceCacheKey } from "@/lib/books/source";

const args = process.argv.slice(2);
const books = args.includes("--all")
  ? CATALOGUE
  : args.map((a) => {
      const b = catalogueBook(a.normalize("NFC"));
      if (!b) throw new Error(`not in the catalogue: ${a}`);
      return b;
    });
if (!books.length) {
  console.error("usage: bun scripts/books/warm.ts <lang>/<slug>… | --all");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "lianki-books-"));
try {
  for (const b of books) {
    const html = await fetchSourceFile(b);
    const key = await sourceCacheKey(b);
    const file = join(dir, "source.html");
    writeFileSync(file, html);
    const p = Bun.spawnSync(
      [
        "bunx",
        "wrangler",
        "r2",
        "object",
        "put",
        `lianki-blobs/${key}`,
        "--file",
        file,
        "--content-type",
        "text/html; charset=utf-8",
        "--remote",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (p.exitCode !== 0) throw new Error(`wrangler put failed for ${bookKey(b)}`);
    console.log(`warmed ${bookKey(b)} → ${key} (${html.length} chars)`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
