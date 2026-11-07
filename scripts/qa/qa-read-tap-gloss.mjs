// A tap on a new word shows its AI meaning, paid once; the commit does not pay again
// (docs/books-plan.md, "Grading from the selection card"; docs/byok.md). Silent;
// iPhone size, light and dark. Against a local `wrangler dev` on local D1, with the
// model stubbed by the small server here: nothing reaches a real model, and it counts
// the calls. Not in qa:all, whose Worker has no model. A throwaway account each time,
// the public-domain fixture EPUB, made-up text under a fake doc id.
//
//   bun scripts/qa/qa-read-tap-gloss.mjs starts the stub on QA_STUB_PORT (3499).
//   The Worker has to call it, so, in a checkout of its own, after the OpenNext build:
//
//     grep -rl https://api.cloudflare.com/client/v4/accounts .open-next \
//       | xargs sed -i '' 's#https://api.cloudflare.com/client/v4/accounts#http://127.0.0.1:3499/client/v4/accounts#g'
//     bunx wrangler dev --port 3491 --local --var CLOUDFLARE_ACCOUNT_ID:qa --var CLOUDFLARE_AI_TOKEN:qa
//     QA_BASE=http://localhost:3491 bun scripts/qa/qa-read-tap-gloss.mjs [outDir]
//
// It turns the flag read.gdoc-stream on in the local D1, and off at the end. Rebuild afterwards: that bundle is for this script only.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, devices } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const BASE = process.env.QA_BASE || "http://localhost:3491";
const STUB_PORT = Number(process.env.QA_STUB_PORT || 3499);
const OUT = process.argv[2] || "test-results/read-tap-gloss";
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";
const PW = "qa-test-pass-1234";
const FLAGS = ["read.gdoc-stream"];
const STUB_BACK = (w) => `stub meaning of ${w}`;
mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const until = async (page, f, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const d1 = (command) => {
  const r = spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "lianki", "--local", "--command", command],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`local D1: ${r.stderr}`);
};
const setFlags = (on) =>
  d1(
    on
      ? `INSERT OR REPLACE INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ${FLAGS.map(
          (f) => `('${f}', 1, '2026-11-06T00:00:00.000Z', 'qa')`,
        ).join(", ")}`
      : `DELETE FROM feature_flags WHERE key IN (${FLAGS.map((f) => `'${f}'`).join(", ")})`,
  );

// ── The stubbed model: OpenAI-compatible, counts its calls by word ──
const stub = { calls: [], delayMs: 0, fail: false };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    // A gloss asks with a JSON list of words; anything else (a sentence's translation) is not counted.
    let asked = null;
    try {
      asked = JSON.parse(body.messages?.[1]?.content || "[]").map((x) => x.word);
    } catch {}
    if (asked) stub.calls.push(...asked);
    const { delayMs, fail } = stub;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.setHeader("content-type", "application/json");
    if (fail) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "stubbed failure" } }));
    }
    res.end(
      JSON.stringify({
        id: "stub",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: asked
                ? JSON.stringify(Object.fromEntries(asked.map((w) => [w, STUB_BACK(w)])))
                : "stub translation",
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
  });
});
await new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r));
const callsOf = (w) => stub.calls.filter((x) => x === w).length;

const browser = await launchSilent(chromium);

async function touchDrag(cdp, page, knob, dx) {
  const b = await knob.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 14; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 14, y }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function newAccount(scheme, tag, init, arg) {
  // The shared meanings of an earlier part: each part starts with no cache.
  d1("DELETE FROM word_gloss");
  stub.calls.length = 0;
  const ctx = await newSilentContext(browser, {
    ...devices["iPhone 15"],
    baseURL: BASE,
    colorScheme: scheme,
  });
  if (init) await ctx.addInitScript(init, arg);
  const r = await ctx.request.post("/api/auth/sign-up/email", {
    data: {
      email: `qa+tapgloss-${tag}${scheme}${Date.now()}@lianki.test`,
      password: PW,
      name: "QA",
    },
    headers: { origin: BASE },
  });
  check(r.ok(), `sign-up ${tag} (${r.status()})`);
  return ctx;
}

function watch(page) {
  const seen = { errs: [], writes: [], glosses: [], makes: 0 };
  page.on("pageerror", (e) => seen.errs.push(e.message));
  page.on("request", (q) => {
    if (q.method() !== "POST") return;
    if (q.url().includes("/make-cards")) seen.makes++;
    if (q.url().includes("/gloss")) seen.glosses.push(JSON.parse(q.postData() || "{}"));
    if (q.url().includes("/batch-grade")) {
      const b = JSON.parse(q.postData() || "{}");
      if (!b.probe) seen.writes.push(b);
    }
  });
  return seen;
}

