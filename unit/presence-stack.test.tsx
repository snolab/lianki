/**
 * The who-is-here stack in a DOM (PresenceStack.tsx, docs/dev-debug-widget.md
 * "Who is here"): hover and one tap show the summary, a click, a double tap
 * or a key open the panel; the viewer's own tokens can be renamed, given a
 * picture and removed (one confirm step); Invite shows the prefilled link and
 * the connect snippet. And a custom avatar fetched, re-sanitized and drawn.
 */
import { expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import { PresenceStack, type ParticipantChange } from "../packages/debug-chat/src/PresenceStack";
import { CustomAvatar } from "../packages/debug-chat/src/LaneMark";
import { Avatar } from "../packages/debug-chat/src/Avatar";
import { UI_EN } from "../packages/debug-chat/src/ui-strings";
import {
  INVITE_HREF,
  mcpSnippet,
  parsePresent,
  type Present,
} from "../packages/debug-chat/src/presence";

const T = Date.parse("2026-11-14T00:00:00Z");
const LIST: Present[] = [
  {
    key: "tok:aaaaaaaaaaaaaaaa",
    name: "mcp-bot",
    tok: "aaaaaaaaaaaaaaaa",
    id: "a".repeat(64),
    mcp: true,
    live: true,
    since: T - 60_000,
    active: T,
  },
  { key: "lane:codex", name: "codex", lane: "codex", postAt: T - 1, active: T - 1 },
  {
    key: "tok:bbbbbbbbbbbbbbbb",
    name: "Helper",
    nameBy: "owner",
    selfName: "bot",
    tok: "bbbbbbbbbbbbbbbb",
    id: "b".repeat(64),
    avatar: "1".repeat(64),
    avatarBy: "agent",
    active: T - 2,
  },
  { key: "lane:main", name: "", lane: "main", active: T - 3 },
];

it("parses the hub's list and builds the invite", () => {
  expect(parsePresent("x")).toBeNull();
  expect(parsePresent([{ key: "k", name: "n", active: 1 }, { key: 1 }, null])).toEqual([
    { key: "k", name: "n", active: 1 },
  ]);
  expect(mcpSnippet("https://lianki.com")).toContain("https://lianki.com/mcp");
  expect(mcpSnippet()).toContain("Authorization: Bearer <token>");
  expect(INVITE_HREF).toContain("new-token=chat-agent");
});

it("summary, panel, rename, picture, remove and invite", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  // Put back exactly as they were (absent stays absent): unit/support/globals.ts.
  const restoreGlobals = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: g.fetch,
  });
  const clip: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (s: string) => void clip.push(s) },
    configurable: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  const $ = (s: string) => host.querySelector(s) as unknown as HTMLElement | null;
  const $$ = (s: string) => [...host.querySelectorAll(s)] as unknown as HTMLElement[];
  const fire = (el: unknown, ev: unknown) =>
    act(() => void (el as EventTarget).dispatchEvent(ev as Event));
  const click = (el: unknown, detail = 1) =>
    fire(el, new win.MouseEvent("click", { bubbles: true, detail }));
  const press = (el: unknown, pointerType: string) =>
    fire(el, new win.PointerEvent("pointerdown", { bubbles: true, pointerType }));
  const type = async (el: unknown, v: string) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    await fire(el, new win.Event("input", { bubbles: true }));
  };
  const submit = (el: unknown) =>
    fire(el, new win.Event("submit", { bubbles: true, cancelable: true }));
  try {
    const changes: [string, ParticipantChange][] = [];
    let removeOk = false;
    const removed: string[] = [];
    const render = (list = LIST) =>
      act(() =>
        root.render(
          <PresenceStack
            list={list}
            shown={3}
            t={UI_EN}
            mainName="Li"
            onChange={(tok, c) => void changes.push([tok, c])}
            onRemove={async (id) => {
              removed.push(id);
              return removeOk;
            }}
          />,
        ),
      );
    await render();
    const stack = $('[data-testid="debug-chat-presence"]')!;
    expect($$('[data-testid="debug-chat-presence-avatar"]')).toHaveLength(3);
    expect($('[data-testid="debug-chat-presence-more"]')!.textContent).toBe("+1");
    expect(stack.getAttribute("aria-label")).toBe("Who is here: mcp-bot, codex, Helper +1");

    // Hover: the summary; out: gone.
    await fire(stack, new win.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    expect($('[data-testid="debug-chat-presence-tip"]')?.textContent).toBe(
      "mcp-bot, codex, Helper +1",
    );
    await fire(stack, new win.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    expect($('[data-testid="debug-chat-presence-tip"]')).toBeNull();

    // Touch: one tap the summary, a second tap soon after the panel.
    await press(stack, "touch");
    await click(stack);
    expect($('[data-testid="debug-chat-presence-tip"]')).not.toBeNull();
    expect($('[data-testid="debug-chat-presence-panel"]')).toBeNull();
    await press(stack, "touch");
    await click(stack);
    expect($('[data-testid="debug-chat-presence-panel"]')).not.toBeNull();
    // Escape closes it.
    await fire(win.document, new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($('[data-testid="debug-chat-presence-panel"]')).toBeNull();

    // A mouse click opens the panel; a key (detail 0) too.
    await press(stack, "mouse");
    await click(stack);
    expect($$('[data-testid="debug-chat-presence-row"]')).toHaveLength(4);
    await click(stack, 0);
    expect($('[data-testid="debug-chat-presence-panel"]')).toBeNull();
    await click(stack, 0);
    const rows = $$('[data-testid="debug-chat-presence-row"]');
    expect(rows[0]!.textContent).toContain("reading now");
    expect(rows[0]!.textContent).toContain("MCP");
    expect(rows[2]!.textContent).toContain("set by you");
    expect(rows[3]!.textContent).toContain("Li");
    // Only the viewer's own tokens can be managed.
    expect($$('[data-testid="debug-chat-presence-remove"]')).toHaveLength(2);

    // Rename.
    const rename = [...rows[0]!.querySelectorAll("button")].find(
      (b) => b.textContent === "Rename",
    )!;
    await click(rename);
    const name = $('[data-testid="debug-chat-presence-name"]')!;
    await type(name, "  Scout ");
    await submit(name.closest("form"));
    expect(changes.pop()).toEqual(["aaaaaaaaaaaaaaaa", { name: "Scout" }]);
    // Back to its own name: the agent's name again (null).
    const rename2 = [
      ...$$('[data-testid="debug-chat-presence-row"]')[2]!.querySelectorAll("button"),
    ].find((b) => b.textContent === "Rename")!;
    await click(rename2);
    const name2 = $('[data-testid="debug-chat-presence-name"]')!;
    await type(name2, "bot");
    await submit(name2.closest("form"));
    expect(changes.pop()).toEqual(["bbbbbbbbbbbbbbbb", { name: null }]);

    // Picture: generated, its own, pasted (bad, then good).
    const row0 = () => $$('[data-testid="debug-chat-presence-row"]')[0]!;
    const btn = (r: HTMLElement, label: string) =>
      [...r.querySelectorAll("button")].find((b) => b.textContent === label)!;
    expect(btn(row0(), "Generated picture").getAttribute("aria-pressed")).toBe("true");
    await click(btn(row0(), "Generated picture"));
    expect(changes.pop()).toEqual(["aaaaaaaaaaaaaaaa", { avatar: "auto" }]);
    await click(btn(row0(), "Its own picture"));
    expect(changes.pop()).toEqual(["aaaaaaaaaaaaaaaa", { avatar: null }]);
    await click(btn(row0(), "Paste an SVG"));
    const box = $('[data-testid="debug-chat-presence-svg"]')!;
    await type(box, "<html/>");
    await submit(box.closest("form"));
    expect(row0().textContent).toContain(UI_EN.peopleFailed);
    await type(box, '<svg viewBox="0 0 2 2"><script>x</script><rect width="2" height="2"/></svg>');
    await submit(box.closest("form"));
    const [, pasted] = changes.pop()!;
    expect(pasted.avatar).toContain("<rect");
    expect(pasted.avatar).not.toContain("script");

    // Remove: asks once; a failure says so; cancel; then it goes.
    await click($('[data-testid="debug-chat-presence-remove"]'));
    expect($('[data-testid="debug-chat-presence-confirm"]')!.textContent).toContain(
      "Remove mcp-bot?",
    );
    await click($('[data-testid="debug-chat-presence-remove-yes"]'));
    expect(removed).toEqual(["a".repeat(64)]);
    expect(row0().textContent).toContain(UI_EN.peopleFailed);
    await click(btn(row0(), "Cancel"));
    expect($('[data-testid="debug-chat-presence-confirm"]')).toBeNull();
    removeOk = true;
    await click($('[data-testid="debug-chat-presence-remove"]'));
    await click($('[data-testid="debug-chat-presence-remove-yes"]'));
    expect(removed).toHaveLength(2);
    expect($('[data-testid="debug-chat-presence-confirm"]')).toBeNull();

    // Invite: the prefilled link and the snippet to copy.
    await click($('[data-testid="debug-chat-presence-invite"]'));
    expect($('[data-testid="debug-chat-presence-invite-link"]')!.getAttribute("href")).toBe(
      INVITE_HREF,
    );
    await click(btn($('[data-testid="debug-chat-presence-invite-box"]')!, "Copy"));
    expect(clip[0]).toContain("/mcp");

    // A tap outside closes it; Close too.
    await fire(win.document.body, new win.PointerEvent("pointerdown", { bubbles: true }));
    expect($('[data-testid="debug-chat-presence-panel"]')).toBeNull();
    await click(stack, 0);
    await click(btn($('[data-testid="debug-chat-presence-panel"]')!, "Close"));
    expect($('[data-testid="debug-chat-presence-panel"]')).toBeNull();

    // No one here: on the owner's page a "+" still opens Invite.
    await render([]);
    expect($('[data-testid="debug-chat-presence"]')!.textContent).toBe("+");
    await act(() => root.render(<PresenceStack list={[]} shown={3} t={UI_EN} mainName="Li" />));
    expect($('[data-testid="debug-chat-presence"]')).toBeNull();

    // The avatar box itself: a picture, then (it fails) the initial.
    await act(() => root.render(<Avatar src={["a.png"]} name="Ann" seed="s" />));
    // (happy-dom may fail the load itself at once.)
    const pic = $('[data-avatar="img"]');
    if (pic) await fire(pic, new win.Event("error"));
    expect($('[data-avatar="initial"]')!.textContent).toBe("A");

    // A custom avatar: fetched by reference, sanitized again, drawn as an image.
    const svg = '<svg viewBox="0 0 2 2"><rect width="2" height="2" fill="#0a0"/></svg>';
    g.fetch = async (u: string) => {
      expect(u).toBe(`/api/version/chat-avatar/${"2".repeat(64)}`);
      return new Response(svg);
    };
    await act(() => root.render(<CustomAvatar avatar={"2".repeat(64)} name="x" />));
    await act(() => new Promise((r) => setTimeout(r, 5)));
    const img = $('[data-testid="debug-chat-custom-avatar"]')!;
    expect(img.getAttribute("src")).toStartWith("data:image/svg+xml");
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain("<rect");
    // A refused one stays the generated mark.
    g.fetch = async () => new Response("<html/>");
    await act(() => root.render(<CustomAvatar avatar={"3".repeat(64)} name="y" />));
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect($('[data-testid="debug-chat-auto-mark"]')).not.toBeNull();
    g.fetch = async () => new Response("no", { status: 404 });
    await act(() => root.render(<CustomAvatar avatar={"4".repeat(64)} name="z" />));
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect($('[data-testid="debug-chat-auto-mark"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    restoreGlobals();
    await win.happyDOM.close();
  }
});
