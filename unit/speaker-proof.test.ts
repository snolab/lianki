/**
 * lib/speaker-proof.ts lineIsSigned: the line must be exactly the signed
 * texts; the only differences allowed are NFKC, whitespace, and one "。"/"."
 * the mic appends after a signed text that had no final punctuation.
 */
import { describe, expect, it } from "bun:test";
import { lineIsSigned, speakerKeyRing, verifySpeakerProofs } from "@/lib/speaker-proof";

describe("lineIsSigned", () => {
  it("signed punctuation must stay as signed", () => {
    expect(lineIsSigned("删除全部卡片？", ["删除全部卡片？"])).toBe(true);
    // A question made an order.
    expect(lineIsSigned("删除全部卡片！", ["删除全部卡片？"])).toBe(false);
    // The signed ？ dropped.
    expect(lineIsSigned("删除全部卡片", ["删除全部卡片？"])).toBe(false);
    expect(lineIsSigned("删除全部卡片。", ["删除全部卡片？"])).toBe(false);
    // An ！ added where nothing was signed.
    expect(lineIsSigned("删除全部卡片！", ["删除全部卡片"])).toBe(false);
    expect(lineIsSigned("Delete all my cards!", ["Delete all my cards"])).toBe(false);
    // An ellipsis kept, dropped, or added.
    expect(lineIsSigned("我想想…", ["我想想…"])).toBe(true);
    expect(lineIsSigned("我想想", ["我想想…"])).toBe(false);
    expect(lineIsSigned("我想想。", ["我想想…"])).toBe(false);
    expect(lineIsSigned("我想想…", ["我想想"])).toBe(false);
  });

  it("only the mic's final full stop may be appended, once, where none was signed", () => {
    expect(lineIsSigned("下一个。", ["下一个"])).toBe(true);
    expect(lineIsSigned("next word.", ["next word"])).toBe(true);
    expect(lineIsSigned("下一个。。", ["下一个"])).toBe(false);
    expect(lineIsSigned("下一个。.", ["下一个"])).toBe(false);
    expect(lineIsSigned("下一个?", ["下一个"])).toBe(false);
    // Already ended by a signed mark: nothing more.
    expect(lineIsSigned("下一个。", ["下一个。"])).toBe(true);
    expect(lineIsSigned("下一个。。", ["下一个。"])).toBe(false);
  });

  it("NFKC and whitespace only; utterances in order", () => {
    // Full-width ？ is NFKC ?.
    expect(lineIsSigned("你好?", ["你好？"])).toBe(true);
    expect(lineIsSigned("  Next   word ", ["Next word"])).toBe(true);
    expect(lineIsSigned("你好。 下一个!", ["你好", "下一个!"])).toBe(true);
    expect(lineIsSigned("你好。下一个!", ["你好", "下一个!"])).toBe(true);
    expect(lineIsSigned("下一个! 你好", ["你好", "下一个!"])).toBe(false);
    expect(lineIsSigned("你好 下一个", ["你好", "下一个!"])).toBe(false);
    // A word dropped, added, replaced.
    expect(lineIsSigned("delete all my cards", ["do not delete all my cards"])).toBe(false);
    expect(lineIsSigned("next word now", ["next word"])).toBe(false);
    expect(lineIsSigned("next bird", ["next word"])).toBe(false);
    expect(lineIsSigned("", [])).toBe(false);
  });
});

