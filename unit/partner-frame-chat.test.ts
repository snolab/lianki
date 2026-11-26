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
    let load: (() => { contents: string; loader: string }) | undefined;
    portableWindowPlugin(c).setup({
      onLoad: (o: { filter: RegExp }, fn: () => { contents: string; loader: string }) => {
        filter = o.filter;
        load = fn;
      },
    } as never);
    expect(filter!.test("/repo/src/portable-window.ts")).toBe(true);
    expect(filter!.test("/repo/src/portable-window.tsx")).toBe(false);
    expect(load!().contents.startsWith("export default function portableWindow(gm)")).toBe(true);
    expect(load!().loader).toBe("js");
  });
});
