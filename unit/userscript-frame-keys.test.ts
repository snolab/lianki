import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

/**
 * The hotkeys, for pages that keep the keyboard somewhere else.
 *
 * Every case here was a real failure on books.snomiao.dev, whose calibre-web
 * reader renders a whole book into `<iframe srcdoc sandbox="allow-scripts">`.
 * Keyboard events go to the focused document and never cross a frame boundary,
 * so with focus in the reader the top document received ZERO keydowns — Alt+F
 * did nothing, and once the dialog was open by other means, neither did D.
 *
 * Runs against the BUILT public/lianki.user.js, since that is what users
 * install, and lifts the real functions out of it rather than restating them.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

/** End offset of the function or class whose declaration starts at `start`. */
function bodyEnd(start: number) {
  const open = BUILT.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < BUILT.length; i++) {
    if (BUILT[i] === "{") depth++;
    else if (BUILT[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unterminated block in the built userscript");
}

function sliceDecl(decl: string) {
  const start = BUILT.indexOf(decl);
  if (start === -1) throw new Error(`${decl} not found in the built userscript`);
  return BUILT.slice(start, bodyEnd(start));
}

function lift<T>(decl: string, name: string, ...args: unknown[]): T {
  const argNames = args.length ? ["GM_getValue"] : [];
  return new Function(...argNames, `${sliceDecl(decl)}; return ${name};`)(...args) as T;
}

describe("same-document navigation", () => {
  const stripFragment = lift<(h: string) => string>("function stripFragment(", "stripFragment");

  it("treats a fragment-only difference as the same document", () => {
    // The bug: a reader's next card is the same url with a different
    // `#bookpos=epubcfi(…)`. Assigning location.href there navigates WITHOUT
    // a page load, so the script never re-ran and the dialog sat there showing
    // the card just reviewed. It looked exactly like the review did nothing.
    const a = "https://books.snomiao.dev/#book_id=131&bookpos=epubcfi(/18/2/4/2/6/1:114)";
    const b = "https://books.snomiao.dev/#book_id=131&bookpos=epubcfi(/2/2/4/2@50:49.94)";
    expect(stripFragment(a)).toBe(stripFragment(b));
  });

  it("keeps a real navigation distinct", () => {
    expect(stripFragment("https://a.test/one#x")).not.toBe(stripFragment("https://a.test/two#x"));
    expect(stripFragment("https://a.test/p?q=1#x")).toBe("https://a.test/p?q=1");
    expect(stripFragment("https://a.test/p")).toBe("https://a.test/p");
  });

  it("the built script acts on it rather than trusting a page load", () => {
    // Without the re-arm, nothing follows the href assignment.
    expect(BUILT).toMatch(/sameDocument\s*=\s*stripFragment/);
    expect(BUILT).toMatch(/if \(sameDocument\)/);
  });
});

describe("hotkeys relayed out of a frame", () => {
  it("decides a key from its code and modifiers alone", () => {
    // keyAction exists so the same decision serves keys that never reach this
    // document. Pinned structurally: it is defined inside main()'s closure and
    // cannot be lifted without the dialog state it reads.
    expect(BUILT).toMatch(/function keyAction\(/);
    expect(BUILT).toMatch(/keyAction\(e\.data\)\?\./);
  });

  it("forwards every key, not just the one that opens the dialog", () => {
    // Once the dialog IS open, the ratings are pressed with the focus still in
    // the frame — so a relay that only forwarded Alt+F left D and A dead.
    const relay = sliceDecl("function installFrameKeyRelay(");
    expect(relay).toContain("relayPayload(e)");
    expect(relay).not.toMatch(/isHotkey\(e\)/);
  });

  it("carries the modifiers, so a rating is not confused with a hotkey", () => {
    const payload = sliceDecl("function relayPayload(");
    for (const k of ["code", "altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(payload).toContain(k);
    }
  });

  it("proves a relayed key came from a frame we wrote into", () => {
    // The obvious check — is event.source in window.frames — silently fails
    // across a userscript manager's isolated world: the frame posted
    // `KeyF+alt`, the parent received it, and the dialog stayed shut. A nonce
    // cannot fail that way.
    expect(BUILT).toMatch(/RELAY_NONCE/);
    expect(BUILT).toMatch(/e\.data\.nonce !== RELAY_NONCE/);
  });

  it("ignores the liveness ping as if it were a keystroke", () => {
    expect(BUILT).toMatch(/e\.data\.code === "__alive"/);
  });
});

describe("srcdoc relay injection", () => {
  const src = sliceDecl("function installSrcdocRelays(");

  it("stands down when the extension is present", () => {
    // The extension injects into every frame natively, so rewriting srcdoc
    // there would be pure cost — it reloads the frame.
    expect(src).toContain("dataset.liankiExt");
  });

  it("leaves the site's sandbox exactly as it set it", () => {
    // Adding allow-same-origin also works and was tried; it hands page scripts
    // the parent's origin, which is not ours to give away.
    expect(BUILT).not.toContain("allow-same-origin");
  });

  it("skips frames too small to be a document, and too large to rewrite", () => {
    // calibre-web puts an entire book in one srcdoc — measured at 3.7 MB — and
    // rewriting it during page load made the reader unusable for half a minute.
    expect(src).toMatch(/src\.length < 200/);
    expect(src).toMatch(/src\.length > MAX_SRCDOC/);
    expect(BUILT).toMatch(/MAX_SRCDOC = 512 \* 1024/);
  });

  it("caps re-injection, because a retry loop here is a denial of service", () => {
    // A three-second sweep re-parsed the book until the tab stopped responding.
    expect(BUILT).toMatch(/MAX_INJECTS = 2/);
    expect(src).toMatch(/n >= MAX_INJECTS/);
    expect(src).not.toContain("setInterval");
  });
});
