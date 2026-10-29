import { describe, expect, it } from "bun:test";
import { avatarSrcs, avatarView, lineAvatar } from "@lianki/debug-chat/avatar-rules";
import {
  type ChatMessage,
  MAX_AVATAR_URL,
  avatarColors,
  avatarUrl,
  contrastRatio,
  hashId,
  initialOf,
  oklchLuminance,
  senderOf,
} from "@lianki/debug-chat/wire";

const line = (m: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  from: "owner",
  label: "/words iPhone",
  text: "hi",
  at: 0,
  ...m,
});

describe("initialOf", () => {
  it("is the name's first character, upper-cased", () => {
    expect(initialOf("ada")).toBe("A");
    expect(initialOf("  émile ")).toBe("É");
    expect(initialOf("山田")).toBe("山");
  });
  it("keeps a whole grapheme (an emoji, a combining mark)", () => {
    expect(initialOf("👩‍💻 dev")).toBe("👩‍💻");
    expect(initialOf("émile")).toBe("É");
  });
  it("is ? for no name", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf("   ")).toBe("?");
    expect(initialOf(undefined)).toBe("?");
  });
  it("works without Intl.Segmenter", () => {
    const Seg = Intl.Segmenter;
    try {
      (Intl as { Segmenter?: unknown }).Segmenter = undefined;
      expect(initialOf("ada")).toBe("A");
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = Seg;
    }
  });
});

