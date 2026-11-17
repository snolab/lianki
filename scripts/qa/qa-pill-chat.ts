#!/usr/bin/env bun
/**
 * Li chat from the userscript pill on a hostile page, in a real (muted)
 * Chromium (docs/userscript-li-chat.md, "Security gate"). The real gate and
 * frame shell (scripts/qa/pill-chat-fixture.ts) run in an ISOLATED world, as
 * a userscript manager runs Lianki; the page is hostile in its main world:
 *
 * - it listens for every key on window and document in the capture phase and
 *   logs every message it can hear;
 * - it overrides window.postMessage, MessagePort.prototype.postMessage and
 *   WebSocket to log what passes;
 * - it spoofs `partner-frame-up` to itself, presses the pill and the prompt by
 *   script (el.click(), dispatched events, elementFromPoint), sends the frame
 *   its own hello and port, and finally navigates the frame away (frame-bust).
 *
 * Checks: default deny (no request to the app origin before allow; Escape
 * dismisses), the page's synthetic clicks do nothing, after a real "Allow
 * once" the frame gets its ticket over the port, typed text never reaches the
 * page, no ticket in anything the page can see, the page's hello gets
 * nothing, a navigated frame is torn down, and "Never" hides the entry.
 * M3 (share): the page is read only on a real press of Share inside the
 * frame; the link carries no query or fragment, a hostile title arrives as
 * plain text, and nothing about it reaches the app origin or the page.
 *
 *   bun scripts/qa/qa-pill-chat.ts
 *
 * Silent: no audio, no mic, muted browser. Needs no Worker.
 */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const QA_DIR = new URL(".", import.meta.url).pathname;
const bundle = (entry: string) =>
  Bun.build({ entrypoints: [`${QA_DIR}${entry}`], target: "browser", format: "iife" }).then((o) => {
    if (!o.success) throw new Error(o.logs.join("\n"));
    return o.outputs[0].text();
  });
const fixtureJs = await bundle("pill-chat-fixture.ts");
const guestJs = await bundle("partner-frame-fixture-guest.ts");

const fail: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fail.push(what);
};

const HOSTILE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>hostile</title></head>
<body><p id="own">The page's own text.</p><p id="pick">words he chose</p><input id="pageInput" aria-label="page input">
<script>
  const w = window;
  w.__keys = []; w.__msgs = []; w.__posted = []; w.__portPosted = []; w.__sockets = [];
  w.__theirPort = [];
  const PASS = new Set(["Tab", "Enter", "Escape", " "]);
  for (const t of [window, document]) {
    t.addEventListener("keydown", (e) => { w.__keys.push(e.key); if (!PASS.has(e.key)) e.preventDefault(); }, true);
    t.addEventListener("keypress", (e) => w.__keys.push("press:" + e.key), true);
  }
  // The frame says it is up to its parent with "*": the page hears it, and so
  // learns the frame's WindowProxy (window.frames does not list a frame in a
  // shadow tree). That is the one handle it has on the frame.
  w.__frameWin = null;
  window.addEventListener("message", (e) => {
    w.__msgs.push(JSON.stringify(e.data) + (e.ports?.length ? " +port" : ""));
    if (e.source && e.source !== window && e.data?.lk === "partner-frame-up") w.__frameWin = e.source;
  }, true);
  const pm = window.postMessage.bind(window);
  window.postMessage = (...a) => { w.__posted.push(JSON.stringify(a[0])); return pm(...a); };
  const ppm = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...a) { w.__portPosted.push(JSON.stringify(a[0])); return ppm.apply(this, a); };
  const WS = window.WebSocket;
  window.WebSocket = function (url, p) { w.__sockets.push(String(url) + " " + String(p)); return new WS(url, p); };
  // Spoof the frame's "up" from the page itself, again and again.
  setInterval(() => pm({ lk: "partner-frame-up", v: 1 }, "*"), 50);
  // Press everything it can find, by script.
  w.__press = () => {
    for (const el of document.querySelectorAll("html > div")) {
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    const at = document.elementFromPoint(innerWidth - 40, innerHeight - 30);
    at?.click();
    const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    mid?.click();
  };
  w.__probe = () => {
    const out = { shadowRoots: 0, iframes: document.querySelectorAll("iframe").length, frames: window.frames.length, frameDoc: "n/a" };
    for (const el of document.querySelectorAll("*")) if (el.shadowRoot) out.shadowRoots++;
    if (w.__frameWin) { try { out.frameDoc = String(w.__frameWin.document.body.innerHTML); } catch (e) { out.frameDoc = "blocked"; } }
    return out;
  };
  w.__hello = () => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => w.__theirPort.push(JSON.stringify(m.data));
    w.__frameWin.postMessage({ lk: "partner-hello", v: 1, label: "evil" }, "*", [ch.port2]);
  };
  w.__bust = (to) => { w.__frameWin.location = to; };
