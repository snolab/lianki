#!/usr/bin/env bun
/**
 * Publish a mini app into the LOCAL D1 and R2 (.wrangler/state, what `bun run
 * dev` reads), as the given local account — docs/mini-apps.md, "Who can
 * publish". Never production: the bindings come from getPlatformProxy with
 * remote bindings off.
 *
 *   bun scripts/dev/mini-app-publish.ts [app.html] [manifest.json] [--user you@example.com]
 *
 * Defaults to the calculator sample (scripts/dev/mini-apps/calculator.*), and
 * to the first local account holding `dev`. Then open http://localhost:3000/m/<slug>.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "@/lib/mini-apps/handlers";
import { CONFIG } from "@/lib/config";

const root = join(import.meta.dir, "../..");
const args = process.argv.slice(2);
const userAt = args.indexOf("--user");
const email = userAt >= 0 ? args[userAt + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith("--") && (userAt < 0 || i !== userAt + 1));
const htmlPath = files[0] ?? join(import.meta.dir, "mini-apps/calculator.html");
const manifestPath = files[1] ?? htmlPath.replace(/\.html$/, ".manifest.json");

type D1 = {
  prepare(q: string): {
    bind(...v: unknown[]): { first<T>(): Promise<T | null> };
    first<T>(): Promise<T | null>;
  };
  exec(q: string): Promise<unknown>;
};

const { getPlatformProxy } = await import("wrangler");
const proxy = await getPlatformProxy<{ DB: D1; BLOBS: unknown }>({
  configPath: join(root, "wrangler.jsonc"),
  remoteBindings: false,
  envFiles: [],
});
try {
  const db = proxy.env.DB;
  // The tables, if this local database predates migration 0078 (idempotent).
  const sql = await readFile(join(root, "db/migrations/0078_mini_apps.sql"), "utf8");
  for (const stmt of sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean))
    await db.prepare(stmt).first();
  const user = email
    ? await db
        .prepare("SELECT id, email FROM user WHERE email = ?")
        .bind(email)
        .first<{ id: string; email: string }>()
    : await db
        .prepare(
          `SELECT u.id, u.email FROM user u JOIN account_permission p ON p.email = u.email
           WHERE p.permission = 'dev' AND p.revoked_at IS NULL ORDER BY p.granted_at LIMIT 1`,
        )
        .first<{ id: string; email: string }>()
        .catch(() => null);
  if (!user) {
    console.error(
      "No local account found: sign in once on http://localhost:3000, or pass --user <email>.",
    );
    process.exit(1);
  }
  const body = JSON.stringify({
    manifest: JSON.parse(await readFile(manifestPath, "utf8")),
    html: await readFile(htmlPath, "utf8"),
  });
  const res = await publish(
    new Request("http://localhost:3000/api/my/mini-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    {
      who: async () => ({ id: user.id, email: user.email, dev: true }),
      on: async () => true,
      db: () => db as never,
      bucket: () => proxy.env.BLOBS as never,
      config: async () => ({
        maxBytes: CONFIG["miniApps.maxBytes"].default,
        storageBytes: CONFIG["miniApps.storageBytes"].default,
        perAccount: CONFIG["miniApps.perAccount"].default,
        callsPerMinute: CONFIG["miniApps.callsPerMinute"].default,
        cardWaitMs: CONFIG["miniApps.cardWaitMs"].default,
        origin: CONFIG["miniApps.origin"].default,
        scripts: CONFIG["miniApps.scriptOrigins"].default,
        styles: CONFIG["miniApps.styleOrigins"].default,
        fonts: CONFIG["miniApps.fontOrigins"].default,
        prefKeys: CONFIG["miniApps.prefKeys"].default,
      }),
    },
  );
  const out = (await res.json()) as { url?: string };
  console.log(res.status, JSON.stringify(out));
  if (out.url) console.log(`Open http://localhost:3000${out.url} signed in as ${user.email}`);
  if (!res.ok) process.exitCode = 1;
} finally {
  await proxy.dispose();
}
