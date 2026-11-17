/**
 * M3 of Li chat from the userscript pill (docs/userscript-li-chat.md): share
 * the page's selection, or its title and link, from the frame's composer.
 * Page-provided text is escaped (gate 6), the link is http(s) origin + path
 * only (gate 5), and nothing is ever sent by a share: it fills the draft or
 * the attachment chip, and the typing debounce stays off until he presses send.
 * The port side (shell, guest) is in unit/partner-frame.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import {
  MAX_SHARE_URL,
  cleanShare,
  escapeMarkdown,
  isShareWhat,
  readShare,
  shareToContext,
  shareToDraft,
  shareUrl,
} from "@lianki/debug-chat/embed/share";
import { MAX_SELECTION } from "@lianki/debug-chat/wire";
import { planPendingSend } from "../packages/debug-chat/src/pending-bubble";
import { richOf } from "@lianki/debug-chat/rich-text";
import { pillChat, type PillChatDeps } from "@/src/pill-chat";

describe("the shared link: http(s), origin + path only", () => {
  it("drops the query, the fragment and userinfo; keeps the port", () => {
    expect(shareUrl("https://news.example/story/1?token=abc#c2")).toBe(
      "https://news.example/story/1",
    );
    expect(shareUrl("http://u:p@a.example:8080/x")).toBe("http://a.example:8080/x");
  });
  it("refuses any other scheme, junk and the absurdly long", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<b>",
      "file:///etc/passwd",
      "chrome://settings",
      "not a url",
      42,
      null,
    ])
      expect(shareUrl(bad)).toBeNull();
    expect(shareUrl(`https://a.example/${"x".repeat(9000)}`)).toBeNull();
    expect(shareUrl(`https://a.example/${"x".repeat(MAX_SHARE_URL)}`)).toBeNull();
  });
  it("percent-encodes what could close a markdown link", () => {
    expect(shareUrl("https://a.example/wiki/Foo_(bar)")).toBe(
      "https://a.example/wiki/Foo_%28bar%29",
    );
    expect(shareUrl("https://a.example/a'b\"c`d")).toBe("https://a.example/a%27b%22c%60d");
  });
});

describe("reading the page for a share", () => {
  const page = {
    href: "https://news.example/s?x=1",
    title: "  A \n title\u0000  ",
    selection: "  picked\ttext\nline 2\u0007  ",
  };
  it("page: title (one line, cleaned) and link; no selection", () => {
    expect(readShare("page", page)).toEqual({
      what: "page",
      title: "A title",
      url: "https://news.example/s",
    });
  });
  it("selection: the text (tabs and newlines kept, control characters out), bounded", () => {
    expect(readShare("selection", page)).toEqual({
      what: "selection",
      title: "A title",
      url: "https://news.example/s",
      selection: "picked\ttext\nline 2",
    });
    expect(
      readShare("selection", { ...page, selection: "x".repeat(5000) })?.selection?.length,
    ).toBe(MAX_SELECTION);
    expect(readShare("selection", { ...page, selection: "abcdef" }, 3)?.selection).toBe("abc");
  });
  it("nothing to share: no selection, a non-web page, junk", () => {
    expect(readShare("selection", { ...page, selection: "   " })).toBeNull();
    expect(readShare("selection", { ...page, selection: undefined })).toBeNull();
    expect(readShare("page", { ...page, href: "file:///x" })).toBeNull();
    expect(readShare("page", { href: "https://a.example/", title: 5 })?.title).toBe("");
  });
  it("the frame checks the shell's answer again", () => {
    const ok = { what: "page", title: "T", url: "https://a.example/p?q#h" };
    expect(cleanShare(ok, "page")).toEqual({
      what: "page",
      title: "T",
      url: "https://a.example/p",
    });
    expect(cleanShare(ok, "selection")).toBeNull();
    expect(cleanShare(null, "page")).toBeNull();
    expect(cleanShare([ok], "page")).toBeNull();
    expect(cleanShare("x", "page")).toBeNull();
    expect(isShareWhat("page") && isShareWhat("selection") && !isShareWhat("all")).toBe(true);
  });
});

describe("escaped: page text renders as text (gate 6)", () => {
  it("links, images, HTML, emphasis and block markers are escaped", () => {
    expect(escapeMarkdown("[x](javascript:alert(1))")).toBe("\\[x\\](javascript:alert(1))");
    expect(escapeMarkdown("![i](https://e/x.png) <img src=x onerror=alert(1)>")).toBe(
      "\\!\\[i\\](https://e/x.png) \\<img src=x onerror=alert(1)\\>",
    );
    expect(escapeMarkdown("*a* _b_ `c` ~d~ |e|")).toBe("\\*a\\* \\_b\\_ \\`c\\` \\~d\\~ \\|e\\|");
    expect(escapeMarkdown("# Heading")).toBe("\\# Heading");
    expect(escapeMarkdown("- item")).toBe("\\- item");
    expect(escapeMarkdown("12. item")).toBe("12\\. item");
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
    expect(escapeMarkdown("Plain - title, 2026")).toBe("Plain - title, 2026");
  });

  it("a hostile title in the draft renders with no link, image or HTML", () => {
    const title =
      "[click me](javascript:alert(1)) <script>alert(1)</script> ![x](https://evil.example/t.png)";
    const draft = shareToDraft("", { what: "page", title, url: "https://news.example/a" });
    const rich = richOf(draft, "markdown");
    const html = JSON.stringify(rich.nodes);
    // The hostile markup is text: no script, no image, no link to javascript:.
    expect(html).not.toContain('"tag":"script"');
    expect(html).not.toContain('"tag":"img"');
    const hrefs = [...html.matchAll(/"href":"([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    // Links that remain are bare http(s) URLs (autolinked text), never a markdown link's target.
    expect(hrefs.every((h) => h.startsWith("https://"))).toBe(true);
    expect(rich.shown).toContain(
      "[click me](javascript:alert(1))".replace(/[[\]]/g, (c) => `\\${c}`),
    );
  });
});

describe("a share fills the composer, never sends", () => {
  const p = { what: "page" as const, title: "Story", url: "https://news.example/a" };
  it("the draft: what he typed, then the title and the link", () => {
    expect(shareToDraft("", p)).toBe("Story\nhttps://news.example/a");
    expect(shareToDraft("look at this  \n", p)).toBe("look at this\nStory\nhttps://news.example/a");
    expect(shareToDraft("", { ...p, title: "" })).toBe("https://news.example/a");
    expect(shareToDraft("abc", p, 5)).toBe("abc\nS");
  });
  it("the attachment: text, title, path and host; cut to the configured length", () => {
    const sel = {
      ...p,
      what: "selection" as const,
      url: "https://news.example/a%20b",
      selection: "abcdef",
    };
    expect(shareToContext(sel)).toEqual({
      selection: "abcdef",
      title: "Story",
      path: "/a b",
      host: "news.example",
    });
    expect(shareToContext(sel, 3)?.selection).toBe("abc");
    expect(shareToContext(sel, 0)?.selection).toBe("a");
    expect(shareToContext(p)).toBeUndefined();
    // A path that cannot be decoded stays encoded.
    expect(shareToContext({ ...sel, url: "https://news.example/%E0%A4%A" })?.path).toBe(
      "/%E0%A4%A",
    );
  });
  it("the attachment rides with the line only when he sends one (the plan needs his text)", () => {
    const ctx = shareToContext({ ...p, what: "selection", selection: "quote" });
    // No text and no tap on the chip: nothing to send.
    expect(planPendingSend({ text: "", files: [], attached: ctx })).toBeNull();
    expect(planPendingSend({ text: "what is this?", files: [], attached: ctx })?.context).toEqual(
      ctx,
    );
  });

  it("DebugChat: a share never calls send, and holds the typing debounce until he sends", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    const on = src.slice(
      src.indexOf("const onShare = async"),
      src.indexOf("};", src.indexOf("const onShare = async")),
    );
    expect(on).toContain("shareHeld.current = true");
    expect(on).not.toMatch(/submit\(|sendRef|onSend|arm\(/);
    const arm = src.slice(
      src.indexOf("const arm = () => {"),
      src.indexOf("const armRef = useRef(arm)"),
    );
    // Held: arm returns before the burst send and before the debounce timer.
    const held = arm.indexOf("if (shareHeld.current) return setArmed(0);");
    expect(held).toBeGreaterThan(-1);
    expect(held).toBeLessThan(arm.indexOf("return submit()"));
    expect(held).toBeLessThan(arm.indexOf("setTimeout(submit"));
    // Released only after a line actually went out.
    const submit = src.slice(
      src.indexOf("const submit = (candidateTapped"),
      src.indexOf("pttSendRef.current = (line)"),
    );
    expect(submit.indexOf("shareHeld.current = false")).toBeGreaterThan(
      submit.indexOf("setOffline(true);"),
    );
    // The share items in the + menu act only on his own (trusted) press.
    const menu = readFileSync("packages/debug-chat/src/AttachMenu.tsx", "utf8");
    const items = menu.slice(menu.indexOf("debug-chat-share-"));
    expect(items.slice(0, 400)).toContain("if (!e.isTrusted) return;");
  });

  it("the frame passes the attachment through on his send, and no share without a press", () => {
    const src = readFileSync("app/embed/partner/PartnerFrame.tsx", "utf8");
    expect(src).toContain("client.send(text, to, opts?.context)");
    // guest.share is only inside the DebugChat share callback (called from the menu press).
    expect(src.match(/guest\.share\(/g)?.length).toBe(1);
  });
});

describe("the userscript reads the page only for a share he asked for", () => {
  it("the frame's share reader: the selection and title at that moment, the link without query", async () => {
    const win = new Window({ url: "https://news.example/story/1?token=s#c" });
    const doc = win.document as unknown as Document;
    doc.title = "Story [x](javascript:1)";
    doc.body.innerHTML = "<p id=p>the chosen words</p>";
    let shareFn: ((what: "page" | "selection") => unknown) | undefined;
    const d: PillChatDeps = {
      origin: "https://lianki.com",
      hostname: "news.example",
      path: "/story/1",
      href: () => "https://news.example/story/1?token=s#c",
      top: true,
      doc,
      win: win as unknown as PillChatDeps["win"],
      info: { injectInto: "content" },
      getValue: (k: string) =>
        k === "lianki_pillchat_on" ? JSON.stringify({ on: true, at: Date.now() }) : undefined,
      setValue: () => {},
      gmFetch: async () => ({ ok: true, status: 200, json: async () => ({ on: true }) }),
      prompt: async () => "once",
      frame: ((f: { share?: (w: "page" | "selection") => unknown }) => {
        shareFn = f.share;
        return {
          result: Promise.resolve("ready"),
          iframe: { addEventListener: () => {} },
          host: {},
          destroy: () => {},
        };
      }) as never,
    } as PillChatDeps;
    expect(await pillChat(d).open()).toBe("ready");
    expect(shareFn!("page")).toEqual({
      what: "page",
      title: "Story [x](javascript:1)",
      url: "https://news.example/story/1",
    });
    expect(shareFn!("selection")).toBeNull(); // nothing selected
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById("p")!);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
    expect((shareFn!("selection") as { selection: string }).selection).toBe("the chosen words");
  });
});

describe("the real DebugChat in the pill's frame never sends a share by itself", () => {
  // In its own process, outside the coverage gate (see unit/mount/pill-chat-share-mount.tsx).
  it("share → draft / chip; typing and the pause send nothing; Enter sends once (unit/mount)", () => {
    const r = Bun.spawnSync(["bun", "test", "./pill-chat-share-mount.tsx"], {
      cwd: `${import.meta.dir}/mount`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/\b1 pass\b/);
    expect(out).toMatch(/\b0 fail\b/);
  }, 60_000);
});
