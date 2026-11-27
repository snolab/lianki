import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { startPortableLi, type PortableUi } from "../src/portable-li";
import { GLOBAL_CHAT_KEY, globalChatStore } from "../src/pill-chat-global";
import { PILLCHAT_ON_KEY } from "../src/pill-chat-trust";
import { stubGlobals } from "./support/globals";

const turn = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(previous?: Map<string, unknown>) {
  const win = new Window({ url: "https://example.test" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
  });
  const values =
    previous ?? new Map<string, unknown>([[PILLCHAT_ON_KEY, JSON.stringify({ on: true })]]);
  const changes = new Map<string, Set<() => void>>();
  const gm = {
    getValue: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    setValue: (key: string, value: unknown) => {
      values.set(key, value);
      for (const callback of changes.get(key) ?? []) callback();
    },
  };
  const store = globalChatStore(gm);
  if (!previous) store.consent("all", "account_a");
  const mounts: Parameters<PortableUi["mount"]>[0][] = [];
  let destroyed = 0;
  const controller = startPortableLi({
    gm,
    doc: win.document as never,
    win: win as never,
    origin: "https://lianki.com",
    hostOrigin: win.location.origin,
    top: true,
    call: async () => ({ ok: true, kind: "hello", principal: "account_a" }),
    ui: async () => ({
      mount: (options) => {
        mounts.push(options);
        return {
          destroy: () => {
            destroyed++;
          },
        };
      },
    }),
    watch: (key, callback) => {
      const list = changes.get(key) ?? new Set();
      list.add(callback);
      changes.set(key, list);
      return () => {
        list.delete(callback);
      };
    },
  });
  return {
    win,
    store,
    values,
    mounts,
    destroyed: () => destroyed,
    finish() {
      controller.destroy();
      restore();
      win.happyDOM.abort();
    },
  };
}

test("a temporary signed-out or off reply closes the connection without deleting account-bound consent", async () => {
  for (const error of ["signed-out", "off"]) {
    const f = fixture();
    try {
      await turn();
      const before = f.store.read();
      (f.mounts[0].onInvalidAccount as (error: string) => void)(error);
      expect(f.destroyed()).toBe(1);
      expect(f.store.read()).toEqual(before);
    } finally {
      f.finish();
    }
  }
});

test("a superseded panel cannot invalidate newer explicit consent or an account change in another tab", async () => {
  for (const principal of ["account_a", "account_b"]) {
    const f = fixture();
    try {
      await turn();
      const old = f.mounts[0];
      f.store.consent("all", principal);
      const fresh = f.store.read();
      await turn();
      (old.onInvalidAccount as (error: string) => void)("account-changed");
      expect(f.store.read()).toEqual(fresh);
      expect(f.mounts.at(-1)?.principal).toBe(principal);
      expect(f.mounts).toHaveLength(2);
    } finally {
      f.finish();
    }
  }
});

test("a live confirmed mismatch still invalidates exactly its own principal and consent stamp", async () => {
  const f = fixture();
  try {
    await turn();
    (f.mounts[0].onInvalidAccount as (error: string) => void)("account-changed");
    expect(f.store.read()).toMatchObject({ consent: "unknown", principal: null });
  } finally {
    f.finish();
  }
});

test("a denied or silently discarded GM consent write is not reported as successful", () => {
  for (const mode of ["drop", "throw"]) {
    const store = globalChatStore({
      getValue: () => undefined,
      setValue: () => {
        if (mode === "throw") throw Error("synthetic quota failure");
      },
    });
    expect(store.consent("all", "account_a")).toBe(false);
    expect(store.read().consent).toBe("unknown");
  }
  // The real key is stable across page loads; no version/revision is part of it.
  expect(GLOBAL_CHAT_KEY).toBe("lianki_lichat_global_v1");
});

test("same-install consent and its stamp survive teardown and a new page instance", async () => {
  const first = fixture();
  const values = first.values;
  const saved = first.store.read();
  try {
    await turn();
    expect(first.mounts).toHaveLength(1);
  } finally {
    first.finish();
  }
  const next = fixture(values);
  try {
    await turn();
    expect(next.store.read()).toEqual(saved);
    expect(next.mounts).toHaveLength(1);
    expect(next.win.document.querySelector("lianki-portable-consent")).toBeNull();
  } finally {
    next.finish();
  }
});

test("approval or refusal received from another tab dismisses an already-open consent prompt", async () => {
  for (const decision of ["all", "off"] as const) {
    const f = fixture(new Map([[PILLCHAT_ON_KEY, JSON.stringify({ on: true })]]));
    try {
      await turn();
      expect(f.win.document.querySelector("lianki-portable-consent")).not.toBeNull();
      f.store.consent(decision, "account_a");
      await turn();
      expect(f.win.document.querySelector("lianki-portable-consent")).toBeNull();
      expect(f.mounts).toHaveLength(decision === "all" ? 1 : 0);
      const diagnosis = f.win.document.documentElement.getAttribute("data-lk-portable-consent");
      expect(diagnosis).toBe(`${decision}:bound:stamped`);
      expect(diagnosis).not.toContain("account_a");
    } finally {
      f.finish();
    }
  }
});
