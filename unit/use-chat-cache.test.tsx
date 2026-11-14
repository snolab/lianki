/**
 * useChatCache (lib/use-chat-cache.ts), the chat's device copy as DebugEval
 * holds it, rendered for real: the write timer, the account changing under
 * one mounted instance, and sign-out racing a pending write or a hub line.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { CHAT_CACHE_KEY, freezeChatCache, thawChatCache } from "@/lib/chat-cache";
import { CACHE_WRITE_MS, useChatCache } from "@/lib/use-chat-cache";
import { signOut } from "@/lib/sign-out";
import { stubGlobals } from "./support/globals";

const win = new Window();
const store = new Map<string, string>();
const restoreGlobals = stubGlobals({
  window: win,
  document: win.document,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
const { createRoot } = await import("react-dom/client");
afterAll(() => restoreGlobals());

const line = (id: string): ChatMessage => ({
  id,
  from: "agent",
  label: "",
  text: `t-${id}`,
  at: 1,
});
const stored = () => {
  const raw = store.get(CHAT_CACHE_KEY);
  return raw ? (JSON.parse(raw) as { account: string; lines: ChatMessage[] }) : null;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WRITE = CACHE_WRITE_MS + 60;

type Api = ReturnType<typeof useChatCache>;
let api: Api | null = null;
function Probe({ account }: { account: string | null }) {
  const s = useChatCache({ account, box: false, cacheLines: 40, wanted: true });
  const r = useRef(s);
  r.current = s;
  api = s;
  return (
    <div data-n={s.messages.length} data-hub={String(s.fromHub)} data-c={s.cachedLines.length} />
  );
}

function mount(account: string | null) {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const render = (a: string | null) => act(() => root.render(<Probe account={a} />));
  render(account);
  return {
    render,
    probe: () => host.firstElementChild as unknown as { dataset: Record<string, string> },
    unmount: () => act(() => root.unmount()),
  };
}

/** The hub's history, then one live line (the setters DebugEval calls). */
function hubHistory(lines: ChatMessage[]) {
  act(() => {
    api!.setMessages(lines);
    api!.setFromHub(true);
  });
}

beforeEach(() => {
  store.clear();
  thawChatCache();
});
afterEach(() => thawChatCache());

describe("useChatCache: the device copy", () => {
  it("shows the cached lines first, writes the hub's back after the debounce", async () => {
    store.set(
      CHAT_CACHE_KEY,
      JSON.stringify({ v: 1, account: "acct-a", at: 1, lines: [line("old")] }),
    );
    const m = mount("acct-a");
    expect(m.probe().dataset.c).toBe("1");
    expect(m.probe().dataset.n).toBe("1");
    expect(m.probe().dataset.hub).toBe("false");
    hubHistory([line("1"), line("2")]);
    expect(m.probe().dataset.hub).toBe("true");
    await wait(WRITE);
    expect(stored()?.lines.map((l) => l.id)).toEqual(["1", "2"]);
    m.unmount();
  });

  it("writes nothing before the hub's history is in", async () => {
    const m = mount("acct-a");
    act(() => api!.setMessages([line("1")]));
    await wait(WRITE);
    expect(stored()).toBeNull();
    m.unmount();
  });
});

describe("useChatCache: the account changes under one instance", () => {
  it("A → B: A's lines leave the page and are never written under B's key", async () => {
    const m = mount("acct-a");
    hubHistory([line("a1"), line("a2")]);
    await wait(WRITE);
    expect(stored()?.account).toBe("acct-a");
    // The root layout's session refresh renders this instance for B: the
    // pending timer (a new one per change) would have written A's lines as B's.
    act(() => api!.setMessages([line("a1"), line("a2"), line("a3")]));
    m.render("acct-b");
    expect(m.probe().dataset.n).toBe("0");
    expect(m.probe().dataset.c).toBe("0");
    expect(m.probe().dataset.hub).toBe("false");
    // A's entry went with the read for B; nothing of A's is written for B.
    expect(stored()).toBeNull();
    await wait(WRITE);
    expect(stored()).toBeNull();
    // B's own hub history is kept as B's.
    hubHistory([line("b1")]);
    await wait(WRITE);
    expect(stored()).toEqual(expect.objectContaining({ account: "acct-b" }));
    expect(stored()?.lines.map((l) => l.id)).toEqual(["b1"]);
    m.unmount();
  });

  it("A → null: the lines leave the page, the device copy goes, nothing is written", async () => {
    const m = mount("acct-a");
    hubHistory([line("a1")]);
    await wait(WRITE);
    expect(stored()?.account).toBe("acct-a");
    act(() => api!.setMessages([line("a1"), line("a2")]));
    m.render(null);
    expect(m.probe().dataset.n).toBe("0");
    expect(stored()).toBeNull();
    await wait(WRITE);
    expect(stored()).toBeNull();
    // A line from the still-open socket on a page with no session: not kept either.
    act(() => api!.setMessages([line("a3")]));
    await wait(WRITE);
    expect(stored()).toBeNull();
    m.unmount();
  });
});

describe("useChatCache: sign-out while mounted", () => {
  const signingOut = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const replaced: string[] = [];
    const done = signOut("/", {
      fetch: async () => {
        await gate;
        return new Response("{}", { status: 200 });
      },
      replace: (u) => void replaced.push(u),
      forgetChat: () => freezeChatCache(),
    });
    return { release, replaced, done };
  };

  it("(a) a write timer pending when sign-out starts writes nothing", async () => {
    const m = mount("acct-a");
    hubHistory([line("a1")]);
    await wait(WRITE);
    expect(stored()?.account).toBe("acct-a");
    // A new line: its 300 ms write is pending when the user taps Sign out.
    act(() => api!.setMessages([line("a1"), line("a2")]));
    const s = signingOut();
    expect(stored()).toBeNull();
    await wait(WRITE);
    expect(stored()).toBeNull();
    s.release();
    expect(await s.done).toBe(true);
    expect(s.replaced).toEqual(["/"]);
    expect(stored()).toBeNull();
    m.unmount();
  });

  it("(b) a hub line arriving while the sign-out request runs writes nothing", async () => {
    const m = mount("acct-a");
    hubHistory([line("a1")]);
    await wait(WRITE);
    const s = signingOut();
    expect(stored()).toBeNull();
    // {type:"chat"} from the hub mid-sign-out: DebugEval appends it as before.
    act(() => api!.setMessages((l) => [...l, line("a2")]));
    await wait(WRITE);
    expect(stored()).toBeNull();
    // And the hub's history on a reconnect, replacing the lines.
    hubHistory([line("a1"), line("a2"), line("a3")]);
    await wait(WRITE);
    expect(stored()).toBeNull();
    s.release();
    await s.done;
    expect(stored()).toBeNull();
    expect(s.replaced).toEqual(["/"]);
    m.unmount();
  });
});