async function openBook(page) {
  await page.goto("/read", { waitUntil: "networkidle" });
  await page.locator('[data-testid="read-import-epub"] input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL(/\/read\/[^/?]+$/, { timeout: 30000 });
  const id = page.url().split("/").pop();
  await page.goto(`/read/${id}`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await page.locator("[data-testid=reader-book] [data-item]").first().waitFor();
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")));
  return id;
}

/** Words with no card, none of `used`: the longest first, the likeliest to be in no deck. */
const spots = (page, used) =>
  page.evaluate(
    (used) =>
      [
        ...new Set(
          [
            ...document.querySelectorAll(
              '[data-testid=reader-book] [data-t][data-f="u"], [data-testid=reader-book] [data-t][data-f="n"]',
            ),
          ]
            .map((el) => el.textContent)
            .filter((t) => /^[a-z]+$/.test(t) && !used.includes(t)),
        ),
      ]
        .sort((a, b) => b.length - a.length)
        .slice(0, 40),
    used,
  );

/**
 * Tap words till the route asks the model for one, whichever: the fixture's decks
 * know many, and a name of the book gets no model. Returns that word.
 */
async function tapUnknown(page, seen, used) {
  for (const text of await spots(page, used)) {
    used.push(text);
    const n = stub.calls.length;
    const asked = seen.glosses.length;
    await tapText(page, text);
    await until(page, () => seen.glosses.length > asked, 1500);
    if (await until(page, () => stub.calls.length > n, 1500)) return stub.calls.at(-1);
    await page
      .getByTestId("read-select-close")
      .click()
      .catch(() => {});
    await page.waitForTimeout(500);
  }
  return null;
}
/** That word of the book, wherever it is now. */
async function tapText(page, text) {
  const p = await page.evaluate((text) => {
    const el = [...document.querySelectorAll("[data-testid=reader-book] [data-t]")].find(
      (x) => x.textContent === text,
    );
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  await page.waitForTimeout(300);
  await page.touchscreen.tap(p.x, p.y);
}
const probeOf = async (ctx, id, w) =>
  (
    await (
      await ctx.request.post(`/api/read/${id}/batch-grade`, {
        data: { probe: { sentences: [], words: [{ w }] } },
        headers: { origin: BASE },
      })
    ).json()
  ).words?.[0];
const closeCard = async (page) => {
  await page
    .getByTestId("read-select-close")
    .click()
    .catch(() => {});
  await page.waitForTimeout(600);
};

async function floatingCard(scheme) {
  console.log(`— the reader's card, ${scheme}`);
  const ctx = await newAccount(scheme, "float");
  const page = await ctx.newPage();
  const seen = watch(page);
  const cdp = await ctx.newCDPSession(page);
  const id = await openBook(page);
  const used = [];

  // A tap: the AI meaning at once, one model call, nothing stored.
  const w = await tapUnknown(page, seen, used);
  check(!!w, `a tap asks the model for a word nothing knows (${w})`);
  const back = page.getByText(STUB_BACK(w));
  check(await until(page, () => back.isVisible(), 8000), "its meaning shows on the card");
  const knob = page.getByTestId("read-grade-knob");
  check(await until(page, () => knob.isVisible(), 8000), "the slider is there");
  check((await page.locator("[data-testid=read-grade-make]").count()) === 0, "no 制卡 button");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `reader-tap-${scheme}.png`) });
  check((await probeOf(ctx, id, w))?.listId === null, "the tap stored no card");
  check(seen.writes.length === 0 && seen.makes === 0, "the tap wrote nothing");

  // A second tap, and after a reload (the tab's memory gone): no second call.
  await closeCard(page);
  const glossesBefore = seen.glosses.length;
  const text = used.at(-1);
  await tapText(page, text);
  check(await until(page, () => back.isVisible(), 5000), "tapped again: the meaning");
  check(seen.glosses.length === glossesBefore, "tapped again: not even asked in this tab");
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 20000 });
  await until(page, () => page.evaluate(() => !!document.querySelector(".lk-book [data-f]")));
  await page.waitForTimeout(500);
  await tapText(page, text);
  check(
    await until(page, () => back.isVisible(), 8000),
    "after a reload: the meaning, from the cache",
  );
  check(callsOf(w) === 1, `the model was asked once for it (${callsOf(w)})`);

  // The commit: past a level, after the hold, carrying it; no second call.
  await until(page, () => knob.isVisible(), 8000);
  await page.waitForTimeout(600);
  await touchDrag(cdp, page, knob, 56);
  check(
    await until(page, () => seen.writes.length === 1, 12000),
    "the batch is sent after the hold",
  );
  check(
    seen.writes[0]?.words?.[0]?.back === STUB_BACK(w),
    `the commit carries the tap's meaning (${seen.writes[0]?.words?.[0]?.back})`,
  );
  await page.waitForTimeout(1500);
  const after = await probeOf(ctx, id, w);
  check(!!after?.listId, "committed: the card exists");
  check(callsOf(w) === 1, `the commit asked the model nothing more (${callsOf(w)})`);
  await page.screenshot({ path: join(OUT, `reader-committed-${scheme}.png`) });
  await closeCard(page);

  // A commit while the tap's call is still out: it waits, one call in all.
  stub.delayMs = 11000;
  const slow = await tapUnknown(page, seen, used);
  check(!!slow, `slow model: a tap (${slow})`);
  await until(page, () => knob.isVisible(), 8000);
  await page.waitForTimeout(600);
  const writes0 = seen.writes.length;
  await touchDrag(cdp, page, knob, 56);
  await page.waitForTimeout(9000);
  check(seen.writes.length === writes0, "past the hold, the tap still out: not sent yet");
  stub.delayMs = 0;
  check(await until(page, () => seen.writes.length === writes0 + 1, 15000), "then it is sent");
  check(
    seen.writes.at(-1)?.words?.[0]?.back === STUB_BACK(slow),
    `carrying that meaning (${seen.writes.at(-1)?.words?.[0]?.back})`,
  );
  await page.waitForTimeout(1500);
  check(callsOf(slow) === 1, `one model call in all (${callsOf(slow)})`);
  await closeCard(page);

  // The model failing (as any failure, or a limit): the word shows, and can be added.
  stub.fail = true;
  const bad = await tapUnknown(page, seen, used);
  check(!!bad, `failing model: a tap (${bad})`);
  check(await until(page, () => knob.isVisible(), 8000), "no meaning, and the slider");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `reader-no-meaning-${scheme}.png`) });
  const writes1 = seen.writes.length;
  await touchDrag(cdp, page, knob, 56);
  check(await until(page, () => seen.writes.length === writes1 + 1, 12000), "and it can be added");
  await page.waitForTimeout(1500);
  check(!!(await probeOf(ctx, id, bad))?.listId, "the card exists, without a meaning");
  stub.fail = false;
  await closeCard(page);

  check(seen.makes === 0, `never make-cards (${seen.makes})`);
  check(seen.errs.length === 0, `no page errors (${seen.errs.join(" | ").slice(0, 200)})`);
  await ctx.close();
}