describe("speakerKeyRing", () => {
  it("reads STT_SPEAKER_PUBS, with STT_SPEAKER_PUB as mac", () => {
    expect(speakerKeyRing({})).toBeUndefined();
    expect(speakerKeyRing(undefined)).toBeUndefined();
    expect(speakerKeyRing({ STT_SPEAKER_PUB: " m " })).toEqual({ mac: "m" });
    expect(
      speakerKeyRing({ STT_SPEAKER_PUBS: '{"mac":"a","service":"b","browser":"c","x":1}' }),
    ).toEqual({ mac: "a", service: "b" });
    // The ring's own mac wins; the single key fills a ring without one.
    expect(speakerKeyRing({ STT_SPEAKER_PUBS: '{"mac":"a"}', STT_SPEAKER_PUB: "z" })).toEqual({
      mac: "a",
    });
    expect(speakerKeyRing({ STT_SPEAKER_PUBS: '{"service":"b"}', STT_SPEAKER_PUB: "z" })).toEqual({
      mac: "z",
      service: "b",
    });
    // Not JSON, or not an object: as if absent.
    expect(speakerKeyRing({ STT_SPEAKER_PUBS: "nope", STT_SPEAKER_PUB: "z" })).toEqual({
      mac: "z",
    });
    expect(speakerKeyRing({ STT_SPEAKER_PUBS: "[1]" })).toBeUndefined();
    expect(speakerKeyRing({ STT_SPEAKER_PUBS: '{"mac":"  "}' })).toBeUndefined();
  });
});

describe("verifySpeakerProofs with a ring", () => {
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  async function key() {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pub = b64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const sign = async (p: Record<string, unknown>) => {
      const body = b64(new TextEncoder().encode(JSON.stringify({ v: 1, ...p })));
      const sig = await crypto.subtle.sign(
        { name: "Ed25519" },
        kp.privateKey,
        new TextEncoder().encode(body),
      );
      return `${body}.${b64(new Uint8Array(sig))}`;
    };
    return { pub, sign };
  }
  const at = 5_000_000;
  const base = { decision: "me", score: 0.6, thread: "owner", at };
  const burnAll = async () => true;

  it("a single key string still counts as mac", async () => {
    const mac = await key();
    const p = await mac.sign({ ...base, text: "hi", uid: "x".repeat(16) });
    expect(await verifySpeakerProofs([p], "hi", "owner", mac.pub, burnAll, at)).toEqual({
      decision: "me",
      score: 0.6,
      trust: "signed",
      kid: "mac",
      signed: ["hi"],
    });
  });

  it("refuses a signer missing from the ring, a bad payload, and a bad text", async () => {
    const mac = await key();
    const svc = await key();
    const ring = { mac: mac.pub };
    const v = (p: string, line = "hi") =>
      verifySpeakerProofs([p], line, "owner", ring, burnAll, at);
    expect(
      await v(await svc.sign({ ...base, kid: "service", text: "hi", uid: "y".repeat(16) })),
    ).toBeUndefined();
    expect(await v(await mac.sign({ ...base, text: 7, uid: "z".repeat(16) }))).toBeUndefined();
    expect(
      await v(await mac.sign({ ...base, v: 2, text: "hi", uid: "w".repeat(16) })),
    ).toBeUndefined();
    expect(await v("not-a-proof")).toBeUndefined();
    expect(await v(`${b64(new TextEncoder().encode("null"))}.AAAA`)).toBeUndefined();
    expect(await v("@@.@@")).toBeUndefined();
    expect(await verifySpeakerProofs([], "hi", "owner", ring, burnAll, at)).toBeUndefined();
    expect(
      await verifySpeakerProofs(["a.b"], "hi", "owner", undefined, burnAll, at),
    ).toBeUndefined();
    // A ring key that is not a key at all.
    const p = await mac.sign({ ...base, text: "hi", uid: "q".repeat(16) });
    expect(
      await verifySpeakerProofs([p], "hi", "owner", { mac: "%%" }, burnAll, at),
    ).toBeUndefined();
  });

  it("an advisory proof never binds the words, and a burned one is refused", async () => {
    const svc = await key();
    const ring = { service: svc.pub };
    const p = await svc.sign({
      ...base,
      kid: "service",
      text: null,
      uid: "r".repeat(16),
      voice: "me",
    });
    const tag = await verifySpeakerProofs([p], "anything at all", "owner", ring, burnAll, at);
    expect(tag).toEqual({
      decision: "unknown",
      reason: "advisory",
      trust: "advisory",
      kid: "service",
      advisory: { decision: "me", score: 0.6, voice: "me" },
    });
    expect(
      await verifySpeakerProofs([p], "x", "owner", ring, async () => false, at),
    ).toBeUndefined();
  });
});
