/**
 * Chat links to this same site open in this tab (the host's router when it
 * has one, else a plain navigation); external links keep the new tab and the
 * host's ExternalLinkGuard; in an embed (随身Li on another site, the partner
 * frame) every link is a new tab, so the host page is never navigated away.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { importReactDomClient, stubGlobals } from "./support/globals";
import { linkOpen } from "@lianki/debug-chat/chat-links";
import { openChatLink } from "@lianki/debug-chat/ChatLinkMenu";
import { ChatLink } from "@lianki/debug-chat/RichText";

const { createRoot } = await importReactDomClient();

describe("linkOpen", () => {
  const page = "https://lianki.com/en/words";

  it("same origin: the router's path when there is one, else this tab", () => {
    expect(linkOpen("https://lianki.com/dev/flags?x=1#a", page, { hasRouter: true })).toEqual({
      to: "app",
      path: "/dev/flags?x=1#a",
    });
    expect(linkOpen("https://lianki.com/my", page)).toEqual({
      to: "here",
      href: "https://lianki.com/my",
    });
  });

  it("relative links resolve against the page and stay", () => {
    expect(linkOpen("/review", page, { hasRouter: true })).toEqual({ to: "app", path: "/review" });
    expect(linkOpen("../ja", page)).toEqual({ to: "here", href: "https://lianki.com/ja" });
    // A local dev origin or a box is its own site.
    expect(linkOpen("/words", "http://localhost:3000/en", { hasRouter: true })).toEqual({
      to: "app",
      path: "/words",
    });
  });

  it("lianki.com and www.lianki.com are one site, in this tab without the router", () => {
    expect(linkOpen("https://www.lianki.com/my", page, { hasRouter: true })).toEqual({
      to: "here",
      href: "https://www.lianki.com/my",
    });
    expect(linkOpen("https://lianki.com/my", "https://www.lianki.com/en")).toEqual({
      to: "here",
      href: "https://lianki.com/my",
    });
  });

  it("external links, other Lianki subdomains and other schemes get a new tab", () => {
    for (const href of [
      "https://en.wikipedia.org/wiki/Spaced_repetition",
      "https://lianki.com.evil.example/x",
      "https://preview.lianki.com/my",
      "http://lianki.com/my",
      "mailto:a@b.example",
    ])
      expect(linkOpen(href, page, { hasRouter: true }).to).toBe("tab");
    // lianki.com from a local dev origin leaves that origin: a new tab.
    expect(linkOpen("https://lianki.com/my", "http://localhost:3000/en").to).toBe("tab");
  });

  it("embedded (随身Li, the partner frame): every link is a new tab", () => {
    for (const [href, at] of [
      ["https://lianki.com/my", "https://en.wikipedia.org/wiki/X"],
      ["https://lianki.com/my", "https://lianki.com/embed/partner"],
      ["/words", "https://lianki.com/embed/partner"],
    ] as const)
      expect(linkOpen(href, at, { embedded: true, hasRouter: true })).toEqual({
        to: "tab",
        href: new URL(href, at).href,
      });
    // Not embedded, a lianki.com link on another site is still a new tab.
    expect(linkOpen("https://lianki.com/my", "https://en.wikipedia.org/wiki/X").to).toBe("tab");
  });
});

describe("openChatLink and ChatLink in a page", () => {
  let win: Window;
  let restore: () => void;
  let root: Root | null = null;
  let assigned: string[];
  let anchors: { href: string; target: string; rel: string }[];

  function setup(url: string, framed = false) {
    win = new Window({ url });
    assigned = [];
    anchors = [];
    const loc = {
      href: win.location.href,
      hostname: win.location.hostname,
      origin: win.location.origin,
      assign: (u: string) => assigned.push(u),
    };
    restore = stubGlobals({
      // Framed: window.top is another window than this one.
      window: framed ? { top: {}, self: {} } : win,
      document: win.document,
      location: loc,
      HTMLElement: win.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    win.addEventListener("click", (e) => {
      const a = e.target;
      if (
        a instanceof win.HTMLAnchorElement &&
        a.getAttribute("data-testid") !== "debug-chat-link"
      ) {
        anchors.push({ href: a.href, target: a.target, rel: a.rel });
        e.preventDefault();
      }
    });
  }

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    restore();
    await win.happyDOM.close();
  });

  it("same site: the router, or this tab; never a new-tab anchor", () => {
    setup("https://lianki.com/en");
    const routed: string[] = [];
    openChatLink("https://lianki.com/dev/flags#a", (p) => routed.push(p));
    openChatLink("/words", (p) => routed.push(p));
    openChatLink("https://www.lianki.com/my", (p) => routed.push(p));
    openChatLink("https://lianki.com/review");
    expect(routed).toEqual(["/dev/flags#a", "/words"]);
    expect(assigned).toEqual(["https://www.lianki.com/my", "https://lianki.com/review"]);
    expect(anchors).toEqual([]);
  });

  it("external: a new-tab anchor the host guard sees", () => {
    setup("https://lianki.com/en");
    const routed: string[] = [];
    openChatLink("https://example.test/x", (p) => routed.push(p));
    expect(routed).toEqual([]);
    expect(assigned).toEqual([]);
    expect(anchors).toEqual([
      { href: "https://example.test/x", target: "_blank", rel: "noopener noreferrer" },
    ]);
  });

  it("随身Li on another site: a lianki.com link opens a new tab, the host page stays", () => {
    setup("https://en.wikipedia.org/wiki/X");
    openChatLink("https://lianki.com/my", undefined, { embedded: true });
    openChatLink("https://lianki.com/words");
    expect(assigned).toEqual([]);
    expect(anchors.map((a) => [a.href, a.target])).toEqual([
      ["https://lianki.com/my", "_blank"],
      ["https://lianki.com/words", "_blank"],
    ]);
  });

  it("the partner frame (embedded on lianki.com): still a new tab", () => {
    setup("https://lianki.com/embed/partner");
    openChatLink("https://lianki.com/my", () => assigned.push("routed"), { embedded: true });
    expect(assigned).toEqual([]);
    expect(anchors).toEqual([
      { href: "https://lianki.com/my", target: "_blank", rel: "noopener noreferrer" },
    ]);
  });

  it("a framed page never navigates itself, even without the embedded flag", () => {
    setup("https://lianki.com/embed/partner", true);
    openChatLink("/words", () => assigned.push("routed"));
    expect(assigned).toEqual([]);
    expect(anchors).toEqual([
      { href: "https://lianki.com/words", target: "_blank", rel: "noopener noreferrer" },
    ]);
  });

  it("the anchor: same site has no target; external and embedded get a new tab", async () => {
    setup("https://lianki.com/en");
    const host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);
    root = createRoot(host);
    const target = async (href: string, embedded?: boolean) => {
      await act(async () =>
        root!.render(createElement(ChatLink, { href, embedded, children: "link" })),
      );
      const a = win.document.querySelector('[data-testid="debug-chat-link"]')!;
      return a.getAttribute("target");
    };
    expect(await target("https://lianki.com/words")).toBeNull();
    expect(await target("https://www.lianki.com/words")).toBeNull();
    expect(await target("https://example.test/")).toBe("_blank");
    expect(await target("https://lianki.com/words", true)).toBe("_blank");
  });
});
