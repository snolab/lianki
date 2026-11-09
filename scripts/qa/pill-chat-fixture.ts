/**
 * qa-pill-chat.ts fixture: the userscript's real Li chat path (src/pill-chat.ts:
 * the gate, the prompt, the frame shell) with a stand-in "pill" — one Li
 * button in a closed shadow root, fixed at the bottom-right corner. Injected
 * by the QA into an **isolated world** (CDP worldName), as a userscript
 * manager runs Lianki: the hostile page's globals are not ours.
 *
 * GM storage is memory (one page load); GM_xmlhttpRequest is a CORS fetch to
 * the test server, which records every request so the QA can assert that
 * nothing reaches the app origin before the site is allowed.
 */
import { pillChat } from "../../src/pill-chat";

const APP = (globalThis as unknown as { __QA_APP__: string }).__QA_APP__;
const mem = new Map<string, unknown>([
  ["lianki_pillchat_on", JSON.stringify({ on: true, at: Date.now() })],
]);

function start() {
  const pc = pillChat({
    origin: APP,
    info: { injectInto: "content" },
    getValue: (k, d) => (mem.has(k) ? mem.get(k) : d),
    setValue: (k, v) => void mem.set(k, v),
    gmFetch: async (url, o) => {
      const r = await fetch(url, { method: o?.method ?? "GET", headers: o?.headers, mode: "cors" });
      const body = await r.text();
      return { ok: r.ok, status: r.status, json: async () => JSON.parse(body) };
    },
    strings: undefined,
  });
  const host = document.createElement("div");
  const css = (el: HTMLElement, rules: [string, string][]) => {
    for (const [k, v] of rules) el.style.setProperty(k, v, "important");
  };
  css(host, [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["right", "16px"],
    ["bottom", "16px"],
    ["width", "60px"],
    ["height", "44px"],
    ["z-index", "2147483646"],
  ]);
  const root = host.attachShadow({ mode: "closed" });
  const b = document.createElement("button");
  b.textContent = "Li";
  css(b, [
    ["all", "initial"],
    ["display", "block"],
    ["width", "60px"],
    ["height", "44px"],
    ["background", "oklch(0.25 0.02 65)"],
    ["color", "oklch(0.98 0 0)"],
    ["text-align", "center"],
    ["cursor", "pointer"],
  ]);
  const update = () => css(host, [["display", pc.entry() === "hidden" ? "none" : "block"]]);
  b.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void pc.open().then(update);
  });
  root.append(b);
  document.documentElement.append(host);
  update();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
