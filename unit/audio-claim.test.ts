// The page's audio owner (packages/debug-chat/src/audio-claim.ts), the reader
// and /words on it, on fake audio: nothing here makes a sound.
import { describe, expect, it } from "bun:test";
import {
  AUDIO_CLAIM,
  AUDIO_PRIO,
  AUDIO_RELEASE,
  audioOwner,
  type AudioOwnerOpts,
} from "@lianki/debug-chat/audio-claim";
import { createSequencer } from "@/lib/words/sequence";

function page() {
  const target = new EventTarget();
  const log: string[] = [];
  const make = (id: string, prio: number, extra: Partial<AudioOwnerOpts> = {}) =>
    audioOwner({
      id,
      prio,
      target,
      onYield: () => void log.push(`${id} yield`),
      onResume: () => void log.push(`${id} resume`),
      ...extra,
    });
  return { target, log, make };
}

describe("audio owner: one sound at a time, by rank", () => {
  it("Li pauses a paragraph; the paragraph resumes when Li is done", () => {
    const p = page();
    const para = p.make("para", AUDIO_PRIO.para);
    const li = p.make("li", AUDIO_PRIO.li);
    expect(para.claim()).toBe(true);
    expect(li.claim()).toBe(true);
    expect(p.log).toEqual(["para yield"]);
    expect(para.state()).toBe("waiting");
    li.release();
    expect(p.log).toEqual(["para yield", "para resume"]);
    expect(para.state()).toBe("holding");
  });

  it("a lower claim waits for a higher holder, and starts when it lets go", () => {
    const p = page();
    const li = p.make("li", AUDIO_PRIO.li);
    const card = p.make("card", AUDIO_PRIO.card);
    li.claim();
    expect(card.claim()).toBe(false);
    expect(p.log).toEqual([]);
    li.release();
    expect(p.log).toEqual(["card resume"]);
  });

  it("when Li lets go, the word read-aloud goes first, the paragraph after it", () => {
    const p = page();
    // Registered first, so it hears the release first: the card still wins.
    const para = p.make("para", AUDIO_PRIO.para);
    const card = p.make("card", AUDIO_PRIO.card);
    const li = p.make("li", AUDIO_PRIO.li);
    para.claim();
    card.claim();
    li.claim();
    expect(p.log).toEqual(["para yield", "card yield"]);
    li.release();
    expect(p.log.slice(2)).toEqual(["card resume"]);
    expect(para.state()).toBe("waiting");
    card.release();
    expect(p.log.slice(3)).toEqual(["para resume"]);
  });

  it("the newest of equals wins; the other waits for it", () => {
    const p = page();
    const review = p.make("review", AUDIO_PRIO.card);
    const words = p.make("words", AUDIO_PRIO.card);
    review.claim();
    expect(words.claim()).toBe(true);
    expect(p.log).toEqual(["review yield"]);
    words.release();
    expect(p.log).toEqual(["review yield", "review resume"]);
  });

  it("a waiter leaving frees nothing; an idle owner listens to nothing", () => {
    const p = page();
    const li = p.make("li", AUDIO_PRIO.li);
    const para = p.make("para", AUDIO_PRIO.para);
    const card = p.make("card", AUDIO_PRIO.card);
    li.claim();
    para.claim();
    let releases = 0;
    p.target.addEventListener(AUDIO_RELEASE, () => releases++);
    para.release();
    expect(releases).toBe(0);
    li.release();
    expect(p.log).toEqual([]);
    // An idle owner does not cancel claims.
    const e = new CustomEvent(AUDIO_CLAIM, { detail: { id: "x", prio: 0 }, cancelable: true });
    p.target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(card.state()).toBe("idle");
  });

  it("speaks the window-event contract, for a bundle carrying its own copy", () => {
    const p = page();
    const para = p.make("para", AUDIO_PRIO.para);
    para.claim();
    // Another bundle's Li: plain events, no import.
    const claim = new CustomEvent(AUDIO_CLAIM, {
      detail: { id: "li-x", prio: 3 },
      cancelable: true,
    });
    p.target.dispatchEvent(claim);
    expect(claim.defaultPrevented).toBe(false);
    expect(p.log).toEqual(["para yield"]);
    p.target.dispatchEvent(new CustomEvent(AUDIO_RELEASE, { detail: { id: "li-x" } }));
    expect(p.log).toEqual(["para yield", "para resume"]);
  });
});

describe("/words sequencer on the audio owner", () => {
  const setup = () => {
    const p = page();
    const said: string[] = [];
    let cancels = 0;
    const dones: ((played: boolean) => void)[] = [];
    const timers: (() => void)[] = [];
    const seq = createSequencer<string>({
      say: (part, done) => {
        said.push(part);
        dones.push(done);
      },
      cancel: () => void cancels++,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
      owner: (h) => audioOwner({ ...h, id: "words", prio: AUDIO_PRIO.card, target: p.target }),
    });
    const li = p.make("li", AUDIO_PRIO.li);
    const runTimers = () => timers.splice(0).forEach((f) => f());
    return { p, seq, said, dones, li, cancels: () => cancels, runTimers };
  };

  it("Li cuts the part playing; the same part is said again when Li is done", () => {
    const x = setup();
    x.seq.play(["chat", "le chat dort"]);
    expect(x.said).toEqual(["chat"]);
    x.li.claim();
    expect(x.cancels()).toBe(2); // play's own halt, then the pause
    x.dones[0](false); // the cut part's late done is ignored
    x.runTimers();
    expect(x.said).toEqual(["chat"]);
    x.li.release();
    expect(x.said).toEqual(["chat", "chat"]);
    x.dones[1](true);
    x.runTimers();
    expect(x.said).toEqual(["chat", "chat", "le chat dort"]);
  });

  it("a word tapped while Li speaks waits for Li, then plays", () => {
    const x = setup();
    x.li.claim();
    x.seq.play(["chat"]);
    expect(x.said).toEqual([]);
    x.li.release();
    expect(x.said).toEqual(["chat"]);
  });

  it("stop while paused for Li does not cancel (that would cut Li's voice)", () => {
    const x = setup();
    x.seq.play(["chat"]);
    x.li.claim();
    const before = x.cancels();
    x.seq.stop();
    expect(x.cancels()).toBe(before);
    x.li.release();
    expect(x.said).toEqual(["chat"]);
  });

  it("the next row keeps the page: a paused paragraph does not slip in between", () => {
    const x = setup();
    const para = x.p.make("para", AUDIO_PRIO.para);
    para.claim();
    x.seq.play(["chat"]);
    x.seq.play(["chien"]);
    expect(x.p.log).toEqual(["para yield"]);
    x.dones[1](true);
    expect(x.p.log).toEqual(["para yield", "para resume"]);
  });
});
