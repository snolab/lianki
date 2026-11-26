#!/usr/bin/env bun
import { pillChatStrings } from "../../src/pill-chat-strings";
/** Silent, device-free STRICT-CSP fixture. Not real manager/production acceptance. */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { DebugHub, type Storage } from "../../workers/push/src/debug";
import { pageChatHttp, type PageChatHttpDeps } from "../../lib/page-chat-http-route";
import { threadHashKey } from "../../lib/li-thread";
import { b64url } from "../../lib/stt-ticket";
import { GLOBAL_CHAT_KEY } from "../../src/pill-chat-global";
import { PILL_UI_LANGUAGE_KEY } from "../../src/pill-chat-language";
const built = await Bun.build({
  entrypoints: [new URL("./portable-li-fixture.ts", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
if (!built.success) throw new Error(built.logs.join("\n"));
const code = await built.outputs[0]!.text();
const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const data = new Map<string, unknown>();
const storage: Storage = {
  get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
  put: async (k, v) => {
    data.set(k, structuredClone(v));
  },
  delete: async (k) => data.delete(k),
  list: async <T>(o: { prefix: string; reverse?: boolean; limit?: number }) => {
    let rows = [...data]
      .filter(([k]) => k.startsWith(o.prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    if (o.reverse) rows.reverse();
    return new Map(rows.slice(0, o.limit).map(([k, v]) => [k, structuredClone(v) as T]));
  },
  getAlarm: async () => null,
  setAlarm: async () => {},
};
const pending: Promise<unknown>[] = [];
let aiCalls = 0;
const hub = new DebugHub(
  { storage, acceptWebSocket() {}, getWebSockets: () => [], waitUntil: (p) => pending.push(p) },
  {
    PARTNER_TICKET_PUB: pub,
    SESSIONS: {
      flag: async (key: string) => key === "partner.ai-reply",
      config: async () => undefined,
      partnerReply: async () => {
        aiCalls++;
        return { ok: true, text: "已连接：fixture reply", tokensIn: 1, tokensOut: 1 };
      },
    },
  },
);
const deps: PageChatHttpDeps = {
  backend: () => "d1",
  d1: () => {
    throw Error("no tokens");
  },
  sessionUser: async () => ({ id: "account_a", email: "viewer@example.test" }),
  isDev: async () => true,
  flags: async () => ({ "ext.pill-chat": true }),
  allow: async () => true,
  key: async () => pair.privateKey,
  threadKey: async () => threadHashKey("synthetic-portable-fixture"),
  push: () => ({ fetch: (r) => hub.fetch(r) }),
};
const gm = new Map<string, unknown>();
const aborts = new Map<string, AbortController>();
let calls = 0;
const browser = await launchSilent(chromium);
const context = await newSilentContext(browser, {
  locale: "fr",
  viewport: { width: 1000, height: 760 },
});
const checks: string[] = [];
const check = (ok: unknown, label: string) => {
  if (!ok) throw Error(label);
  checks.push(label);
  console.log("PASS " + label);
};
try {
  await context.route("**/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "content-security-policy":
          "default-src 'none'; script-src 'none'; style-src 'none'; frame-src 'none'; connect-src 'none'; img-src 'none'",
      },
      body: '<!doctype html><html lang="zh"><body><input id="site-input" autofocus><p>Fixture website</p></body></html>',
    }),
  );
  await context.exposeBinding("__portableQaStore", (_s, key, value) => {
    gm.set(key, value);
  });
  await context.exposeBinding("__portableQaAbort", (_s, id) => {
    aborts.get(id)?.abort();
  });
  await context.exposeBinding("__portableQaCall", async (_s, id, details) => {
    calls++;
    const controller = new AbortController();
    aborts.set(id, controller);
    try {
      const r = await pageChatHttp(
        new Request(details.url, {
          method: details.method,
          headers: details.headers,
          body: details.data,
          signal: controller.signal,
        }),
        deps,
      );
      return { status: r.status, responseText: await r.text() };
    } finally {
      aborts.delete(id);
    }
  });
  const page = await context.newPage();
  const install = async (url: string) => {
    await page.goto(url);
    const cdp = await context.newCDPSession(page);
    // Simulates privileged userscript injection; no remote script is loaded and the site's CSP stays intact.
    await cdp.send("Runtime.evaluate", {
      expression:
        "globalThis.__portableQaSeed=" + JSON.stringify(Object.fromEntries(gm)) + ";" + code,
      awaitPromise: true,
    });
    await page.evaluate(() => {
      const old = document.createElement("button");
      old.id = "legacy-card";
      old.textContent = "🔖";
      Object.assign(old.style, {
        position: "fixed",
        right: "12px",
        bottom: "20px",
        width: "180px",
        height: "44px",
        zIndex: "2147483647",
      });
      old.addEventListener("click", () => {
        old.dataset.clicked = "true";
      });
      document.body.append(old);
    });
    return cdp;
  };
  const state = () => page.evaluate(() => (globalThis as any).__portableQa.state());
  const click = async (text: string) => {
    const r = await page.evaluate((t) => (globalThis as any).__portableQa.rect(t), text);
    if (!r) throw Error("missing button " + text);
    await page.mouse.click(r.x, r.y);
  };
  const wait = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("fixture timeout");
  };
  await install("https://lianki.com/chat/sites");
  check(
    gm.get(PILL_UI_LANGUAGE_KEY) === "zh",
    "first-party Lianki language recorded despite French browser",
  );
  await install("https://github.com/");
  await wait(async () => (await state()).consents === 1);
  check(calls === 0, "no chat request before explicit global consent");
  check(
    (await state()).text.includes("在所有网站显示 Li"),
    "consent uses Lianki Chinese UI language",
  );
  check(
    (await state()).focused === "site-input",
    "auto consent does not steal website input focus",
  );
  await click("同意所有网站");
  await wait(async () => (await state()).hosts === 1 && (await state()).consents === 0);
  check((await state()).iframes === 0, "strict frame-src none uses no iframe");
  check(
    !(await state()).text.includes(pillChatStrings("zh").chatOnly),
    "chat opens without a standing capability banner",
  );
  check(
    await page.evaluate(() => {
      const old = document.getElementById("legacy-card")!;
      const r = old.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === old;
    }),
    "portable chat leaves existing LiCards controls clickable",
  );
  await page.locator("#legacy-card").click();
  check(
    (await page.locator("#legacy-card").getAttribute("data-clicked")) === "true",
    "ordinary pointer reaches the existing card button",
  );

  check(
    (await state()).panel.some((p: any) => p.position === "fixed" && p.section.width > 300),
    "constructed local CSS works under style-src none",
  );
  const input = await page.evaluate(() => (globalThis as any).__portableQa.input());
  await page.mouse.click(input.x, input.y);
  await page.keyboard.type("fixture hello");
  await click("发送");
  await wait(async () => (await state()).text.includes("已连接：fixture reply"));
  check(aiCalls === 1, "GM broker reaches real hub orchestration and one synthetic AI reply");
  await click("收起");
  check(
    JSON.parse(String(gm.get(GLOBAL_CHAT_KEY))).collapsed.includes("github.com"),
    "collapse persists for this website",
  );
  await page.evaluate(() => (globalThis as any).__portableQa.destroy());
  await install("https://www.zhihu.com/");
  await wait(async () => (await state()).hosts === 1);
  check(
    (await state()).consents === 0,
    "global consent opens a second website without asking again",
  );
  check(!(await state()).text.includes("fixture hello"), "site history remains separate");
  await click("不在此网站显示");
  check((await state()).hosts === 0, "exclude immediately removes panel");
  await install("https://www.zhihu.com/");
  check((await state()).hosts === 0, "excluded website stays hidden after reload");
  await install("https://github.com/");
  await wait(async () => (await state()).hosts === 1);
  check(
    !(await page.evaluate(() => (globalThis as any).__portableQa.input())),
    "remembered collapsed website does not start expanded",
  );
  const policy = JSON.parse(String(gm.get(GLOBAL_CHAT_KEY)));
  policy.consent = "off";
  await page.evaluate(({ key, value }) => (globalThis as any).__portableQa.remote(key, value), {
    key: GLOBAL_CHAT_KEY,
    value: JSON.stringify(policy),
  });
  check((await state()).hosts === 0, "remote GM revoke removes chat without reload");
  check(
    JSON.stringify(Object.fromEntries(gm)).includes("lianki_lichat_global_v1") &&
      !JSON.stringify(Object.fromEntries(gm)).includes("lk:token"),
    "new subsystem stores policy and locale only, no general token",
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      aiCalls,
      physicalAudio: 0,
      realMic: 0,
      production: false,
    }),
  );
} finally {
  for (const c of aborts.values()) c.abort();
  await context.close();
  await browser.close();
  await Promise.allSettled(pending);
}