</script></body></html>`;

type Req = { method: string; path: string };
const seen: Req[] = [];
let pageOrigin = "";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    const html = (s: string) =>
      new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (host.startsWith("127.0.0.1")) {
      if (url.pathname === "/hostile") return html(HOSTILE);
      if (url.pathname === "/hostile-share")
        return html(
          HOSTILE.replace(
            "<title>hostile</title>",
            "<title>[x](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</title>",
          ),
        );
      if (url.pathname === "/phish") return html("<!doctype html><textarea>phish</textarea>");
      return new Response("not found", { status: 404 });
    }
    // The "app origin" (localhost): every request recorded.
    seen.push({ method: req.method, path: url.pathname });
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-headers": "x-lianki-userscript",
      "access-control-allow-methods": "GET, POST",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/api/ext/pill-chat")
      return Response.json({ on: true }, { headers: cors });
    if (url.pathname === "/api/debug/partner-ticket")
      return Response.json({ ticket: "TK-pill.secret" }, { headers: cors });
    if (url.pathname === "/embed/partner")
      return html(
        `<!doctype html><meta charset=utf-8><body style="margin:0;background:oklch(0.97 0.01 82)"><textarea id=t aria-label=chat></textarea><button id=share-page>page</button><button id=share-selection>sel</button><script>${guestJs}</script>`,
      );
    return new Response("not found", { status: 404 });
  },
});
const PAGE = `http://127.0.0.1:${server.port}`;
pageOrigin = PAGE;
const APP = `http://localhost:${server.port}`;
const appSeen = () => seen.filter((r) => r.method !== "OPTIONS").map((r) => r.path);

