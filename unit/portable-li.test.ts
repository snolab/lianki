import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import { startPortableLi } from "../src/portable-li";
import { GLOBAL_CHAT_KEY, globalChatStore } from "../src/pill-chat-global";
import { PILLCHAT_ON_KEY } from "../src/pill-chat-trust";
import { PILL_UI_LANGUAGE_KEY } from "../src/pill-chat-language";
import {
  PORTABLE_SETTINGS_REQUEST,
  PORTABLE_SETTINGS_STATE,
  parsePortableSettingsRequest,
} from "../src/portable-li-settings-wire";
import { PORTABLE_LI_STRINGS, PORTABLE_LI_CONTEXT } from "../src/portable-li-strings";
import { PILL_CHAT_LOCALES } from "../src/pill-chat-strings";
import type { PortableChatCall } from "../src/portable-li-panel";
const turn = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(url = "https://github.com/") {
  const win = new Window({ url });
  win.document.documentElement.lang = "zh";
  const restore = stubGlobals({
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
  });
  const values = new Map<string, unknown>([
    [PILLCHAT_ON_KEY, JSON.stringify({ on: true, at: Date.now() })],
    [PILL_UI_LANGUAGE_KEY, "zh"],
  ]);
  const changes = new Map<string, Set<() => void>>();
  const gm = {
    getValue: (k: string, d?: unknown) => values.get(k) ?? d,
    setValue: (k: string, v: unknown) => {
      values.set(k, v);
      for (const fn of changes.get(k) ?? []) fn();
    },
  };
  const roots: ShadowRoot[] = [];
  const original = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (o) {
    const root = original.call(this, o);
    roots.push(root as never);
    return root;
  };
  let callCount = 0;
  let failHello = false;
  let readError = false;
  let helloDelay: Promise<void> | undefined;
  let principal = "account_a";
  const calls: unknown[] = [];
  const call: PortableChatCall = async (input, p, signal) => {
    callCount++;
    calls.push([input, p]);
    if (input.op === "hello") {
      await helloDelay;
      return failHello
        ? { ok: false, error: "signed-out" }
        : { ok: true, kind: "hello", principal };
    }
    if (input.op === "send") return { ok: true, kind: "accepted", id: input.id, seq: 1 };
    if (readError) return { ok: false, error: "account-changed" };
    if (input.afterSeq === undefined)
      return {
        ok: true,
        kind: "history",
        range: {
          type: "history",
          thread: "owner~" + "A".repeat(22),
          messages: [],
          removed: [],
          skipped: [],
          afterSeq: 0,
          throughSeq: 0,
          headSeq: 0,
          prunedThroughSeq: 0,
        },
      };
    return new Promise((resolve) => {
      const done = () => resolve({ ok: false, error: "cancelled" });
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  };
  const ac = new AbortController();
  const controller = startPortableLi({
    gm,
    doc: win.document as never,
    win: win as never,
    origin: "https://lianki.com",
    hostOrigin: win.location.origin,
    top: true,
    call,
    signal: ac.signal,
    watch: (key, fn) => {
      const set = changes.get(key) ?? new Set();
      set.add(fn);
      changes.set(key, set);
      return () => {
        set.delete(fn);
      };
    },
  });
  const buttons = () =>
    roots.filter((r) => r.host.isConnected).flatMap((r) => [...r.querySelectorAll("button")]);
  const click = (text: string) => {
    const button = buttons().find((b) => b.textContent === text);
    expect(button).toBeDefined();
    (button as unknown as { click(): void }).click();
  };
  return {
    win,
    values,
    gm,
    roots,
    controller,
    ac,
    calls,
    click,
    callCount: () => callCount,
    helloDelay: (value: Promise<void>) => {
      helloDelay = value;
    },
    readError: (v: boolean) => {
      readError = v;
    },
    failHello: (v: boolean) => {
      failHello = v;
    },
    principal: (v: string) => {
      principal = v;
    },
    finish: () => {
      ac.abort();
      win.HTMLElement.prototype.attachShadow = original;
      restore();
      win.happyDOM.abort();
    },
  };
}
test("global opt-in never fetches chat first, survives site navigation, retracts immediately and keeps LiCards untouched", async () => {
  const f = fixture();
  try {
    f.win.document.body.innerHTML = '<button id="existing-card">Card</button>';
    await turn();
    expect(f.callCount()).toBe(0);
    expect(f.controller.active()).toBe(true);
    expect(f.win.document.querySelector("lianki-portable-consent")).not.toBeNull();
    f.click("同意所有网站");
    await turn();
    expect(globalChatStore(f.gm).read().consent).toBe("all");
    expect(f.callCount()).toBeGreaterThan(0);
    expect(f.win.document.querySelector("lianki-portable-chat")).not.toBeNull();
    expect(f.win.document.getElementById("existing-card")?.textContent).toBe("Card");
    f.click("收起");
    await turn();
    f.click("展开");
    await turn();
    let opened = "";
    f.win.open = ((url: unknown) => {
      opened = String(url);
      return null;
    }) as never;
    f.controller.manage().remove();
    expect(opened).toBe("https://lianki.com/chat/sites");
    f.controller.close();
    await f.controller.open();
    await turn();
    globalChatStore(f.gm).revoke();
    await turn();
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
    await f.controller.open();
    await turn();
    f.click("暂不");
    expect(f.win.document.querySelector("lianki-portable-consent")).toBeNull();
  } finally {
    f.finish();
  }
});
test("failed login cannot grant consent, exclusions remove chat, flag-off dismisses consent and abort unhooks observers", async () => {
  const f = fixture();
  try {
    await turn();
    f.failHello(true);
    f.click("同意所有网站");
    await turn();
    expect(globalChatStore(f.gm).read().consent).toBe("unknown");
    f.gm.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: false, at: Date.now() }));
    await turn();
    expect(f.win.document.querySelector("lianki-portable-consent")).toBeNull();
    f.failHello(false);
    f.gm.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: true, at: Date.now() }));
    await turn();
    f.click("同意所有网站");
    await turn();
    f.click("不在此网站显示");
    await turn();
    expect(f.controller.excluded()).toBe(true);
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
    f.ac.abort();
    globalChatStore(f.gm).exclude("github.com", false);
    await turn();
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
  } finally {
    f.finish();
  }
});
test("settings bridge is confined to the first-party top settings route, including SPA navigation", async () => {
  const f = fixture("https://lianki.com/home");
  try {
    const states: any[] = [];
    f.win.document.addEventListener(PORTABLE_SETTINGS_STATE, (e) =>
      states.push(JSON.parse((e as unknown as CustomEvent).detail)),
    );
    const request = (v: unknown) =>
      f.win.document.dispatchEvent(
        new f.win.CustomEvent(PORTABLE_SETTINGS_REQUEST, { detail: JSON.stringify(v) as never }),
      );
    request({ op: "allow" });
    await turn();
    expect(f.callCount()).toBe(0);
    f.win.history.pushState({}, "", "/chat/sites");
    request({ op: "state" });
    expect(states.at(-1)).toMatchObject({ installed: true, consent: "unknown" });
    request({ op: "allow" });
    await turn();
    expect(states.at(-1).consent).toBe("all");
    request({ op: "exclude", host: "github.com", excluded: true });
    expect(states.at(-1).excluded).toContain("github.com");
    request({ op: "exclude", host: "github.com", excluded: false });
    expect(states.at(-1).excluded).not.toContain("github.com");
    request({ op: "off" });
    expect(states.at(-1).consent).toBe("off");
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
    f.win.document.documentElement.lang = "ja";
    await turn();
    expect(f.values.get(PILL_UI_LANGUAGE_KEY)).toBe("ja");
  } finally {
    f.finish();
  }
  const foreign = fixture();
  try {
    await turn();
    foreign.win.document.dispatchEvent(
      new foreign.win.CustomEvent(PORTABLE_SETTINGS_REQUEST, {
        detail: JSON.stringify({ op: "allow" }) as never,
      }),
    );
    await turn();
    expect(foreign.callCount()).toBe(0);
  } finally {
    foreign.finish();
  }
});
test("settings parser rejects general GM keys and advanced operations; all 16 languages carry disclosure context", () => {
  for (const detail of [
    null,
    {},
    "x",
    JSON.stringify({ op: "eval" }),
    JSON.stringify({ op: "state", key: "lk:token" }),
    JSON.stringify({ op: "exclude", host: "x", excluded: "yes" }),
    "x".repeat(513),
  ])
    expect(parsePortableSettingsRequest(detail)).toBeNull();
  expect(parsePortableSettingsRequest('{"op":"off"}')).toEqual({ op: "off" });
  for (const locale of PILL_CHAT_LOCALES)
    for (const key of Object.keys(PORTABLE_LI_CONTEXT) as (keyof typeof PORTABLE_LI_CONTEXT)[]) {
      expect(PORTABLE_LI_STRINGS[locale][key].length).toBeGreaterThan(0);
      expect(PORTABLE_LI_CONTEXT[key].length).toBeGreaterThan(15);
    }
});

