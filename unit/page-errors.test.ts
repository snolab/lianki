import { describe, expect, it } from "bun:test";
import {
  NETWORK_AFTER_HIDE_MS,
  PAGE_ERROR_DEDUPE_MS,
  PAGE_ERROR_MESSAGE_MAX,
  PAGE_ERROR_PER_MINUTE,
  PAGE_ERROR_STACK_MAX,
  argText,
  createPageErrorReporter,
  installPageErrorHooks,
  isReportableNetworkFailure,
  pathOf,
  reportPageError,
  scrub,
  typedText,
} from "@lianki/debug-chat/page-errors";

describe("page-errors scrub", () => {
  it("strips emails, bearer tokens, JWTs, key=value secrets and cookies", () => {
    const s = scrub(
      "user a.b+c@example.com Authorization: Bearer abc.DEF-123 jwt eyJhbGciOi.eyJzdWIiOiIx.sig token=s3cr3t password: hunter2 cookie a=1; b=2",
    );
    expect(s).not.toContain("example.com");
    expect(s).not.toContain("abc.DEF-123");
    expect(s).not.toContain("eyJ");
    expect(s).not.toContain("s3cr3t");
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("a=1; b=2");
    expect(s).toContain("<email>");
  });

  it("drops query strings and fragments, keeping the path", () => {
    expect(scrub("GET https://lianki.com/api/words/tts?text=hello&lang=en failed")).toBe(
      "GET https://lianki.com/api/words/tts?… failed",
    );
    expect(scrub("at /list?q=private#frag")).toBe("at /list?…");
    // A sentence's question mark is not a query.
    expect(scrub("Why? because")).toBe("Why? because");
  });

  it("cuts out long opaque tokens, not ordinary words", () => {
    expect(scrub("id 0123456789abcdef0123456789abcdef01 ok")).toBe("id <token> ok");
    expect(scrub("TypeError: Cannot read properties of undefined")).toBe(
      "TypeError: Cannot read properties of undefined",
    );
  });

  it("cuts out what the user typed or said", () => {
    expect(scrub("render failed for my secret note here", ["my secret note"])).toBe(
      "render failed for <typed> here",
    );
    // Too short to be worth it (and would eat ordinary text).
    expect(scrub("a b", ["a"])).toBe("a b");
  });

  it("pathOf keeps only the path", () => {
    expect(pathOf("/api/words/tts?text=x", "https://lianki.com")).toBe("/api/words/tts");
    expect(pathOf("https://lianki.com/a/b?c#d", "https://lianki.com")).toBe("/a/b");
    expect(pathOf("https://cdn.example/x.mp3?sig=1", "https://lianki.com")).toBe(
      "cdn.example/x.mp3",
    );
    expect(pathOf("blob:https://lianki.com/uuid")).toBe("blob:");
    expect(pathOf("data:audio/wav;base64,AAAA")).toBe("data:");
  });

  it("never serializes an object passed to console.error", () => {
    expect(argText({ text: "what I typed" })).toBe("[Object]");
    expect(argText(new TypeError("x"))).toBe("TypeError: x");
    expect(argText(503)).toBe("503");
  });
});

describe("page-errors reporter", () => {
  const make = (t = { now: 1_000_000 }) => {
    const sent: Record<string, unknown>[] = [];
    const r = createPageErrorReporter({
      now: () => t.now,
      rev: "abc",
      pagePath: () => "/words",
      sensitive: () => ["typed words here"],
    });
    r.attach((m) => sent.push(m));
    return { r, sent, t };
  };

  it("sends the wire shape: kind, message, stack, path, status, at, rev", () => {
    const { r, sent } = make();
    r.report({
      kind: "fetch",
      message: "GET /api/words/tts 503",
      path: "/api/words/tts?text=x",
      status: 503,
    });
    expect(sent).toEqual([
      {
        type: "page-error",
        kind: "fetch",
        message: "GET /api/words/tts 503",
        path: "/api/words/tts",
        status: 503,
        at: 1_000_000,
        rev: "abc",
      },
    ]);
  });

  it("dedupes kind+message+path for 5 minutes", () => {
    const { r, sent, t } = make();
    const e = { kind: "error" as const, message: "TypeError: x is undefined" };
    r.report(e);
    r.report(e);
    r.report({ ...e, path: "/list" });
    r.report({ ...e, kind: "console" });
    expect(sent).toHaveLength(3);
    t.now += PAGE_ERROR_DEDUPE_MS - 1;
    r.report(e);
    expect(sent).toHaveLength(3);
    t.now += 1;
    r.report(e);
    expect(sent).toHaveLength(4);
  });

  it("sends at most 10 a minute", () => {
    const { r, sent, t } = make();
    for (let i = 0; i < 25; i++) r.report({ kind: "console", message: `boom ${i}` });
    expect(sent).toHaveLength(PAGE_ERROR_PER_MINUTE);
    t.now += 60_000;
    r.report({ kind: "console", message: "later" });
    expect(sent).toHaveLength(PAGE_ERROR_PER_MINUTE + 1);
  });

  it("caps message and stack, and scrubs both", () => {
    const { r, sent } = make();
    const stack = Array.from(
      { length: 40 },
      (_, i) => `at f${i} (https://lianki.com/x.js?v=${i}:1:1)`,
    ).join("\n");
    r.report({
      kind: "error",
      message: `typed words here ${"y".repeat(2000)} me@x.com`,
      stack: stack + "z".repeat(5000),
    });
    const m = sent[0] as { message: string; stack: string };
    expect(m.message.length).toBeLessThanOrEqual(PAGE_ERROR_MESSAGE_MAX);
    expect(m.message.startsWith("<typed>")).toBe(true);
    expect(m.stack.length).toBeLessThanOrEqual(PAGE_ERROR_STACK_MAX);
    expect(m.stack.split("\n").length).toBeLessThanOrEqual(12);
    expect(m.stack).not.toContain("v=");
  });

  it("queues until attached; a friend's page (disable) sends nothing, ever", () => {
    const sent: unknown[] = [];
    const r = createPageErrorReporter({ now: () => 1, pagePath: () => "/" });
    r.report({ kind: "error", message: "early" });
    r.attach((m) => sent.push(m));
    expect(sent).toHaveLength(1);
    r.detach();
    r.report({ kind: "error", message: "while away" });
    expect(sent).toHaveLength(1);
    const friend = createPageErrorReporter({ now: () => 1, pagePath: () => "/" });
    friend.report({ kind: "error", message: "load" });
    friend.disable();
    friend.attach((m) => sent.push(m));
    friend.report({ kind: "error", message: "after" });
    expect(sent).toHaveLength(1);
  });
});

