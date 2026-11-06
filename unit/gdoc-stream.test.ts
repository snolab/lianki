// The Docs page's side of the live stream (docs/connections.md, "Live stream").
import { afterEach, describe, expect, it } from "bun:test";
import { docIdOfPath, looksTruncated, startGdocStream, stripImages } from "../src/gdoc-stream";

const ID = "fake_doc_id_for_tests_0123456789abcdefABCD";

describe("docIdOfPath", () => {
  it("finds the doc on an editor path, with or without an account", () => {
    expect(docIdOfPath(`/document/d/${ID}/edit`)).toBe(ID);
    expect(docIdOfPath(`/document/u/1/d/${ID}/edit`)).toBe(ID);
  });
  it("refuses anything that is not a document", () => {
    expect(docIdOfPath(`/spreadsheets/d/${ID}/edit`)).toBeNull();
    expect(docIdOfPath("/document/d/short/edit")).toBeNull();
    expect(docIdOfPath("/")).toBeNull();
  });
});

describe("stripImages", () => {
  it("drops images and keeps the text", () => {
    expect(stripImages('<p>a<img src="data:x" alt="y">b</p><IMG src=z>')).toBe("<p>ab</p>");
  });
});

describe("looksTruncated", () => {
  it("doubts only an answer under half the last one", () => {
    expect(looksTruncated("x".repeat(40), "x".repeat(100))).toBe(true);
    expect(looksTruncated("x".repeat(60), "x".repeat(100))).toBe(false);
    expect(looksTruncated("x", null)).toBe(false);
  });
});

