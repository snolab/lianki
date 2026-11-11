// `say --play` on the command line (docs/li-sound-hub.md, "Playing audio from
// an agent"): eval.ts's flag check (scripts/dev/node-args.ts sayPlay), the
// controller message the hub takes (lib/dev-eval.ts), lianki-dev's argv on
// both paths (grant and lane token), and the public CLI's `lianki chat say
// --play` body (packages/lianki-cli). Nothing is sent and nothing plays.
import { describe, expect, it } from "bun:test";
import { sayPlay } from "@/scripts/dev/node-args";
import { chatArgv, evalArgv } from "@/scripts/dev/lianki-dev-cli";
import { parseControllerMessage } from "@/lib/dev-eval";
import { playOf } from "../packages/lianki-cli/cli.mjs";

const g = (o: { lane?: string; pair?: boolean } = {}) =>
  ({ json: false, pair: false, ...o }) as never;

describe("eval.ts say --play", () => {
  it("checked before a socket opens, by the hub's own parser", () => {
    expect(sayPlay()).toEqual({});
    expect(sayPlay("https://cdn.example.com/a.mp3", "Lesson")).toEqual({
      audio: { src: "https://cdn.example.com/a.mp3", title: "Lesson" },
    });
    expect(sayPlay("https://ice.example.com/live.mp3", undefined, "stream")).toEqual({
      audio: { src: "https://ice.example.com/live.mp3", kind: "stream" },
    });
    expect(sayPlay("file:0123456789abcdef0123")).toEqual({
      audio: { src: "file:0123456789abcdef0123" },
    });
    expect(sayPlay("http://cdn.example.com/a.mp3")).toHaveProperty("error");
    expect(sayPlay("https://10.0.0.1/a.mp3")).toHaveProperty("error");
    expect(sayPlay(undefined, "t")).toEqual({ error: "--title and --kind go with --play <src>" });
    expect(sayPlay(undefined, undefined, "file")).toHaveProperty("error");
  });
});

describe("the hub's controller say", () => {
  const say = (o: object) =>
    parseControllerMessage(JSON.stringify({ type: "say", text: "hi", ...o }));
  it("keeps a parsed audio, refuses a bad one with the reason", () => {
    expect(say({ audio: { src: "https://cdn.example.com/a.wav", title: "x" } })).toEqual({
      ok: true,
      value: {
        type: "say",
        text: "hi",
        audio: {
          src: "https://cdn.example.com/a.wav",
          kind: "file",
          mime: "audio/wav",
          title: "x",
        },
      },
    });
    expect(say({ audio: { src: "https://cdn.example.com/x", kind: "gen" } })).toMatchObject({
      ok: false,
      error: expect.stringContaining("not built yet"),
    });
    expect(say({ audio: "https://cdn.example.com/a.mp3" })).toMatchObject({ ok: false });
    expect(say({ audio: null })).toMatchObject({ ok: false });
  });
});

describe("lianki-dev say --play", () => {
  it("the grant path passes --play, --title, --kind to eval.ts", () => {
    expect(
      evalArgv("say", ["--play", "https://cdn.example.com/a.mp3", "--title", "L3", "listen"], g()),
    ).toEqual([
      "say",
      "--play",
      "https://cdn.example.com/a.mp3",
      "--title",
      "L3",
      "listen",
      "--no-pair",
    ]);
    expect(evalArgv("say", ["--play"], g())).toBeInstanceOf(Error);
  });

  it("a lane token's path passes them to lianki chat say, the text on stdin", () => {
    const a = chatArgv("say", [
      "--quiet",
      "--play",
      "https://x.example.com/live",
      "--kind",
      "stream",
      "radio",
    ]);
    if (a instanceof Error) throw a;
    expect([...a]).toEqual([
      "chat",
      "say",
      "--quiet",
      "-",
      "--play",
      "https://x.example.com/live",
      "--kind",
      "stream",
    ]);
    expect(a.stdin).toBe("radio");
    const b = chatArgv("say", ["--play", "https://x.example.com/a.mp3", "hi"]);
    if (b instanceof Error) throw b;
    expect([...b]).toEqual(["chat", "say", "-", "--play", "https://x.example.com/a.mp3"]);
    expect(chatArgv("say", ["--title"])).toBeInstanceOf(Error);
  });
});

describe("lianki chat say --play (the public CLI)", () => {
  it("the play object: https or file:<id>, a title, a kind", () => {
    expect(playOf({})).toBeUndefined();
    expect(playOf({ play: "https://cdn.example.com/a.mp3", title: " L3 " })).toEqual({
      src: "https://cdn.example.com/a.mp3",
      title: "L3",
    });
    expect(playOf({ play: "file:0123456789abcdef0123", kind: "file" })).toEqual({
      src: "file:0123456789abcdef0123",
      kind: "file",
    });
    expect(() => playOf({ play: "http://cdn.example.com/a.mp3" })).toThrow("https");
    expect(() => playOf({ play: "" })).toThrow("https");
    expect(() => playOf({ play: "https://a.example.com/x", kind: "rtc" })).toThrow("--kind");
  });
});