const browser = await launchSilent(chromium);
try {
  const ctx = await newSilentContext(browser, { viewport: { width: 390, height: 780 } });
  const open = async () => {
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__QA_APP__=${JSON.stringify(APP)};\n${fixtureJs}`,
      worldName: "lianki-userscript",
    });
    await p.goto(`${PAGE}/hostile`);
    await p.waitForTimeout(200);
    return { p, errors };
  };
  const tapLi = (p: import("playwright").Page) => p.mouse.click(390 - 16 - 30, 780 - 16 - 22);
  const overlays = (p: import("playwright").Page) =>
    p.evaluate(() => document.querySelectorAll("html > div").length);

  // ── 1. Default deny ────────────────────────────────────────────────────────
  const { p, errors } = await open();
  const baseDivs = await overlays(p);
  check(baseDivs === 1, `the pill's Li entry is there (${baseDivs} overlay)`);
  await p.evaluate(() => (window as unknown as { __press(): void }).__press());
  await p.waitForTimeout(300);
  check(
    (await overlays(p)) === 1 && appSeen().length === 0,
    "the page's scripted clicks on the pill open nothing and reach nothing",
  );
  await tapLi(p);
  await p.waitForTimeout(200);
  check((await overlays(p)) === 2, "a real tap shows the trust prompt");
  check(appSeen().length === 0, "prompt showing: still no request to the app origin");
  await p.evaluate(() => (window as unknown as { __press(): void }).__press());
  await p.waitForTimeout(300);
  check(
    (await overlays(p)) === 2 && appSeen().length === 0,
    "the page's scripted clicks on the prompt choose nothing",
  );
  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);
  check(
    (await overlays(p)) === 1 && appSeen().length === 0,
    "Escape dismisses: denied, nothing sent",
  );

  // ── 2. Allow once ──────────────────────────────────────────────────────────
  await tapLi(p);
  await p.waitForTimeout(200);
  // Focus starts on ×; Tab → Always, Tab → Allow once.
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
  await p.keyboard.press("Enter");
  const frame = await (async () => {
    for (let i = 0; i < 50; i++) {
      const f = p.frames().find((x) => x.url().startsWith(`${APP}/embed/partner`));
      if (f) return f;
      await p.waitForTimeout(100);
    }
    return null;
  })();
  check(!!frame, "allowed once: the app-origin frame opens");
  check(appSeen()[0] === "/api/ext/pill-chat", `the flag is asked first (${appSeen().join(", ")})`);
  if (frame) {
    await frame
      .waitForFunction(() => document.body.dataset.ticket === "TK-pill.secret", undefined, {
        timeout: 5000,
      })
      .catch(() => {});
    const t = await frame.evaluate(() => document.body.dataset.ticket);
    check(t === "TK-pill.secret", "the frame got its ticket over the port");
    await frame.click("#t");
    await p.keyboard.type("secret words");
    const typed = await frame.evaluate(
      () => (document.getElementById("t") as HTMLTextAreaElement).value,
    );
    check(typed === "secret words", `the text arrives in the frame ("${typed}")`);
  }
  const probe = await p.evaluate(() =>
    (window as unknown as { __probe(): Record<string, unknown> }).__probe(),
  );
  check(
    probe.shadowRoots === 0 && probe.iframes === 0,
    `the page finds no shadow root and no iframe in its DOM (${JSON.stringify(probe)})`,
  );
  check(
    probe.frames === 0,
    "window.frames does not list the frame (it is in a closed shadow tree)",
  );
  check(
    probe.frameDoc === "blocked",
    `through the WindowProxy it learns from the frame's hello, the page cannot read the frame (${probe.frameDoc})`,
  );
  await p.evaluate(() => (window as unknown as { __hello(): void }).__hello());
  await p.waitForTimeout(400);
  const heard = await p.evaluate(() => {
    const w = window as unknown as Record<string, string[]>;
    return {
      // Typed in the frame: none of its characters may reach the page.
      // (Tab/Enter/Escape pressed on the prompt, in the page's own document, are seen.)
      keys: w.__keys.filter((k) => /^(press:)?[a-z ]$/.test(k)),
      all: JSON.stringify([w.__msgs, w.__posted, w.__portPosted, w.__sockets, w.__theirPort]),
      theirPort: w.__theirPort,
    };
  });
  check(
    heard.keys.length === 0,
    `the page's key listeners saw none of the typing (${heard.keys.join("")})`,
  );
  check(
    !heard.all.includes("TK-pill") && !heard.all.includes("secret"),
    "no ticket and no typed text in any message, port or socket the page can see",
  );
  check(heard.theirPort.length === 0, "the page's own hello and port get nothing from the frame");
  const html = await p.content();
  check(
    !html.includes("TK-pill") && !html.includes("lianki_"),
    "no ticket or storage key in the DOM",
  );

  // ── 3. Frame-bust: the page navigates the frame ────────────────────────────
  await p.evaluate(
    (to) => (window as unknown as { __bust(t: string): void }).__bust(to),
    `${PAGE}/phish`,
  );
  await p.waitForTimeout(800);
  const left = p
    .frames()
    .filter((f) => f !== p.mainFrame())
    .map((f) => f.url());
  check(
    left.length === 0,
    `a frame the page navigated away is torn down (${left.join(", ") || "none left"})`,
  );
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
  await p.close();

  // ── 3b. Share (M3): only on his press in the frame ───────────────────────────
  {
    const sp = await ctx.newPage();
    const cdp = await ctx.newCDPSession(sp);
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__QA_APP__=${JSON.stringify(APP)};\n${fixtureJs}`,
      worldName: "lianki-userscript",
    });
    await sp.goto(`${PAGE}/hostile-share?token=s3cret#frag`);
    await sp.waitForTimeout(200);
    await tapLi(sp);
    await sp.waitForTimeout(200);
    await sp.keyboard.press("Tab");
    await sp.keyboard.press("Tab");
    await sp.keyboard.press("Enter");
    let f: import("playwright").Frame | null = null;
    for (let i = 0; i < 50 && !f; i++) {
      f = sp.frames().find((x) => x.url().startsWith(`${APP}/embed/partner`)) ?? null;
      if (!f) await sp.waitForTimeout(100);
    }
    check(!!f, "share: the frame opens on the hostile page");
    if (f) {
      await f.waitForFunction(() => !!document.body.dataset.ticket, undefined, { timeout: 5000 });
      const before = appSeen().length;
      await sp.waitForTimeout(300);
      check(
        (await f.evaluate(() => document.body.dataset.sharePage ?? "")) === "",
        "share: nothing read from the page before he presses Share",
      );
      // The page scripts a click on the frame's Share: it cannot reach into the frame.
      await sp.evaluate(() => {
        const at = document.elementFromPoint(innerWidth - 40, innerHeight - 60);
        (at as HTMLElement | null)?.click();
      });
      await sp.waitForTimeout(200);
      check(
        (await f.evaluate(() => document.body.dataset.sharePage ?? "")) === "",
        "share: the page's scripted click shares nothing",
      );
      await f.click("#share-page");
      await f.waitForFunction(() => !!document.body.dataset.sharePage, undefined, {
        timeout: 3000,
      });
      const page = JSON.parse(await f.evaluate(() => document.body.dataset.sharePage!));
      check(
        page?.url === `${PAGE}/hostile-share`,
        `share page: the link has no query or fragment (${page?.url})`,
      );
      check(
        page?.title === "[x](javascript:alert(1)) <img src=x onerror=alert(1)>",
        "share page: the hostile title arrives as plain text (escaped in the composer)",
      );
      // Nothing selected yet: no selection share.
      await f.click("#share-selection");
      await f.waitForFunction(() => !!document.body.dataset.shareSelection, undefined, {
        timeout: 3000,
      });
      check(
        (await f.evaluate(() => document.body.dataset.shareSelection)) === "null",
        "share selection: nothing selected → nothing shared",
      );
      await sp.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById("pick")!);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      });
      await f.evaluate(() => delete document.body.dataset.shareSelection);
      await f.click("#share-selection");
      await f.waitForFunction(() => !!document.body.dataset.shareSelection, undefined, {
        timeout: 3000,
      });
      const sel = JSON.parse(await f.evaluate(() => document.body.dataset.shareSelection!));
      check(
        sel?.selection === "words he chose",
        `share selection: the chosen words (${sel?.selection})`,
      );
      check(appSeen().length === before, "share: nothing about it reaches the app origin");
      const heard = await sp.evaluate(() => {
        const w = window as unknown as Record<string, string[]>;
        return JSON.stringify([w.__msgs, w.__posted, w.__portPosted, w.__sockets]);
      });
      check(
        !heard.includes("words he chose") && !heard.includes("hostile-share"),
        "share: the page hears nothing of it (port only)",
      );
    }
    await sp.close();
  }

  // ── 4. Never ───────────────────────────────────────────────────────────────
  const before = appSeen().length;
  const n = await open();
  await tapLi(n.p);
  await n.p.waitForTimeout(200);
  await n.p.keyboard.press("Tab");
  await n.p.keyboard.press("Tab");
  await n.p.keyboard.press("Tab");
  await n.p.keyboard.press("Enter");
  await n.p.waitForTimeout(300);
  const hidden = await n.p.evaluate(() => {
    const el = document.querySelector("html > div") as HTMLElement | null;
    return el ? getComputedStyle(el).display : "gone";
  });
  check(hidden === "none", `never: the Li entry hides on this site (${hidden})`);
  check(appSeen().length === before, "never: nothing sent to the app origin");
  await n.p.close();
  await ctx.close();
} finally {
  await browser.close();
  server.stop(true);
}

if (fail.length) {
  console.error(`\n${fail.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall pill-chat checks passed");
