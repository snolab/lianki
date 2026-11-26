import { describe, expect, test } from "bun:test";
import { frameDraftScope, frameWarning, isAdvancedSend } from "../lib/partner-frame-chat";
import { windowModule } from "../scripts/portable-window-plugin";

describe("the frame chat's rules", () => {
  test("drafts are scoped per account and site; unknown viewers share no account's scope", () => {
    expect(frameDraftScope("acct_a", "https://github.com")).toBe(
      "portable~acct_a~https://github.com",
    );
    expect(frameDraftScope("acct_b", "https://github.com")).not.toBe(
      frameDraftScope("acct_a", "https://github.com"),
    );
    expect(frameDraftScope("acct_a", "https://zhihu.com")).not.toBe(
      frameDraftScope("acct_a", "https://github.com"),
    );
    expect(frameDraftScope(undefined, "https://github.com")).toBe(
      "portable~pending~https://github.com",
    );
    expect(frameDraftScope("a b<script>", undefined)).toBe("portable~pending~unknown");
  });

  test("no standing notice: only a failure, the hub's warning, a share note, or a tried advanced action", () => {
    expect(frameWarning({}, { sendFailed: "x" })).toBeUndefined();
    expect(frameWarning({ sendFailed: true }, { sendFailed: "Not sent", advanced: "adv" })).toBe(
      "⚠ Not sent",
    );
    expect(frameWarning({ warning: "slow down" }, { sendFailed: "x", advanced: "adv" })).toBe(
      "slow down",
    );
    expect(frameWarning({}, { sendFailed: "x", note: "nothing selected", advanced: "adv" })).toBe(
      "nothing selected",
    );
    expect(frameWarning({}, { sendFailed: "x", advanced: "adv" })).toBe("adv");
  });

  test("advanced sends: an address, page context or files", () => {
    expect(isAdvancedSend()).toBe(false);
    expect(isAdvancedSend("/plan")).toBe(true);
    expect(isAdvancedSend(undefined, { context: {} })).toBe(true);
    expect(isAdvancedSend(undefined, { attachments: [1] })).toBe(true);
    expect(isAdvancedSend(undefined, { attachments: [] })).toBe(false);
  });
});

describe("the bundled window module", () => {
  test("the partner build becomes one named function, its body not run at module load", () => {
    const mod = windowModule(
      '(function (gm) {"use strict";var x=globalThis.__ran=1;return {api:{},css:[],rev:"r"};})',
    );
    expect(mod.startsWith("export default function portableWindow(gm)")).toBe(true);
    (globalThis as { __ran?: number }).__ran = 0;
    // Evaluating the module body (as the bundle does) only defines the function.
    const fn = new Function(mod.replace("export default ", "return "))();
    expect((globalThis as { __ran?: number }).__ran).toBe(0);
    fn(null);
    expect((globalThis as { __ran?: number }).__ran).toBe(1);
    expect(() => windowModule("var notAFunction = 1")).toThrow();
  });
});

describe("the portable window plugin", () => {
  test("serves the partner build as the window module, and rebuilds only when an input changed", async () => {
    const { mkdtempSync, writeFileSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { partnerBuildCached, portableWindowPlugin } =
      await import("../scripts/portable-window-plugin");
    const dir = mkdtempSync(join(tmpdir(), "pw-"));
    const input = join(dir, "a.ts");
    writeFileSync(input, "x");
    let builds = 0;
    const make = async () => (
      builds++,
      {
        code: '(function (gm) {"use strict";return {api:{},css:[],rev:"r"};})',
        rev: "r" + builds,
        bytes: 1,
        inputs: [input, join(dir, "missing.ts")],
      }
    );
    const a = await partnerBuildCached(make);
    const b = await partnerBuildCached(make);
    expect(b).toBe(a);
    expect(builds).toBe(1);
    utimesSync(input, new Date(), new Date(Date.now() + 5000));
    const c = await partnerBuildCached(make);
    expect(c).not.toBe(a);
    expect(builds).toBe(2);
    // The plugin answers only for src/portable-window.ts, with the window module.
    let filter: RegExp | undefined;
    let load: (() => Promise<{ contents: string; loader: string }>) | undefined;
    portableWindowPlugin(c, async () => ({ zh: { message: "给{name}发消息…" } })).setup({
      onLoad: (o: { filter: RegExp }, fn: () => Promise<{ contents: string; loader: string }>) => {
        filter = o.filter;
        load = fn;
      },
    } as never);
    expect(filter!.test("/repo/src/portable-window.ts")).toBe(true);
    expect(filter!.test("/repo/src/portable-window.tsx")).toBe(false);
    const out = await load!();
    expect(out.contents.startsWith("export default function portableWindow(gm)")).toBe(true);
    expect(out.contents).toContain(
      'export const portableChatStrings = {"zh":{"message":"给{name}发消息…"}}',
    );
    expect(out.loader).toBe("js");
  });
});

describe("the frame's language and capability", () => {
  test("the frame URL carries his Lianki language; a ready says what the frame can do", async () => {
    const { frameUrl, portMsg, PORTABLE_CAP } =
      await import("../packages/debug-chat/src/embed/frame-protocol");
    expect(frameUrl("https://lianki.com", "zh")).toBe("https://lianki.com/embed/partner?lang=zh");
    expect(frameUrl("https://lianki.com", "zh-CN&x=1")).toBe("https://lianki.com/embed/partner");
    expect(frameUrl("https://lianki.com")).toBe("https://lianki.com/embed/partner");
    expect(portMsg({ type: "ready" })).toEqual({ type: "ready" });
    expect(portMsg({ type: "ready", caps: [PORTABLE_CAP, 3, "x".repeat(40)] })).toEqual({
      type: "ready",
      caps: [PORTABLE_CAP],
    });
  });

  test("the chat strings table comes from the learning-partner dictionary, 16 locales", async () => {
    const { chatStringsTable } = await import("../scripts/portable-window-plugin");
    const t = await chatStringsTable();
    expect(Object.keys(t).length).toBe(16);
    expect(t.zh!.message).toContain("{name}");
    expect(t.fr!.message).not.toBe(t.zh!.message);
  });
});

describe("the frame shell is see-through", () => {
  test("the iframe's color-scheme matches the lianki.com page inside, so no opaque canvas is painted", async () => {
    const { Window } = await import("happy-dom");
    const { frameShell } = await import("../src/partner-frame");
    const win = new Window({ url: "https://example.org/" });
    const shell = frameShell({
      doc: win.document as never,
      win: win as never,
      origin: "https://lianki.com",
      label: "example.org/",
      ticket: async () => null,
      gripLabel: "Li",
      fixedSize: { w: "420px", h: "560px" },
      capMs: 10,
    });
    try {
      expect(shell.iframe.style.getPropertyValue("color-scheme")).toBe("light dark");
      expect(shell.iframe.style.getPropertyValue("background")).toContain("transparent");
      expect(shell.iframe.style.getPropertyValue("width")).toBe("420px");
    } finally {
      shell.destroy();
      await win.happyDOM.abort();
    }
  });
});
