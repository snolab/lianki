import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import {
  portableLiPanel,
  attachPortableStyle,
  type PortableChatCall,
} from "../src/portable-li-panel";
import { PORTABLE_LI_STRINGS } from "../src/portable-li-strings";
import { pillChatStrings } from "../src/pill-chat-strings";
const turn = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
test("panel renders text only, bounds retained history, retries a stable message id and stops on account changes", async () => {
  const win = new Window({ url: "https://example.test" });
  let root: ShadowRoot | undefined;
  const original = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (o) {
    const r = original.call(this, o);
    root = r as never;
    return r;
  };
  const restore = stubGlobals({ window: win, document: win.document });
  const thread = "owner~" + "A".repeat(22),
    ids: string[] = [];
  let sends = 0,
    reads = 0,
    invalid = 0;
  const call: PortableChatCall = async (input, _principal, signal) => {
    if (input.op === "send") {
      ids.push(input.id);
      sends++;
      if (sends === 1) throw Error("network");
      if (sends === 2) return { ok: false, error: "busy" };
      return sends === 3
        ? { ok: true, kind: "accepted", id: input.id, seq: 203 }
        : { ok: true, kind: "hello", principal: "unexpected" };
    }
    const index = reads++;
    if (index === 0 || index === 1)
      return {
        ok: true,
        kind: "history",
        range: {
          type: "history",
          thread,
          messages:
            index === 0
              ? Array.from({ length: 201 }, (_, i) => ({
                  id: "line" + i,
                  from: "agent" as const,
                  text: i === 200 ? "<script>not executed</script>" : "text" + i,
                  label: "",
                  at: i,
                  seq: i + 1,
                }))
              : [],
          removed: index === 1 ? [{ id: "line199", seq: 202 }] : [],
          skipped: [],
          afterSeq: index === 0 ? 0 : 201,
          throughSeq: index === 0 ? 201 : 202,
          headSeq: index === 0 ? 201 : 202,
          prunedThroughSeq: index === 0 ? 0 : 2,
        },
        pending: index === 0 ? "message_pending" : undefined,
      };
    if (index === 3) return { ok: false, error: "unavailable" };
    if (index === 4) throw Error("read network");
    if (index === 5) return { ok: true, kind: "hello", principal: "unexpected" };
    if (index === 6) return { ok: false, error: "account-changed" };
    return new Promise((resolve) => {
      const done = () => resolve({ ok: false, error: "cancelled" });
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  };
  const panel = portableLiPanel({
    doc: win.document as never,
    origin: "https://lianki.com",
    hostOrigin: "https://example.test",
    principal: "account_a",
    call,
    strings: PORTABLE_LI_STRINGS.en,
    common: pillChatStrings("en"),
    collapsed: false,
    onCollapse() {},
    onExclude() {},
    onInvalidAccount() {
      invalid++;
    },
  });
  try {
    await turn();
    expect(root!.querySelectorAll(".line").length).toBeLessThanOrEqual(200);
    expect(root!.querySelectorAll("script")).toHaveLength(0);
    expect(root!.textContent).toContain("<script>not executed</script>");
    expect(root!.textContent).not.toContain("text199");
    const input = root!.querySelector("textarea")!;
    const form = root!.querySelector("form")!;
    input.value = "Hello";
    for (let i = 0; i < 3; i++) {
      form.dispatchEvent(new win.Event("submit", { cancelable: true }) as never);
      await turn();
    }
    expect(new Set(ids).size).toBe(1);
    expect(input.value).toBe("");
    input.value = "New message";
    form.dispatchEvent(new win.Event("submit", { cancelable: true }) as never);
    await turn();
    expect(root!.textContent).toContain(PORTABLE_LI_STRINGS.en.failed);
    const retry = () => {
      (
        [...root!.querySelectorAll("button")].find(
          (b) => b.textContent === "Try again",
        ) as unknown as { click(): void }
      ).click();
    };
    for (let i = 0; i < 4; i++) {
      retry();
      await turn();
    }
    expect(invalid).toBe(1);
    Object.defineProperty(win.document, "visibilityState", { configurable: true, value: "hidden" });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    await turn();
    Object.defineProperty(win.document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    await turn();
    panel.collapse(true);
    expect(panel.isCollapsed()).toBe(true);
    panel.collapse(false);
    await turn();
  } finally {
    panel.destroy();
    panel.destroy();
    win.HTMLElement.prototype.attachShadow = original;
    restore();
    await win.happyDOM.abort();
  }
});
test("static stylesheet has a safe fallback for browsers without constructed stylesheets", () => {
  const win = new Window();
  Object.defineProperty(win, "CSSStyleSheet", { value: undefined, configurable: true });
  const root = win.document.createElement("div").attachShadow({ mode: "closed" });
  attachPortableStyle(root as never, win.document as never, ":host{display:block}");
  expect(root.querySelector("style")?.textContent).toBe(":host{display:block}");
});
