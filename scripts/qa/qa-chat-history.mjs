// /chat/history (docs/chat-history.md): the account's chat lines. Silent;
// iPhone and desktop, light and dark screenshots.
//
//   QA_BASE=http://localhost:3457 bun scripts/qa/qa-chat-history.mjs [outDir]
//
// Local only: needs `next dev` (or wrangler dev) on the LOCAL D1 with
// migrations applied, and seeds rows with `wrangler d1 execute --local`
// (lines come from the hub in production; there is no API to write them).
// Signs up two throwaway accounts and checks: lines newest first, grouped by
// written-out dates, lane marks and names, the ask tag and its answer;
// search and the lane filter (and that both go in the address); deleting a
// line and a day; the other account sees none of it and gets 404 deleting it.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3000";
const OUT = process.argv[2] || "test-results/chat-history";
const PW = "qa-test-pass-1234";
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const sql = (command) =>
  execFileSync("bunx", ["wrangler", "d1", "execute", "lianki", "--local", "--command", command], {
    stdio: "pipe",
    env: { ...process.env, CI: "1" },
  });
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;

async function account(browser, device, tag) {
  const ctx = await newSilentContext(browser, { ...device, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: { email: `qa+hist${tag}${Date.now()}@lianki.test`, password: PW, name: "QA History" },
    headers: { origin: BASE },
  });
  check(r.ok(), `${tag}: sign-up (${r.status()})`);
  const s = await (await ctx.request.get("/api/auth/get-session")).json();
  return { ctx, id: s?.user?.id };
}

function seed(user) {
  const day = 86_400_000;
  const now = Date.now();
  const rows = [
    ["l1", "owner", null, "Morning! Can you check the words deck?", now - 2 * day, 0, null],
    ["l2", "agent", "main", "On it — the deck has 12 due now.", now - 2 * day + 60_000, 0, null],
    ["l3", "agent", "codex", "Pushed the fix for the sync button.", now - day, 0, null],
    ["l4", "agent", "agy", "Translations are in for 16 locales.", now - day + 1000, 0, null],
    ["l5", "agent", "main", "Ship it? — Yes / Not yet", now - 3600_000, 1, "Yes"],
    ["l6", "owner", null, "Thanks, looks good on the phone.", now - 60_000, 0, null],
  ];
  sql(
    `INSERT OR REPLACE INTO chat_line (user_id, id, thread, sender, lane, text, at_ms, ask, answer) VALUES ` +
      rows
        .map(
          ([id, from, lane, text, at, ask, answer]) =>
            `(${q(user)}, ${q(`${user}-${id}`)}, 'owner', ${q(from)}, ${lane ? q(lane) : "NULL"}, ${q(text)}, ${at}, ${ask}, ${answer ? q(answer) : "NULL"})`,
        )
        .join(", "),
  );
}

const browser = await launchSilent(chromium);
try {
  for (const [name, device] of [
    ["iphone", devices["iPhone 13"]],
    ["desktop", { viewport: { width: 1280, height: 860 } }],
  ]) {
    const a = await account(browser, device, `${name}a`);
    const b = await account(browser, device, `${name}b`);
    seed(a.id);
    const page = await a.ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("dialog", (d) => void d.accept());
    await page.goto("/chat/history", { waitUntil: "networkidle" });
    const lines = page.getByTestId("chat-history-line");
    await lines.first().waitFor();
    check((await lines.count()) === 6, `${name}: 6 lines`);
    const days = await page.getByTestId("chat-history-day").count();
    check(days === 3, `${name}: grouped into 3 days (${days})`);
    const heads = await page.locator("[data-testid=chat-history-day] h2").allTextContents();
    check(
      heads.every((h) => /[A-Za-z]+ \d{4}|\d{4}/.test(h) && !/^\d{1,2}\/\d{1,2}\//.test(h)),
      `${name}: written-out dates (${heads.join(" | ")})`,
    );
    check(
      (await lines.first().textContent())?.includes("Thanks, looks good"),
      `${name}: newest first`,
    );
    check(
      (await page.locator("[data-lane=codex] [data-testid=debug-chat-lane-mark]").count()) === 1,
      `${name}: codex line has its lane mark`,
    );
    check(
      (
        await page.locator("[data-testid=chat-history-line][data-lane=agy]").textContent()
      )?.includes("杰咪"),
      `${name}: agy line has its lane name (杰咪)`,
    );
    check(
      (await page.getByText("Answered: Yes").count()) === 1,
      `${name}: ask card shows its answer`,
    );
    check(
      await page.getByTestId("chat-history-follows").isVisible(),
      `${name}: says history follows the account`,
    );
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(OUT, `${name}-${scheme}.png`), fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "light" });

    // Search, in the address.
    await page.getByTestId("chat-history-search").fill("sync");
    await page.waitForURL(/q=sync/);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 1,
    );
    check(true, `${name}: search narrows to 1 line, q in the address`);
    await page.getByTestId("chat-history-search").fill("");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 6,
    );
    // Lane filter.
    await page.getByTestId("chat-history-lane-you").click();
    await page.waitForURL(/lane=you/);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 2,
    );
    check(true, `${name}: lane filter "you" shows the 2 own lines`);
    await page.getByTestId("chat-history-lane-you").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 6,
    );

    // The other account: nothing, and 404 deleting it.
    const other = await b.ctx.request.get("/api/chat/history");
    check(
      other.ok() && (await other.json()).lines.length === 0,
      `${name}: another account sees none of these lines`,
    );
    const steal = await b.ctx.request.delete("/api/chat/history", {
      data: { id: `${a.id}-l6` },
      headers: { origin: BASE },
    });
    check(steal.status() === 404, `${name}: another account's delete is 404 (${steal.status()})`);
    const anon = await newSilentContext(browser, { baseURL: BASE });
    check(
      (await anon.request.get("/api/chat/history")).status() === 404,
      `${name}: signed out is 404`,
    );
    await anon.close();

    // Delete a line, then a day.
    await lines.first().getByTestId("chat-history-delete-line").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 5,
    );
    await page.getByTestId("chat-history-delete-day").last().click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid=chat-history-line]").length === 3,
    );
    await page.reload({ waitUntil: "networkidle" });
    await lines.first().waitFor();
    check((await lines.count()) === 3, `${name}: deletes stick after a reload`);
    check(errs.length === 0, `${name}: no page errors ${errs.join("; ")}`);
    await a.ctx.close();
    await b.ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
