/**
 * Hot islands end to end (docs/dev-hot-islands.md), against LOCAL dev only:
 *
 *   bun run dev        # or: bunx next dev -p <port>
 *   LIANKI_URL=http://localhost:3000 bunx playwright test tests/hot-islands.spec.ts
 *
 * It runs scripts/dev/islands-server.ts on localhost with a throwaway entry,
 * grants the page by hand (the dev-only `__lkIslandsGrant`, since the hub that
 * grants code runs is not part of `next dev`), and checks that the override
 * renders with the page's React, that a save swaps it without a page reload,
 * and that a throwing island falls back to the built-in one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const BASE = process.env.LIANKI_URL ?? "";
test.skip(
  !/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE),
  "local dev only (LIANKI_URL=http://localhost:…)",
);

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => done(typeof a === "object" && a ? a.port : 0));
    });
  });

/** An islands entry whose header.brand renders `body` (a JSX expression). */
const entrySource = (body: string) => `
import { useState } from "react";
export const ISLANDS_API = 1;
export const versions = { "header.brand": 1 };
function RemoteBrand({ appName }) {
  const [n, setN] = useState(0);
  ${body}
}
export const islands = { "header.brand": RemoteBrand };
`;
const v = (tag: string) =>
  `return <button type="button" data-island-test="${tag}" onClick={() => setN(n + 1)}>remote ${tag} {appName} {n}</button>;`;

let dir = "";
let entry = "";
let server: ChildProcess | null = null;
let src = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lk-islands-"));
  entry = join(dir, "entry.jsx");
  writeFileSync(entry, entrySource(v("v1")));
  const port = await freePort();
  src = `http://localhost:${port}/islands.js`;
  server = spawn(
    "bun",
    [
      resolve("scripts/dev/islands-server.ts"),
      "--port",
      String(port),
      "--entry",
      entry,
      "--no-typecheck",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => fail(new Error("islands server did not start")), 30_000);
    server?.stdout?.on("data", (b: Buffer) => {
      if (String(b).includes("listening on")) {
        clearTimeout(t);
        done();
      }
    });
  });
});

test.afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("override renders, hot-reloads in place, and falls back on a throw", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((s) => localStorage.setItem("lk:slots-src", s), src);
  await page.goto("/en");
  const brand = page.locator("header [data-brand-domain]").first();
  await expect(brand).toBeAttached();

  // No grant yet: the built-in island, and nothing hot.
  await page.waitForFunction(
    () => typeof (globalThis as Record<string, unknown>).__lkIslandsGrant === "function",
  );
  await expect(page.locator("[data-island-test]")).toHaveCount(0);

  // A live code-run grant: the remote island renders, with the page's React (useState works).
  await page.evaluate(() => {
    (globalThis as unknown as { __lkIslandsGrant: (u: number) => void }).__lkIslandsGrant(
      Date.now() + 600_000,
    );
    (window as unknown as { __marker: number }).__marker = 42;
  });
  const v1 = page.locator('[data-island-test="v1"]');
  await expect(v1).toHaveText(/remote v1 Lianki 0/);
  await v1.click();
  await expect(v1).toHaveText(/remote v1 Lianki 1/);

  // A save: the server pushes slot-reload and only the island swaps — no page reload.
  writeFileSync(entry, entrySource(v("v2")));
  await expect(page.locator('[data-island-test="v2"]')).toHaveText(/remote v2 Lianki/, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42);

  // An island that throws: the boundary shows the built-in one.
  writeFileSync(entry, entrySource(`if (appName) throw new Error("boom"); ${v("never")}`));
  await expect(page.locator("[data-island-test]")).toHaveCount(0, { timeout: 20_000 });
  await expect(brand).toBeAttached();
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42);

  // Grant withdrawn: back to built in for good.
  writeFileSync(entry, entrySource(v("v3")));
  await expect(page.locator('[data-island-test="v3"]')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() =>
    (globalThis as unknown as { __lkIslandsGrant: (u: number | null) => void }).__lkIslandsGrant(
      null,
    ),
  );
  await expect(page.locator("[data-island-test]")).toHaveCount(0);
});

test("an origin off the allowlist is ignored", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("lk:slots-src", "https://evil.example/islands.js"),
  );
  await page.goto("/en");
  await page.waitForTimeout(500);
  const status = await page.evaluate(() => localStorage.getItem("lk:s:islands.status"));
  expect(status).toContain("not an allowed origin");
});
