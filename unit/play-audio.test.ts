// An agent's audio on a chat line (packages/debug-chat/src/play-audio.ts;
// docs/li-sound-hub.md, "Playing audio from an agent"): the src check the
// CLI, the hub and the page share, and the autoplay decision. Pure: nothing
// is fetched and nothing plays.
import { describe, expect, it } from "bun:test";
import {
  HLS_MIME,
  MAX_SRC,
  MAX_TITLE,
  PLAY_FLAG,
  PLAY_KINDS,
  PLAY_KINDS_NOW,
  type AutoplayInput,
  autoplayDecision,
  denyList,
  hostDenied,
  isHls,
  isIpHost,
  lineAudioOf,
  parsePlay,
  playRefusal,
  srcHost,
} from "@lianki/debug-chat/play-audio";
import { FLAGS } from "@/lib/flags";

const ok = (src: string, extra: Record<string, unknown> = {}, deny?: string[]) => {
  const p = parsePlay({ src, ...extra }, deny ? { deny } : {});
  if (!p.ok) throw new Error(p.error);
  return p.audio;
};
const err = (src: unknown, extra: Record<string, unknown> = {}, deny?: string[]) => {
  const p = parsePlay({ src, ...extra }, deny ? { deny } : {});
  if (p.ok) throw new Error(`accepted ${String(src)}`);
  return p.error;
};

