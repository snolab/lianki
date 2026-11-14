#!/usr/bin/env bun
/**
 * Headless QA for mini apps (docs/mini-apps.md): the calculator sample in a
 * real Chromium, in the srcdoc sandbox under its CSP, with the real SDK
 * (public/m/sdk.js), the real host bridge (lib/mini-apps/bridge.ts) and the
 * real route handlers over the test D1 and an in-memory R2. No network
 * besides 127.0.0.1, no audio, no production anything.
 *
 *   bun scripts/qa/mini-apps-qa.ts        (exit 0 = every check passed)
 *
 * Checks: the app paints with the style pack; the first storage use shows the
 * prompt and "Allow for this app" is stored; the result is saved per app in
 * D1; "Send to chat" prompts for chat:write and "Allow this time" posts one
 * line named after the app; the frame has an opaque origin (no cookies, no
 * localStorage) and no network (connect-src 'none'); a message from another
 * window is ignored.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { createTestD1 } from "../../lib/d1/testDb";
import {
  act,
  hostView,
  publish,
  type MiniBucket,
  type MiniDeps,
} from "../../lib/mini-apps/handlers";
import type { MiniDb } from "../../lib/mini-apps/store";
import { CONFIG } from "../../lib/config";

const root = join(import.meta.dir, "../..");
const mig = (f: string) => readFileSync(join(root, "db/migrations", f), "utf8");
const d1 = createTestD1(
  [
    "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);",
    mig("0020_user_prefs.sql"),
    mig("0057_chat_line.sql"),
    mig("0078_mini_apps.sql"),
  ].join("\n"),
);
d1.raw().exec("INSERT INTO user (id, email) VALUES ('qa1', 'qa@example.com')");
const files = new Map<string, string>();
const bucket: MiniBucket = {
  put: async (k, v) => void files.set(k, v),
  get: async (k) => (files.has(k) ? { text: async () => files.get(k)! } : null),
  delete: async (k) => void (Array.isArray(k) ? k : [k]).forEach((x) => files.delete(x)),
};
const said: string[] = [];
const deps: MiniDeps = {
  who: async () => ({ id: "qa1", email: "qa@example.com", dev: true }),
  on: async () => true,
  db: () => d1 as unknown as MiniDb,
  bucket: () => bucket,
  config: async () => ({
    maxBytes: CONFIG["miniApps.maxBytes"].default,
    storageBytes: CONFIG["miniApps.storageBytes"].default,
    perAccount: 5,
    callsPerMinute: 1000,
    cardWaitMs: 10_000,
    origin: "",
    scripts: CONFIG["miniApps.scriptOrigins"].default,
    styles: CONFIG["miniApps.styleOrigins"].default,
    fonts: CONFIG["miniApps.fontOrigins"].default,
    prefKeys: CONFIG["miniApps.prefKeys"].default,
  }),
  chat: () => ({
    read: async () => [],
    say: async (_u, lane, text) => (said.push(`${lane}: ${text}`), { id: `l${said.length}` }),
    card: async () => ({ choice: null }),
  }),
};

const sample = join(root, "scripts/dev/mini-apps");
const pub = await publish(
  new Request("http://127.0.0.1/api/my/mini-apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest: JSON.parse(readFileSync(join(sample, "calculator.manifest.json"), "utf8")),
      html: readFileSync(join(sample, "calculator.html"), "utf8"),
    }),
  }),
  deps,
);
if (pub.status !== 201) throw new Error(`publish: ${pub.status} ${await pub.text()}`);

const bridgeJs = await (
  await Bun.build({
    entrypoints: [join(root, "lib/mini-apps/bridge.ts")],
    target: "browser",
    format: "esm",
  })
).outputs[0]!.text();

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/m/sdk.js" || url.pathname.startsWith("/m/presets/")) {
      const type = url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
      return new Response(Bun.file(join(root, "public", url.pathname)), {
        headers: { "content-type": type },
      });
    }
    if (url.pathname === "/bridge.js")
      return new Response(bridgeJs, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/my/mini-apps/calc" && req.method === "POST")
      return act(req, "calc", deps);
    if (url.pathname === "/m/calc") {
      const view = await hostView("calc", url.origin, deps);
      if (view?.frame.mode !== "srcdoc") return new Response("no view", { status: 500 });
      return new Response(hostPage(view), { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  },
});

/** The host page: the same bridge wiring as app/(app)/m/[slug]/MiniAppHost.tsx, without React. */
function hostPage(view: Awaited<ReturnType<typeof hostView>> & object) {
  const f = view.frame as { srcdoc: string; sandbox: string };
  const manifest = {
    slug: view.slug,
    name: view.name,
    icon: view.icon,
    version: view.version,
    permissions: view.permissions,
  };
  return `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" sandbox="${f.sandbox}" style="width:100%;height:90vh;border:0"></iframe>
<div id="ask" hidden><span id="what"></span>
  <button id="allow-app">app</button><button id="allow-once">once</button><button id="deny">deny</button></div>
<script type="module">
  import { createBridge, fromFrame, parseRequest, replyTarget } from "/bridge.js";
  const frame = document.getElementById("f");
  frame.srcdoc = ${JSON.stringify(f.srcdoc).replaceAll("</", "<\\/")};
  const ask = document.getElementById("ask");
  const post = async (body) => {
    const r = await fetch("/api/my/mini-apps/calc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const bridge = createBridge({
    manifest: ${JSON.stringify(manifest)},
    grants: () => (${JSON.stringify(view.grants)}),
    prompt: (cap) => new Promise((resolve) => {
      document.getElementById("what").textContent = cap;
      ask.hidden = false;
      for (const [id, c] of [["allow-app", "app"], ["allow-once", "once"], ["deny", "deny"]])
        document.getElementById(id).onclick = () => { ask.hidden = true; resolve(c); };
    }),
    decide: async (cap, choice) => (await post({ action: "decide", permission: cap, choice })).body.grants ?? {},
    call: (method, args) => post({ action: "call", method, args }),
  });
  window.__seen = 0;
  addEventListener("message", (e) => {
    const win = frame.contentWindow;
    window.__seen++;
    if (!fromFrame(e, win, "null")) return;
    const r = parseRequest(e.data);
    if (r) bridge.handle(r).then((reply) => win.postMessage(reply, replyTarget("null")));
  });
</script>`;
}

