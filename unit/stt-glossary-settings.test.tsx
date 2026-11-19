import { expect, test } from "bun:test";
import React, { act } from "react";
import { Window } from "happy-dom";
import { SttGlossarySettings, type SttGlossaryLabels } from "../app/components/SttGlossarySettings";
import { STT_HOTWORDS_KEY, STT_CORRECTIONS_KEY } from "../lib/stt-glossary";
import { SYNC_KEY, PREF_APPLIED_EVENT } from "../packages/ui-state/src/account";
import { stubGlobals } from "./support/globals";

const labels: SttGlossaryLabels = {
  heading: "Vocabulary",
  help: "Explicit hints",
  words: "Terms",
  corrections: "Pairs",
  save: "Save",
  saved: "Saved",
  error: "Try again",
};
test("preferences editor saves explicit pairs, preserves unsaved edits, and clears another account's values", async () => {
  const win = new Window({ url: "https://example.invalid/my/preferences" });
  const storage = win.localStorage;
  storage.setItem(SYNC_KEY, JSON.stringify({ userId: "account-a", outbox: {} }));
  let reject = false;
  let pendingReceipt: Promise<Response> | undefined;
  const sync = { pull: async () => {}, scan: () => 0, flush: async () => {} };
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: win.navigator,
    Event: win.Event,
    localStorage: storage,
    __lkPrefSync: sync,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () =>
      pendingReceipt ??
      Response.json({
        user: "account-a",
        prefs: reject
          ? {}
          : {
              "stt.hotwords": {
                value: JSON.parse(storage.getItem(STT_HOTWORDS_KEY) ?? "{}").value ?? [],
              },
              "stt.corrections": {
                value: JSON.parse(storage.getItem(STT_CORRECTIONS_KEY) ?? "{}").value ?? [],
              },
            },
      }),
  });
  // ReactDOM caches DOM/change-event support when imported. Initialize it
  // only after the fake document exists, so later UI suites remain usable.
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  try {
    await act(async () => root.render(<SttGlossarySettings userId="account-a" labels={labels} />));
    const fields = Array.from(host.querySelectorAll("textarea"));
    const edit = async (i: number, text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
          fields[i],
          text,
        );
        fields[i]!.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
    await edit(0, "Aurora");
    await edit(1, "aura => Aurora");
    await act(async () => win.dispatchEvent(new win.Event(PREF_APPLIED_EVENT)));
    expect(fields[0]!.value).toBe("Aurora");
    await act(async () => host.querySelector("button")!.click());
    expect(JSON.parse(storage.getItem(STT_HOTWORDS_KEY)!).value).toEqual(["Aurora"]);
    expect(JSON.parse(storage.getItem(STT_CORRECTIONS_KEY)!).value[0]).toMatchObject({
      heard: "aura",
      corrected: "Aurora",
    });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Saved");
    await act(async () => win.dispatchEvent(new win.Event(PREF_APPLIED_EVENT)));
    expect(fields[1]!.value).toBe("aura => Aurora");
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Saved");
    reject = true;
    await edit(1, "wrong syntax");
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Try again");
    storage.setItem(SYNC_KEY, JSON.stringify({ userId: "account-b", outbox: {} }));
    await act(async () => win.dispatchEvent(new win.Event(PREF_APPLIED_EVENT)));
    expect(fields[0]!.value).toBe("");
    expect(host.querySelector("button")!.disabled).toBe(true);
    // Return to A, then change the authenticated/prop account while A's save awaits its receipt.
    storage.setItem(SYNC_KEY, JSON.stringify({ userId: "account-a", outbox: {} }));
    await act(async () => win.dispatchEvent(new win.Event(PREF_APPLIED_EVENT)));
    await edit(0, "UnsavedAccountA");
    await edit(1, "aura => Aurora");
    let release!: (response: Response) => void;
    pendingReceipt = new Promise((resolve) => {
      release = resolve;
    });
    await act(async () => host.querySelector("button")!.click());
    storage.setItem(SYNC_KEY, JSON.stringify({ userId: "account-b", outbox: {} }));
    storage.setItem(STT_HOTWORDS_KEY, JSON.stringify({ userId: "account-b", value: ["Boreal"] }));
    storage.setItem(STT_CORRECTIONS_KEY, JSON.stringify({ userId: "account-b", value: [] }));
    await act(async () => root.render(<SttGlossarySettings userId="account-b" labels={labels} />));
    expect(fields[0]!.value).toBe("Boreal");
    expect(fields[1]!.value).toBe("");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
    await act(async () => {
      release(Response.json({ user: "account-a", prefs: {} }));
      await pendingReceipt;
    });
    expect(fields[0]!.value).toBe("Boreal");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    restore();
  }
});