describe("parsePlay: what may be played", () => {
  it("an https file: kind file, its type from the extension", () => {
    expect(ok("https://cdn.example.com/a/hello.mp3")).toEqual({
      src: "https://cdn.example.com/a/hello.mp3",
      kind: "file",
      mime: "audio/mpeg",
    });
    expect(ok("https://x.example.org/b.OGG").mime).toBe("audio/ogg");
    expect(ok("https://x.example.org/b.wav?x=1").mime).toBe("audio/wav");
    expect(ok("https://x.example.org/b.webm").mime).toBe("audio/webm");
    expect(ok("https://x.example.org/b.m4a").mime).toBe("audio/mp4");
  });

  it("HLS and Icecast streams: kind stream", () => {
    const hls = ok("https://live.example.com/radio/index.m3u8");
    expect(hls).toMatchObject({ kind: "stream", mime: HLS_MIME });
    expect(isHls(hls)).toBe(true);
    const ice = ok("https://ice.example.net:8000/stream");
    expect(ice.kind).toBe("stream");
    expect(ice.mime).toBeUndefined();
    expect(isHls(ice)).toBe(false);
  });

  it("an explicit kind wins over the guess; the later kinds are refused by name", () => {
    expect(ok("https://ice.example.net/live.mp3", { kind: "stream" }).kind).toBe("stream");
    expect(ok("https://ice.example.net/stream", { kind: "file" }).kind).toBe("file");
    for (const k of ["rtc", "gen", "webaudio"])
      expect(err("https://a.example.com/x", { kind: k })).toContain("not built yet");
    expect(err("https://a.example.com/x", { kind: "video" })).toContain("unknown kind");
    expect(PLAY_KINDS).toEqual(["file", "stream", "rtc", "gen", "webaudio"]);
    expect(PLAY_KINDS_NOW).toEqual(["file", "stream"]);
  });

  it("file:<id> from My Files", () => {
    expect(ok("file:0123456789abcdef0123")).toEqual({
      src: "file:0123456789abcdef0123",
      kind: "file",
    });
    expect(err("file:../etc/passwd")).toContain("My Files id");
    expect(err("file:0123456789ABCDEF0123")).toContain("My Files id");
    expect(err("file:0123456789abcdef0123", { kind: "stream" })).toContain("kind file");
  });

  it("https only, no credentials", () => {
    expect(err("http://cdn.example.com/a.mp3")).toContain("https");
    expect(err("ftp://cdn.example.com/a.mp3")).toContain("https");
    expect(err("data:audio/wav;base64,AAAA")).toContain("https");
    expect(err("javascript:alert(1)")).toContain("https");
    expect(err("https://user:pw@cdn.example.com/a.mp3")).toContain("credentials");
    expect(err("https://user@cdn.example.com/a.mp3")).toContain("credentials");
  });

  it("never an IP literal, in any spelling the URL parser understands", () => {
    for (const s of [
      "https://127.0.0.1/a.mp3",
      "https://10.0.0.8/a.mp3",
      "https://169.254.169.254/latest",
      "https://2130706433/a.mp3",
      "https://0x7f.1/a.mp3",
      "https://017700000001/a.mp3",
      "https://[::1]/a.mp3",
      "https://[fd00::1]:8443/a.mp3",
    ])
      expect(err(s)).toContain("IP");
    expect(isIpHost("example.com")).toBe(false);
  });

  it("never a local name", () => {
    for (const s of [
      "https://localhost/a.mp3",
      "https://intranet/a.mp3",
      "https://printer.local/a.mp3",
      "https://a.localhost/a.mp3",
      "https://db.internal/a.mp3",
      "https://nas.lan/a.mp3",
      "https://nas.home.arpa/a.mp3",
    ])
      expect(err(s)).toContain("public host");
  });

  it("the deny list: the host and every name under it", () => {
    const deny = denyList(" Bad.example , .evil.test\nother.org ");
    expect(deny).toEqual(["bad.example", "evil.test", "other.org"]);
    expect(err("https://bad.example/a.mp3", {}, deny)).toContain("deny list");
    expect(err("https://cdn.BAD.example/a.mp3", {}, deny)).toContain("deny list");
    expect(ok("https://notbad.example/a.mp3", {}, deny).kind).toBe("file");
    expect(hostDenied("x.other.org", deny)).toBe(true);
    expect(denyList(undefined)).toEqual([]);
    expect(denyList(["A.com", ""])).toEqual(["a.com"]);
  });

  it("shape: required, bounded, a URL; a title is cleaned and cut", () => {
    expect(err(undefined)).toContain("needs a src");
    expect(err("   ")).toContain("needs a src");
    expect(err(`https://a.example.com/${"x".repeat(MAX_SRC)}`)).toContain("longer");
    expect(err("https://")).toContain("not a URL");
    expect(err("not a url")).toContain("not a URL");
    expect(err("https://a.example.com/a.mp3", { title: 5 })).toContain("title");
    expect(ok("https://a.example.com/a.mp3", { title: "  hi\u0000 there\n " }).title).toBe(
      "hi there",
    );
    expect(ok("https://a.example.com/a.mp3", { title: "x".repeat(500) }).title).toHaveLength(
      MAX_TITLE,
    );
    expect(ok("https://a.example.com/a.mp3", { title: "​" }).title).toBeUndefined();
  });

  it("a stored line is read back only if it still parses", () => {
    expect(
      lineAudioOf({ src: "https://a.example.com/a.mp3", kind: "file", title: "t" }),
    ).toMatchObject({ title: "t" });
    expect(lineAudioOf({ src: "http://a.example.com/a.mp3", kind: "file" })).toBeUndefined();
    expect(lineAudioOf({ src: "https://a.example.com/a", kind: "rtc" })).toBeUndefined();
    expect(lineAudioOf(null)).toBeUndefined();
    expect(lineAudioOf("https://a.example.com/a.mp3")).toBeUndefined();
  });

  it("the audit log keeps the host only", () => {
    expect(srcHost("https://CDN.example.com:8443/p/a.mp3?token=secret")).toBe("cdn.example.com");
    expect(srcHost("file:0123456789abcdef0123")).toBe("lianki.com");
    expect(srcHost("nope")).toBe("");
  });

  it("each refusal says what to do", () => {
    expect(playRefusal("flag")).toContain("lianki.com/dev/flags#chat.play-audio");
    expect(playRefusal("denied")).toContain("chat.play.denyHosts");
    expect(playRefusal("scope")).toContain("chat:play");
    expect(playRefusal("rate")).toContain("chat.play.perTenMin");
    expect(playRefusal("unavailable")).toContain("nothing was sent");
    expect(playRefusal("expired")).toBe("play refused: expired");
  });

  it("the flag is registered: off by default, the owner's audience", () => {
    expect(PLAY_FLAG).toBe("chat.play-audio");
    expect(FLAGS[PLAY_FLAG]).toMatchObject({ default: false, audience: "owner" });
  });
});

describe("autoplayDecision: by itself only when everything holds", () => {
  const all: AutoplayInput = {
    flag: true,
    desktop: false,
    visible: true,
    unlocked: true,
    micOpen: false,
    quiet: false,
    fresh: true,
    speakerTab: true,
  };

  it("a visible, unlocked phone page with the mic off plays", () => {
    expect(autoplayDecision(all)).toEqual({ play: true });
  });

  it("any one missing condition waits for a tap, with its reason", () => {
    const cases: [Partial<AutoplayInput>, string][] = [
      [{ flag: false }, "flag"],
      [{ fresh: false }, "history"],
      [{ desktop: true }, "desktop"],
      [{ speakerTab: false }, "tab"],
      [{ quiet: true }, "quiet"],
      [{ visible: false }, "hidden"],
      [{ micOpen: true }, "mic"],
      [{ unlocked: false }, "locked"],
    ];
    for (const [change, why] of cases)
      expect(autoplayDecision({ ...all, ...change })).toEqual({ play: false, why } as never);
  });

  it("a Mac never plays by itself, even with everything else on", () => {
    expect(autoplayDecision({ ...all, desktop: true })).toEqual({ play: false, why: "desktop" });
  });
});