describe("page-errors hooks", () => {
  /** Enough of a window: events, console and fetch. */
  const fakeWin = (fetchImpl: typeof fetch) => {
    const target = new EventTarget();
    const logged: unknown[][] = [];
    const win = Object.assign(target, {
      location: {
        origin: "https://lianki.com",
        href: "https://lianki.com/words",
        pathname: "/words",
      },
      console: { error: (...a: unknown[]) => void logged.push(a) },
      fetch: fetchImpl,
    });
    return { win: win as unknown as Window & typeof globalThis, logged };
  };

  it("reports console.error (still logging it), /api fetches ≥400 and network failures, and not other origins", async () => {
    const sent: { kind: string; message: string; status?: number }[] = [];
    const r = createPageErrorReporter({ now: () => 1, pagePath: () => "/words" });
    r.attach((m) => sent.push(m));
    const { win, logged } = fakeWin((async (u: string) => {
      if (String(u).includes("down")) throw new TypeError("Failed to fetch");
      return new Response("", { status: String(u).includes("tts") ? 503 : 200 });
    }) as unknown as typeof fetch);
    const off = installPageErrorHooks(win, r);
    win.console.error("oops", { secret: 1 });
    expect(logged).toHaveLength(1);
    await win.fetch("/api/words/tts?text=hi");
    await win.fetch("/api/ok");
    await win.fetch("https://other.example/api/x-tts");
    await win.fetch("/api/down").catch(() => {});
    reportPageError({ kind: "socket", message: "local STT socket closed (1006)" });
    expect(sent.map((m) => [m.kind, m.message])).toEqual([
      ["console", "oops [Object]"],
      ["fetch", "GET /api/words/tts 503"],
      ["network", "GET /api/down failed: TypeError: Failed to fetch"],
      ["socket", "local STT socket closed (1006)"],
    ]);
    off();
    win.console.error("after");
    reportPageError({ kind: "socket", message: "after" });
    expect(sent).toHaveLength(4);
  });

  /** An event as the page would see it, with the given target and fields. */
  const event = (type: string, target: unknown, fields: Record<string, unknown> = {}) => {
    const ev = new Event(type);
    Object.defineProperty(ev, "target", { value: target });
    return Object.assign(ev, fields);
  };

  it("reports uncaught errors, rejections and media load failures; aborts are not errors", async () => {
    const sent: { kind: string; message: string; stack?: string }[] = [];
    const r = createPageErrorReporter({ now: () => 1, pagePath: () => "/words" });
    r.attach((m) => sent.push(m));
    const { win } = fakeWin((async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch);
    const off = installPageErrorHooks(win, r);
    const boom = new TypeError("x is undefined");
    win.dispatchEvent(
      event("error", win, {
        error: boom,
        filename: "https://lianki.com/_next/a.js?v=1",
        lineno: 3,
        colno: 7,
      }),
    );
    win.dispatchEvent(event("error", win, { message: "Script error." }));
    win.dispatchEvent(event("unhandledrejection", win, { reason: "nope" }));
    win.dispatchEvent(
      event(
        "error",
        { tagName: "AUDIO", currentSrc: "/api/words/tts?text=secret", error: { code: 4 } },
        {},
      ),
    );
    win.dispatchEvent(
      event("error", { tagName: "IMG", src: "", getAttribute: () => "blob:x" }, {}),
    );
    // A script tag failing to load is not ours to report.
    win.dispatchEvent(event("error", { tagName: "SCRIPT", src: "/x.js" }, {}));
    await win.fetch("/api/words").catch(() => {});
    expect(sent.map((m) => [m.kind, m.message])).toEqual([
      ["error", "TypeError: x is undefined (/_next/a.js:3:7)"],
      ["error", "Script error."],
      ["rejection", "Unhandled rejection: nope"],
      ["media", "audio failed to load (MediaError 4): /api/words/tts"],
      ["media", "img failed to load: blob:"],
    ]);
    expect(sent[0].stack).toContain("TypeError");
    off();
  });

  it("typedText reads inputs, textareas and editable text of 3+ characters", () => {
    const el = (v: { value?: string; textContent?: string }) => v;
    const doc = {
      querySelectorAll: (sel: string) =>
        sel.startsWith("input")
          ? [el({ value: "hello there" }), el({ value: "hi" })]
          : [el({ textContent: "my draft" })],
    } as unknown as Document;
    expect(typedText(doc)).toEqual(["hello there", "my draft"]);
    expect(typedText({} as Document)).toEqual([]);
  });

  it("a sink that throws keeps the error queued for the next attach", () => {
    const r = createPageErrorReporter({ now: () => 1, pagePath: () => "/" });
    r.attach(() => {
      throw new Error("socket closed");
    });
    r.report({ kind: "error", message: "kept" });
    const sent: unknown[] = [];
    r.attach((m) => sent.push(m));
    expect(sent).toHaveLength(1);
    expect(pathOf("x?y", "not a base")).toBe("x");
  });
});

describe("network failures that are not the network (aborts, the page going away)", () => {
  it("isReportableNetworkFailure: aborts, a page going away, or just gone, are not reported", () => {
    const base = {
      error: new TypeError("Load failed"),
      signalAborted: false,
      unloading: false,
      now: 10_000,
      hiddenAt: null,
    };
    expect(isReportableNetworkFailure(base)).toBe(true);
    expect(
      isReportableNetworkFailure({
        ...base,
        error: Object.assign(new Error("x"), { name: "AbortError" }),
      }),
    ).toBe(false);
    // WebKit: an aborted fetch is a plain TypeError "Load failed"; the signal tells.
    expect(isReportableNetworkFailure({ ...base, signalAborted: true })).toBe(false);
    expect(isReportableNetworkFailure({ ...base, unloading: true })).toBe(false);
    expect(
      isReportableNetworkFailure({ ...base, hiddenAt: 10_000 - NETWORK_AFTER_HIDE_MS + 1 }),
    ).toBe(false);
    expect(isReportableNetworkFailure({ ...base, hiddenAt: 10_000 - NETWORK_AFTER_HIDE_MS })).toBe(
      true,
    );
  });

  it("the hooks: an aborted TTS prefetch, a reload, a hidden page are quiet; a real failure is reported", async () => {
    const sent: { kind: string; message: string }[] = [];
    const r = createPageErrorReporter({ now: () => 1, pagePath: () => "/words" });
    r.attach((m) => sent.push(m));
    let t = 100_000;
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const target = new EventTarget();
    const win = Object.assign(target, {
      location: {
        origin: "https://lianki.com",
        href: "https://lianki.com/words",
        pathname: "/words",
      },
      console: { error: () => {} },
      document: doc,
      fetch: (async () => {
        throw new TypeError("Load failed");
      }) as unknown as typeof fetch,
    }) as unknown as Window & typeof globalThis;
    const off = installPageErrorHooks(win, r, () => t);
    // The audio prefetcher cancels: its signal is aborted (WebKit: TypeError, not AbortError).
    const ctrl = new AbortController();
    ctrl.abort();
    await win.fetch("/api/words/tts?text=a", { signal: ctrl.signal }).catch(() => {});
    // The page going away: pagehide, then a failure.
    win.dispatchEvent(new Event("pagehide"));
    await win.fetch("/api/words/tts?text=b").catch(() => {});
    // Back (bfcache), but within 1 s of the hide: still the page going away.
    win.dispatchEvent(new Event("pageshow"));
    t += 500;
    await win.fetch("/api/words/tts?text=c").catch(() => {});
    // Hidden by the tab switching away.
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    t += 5_000;
    await win.fetch("/api/words/tts?text=d").catch(() => {});
    expect(sent).toEqual([]);
    // Visible again, long after: a genuine failure is reported.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    t += 5_000;
    await win.fetch("/api/words/tts?text=e").catch(() => {});
    expect(sent.map((m) => [m.kind, m.message])).toEqual([
      ["network", "GET /api/words/tts failed: TypeError: Load failed"],
    ]);
    off();
  });
});
