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