test("a changed account invalidates global consent rather than reading with the old browser grant", async () => {
  const f = fixture();
  try {
    await turn();
    f.click("同意所有网站");
    await turn();
    f.controller.close();
    f.readError(true);
    await f.controller.open();
    await turn();
    expect(globalChatStore(f.gm).read().principal).toBeNull();
    expect(globalChatStore(f.gm).read().consent).toBe("unknown");
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
  } finally {
    f.finish();
  }
});

test("remote revoke, repeated off, account switch and flag-off defeat an older pending global approval", async () => {
  for (const change of ["revoke", "repeat-off", "account", "flag"]) {
    const f = fixture();
    try {
      if (change === "repeat-off") globalChatStore(f.gm).revoke();
      await turn();
      await f.controller.open();
      await turn();
      let release!: () => void;
      f.helloDelay(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      f.click("同意所有网站");
      await turn();
      if (change === "flag")
        f.gm.setValue(PILLCHAT_ON_KEY, JSON.stringify({ on: false, at: Date.now() }));
      else if (change === "account") globalChatStore(f.gm).bind("account_b");
      else globalChatStore(f.gm).revoke();
      release();
      await turn();
      expect(globalChatStore(f.gm).read().consent).not.toBe("all");
      expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
    } finally {
      f.finish();
    }
  }
});
test("unrelated collapse does not cancel a pending explicit approval", async () => {
  const f = fixture();
  try {
    await turn();
    let release!: () => void;
    f.helloDelay(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.click("同意所有网站");
    await turn();
    globalChatStore(f.gm).collapse("another.test", true);
    release();
    await turn();
    expect(globalChatStore(f.gm).read().consent).toBe("all");
    expect(f.win.document.querySelector("lianki-portable-chat")).not.toBeNull();
  } finally {
    f.finish();
  }
});
test("the actual pill wiring hands chat to the portable controller without auto-granting legacy site approval", async () => {
  const { pillChat } = await import("../src/pill-chat");
  const win = new Window({ url: "https://github.com/" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    location: win.location,
  });
  const values = new Map<string, unknown>([
    [PILLCHAT_ON_KEY, JSON.stringify({ on: true, at: Date.now() })],
  ]);
  const ac = new AbortController();
  let requests = 0,
    opened = "";
  win.open = ((url: unknown) => {
    opened = String(url);
    return null;
  }) as never;
  try {
    const chat = pillChat({
      origin: "https://lianki.com",
      hostname: "github.com",
      hostOrigin: "https://github.com",
      top: true,
      doc: win.document as never,
      win: win as never,
      info: { sandboxMode: "raw" },
      signal: ac.signal,
      getValue: (key, fallback) => values.get(key) ?? fallback,
      setValue: (key, value) => {
        values.set(key, value);
      },
      gmFetch: async () => {
        throw Error("no general API fetch");
      },
      chatRequest: () => {
        requests++;
      },
    });
    await turn();
    expect(chat.ownsPortable()).toBe(true);
    expect(chat.entry()).not.toBe("hidden");
    expect(await chat.open()).toBe("denied");
    expect(requests).toBe(0);
    chat.manage().remove();
    expect(opened).toBe("https://lianki.com/chat/sites");
    chat.close();
    expect(win.document.querySelector("lianki-portable-consent")).toBeNull();
  } finally {
    ac.abort();
    restore();
    await win.happyDOM.abort();
  }
});

test("non-web documents disable only portable chat without aborting legacy card initialization", async () => {
  const f = fixture("about:blank");
  try {
    f.win.document.body.innerHTML = '<button id="legacy-card">Card</button>';
    await turn();
    expect(f.controller.active()).toBe(false);
    expect(f.controller.excluded()).toBe(true);
    expect(f.callCount()).toBe(0);
    expect(f.win.document.querySelector("lianki-portable-consent")).toBeNull();
    expect(f.win.document.getElementById("legacy-card")).not.toBeNull();
  } finally {
    f.finish();
  }
});