async function ownKey(scheme) {
  console.log(`— the user's own AI, ${scheme}`);
  const device = {
    v: 1,
    mode: "device",
    enabled: true,
    apiKey: "sk-qa-not-a-real-key",
    backend: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m" },
  };
  const ctx = await newAccount(
    scheme,
    "own",
    (d) => {
      try {
        localStorage.setItem("lk:byok", JSON.stringify(d.device));
        localStorage.setItem("lk:byok-ack", JSON.stringify({ v: d.ack }));
      } catch {}
    },
    { device, ack: 2 },
  );
  const page = await ctx.newPage();
  const seen = watch(page);
  const providerAsked = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  };
  await ctx.route("https://api.openai.com/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || "{}");
    const asked = JSON.parse(body.messages?.[1]?.content || "[]").map((x) => x.word);
    providerAsked.push(...asked);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(Object.fromEntries(asked.map((w) => [w, `own ${w}`]))),
            },
          },
        ],
      }),
    });
  });
  const cdp = await ctx.newCDPSession(page);
  const id = await openBook(page);
  const calls0 = stub.calls.length;
  let word = null;
  for (const text of await spots(page, [])) {
    const asked = providerAsked.length;
    await tapText(page, text);
    if (await until(page, () => providerAsked.length > asked, 2500)) {
      word = providerAsked.at(-1);
      break;
    }
    await closeCard(page);
  }
  check(!!word, `a tap asks his own provider (${word})`);
  if (word) {
    check(
      seen.glosses.every((g) => g.own === true),
      "the route is asked with own: true",
    );
    check(stub.calls.length === calls0, "no model of ours");
    check(
      await until(page, () => page.getByTestId("read-select-own-key").first().isVisible(), 5000),
      "tagged as his own key",
    );
    await page.screenshot({ path: join(OUT, `own-key-${scheme}.png`) });
    const knob = page.getByTestId("read-grade-knob");
    await until(page, () => knob.isVisible(), 8000);
    await page.waitForTimeout(600);
    await touchDrag(cdp, page, knob, 56);
    check(await until(page, () => seen.writes.length === 1, 12000), "the commit is sent");
    check(seen.writes[0]?.own === true, "it says own: true");
    check(seen.writes[0]?.words?.[0]?.back === `own ${word}`, "with his provider's answer");
    await page.waitForTimeout(1500);
    check(stub.calls.length === calls0, "still no model of ours");
    check(!!(await probeOf(ctx, id, word))?.listId, "the card exists");
  }
  check(seen.errs.length === 0, `no page errors (${seen.errs.join(" | ").slice(0, 200)})`);
  await ctx.close();
}