describe("startGdocStream", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const timing = { quietMs: 5, maxWaitMs: 20, hiddenCheckMs: 10, retryShortMs: 5 };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const stub = (name: string, value: unknown) => {
    if (!saved.has(name)) saved.set(name, g[name]);
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  };
  afterEach(() => {
    for (const [name, value] of saved)
      Object.defineProperty(g, name, { value, configurable: true, writable: true });
    saved.clear();
  });

  /** A Docs page, its export and Lianki's answers, all in memory. */
  function page(opts: { enabled?: boolean; streamed?: boolean; path?: string } = {}) {
    const state = {
      html: "<p>one</p>",
      exportOk: true,
      posted: [] as { docId: string; html: string; title: string }[],
      postStatus: 200,
      retryAfter: null as string | null,
      opened: [] as { location: { href: string } }[],
      values: new Map<string, unknown>(opts.streamed ? [[`lk:gdoc-stream:${ID}`, true]] : []),
      listeners: new Map<string, () => void>(),
      button: null as null | { textContent: string; click: () => void },
      link: null as null | { href: string; style: { display: string } },
      hidden: false,
      reads: 0,
    };
    const el = (tag: string) => {
      const e: Record<string, unknown> = {
        tag,
        style: {},
        textContent: "",
        attachShadow: () => ({
          append: (...kids: Record<string, unknown>[]) => {
            for (const k of kids) {
              if (k.tag === "button") state.button = k as never;
              else state.link = k as never;
            }
          },
        }),
        addEventListener: (_: string, f: () => void) => {
          e.click = f;
        },
      };
      return e;
    };
    class Canvas {
      fillText(..._: unknown[]) {
        return "drawn";
      }
    }
    stub("location", { pathname: opts.path ?? `/document/d/${ID}/edit` });
    stub("navigator", { language: "en-US" });
    stub("document", {
      title: "Notes - Google Docs",
      get hidden() {
        return state.hidden;
      },
      addEventListener: (n: string, f: () => void) => state.listeners.set(n, f),
      createElement: el,
      documentElement: { append() {} },
    });
    stub("CanvasRenderingContext2D", Canvas);
    stub("window", {
      CanvasRenderingContext2D: Canvas,
      open: () => {
        const w = { location: { href: "" } };
        state.opened.push(w);
        return w;
      },
    });
    stub(
      "fetch",
      async () => (
        state.reads++,
        new Response(state.html, {
          status: state.exportOk ? 200 : 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      ),
    );
    const gmFetch = async (_url: string, o: { method?: string; body?: string } = {}) => {
      if (o.method !== "POST") return { ok: opts.enabled !== false };
      state.posted.push(JSON.parse(o.body as string));
      return {
        ok: state.postStatus < 300,
        status: state.postStatus,
        headers: { get: () => state.retryAfter },
        json: async () => ({ id: "book1" }),
      };
    };
    startGdocStream({
      origin: "https://lianki.test",
      gmFetch,
      getValue: (k, d) => (state.values.has(k) ? state.values.get(k) : d),
      setValue: (k, v) => state.values.set(k, v),
      timing,
    });
    return { state, draw: () => new Canvas().fillText("x") };
  }

  it("does nothing off a document, and shows no switch to someone not allowed", async () => {
    const off = page({ path: "/spreadsheets/d/x/edit" });
    await wait(5);
    expect(off.state.button).toBeNull();
    const refused = page({ enabled: false });
    await wait(5);
    expect(refused.state.button).toBeNull();
    expect(refused.state.posted).toEqual([]);
  });

  it("sends nothing until the switch is on, however much the page draws", async () => {
    const { state } = page();
    await wait(5);
    expect(state.button?.textContent).toBe("Stream to Lianki");
    await wait(30);
    expect(state.reads).toBe(0);
    expect(state.posted).toEqual([]);
  });

  it("on the switch: sends, opens the reader in the tab the click made, follows edits", async () => {
    const { state } = page();
    await wait(5);
    state.button!.click();
    await wait(15);
    expect(state.values.get(`lk:gdoc-stream:${ID}`)).toBe(true);
    expect(state.posted).toEqual([{ docId: ID, html: "<p>one</p>", title: "Notes" }]);
    const reader = `https://lianki.test/read/book1?streamingFrom=google-docs`;
    expect(state.opened[0].location.href).toBe(reader);
    expect(state.link?.href).toBe(reader);

    const Canvas = g.CanvasRenderingContext2D as new () => { fillText(s: string): string };
    state.html = "<p>one two</p>";
    expect(new Canvas().fillText("x")).toBe("drawn");
    await wait(30);
    expect(state.posted.at(-1)?.html).toBe("<p>one two</p>");

    // A draw with no change in the text sends nothing.
    const sent = state.posted.length;
    new Canvas().fillText("x");
    await wait(30);
    expect(state.posted.length).toBe(sent);
  });

  it("resumes a doc already on, without opening another tab", async () => {
    const { state } = page({ streamed: true });
    await wait(15);
    expect(state.posted.length).toBe(1);
    expect(state.opened).toEqual([]);
  });

  it("stops: the switch off sends no more, and forgets the doc", async () => {
    const { state } = page({ streamed: true });
    await wait(15);
    state.button!.click();
    expect(state.values.get(`lk:gdoc-stream:${ID}`)).toBe(false);
    expect(state.button!.textContent).toBe("Stream to Lianki");
    const Canvas = g.CanvasRenderingContext2D as new () => { fillText(s: string): string };
    state.html = "<p>later</p>";
    new Canvas().fillText("x");
    await wait(30);
    expect(state.posted.length).toBe(1);
  });

  it("believes a much shorter answer only when it repeats", async () => {
    const { state } = page({ streamed: true });
    state.html = `<p>${"long text ".repeat(50)}</p>`;
    await wait(15);
    const sent = state.posted.length;
    const Canvas = g.CanvasRenderingContext2D as new () => { fillText(s: string): string };
    state.html = "<p>error</p>";
    new Canvas().fillText("x");
    await wait(8);
    state.html = `<p>${"long text ".repeat(50)}</p>`;
    await wait(30);
    expect(state.posted.length).toBe(sent);
    state.html = "<p>short now</p>";
    new Canvas().fillText("x");
    await wait(40);
    expect(state.posted.at(-1)?.html).toBe("<p>short now</p>");
  });

  it("skips a failed export, and waits out a rate limit", async () => {
    const { state } = page({ streamed: true });
    await wait(15);
    const Canvas = g.CanvasRenderingContext2D as new () => { fillText(s: string): string };
    state.exportOk = false;
    state.html = "<p>hidden by a failure</p>";
    new Canvas().fillText("x");
    await wait(30);
    expect(state.posted.length).toBe(1);

    state.exportOk = true;
    state.postStatus = 429;
    state.retryAfter = "60";
    new Canvas().fillText("x");
    await wait(30);
    const tried = state.posted.length;
    expect(state.button!.textContent).toBe("Sync failed, retrying");
    new Canvas().fillText("x");
    await wait(30);
    expect(state.posted.length).toBe(tried);
  });

  it("reports a refused send, and treats an empty doc as nothing to retry", async () => {
    const { state } = page({ streamed: true });
    state.postStatus = 500;
    await wait(15);
    expect(state.button!.textContent).toBe("Sync failed, retrying");
    state.postStatus = 422;
    const Canvas = g.CanvasRenderingContext2D as new () => { fillText(s: string): string };
    new Canvas().fillText("x");
    await wait(30);
    expect(state.button!.textContent).toBe("Stop streaming");
  });

  it("while hidden, a slow timer still finds changes; visible again, it stops", async () => {
    const { state } = page({ streamed: true });
    await wait(15);
    state.hidden = true;
    state.listeners.get("visibilitychange")!();
    state.html = "<p>edited elsewhere</p>";
    await wait(30);
    expect(state.posted.at(-1)?.html).toBe("<p>edited elsewhere</p>");
    state.hidden = false;
    state.listeners.get("visibilitychange")!();
    await wait(15);
    const reads = state.reads;
    await wait(30);
    expect(state.reads).toBe(reads);
  });
});