const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails.push(name);
};

const browser = await launchSilent(chromium);
try {
  const page = await (await newSilentContext(browser)).newPage();
  const csp: string[] = [];
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => {
    if (process.env.QA_DEBUG) console.log("console:", m.text());
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text());
  });
  await page.goto(`${server.url.origin}/m/calc`);
  const app = page.frameLocator("#f");
  await app.locator("#keys button").first().waitFor();
  const frame = page.frames().find((x) => x !== page.mainFrame())!;

  const bg = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("style pack applied (paper background)", /oklch|rgb\(2[34]\d/.test(bg), bg);
  check(
    "the SDK is there",
    await frame.evaluate(() => typeof (window as never as { lianki?: object }).lianki === "object"),
  );

  // The stored history is read at start: the first storage use prompts.
  await page.locator("#ask:not([hidden])").waitFor();
  check("first storage use prompts", (await page.locator("#what").textContent()) === "storage");
  await page.click("#allow-app");

  for (const k of ["6", "×", "7", "="])
    await app.getByRole("button", { name: k, exact: true }).click();
  await app.locator("#out", { hasText: "42" }).waitFor();
  check("6 × 7 = 42", (await app.locator("#out").textContent()) === "42");
  await app.locator("#history li").first().waitFor();
  await page.waitForTimeout(200);
  const kv = d1.raw().prepare("SELECT value FROM mini_app_kv WHERE key = 'history'").get() as
    | { value?: string }
    | undefined;
  check(
    "history saved per app in D1",
    !!kv?.value && JSON.parse(kv.value)[0]?.value === 42,
    kv?.value,
  );
  const grant = d1
    .raw()
    .prepare("SELECT decision FROM mini_app_grant WHERE permission = 'storage'")
    .get() as { decision?: string } | undefined;
  check("'for this app' stored", grant?.decision === "allow");

  await app.getByRole("button", { name: "Send to chat" }).click();
  await page.locator("#ask:not([hidden])").waitFor();
  check("chat:write prompts", (await page.locator("#what").textContent()) === "chat:write");
  await page.click("#allow-once");
  for (let i = 0; i < 20 && !said.length; i++) await page.waitForTimeout(50);
  check("one line, named after the app", said[0] === "app-calc: 6×7 = 42", said[0]);
  check(
    "'this time' not kept",
    !d1.raw().prepare("SELECT 1 FROM mini_app_grant WHERE permission = 'chat:write'").get(),
  );

  const sandbox = await frame.evaluate(async () => {
    const out: Record<string, string> = { origin: location.origin };
    try {
      out.cookie = String(document.cookie);
    } catch {
      out.cookie = "blocked";
    }
    try {
      localStorage.setItem("x", "1");
      out.storage = "open";
    } catch {
      out.storage = "blocked";
    }
    out.fetch = await fetch("/api/my/mini-apps").then(
      () => "open",
      () => "blocked",
    );
    try {
      out.parent = String((window.parent as unknown as { document: Document }).document.title);
    } catch {
      out.parent = "blocked";
    }
    return out;
  });
  check(
    "opaque origin, no cookies, no storage, no network, no parent",
    sandbox.cookie === "blocked" &&
      sandbox.storage === "blocked" &&
      sandbox.fetch === "blocked" &&
      sandbox.parent === "blocked",
    JSON.stringify(sandbox),
  );
  check(
    "only the app's own fetch was refused by the CSP",
    csp.every((t) => /connect/i.test(t)),
    csp.join(" | "),
  );

  // A request from the host page's own window (not the frame) is ignored.
  const before = said.length;
  await page.evaluate(() =>
    window.postMessage({ lk: "mini/1", id: 99, method: "chat.say", args: { text: "x" } }, "*"),
  );
  await page.waitForTimeout(100);
  check("a message from another window is ignored", said.length === before);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