async function liveCard(scheme) {
  console.log(`— the live doc's card, ${scheme}`);
  const ctx = await newAccount(scheme, "live");
  const added = await ctx.request.post("/api/read/gdoc/stream", {
    data: {
      docId: `FAKE-qa-doc-id-tapgloss-${scheme}`,
      html: "<html><head><title>QA live</title></head><body><p>The first line of a made-up document.</p><p>The second line of it.</p></body></html>",
      title: "QA live",
    },
    headers: { origin: BASE },
  });
  if (!added.ok()) throw new Error(`storing the doc: ${added.status()} ${await added.text()}`);
  const { id } = await added.json();
  let socket = null;
  await ctx.routeWebSocket(/\/api\/version\/read-stream/, (ws) => {
    socket = ws;
  });
  const page = await ctx.newPage();
  const seen = watch(page);
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`/read/${id}?streamingFrom=google-docs`, { waitUntil: "load" });
  await page.getByTestId("reader-v2").waitFor({ timeout: 30000 });
  await until(page, () => !!socket, 15000);
  await page.waitForTimeout(800);
  const made = `zorbliq${scheme}`;
  socket.send(
    JSON.stringify({
      book: id,
      ops: [{ i: 100000, s: `Elephants ${made} beyond qanfrith mountains quietly today.` }],
    }),
  );
  const word = page.locator(`[data-tail-w=${made}]`).first();
  await word.waitFor({ timeout: 8000 });
  await word.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await word.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  const live = page.getByTestId("read-live-card");
  const knob = live.getByTestId("read-grade-knob");
  check(await until(page, () => knob.isVisible(), 15000), "a new word: the slider");
  check(await until(page, () => live.getByText(STUB_BACK(made)).isVisible(), 5000), "its meaning");
  check(!seen.glosses.some((g) => g.cached), "asked with the model allowed");
  check(callsOf(made) === 1, `the model asked once (${callsOf(made)})`);
  check((await probeOf(ctx, id, made))?.listId === null, "the tap stored no card");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `live-tap-${scheme}.png`) });

  await touchDrag(cdp, page, knob, 56);
  check(await until(page, () => seen.writes.length === 1, 5000), "past a level: its batch is sent");
  check(
    seen.writes[0]?.words?.[0]?.back === STUB_BACK(made),
    `it carries the meaning (${seen.writes[0]?.words?.[0]?.back})`,
  );
  const toast = page.getByTestId("read-made-toast");
  check(await until(page, () => toast.isVisible(), 8000), "the toast, with Undo");
  check(callsOf(made) === 1, `the commit asked the model nothing more (${callsOf(made)})`);
  await page.screenshot({ path: join(OUT, `live-added-${scheme}.png`) });
  await toast.locator("button").click();
  check(await until(page, () => seen.writes.length === 2, 5000), "Undo asks the server");
  await page.waitForTimeout(800);
  const again = await word.boundingBox();
  await page.touchscreen.tap(again.x + again.width / 2, again.y + again.height / 2);
  check(await until(page, () => knob.isVisible(), 8000), "undone: a preview again");
  check(callsOf(made) === 1, `re-tapped: still one model call (${callsOf(made)})`);
  check(seen.makes === 0, `never make-cards (${seen.makes})`);
  check(seen.errs.length === 0, `no page errors (${seen.errs.join(" | ").slice(0, 200)})`);
  await ctx.close();
}

setFlags(true);
// readFlags is cached 30 s per isolate.
await new Promise((r) => setTimeout(r, 31000));
try {
  for (const scheme of ["light", "dark"]) {
    await floatingCard(scheme);
    await liveCard(scheme);
    await ownKey(scheme);
  }
} finally {
  setFlags(false);
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
