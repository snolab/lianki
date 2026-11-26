#!/usr/bin/env bun
/**
 * Is 随身Li's lianki.com frame see-through? Opens the live /embed/partner in
 * an iframe on example.com, as the userscript's shell does (handshake over a
 * MessagePort; no ticket, so the chat shows offline), once with the shell's
 * iframe color-scheme ("light dark", src/partner-frame.ts) and once with the
 * old "normal", light and dark, and reports the frame document's backgrounds
 * and color-scheme with a screenshot each. A mismatch between the frame
 * document's color-scheme and the iframe element's makes the browser paint
 * an opaque canvas.
 *
 *   bun scripts/qa/probe-frame-glass.ts [--out /private/tmp/portable-li-frame-probe]
 */
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";

const at = Bun.argv.indexOf("--out");
const out = at > -1 ? Bun.argv[at + 1] : "/private/tmp/portable-li-frame-probe";
const browser = await launchSilent(chromium);
try {
  for (const scheme of ["dark", "light"] as const) {
    const ctx = await newSilentContext(browser, {
      viewport: { width: 1000, height: 700 },
      colorScheme: scheme,
    });
    const p = await ctx.newPage();
    await p.goto("https://example.com/");
    for (const cs of ["light dark", "normal"]) {
      await p.evaluate((cs) => {
        document.querySelectorAll("iframe").forEach((f) => f.remove());
        const f = document.createElement("iframe");
        f.src = "https://lianki.com/embed/partner?lang=zh";
        f.style.cssText = `position:fixed;right:16px;bottom:16px;width:420px;height:560px;border:0;background:transparent;color-scheme:${cs}`;
        // The shell's handshake: hello with a port on "up"; no ticket.
        addEventListener("message", (e) => {
          if (
            e.source !== f.contentWindow ||
            (e.data as { lk?: string })?.lk !== "partner-frame-up"
          )
            return;
          const ch = new MessageChannel();
          ch.port1.onmessage = (m) => {
            if ((m.data as { type?: string })?.type === "need-ticket")
              ch.port1.postMessage({ type: "ticket", ticket: null });
          };
          f.contentWindow?.postMessage(
            { lk: "partner-hello", v: 1, label: "example.com/" },
            "https://lianki.com",
            [ch.port2],
          );
        });
        document.body.append(f);
      }, cs);
      await p.waitForTimeout(8000);
      const fr = p.frames().find((f) => f.url().includes("/embed/partner"));
      const info = fr
        ? await fr.evaluate(() => {
            const s = (e: Element) => {
              const c = getComputedStyle(e);
              return `${e.tagName.toLowerCase()} bg=${c.backgroundColor} scheme=${c.colorScheme}`;
            };
            const chat = document.querySelector("[data-debug-chat]");
            return {
              embed: document.documentElement.hasAttribute("data-embed"),
              build: document.documentElement.dataset.build,
              lang: document.documentElement.lang,
              html: s(document.documentElement),
              body: s(document.body),
              chat: chat ? s(chat) : null,
              placeholder:
                (
                  document.querySelector(
                    "[data-testid=debug-chat-input]",
                  ) as HTMLTextAreaElement | null
                )?.placeholder ?? null,
            };
          })
        : null;
      console.log(scheme, JSON.stringify(cs), JSON.stringify(info));
      await p.screenshot({ path: `${out}-${scheme}-${cs.replace(" ", "-")}.png` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
