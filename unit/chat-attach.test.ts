import { describe, expect, it } from "bun:test";
import {
  ATTACH_KINDS,
  SELECTION_TTL_MS,
  addItems,
  announceChatAttach,
  chatAttachShown,
  createSelectionMemory,
  isSensitive,
  oneLine,
  readSelection,
  setAddItems,
  type ElLike,
  type SelectionDoc,
} from "@lianki/debug-chat/attach";
import { MAX_SELECTION, cleanContext } from "@lianki/debug-chat/wire";
import { parsePageMessage } from "@/lib/dev-eval";
import { chatLine } from "@/scripts/dev/node-args";

/** A page with a selection, its focused element, and the chat's own elements. */
function page() {
  const chat: ElLike = { tagName: "TEXTAREA", nodeType: 1, value: "" };
  const text: ElLike = { nodeType: 3, parentElement: { tagName: "P", nodeType: 1 } };
  const state = {
    active: null as ElLike | null,
    sel: "" as string,
    anchor: text as ElLike | null,
  };
  const listeners: Record<string, ((e: { target: unknown }) => void)[]> = {};
  const doc: SelectionDoc = {
    get activeElement() {
      return state.active;
    },
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: !state.sel,
      anchorNode: state.anchor,
      focusNode: state.anchor,
      toString: () => state.sel,
    }),
    addEventListener: (t, f) => void (listeners[t] ??= []).push(f),
    removeEventListener: (t, f) => {
      listeners[t] = (listeners[t] ?? []).filter((g) => g !== f);
    },
  };
  let now = 1_000;
  const mem = createSelectionMemory({
    doc,
    inChat: (n) => n === chat,
    where: () => ({ path: "/words", title: "Words" }),
    now: () => now,
  });
  const stop = mem.start();
  const fire = (t: string, target: unknown = text) =>
    (listeners[t] ?? []).forEach((f) => f({ target }));
  return {
    chat,
    text,
    state,
    mem,
    stop,
    fire,
    listeners,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("selection memory", () => {
  it("keeps the selection made on the page when the chat input takes focus", () => {
    const p = page();
    p.state.sel = "  le chat noir  ";
    p.fire("selectionchange");
    expect(p.mem.get()).toMatchObject({
      selection: "le chat noir",
      path: "/words",
      title: "Words",
    });
    // A tap on the chat input: the phone clears the page selection.
    p.fire("pointerdown", p.chat);
    p.state.active = p.chat;
    p.state.sel = "";
    p.fire("selectionchange");
    expect(p.mem.get()?.selection).toBe("le chat noir");
  });

  it("lets it go on a tap elsewhere on the page", () => {
    const p = page();
    p.state.sel = "word";
    p.fire("selectionchange");
    p.fire("pointerdown", p.text);
    p.state.sel = "";
    p.fire("selectionchange");
    expect(p.mem.get()).toBeNull();
  });

  it("ignores selections inside the chat", () => {
    const p = page();
    p.state.sel = "outside";
    p.fire("selectionchange");
    p.state.anchor = p.chat;
    p.state.sel = "chat log text";
    p.fire("selectionchange");
    expect(p.mem.get()?.selection).toBe("outside");
  });

  it("never reads a password field or a sensitive part of the page", () => {
    const p = page();
    p.state.active = {
      tagName: "INPUT",
      type: "password",
      value: "hunter2",
      selectionStart: 0,
      selectionEnd: 7,
      nodeType: 1,
    };
    p.fire("selectionchange");
    expect(p.mem.get()).toBeNull();
    p.state.active = null;
    p.state.anchor = {
      nodeType: 3,
      parentElement: { nodeType: 1, closest: (s) => (s.includes("data-sensitive") ? {} : null) },
    };
    p.state.sel = "card number";
    p.fire("selectionchange");
    expect(p.mem.get()).toBeNull();
  });

  it("reads a selection inside a page's own text field", () => {
    const p = page();
    p.state.active = {
      tagName: "TEXTAREA",
      value: "hello world",
      selectionStart: 6,
      selectionEnd: 11,
      nodeType: 1,
    };
    p.fire("selectionchange");
    expect(p.mem.get()?.selection).toBe("world");
    // The chat's own input is never read as a page selection.
    expect(
      readSelection({
        doc: { ...docOf(p.chat), activeElement: p.chat },
        inChat: (n) => n === p.chat,
      }),
    ).toBe("");
  });

  it("is capped, expires, and clears", () => {
    const p = page();
    p.state.sel = "x".repeat(MAX_SELECTION + 500);
    p.fire("selectionchange");
    expect(p.mem.get()?.selection.length).toBe(MAX_SELECTION);
    p.tick(SELECTION_TTL_MS + 1);
    expect(p.mem.get()).toBeNull();
    p.tick(-SELECTION_TTL_MS);
    p.mem.clear();
    expect(p.mem.get()).toBeNull();
    p.stop();
    expect(p.listeners.selectionchange).toHaveLength(0);
  });
});

/** A document whose selection is empty, for readSelection alone. */
function docOf(active: ElLike): SelectionDoc {
  return {
    activeElement: active,
    getSelection: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe("a selection spanning a fenced part", () => {
  it("is never read", () => {
    const fence = {};
    const sel = (crosses: boolean) => ({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: { nodeType: 3, parentElement: { nodeType: 1 } },
      focusNode: { nodeType: 3, parentElement: { nodeType: 1 } },
      toString: () => "before SECRET after",
      getRangeAt: () => ({ intersectsNode: (n: unknown) => crosses && n === fence }),
    });
    const doc = (crosses: boolean): SelectionDoc => ({
      ...docOf(null as never),
      activeElement: null,
      getSelection: () => sel(crosses),
      querySelectorAll: () => [fence],
    });
    expect(readSelection({ doc: doc(true), inChat: () => false })).toBeNull();
    expect(readSelection({ doc: doc(false), inChat: () => false })).toBe("before SECRET after");
  });
});

describe("oneLine", () => {
  it("collapses a selection's whitespace for the chip", () => {
    expect(oneLine("  a\n\n b\tc ")).toBe("a b c");
  });
});

describe("subscribers", () => {
  it("hear a new selection and its clearing, once each", () => {
    const p = page();
    let n = 0;
    const off = p.mem.subscribe(() => n++);
    p.state.sel = "one";
    p.fire("selectionchange");
    p.fire("selectionchange");
    p.mem.clear();
    off();
    p.mem.clear();
    expect(n).toBe(2);
  });
});

describe("isSensitive", () => {
  it("flags passwords, one-time codes and card fields", () => {
    const input = (type: string, ac = ""): ElLike => ({
      tagName: "INPUT",
      type,
      getAttribute: (n) => (n === "autocomplete" ? ac : null),
    });
    expect(isSensitive(input("password"))).toBe(true);
    expect(isSensitive(input("text", "one-time-code"))).toBe(true);
    expect(isSensitive(input("text", "cc-number"))).toBe(true);
    expect(isSensitive(input("text", "name"))).toBe(false);
  });
});

describe("cleanContext", () => {
  it("bounds every field and drops what is not a context", () => {
    expect(cleanContext(null)).toBeUndefined();
    expect(cleanContext({ selection: "   " })).toBeUndefined();
    expect(
      cleanContext({
        selection: "a\u0000b\nc",
        path: "/words?token=1#x",
        title: " A   title ",
        host: "Example.com",
        extra: 1,
      }),
    ).toEqual({ selection: "ab\nc", path: "/words", title: "A title", host: "example.com" });
    expect(cleanContext({ selection: "s", path: "words", host: "a b" })).toEqual({
      selection: "s",
    });
  });
});

describe("the hub schema", () => {
  it("parses a chat line's context, bounded", () => {
    const m = parsePageMessage(
      JSON.stringify({
        type: "chat",
        id: "abc123",
        text: "what does this mean?",
        context: { selection: "y".repeat(3000), path: "/review", title: "Review" },
      }),
    );
    expect(m).toMatchObject({ type: "chat", context: { path: "/review", title: "Review" } });
    expect((m as { context: { selection: string } }).context.selection.length).toBe(MAX_SELECTION);
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "abc123", text: "hi", context: "x" })),
    ).not.toHaveProperty("context");
  });

  it("lanes see it in the chat JSON line", () => {
    const line = chatLine(
      {
        id: "m1",
        from: "friend",
        thread: "u1",
        text: "hi",
        at: 0,
        label: "/",
        context: { selection: "s", path: "/a" },
      },
      {},
      false,
    );
    expect(line).toMatchObject({ thread: "u1", context: { selection: "s", path: "/a" } });
  });
});

describe("the + menu registry", () => {
  it("lists selection first, then the kinds that need the host's upload", () => {
    expect(ATTACH_KINDS.map((k) => [k.id, !!k.upload])).toEqual([
      ["selection", false],
      ["file", true],
      ["media", true],
    ]);
    expect(ATTACH_KINDS.find((k) => k.id === "media")?.accept).toBe("image/*,video/*,audio/*");
  });

  it("counts the + buttons on the page, and holds the app's add items", () => {
    expect(chatAttachShown()).toBe(false);
    const a = announceChatAttach();
    const b = announceChatAttach();
    expect(chatAttachShown()).toBe(true);
    a();
    a();
    expect(chatAttachShown()).toBe(true);
    b();
    expect(chatAttachShown()).toBe(false);
    setAddItems([{ id: "create:link", title: "Add a link", onPick: () => {} }]);
    expect(addItems().map((i) => i.id)).toEqual(["create:link"]);
    setAddItems([]);
    expect(addItems()).toHaveLength(0);
  });
});