describe("avatarColors", () => {
  it("is oklch(0.7 0.12 <hue>), stable per seed", () => {
    const a = avatarColors("k3x9");
    expect(a.bg).toBe(`oklch(0.7 0.12 ${a.hue})`);
    expect(avatarColors("k3x9")).toEqual(a);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    // Different people mostly get different hues.
    const hues = new Set(Array.from({ length: 50 }, (_, i) => avatarColors(`u${i}`).hue));
    expect(hues.size).toBeGreaterThan(30);
  });
  it("letters contrast at least 4.5:1 on every hue", () => {
    for (let i = 0; i < 2000; i++) {
      const { hue, fg } = avatarColors(`seed-${i}`);
      const bg = oklchLuminance(0.7, 0.12, hue);
      const ink = fg === "oklch(1 0 0)" ? 1 : oklchLuminance(0.2, 0, 0);
      expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses oklch only", () => {
    const { bg, fg } = avatarColors("x");
    expect(bg).toStartWith("oklch(");
    expect(fg).toStartWith("oklch(");
  });
  it("luminance matches known points", () => {
    expect(oklchLuminance(1, 0, 0)).toBeCloseTo(1, 3);
    expect(oklchLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 6);
  });
});

describe("senderOf", () => {
  it("hashes the user id, never carries the email", () => {
    const s = senderOf({
      userId: "user_1",
      email: "ada@example.com",
      name: "Ada",
      avatars: ["https://example.com/a.png"],
    });
    expect(s).toEqual({
      id: hashId("user_1"),
      name: "Ada",
      avatars: ["https://example.com/a.png"],
    });
    expect(JSON.stringify(s)).not.toContain("ada@");
  });
  it("hashes the email (lower-cased) when there is no id", () => {
    expect(senderOf({ email: " Ada@Example.com " }).id).toBe(hashId("ada@example.com"));
    expect(senderOf({})).toEqual({});
  });
  it("keeps https pictures only, in order, de-duplicated, at most two", () => {
    const s = senderOf({
      userId: "u",
      avatars: [
        "http://example.com/x.png",
        "https://example.com/own.png",
        null,
        "javascript:alert(1)",
        "https://example.com/own.png",
        "https://example.com/google.png",
        "https://example.com/third.png",
        `https://example.com/${"x".repeat(MAX_AVATAR_URL)}`,
      ],
    });
    expect(s.avatars).toEqual(["https://example.com/own.png", "https://example.com/google.png"]);
  });
  it("cleans and bounds the name", () => {
    expect(senderOf({ name: " A\u0000da\n " }).name).toBe("A da");
    expect(senderOf({ name: "x".repeat(500) }).name).toHaveLength(80);
    expect(senderOf({ name: null }).name).toBeUndefined();
  });
});

describe("avatarUrl", () => {
  it("accepts https only and normalizes", () => {
    expect(avatarUrl("https://example.com/a b.png")).toBe("https://example.com/a%20b.png");
    expect(avatarUrl("http://example.com/a.png")).toBeUndefined();
    expect(avatarUrl("not a url")).toBeUndefined();
    expect(avatarUrl(42)).toBeUndefined();
    expect(avatarUrl("")).toBeUndefined();
  });
});

describe("avatar fallback chain", () => {
  it("tries each picture, then the element, then the initial", () => {
    const srcs = ["https://example.com/own.png", "https://example.com/google.png"];
    expect(avatarView(srcs, 0, false)).toEqual({ kind: "img", src: srcs[0] });
    expect(avatarView(srcs, 1, false)).toEqual({ kind: "img", src: srcs[1] });
    expect(avatarView(srcs, 2, false)).toEqual({ kind: "initial" });
    expect(avatarView(srcs, 2, true)).toEqual({ kind: "node" });
    expect(avatarView([], 0, false)).toEqual({ kind: "initial" });
  });
  it("reads URLs from a string, a list, or nothing (an element has none)", () => {
    expect(avatarSrcs("https://example.com/a.png")).toEqual(["https://example.com/a.png"]);
    expect(avatarSrcs("")).toEqual([]);
    expect(avatarSrcs(["https://example.com/a.png", ""])).toEqual(["https://example.com/a.png"]);
    expect(avatarSrcs(undefined)).toEqual([]);
    expect(avatarSrcs({ type: "svg", props: {}, key: null } as never)).toEqual([]);
  });
});

describe("lineAvatar", () => {
  const viewer = { id: "v1", name: "Ada", avatars: ["https://example.com/now.png"] };
  it("the agent's line shows the host's logo, named by its label", () => {
    expect(
      lineAvatar(line({ from: "agent", label: "liagent" }), { agentAvatar: "/logo.png" }),
    ).toEqual({
      src: "/logo.png",
      name: "liagent",
      initialFrom: "liagent",
      seed: "agent:liagent",
      mine: false,
    });
    expect(lineAvatar(line({ from: "agent", label: "" }), {}).name).toBe("agent");
  });
  it("the viewer's own line is 'you', with their current picture first", () => {
    const m = line({ sender: { id: "v1", avatars: ["https://example.com/old.png"] } });
    expect(lineAvatar(m, { viewer })).toEqual({
      src: ["https://example.com/now.png", "https://example.com/old.png"],
      name: "you",
      initialFrom: "Ada",
      seed: "v1",
      mine: true,
    });
  });
  it("an old line with no sender still gets the viewer's avatar", () => {
    const a = lineAvatar(line({}), { viewer });
    expect(a.src).toEqual(viewer.avatars);
    expect(a.seed).toBe("v1");
  });
  it("on a friend's page, friend lines are theirs", () => {
    expect(lineAvatar(line({ from: "friend" }), { friend: true, viewer }).mine).toBe(true);
    expect(lineAvatar(line({ from: "owner" }), { friend: true, viewer }).mine).toBe(false);
  });
  it("someone else's line uses their sender, never the viewer's", () => {
    const a = lineAvatar(
      line({ from: "friend", thread: "f1", sender: { id: "k3", name: "Émile" } }),
      { viewer },
    );
    expect(a).toEqual({ src: [], name: "Émile", initialFrom: "Émile", seed: "k3", mine: false });
  });
  it("falls back to the thread for the colour and a role for the name", () => {
    const a = lineAvatar(line({ from: "friend", thread: "f1" }), {});
    expect(a.seed).toBe("f1");
    expect(a.name).toBe("friend");
    expect(lineAvatar(line({ from: "owner" }), { friend: true }).name).toBe("owner");
    expect(lineAvatar(line({ from: "owner" }), { friend: true }).seed).toBe("owner");
  });
  it("the host's resolver is tried first", () => {
    const a = lineAvatar(
      line({ from: "friend", sender: { avatars: ["https://example.com/s.png"] } }),
      {
        avatarFor: () => ({ name: "Grace", avatars: ["https://example.com/app.png"] }),
      },
    );
    expect(a.src).toEqual(["https://example.com/app.png", "https://example.com/s.png"]);
    expect(a.name).toBe("Grace");
  });
});
