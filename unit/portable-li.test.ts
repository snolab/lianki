import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import { startPortableLi, type PortableUi } from "../src/portable-li";
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
/**
 * A stand-in for the bundled DebugChat window: a <lianki-portable-chat> host
 * with a closed root and a "Hide on this website" button, reading once through
 * the broker it is handed (as the real client does on mount).
 */
function markerUi(win: Window): PortableUi {
  return {
    mount(o) {
      const host = win.document.createElement("lianki-portable-chat");
      const root = host.attachShadow({ mode: "closed" });
      const hide = win.document.createElement("button");
      hide.textContent = o.strings.excludeHere;
      hide.addEventListener("click", () => o.onExclude());
      root.append(hide as never);
      win.document.documentElement.append(host);
      void o.call({ op: "read", wait: false }, o.principal).then((r) => {
        if (!r.ok && ["account-changed", "signed-out", "off"].includes(r.error))
          o.onInvalidAccount();
      });
      return { destroy: () => host.remove() };
    },
  };
}
type FrameDep = (o: { principal: string; onAccountMismatch: () => void }) => {
  result: Promise<"ready" | "blocked">;
  destroy(): void;
};
function fixture(
  url = "https://github.com/",
  ui?: () => Promise<PortableUi | null>,
  frame?: FrameDep,
) {
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
    ui: ui ?? (async () => markerUi(win as never)),
    ...(frame ? { frame } : {}),
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
test("the lianki.com frame first; where it is refused, the bundled DebugChat with the broker, the hint link and a per-account, per-site draft scope; never a plain panel", async () => {
  const mounts: Parameters<PortableUi["mount"]>[0][] = [];
  let destroyed = 0;
  const ui: PortableUi = {
    mount: (o) => {
      mounts.push(o);
      return { destroy: () => void destroyed++ };
    },
  };
  // 1. The frame answers: it is the window, nothing is bundled-mounted.
  let frames = 0,
    framesGone = 0;
  const ready: FrameDep = () => (
    frames++, { result: Promise.resolve("ready"), destroy: () => void framesGone++ }
  );
  const a = fixture("https://example.org/", async () => ui, ready);
  try {
    await turn();
    a.click("同意所有网站");
    await turn();
    expect(frames).toBe(1);
    expect(mounts).toHaveLength(0);
    // Closing tears the frame down.
    a.controller.close();
    expect(framesGone).toBe(1);
  } finally {
    a.finish();
  }
  // 2. The frame is refused (CSP frame-src): the bundled window, same component.
  let blockedGone = 0;
  const blocked: FrameDep = () => ({
    result: Promise.resolve("blocked"),
    destroy: () => void blockedGone++,
  });
  const f = fixture("https://github.com/", async () => ui, blocked);
  try {
    await turn();
    f.click("同意所有网站");
    await turn();
    expect(blockedGone).toBe(1);
    expect(mounts).toHaveLength(1);
    const o = mounts[0];
    expect(o.principal).toBe("account_a");
    expect(o.draftScope).toBe("portable~account_a~https://github.com");
    expect(o.appOrigin).toBe("https://lianki.com");
    expect(o.strings.name).toBe("随身Li");
    expect(o.strings.advancedHint).toBe("去 lianki.com 为这个网站单独打开");
    expect(o.advancedHref).toBe(
      "https://lianki.com/chat?from=" + encodeURIComponent("https://github.com"),
    );
    expect(f.win.document.querySelector("lianki-portable-chat")).toBeNull();
    // The broker it was handed is the userscript's chat-only call.
    await o.call({ op: "read", wait: false }, o.principal);
    expect(f.calls.at(-1)).toEqual([{ op: "read", wait: false }, "account_a"]);
    // A pill tap while it is up goes through the slot.
    expect(await f.controller.open()).toBe("ready");
    // "Hide on this website" from its menu excludes the site and takes it down.
    o.onExclude();
    await turn();
    expect(f.controller.excluded()).toBe(true);
    expect(destroyed).toBe(1);
  } finally {
    f.finish();
  }
  // Another site, another account: another draft scope.
  const z = fixture("https://www.zhihu.com/", async () => ui);
  try {
    z.principal("account_b");
    await turn();
    z.click("同意所有网站");
    await turn();
    expect(mounts.at(-1)!.draftScope).toBe("portable~account_b~https://www.zhihu.com");
    mounts.at(-1)!.onInvalidAccount();
    await turn();
    expect(destroyed).toBe(2);
  } finally {
    z.finish();
  }
  // 3. Nothing can draw (no bundle, a throwing frame or mount): no other chat UI appears.
  for (const [brokenUi, brokenFrame] of [
    [async () => null, undefined],
    [
      async () => {
        throw new Error("load");
      },
      () => {
        throw new Error("frame");
      },
    ],
    [
      async () => ({
        mount: () => {
          throw new Error("styles blocked");
        },
      }),
      undefined,
    ],
  ] as [() => Promise<PortableUi | null>, FrameDep | undefined][]) {
    const h = fixture("https://github.com/", brokenUi, brokenFrame);
    try {
      await turn();
      h.click("同意所有网站");
      await turn();
      expect(h.win.document.querySelector("lianki-portable-chat")).toBeNull();
      expect(h.roots.filter((r) => r.host.isConnected).map((r) => r.host.localName)).toEqual([]);
    } finally {
      h.finish();
    }
  }
  // 4. Closed while the frame is still answering: the late answer draws nothing.
  let release!: (r: "ready" | "blocked") => void;
  let lateGone = 0;
  const slow: FrameDep = () => ({
    result: new Promise((r) => (release = r)),
    destroy: () => void lateGone++,
  });
  const before = mounts.length;
  const s = fixture("https://github.com/", async () => ui, slow);
  try {
    await turn();
    s.click("同意所有网站");
    await turn();
    s.controller.close();
    release("blocked");
    await turn();
    expect(mounts.length).toBe(before);
    expect(lateGone).toBeGreaterThan(0);
  } finally {
    s.finish();
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

test("frame tickets are for the consented account only: a mismatch or a refusal as another account closes for re-consent", async () => {
  const { consentedFrameTicket } = await import("../src/pill-chat");
  const asks: { url: string; headers?: Record<string, string> }[] = [];
  const answer =
    (status: number, body: unknown) =>
    async (url: string, opts?: { headers?: Record<string, string> }) => {
      asks.push({ url, headers: opts?.headers });
      return { ok: status < 300, status, json: async () => body };
    };
  let mismatches = 0;
  const base = {
    origin: "https://lianki.com",
    principal: "account_a",
    onAccountMismatch: () => void mismatches++,
    report: () => {},
  };
  expect(
    await consentedFrameTicket({
      ...base,
      fetch: answer(200, { ticket: "t1", principal: "account_a" }),
    }),
  ).toBe("t1");
  expect(asks[0].url).toBe("https://lianki.com/api/chat/page-ticket");
  expect(asks[0].headers?.authorization).toBeUndefined();
  expect(mismatches).toBe(0);
  // The cookie switched to B: B's ticket is never handed to A's window.
  expect(
    await consentedFrameTicket({
      ...base,
      fetch: answer(200, { ticket: "tB", principal: "account_b" }),
    }),
  ).toBeNull();
  expect(
    await consentedFrameTicket({ ...base, fetch: answer(409, { error: "account-changed" }) }),
  ).toBeNull();
  expect(mismatches).toBe(2);
  // No echo or a malformed one (an older issuer): fail closed, but no re-consent.
  expect(await consentedFrameTicket({ ...base, fetch: answer(200, { ticket: "t?" }) })).toBeNull();
  expect(
    await consentedFrameTicket({
      ...base,
      fetch: answer(200, { ticket: "t?", principal: "a b<" }),
    }),
  ).toBeNull();
  expect(mismatches).toBe(2);
  // Other refusals and network errors: no ticket, no re-consent.
  expect(
    await consentedFrameTicket({ ...base, fetch: answer(503, { error: "unavailable" }) }),
  ).toBeNull();
  expect(
    await consentedFrameTicket({
      ...base,
      fetch: async () => {
        throw new Error("net");
      },
    }),
  ).toBeNull();
  expect(mismatches).toBe(2);

  // In the window: the frame's mismatch closes it and asks for consent again.
  let frameArgs: { principal: string; onAccountMismatch: () => void } | undefined;
  let gone = 0;
  const f = fixture(
    "https://example.org/",
    async () => null,
    (o) => {
      frameArgs = o;
      return { result: Promise.resolve("ready"), destroy: () => void gone++ };
    },
  );
  try {
    await turn();
    f.click("同意所有网站");
    await turn();
    expect(frameArgs?.principal).toBe("account_a");
    frameArgs!.onAccountMismatch();
    await turn();
    expect(gone).toBeGreaterThan(0);
    expect(globalChatStore(f.gm).read().consent).toBe("unknown");
    expect(f.win.document.documentElement.getAttribute("data-lk-portable")).toBe(
      "none frame:account-mismatch",
    );
  } finally {
    f.finish();
  }
});

test("why the window fell back is recorded as a reason code on <html>, with no secrets", async () => {
  const { portableWhy } = await import("../src/portable-li");
  expect(portableWhy(new Error("styles blocked"))).toBe("Error: styles blocked");
  expect(portableWhy(new TypeError("https://x.test/?token=abc.def <b>"))).not.toMatch(/[/?=.<>]/);
  expect(portableWhy("x".repeat(500)).length).toBeLessThanOrEqual(60);
  const blocked = fixture(
    "https://github.com/",
    async () => null,
    () => ({
      result: Promise.resolve("blocked"),
      destroy() {},
    }),
  );
  try {
    await turn();
    blocked.click("同意所有网站");
    await turn();
    expect(blocked.win.document.documentElement.getAttribute("data-lk-portable")).toBe(
      "none frame:blocked bundle:absent",
    );
  } finally {
    blocked.finish();
  }
  const drawn = fixture("https://github.com/");
  try {
    await turn();
    drawn.click("同意所有网站");
    await turn();
    expect(drawn.win.document.documentElement.getAttribute("data-lk-portable")).toBe(
      "bundled frame:none",
    );
  } finally {
    drawn.finish();
  }
});

test("the pill wiring opens 随身Li in the lianki.com frame with a consented-account ticket; a navigated frame is torn down", async () => {
  const { pillChat } = await import("../src/pill-chat");
  const win = new Window({ url: "https://example.org/" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    location: win.location,
  });
  const roots: ShadowRoot[] = [];
  const original = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (o) {
    const r = original.call(this, o);
    roots.push(r as never);
    return r;
  };
  const values = new Map<string, unknown>([
    [PILLCHAT_ON_KEY, JSON.stringify({ on: true, at: Date.now() })],
    [PILL_UI_LANGUAGE_KEY, "zh"],
  ]);
  const ac = new AbortController();
  let shellDeps:
    | {
        ticket: () => Promise<string | null>;
        label: string;
        pos: { get(): unknown; set(p: { x: number; y: number }): void };
      }
    | undefined;
  let destroyed = 0;
  const iframe = win.document.createElement("iframe");
  const asked: string[] = [];
  try {
    pillChat({
      origin: "https://lianki.com",
      hostname: "example.org",
      hostOrigin: "https://example.org",
      path: "/a",
      top: true,
      doc: win.document as never,
      win: win as never,
      info: { sandboxMode: "raw" },
      signal: ac.signal,
      getValue: (key, fallback) => values.get(key) ?? fallback,
      setValue: (key, value) => void values.set(key, value),
      gmFetch: async () => {
        throw Error("no general API fetch");
      },
      pageFetch: async (url) => {
        asked.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ticket: "tk", principal: "account_a" }),
        };
      },
      chatRequest: ((details: { data?: string; onload: (r: unknown) => void }) => {
        const input = JSON.parse(details.data ?? "{}");
        const body =
          input.op === "hello"
            ? { ok: true, kind: "hello", principal: "account_a" }
            : { ok: false, error: "unavailable" };
        setTimeout(() => details.onload({ status: 200, responseText: JSON.stringify(body) }), 0);
        return { abort() {} };
      }) as never,
      frame: ((deps: NonNullable<typeof shellDeps>) => {
        shellDeps = deps;
        return {
          result: Promise.resolve("ready" as const),
          iframe,
          host: win.document.createElement("div"),
          destroy: () => void destroyed++,
        };
      }) as never,
    });
    await turn();
    const allow = roots
      .flatMap((r) => [...r.querySelectorAll("button")])
      .find((b) => b.textContent === "同意所有网站");
    (allow as unknown as { click(): void }).click();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await turn();
    }
    expect(shellDeps?.label).toBe("example.org/a");
    expect(await shellDeps!.ticket()).toBe("tk");
    expect(asked).toEqual(["https://lianki.com/api/chat/page-ticket"]);
    expect(win.document.documentElement.getAttribute("data-lk-portable")).toBe("frame");
    // The frame keeps the partner's dragged position, per device.
    expect(shellDeps!.pos.get()).toBeNull();
    shellDeps!.pos.set({ x: 1.4, y: 2.6 });
    expect(shellDeps!.pos.get()).toEqual({ x: 1, y: 3 });
    iframe.dispatchEvent(new win.Event("load"));
    expect(destroyed).toBe(0);
    iframe.dispatchEvent(new win.Event("load"));
    expect(destroyed).toBe(1);
  } finally {
    ac.abort();
    win.HTMLElement.prototype.attachShadow = original;
    restore();
    await win.happyDOM.abort();
  }
});
