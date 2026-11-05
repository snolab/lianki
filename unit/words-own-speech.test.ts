// /words cancels only its own browser utterances, so a card change never cuts
// Li's voice off (lib/words/own-speech.ts). Fakes only: nothing makes a sound.
import { describe, expect, it } from "bun:test";
import { ownSpeech } from "@/lib/words/own-speech";

class FakeUtter extends EventTarget {
  constructor(readonly text: string) {
    super();
  }
  end() {
    this.dispatchEvent(new Event("end"));
  }
  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

function setup() {
  const queue: FakeUtter[] = [];
  let cancels = 0;
  const synth = {
    speak: (u: FakeUtter) => void queue.push(u),
    cancel: () => {
      cancels++;
      queue.length = 0;
    },
  };
  return { s: ownSpeech<FakeUtter>(() => synth), queue, cancels: () => cancels };
}

describe("/words own speech", () => {
  it("cancels while its utterance is queued or playing", () => {
    const x = setup();
    x.s.speak(new FakeUtter("chat"));
    expect(x.s.busy()).toBe(true);
    x.s.cancel();
    expect(x.cancels()).toBe(1);
    expect(x.s.busy()).toBe(false);
  });

  it("after its utterance ended, a cancel leaves the engine alone (Li speaking goes on)", () => {
    const x = setup();
    const u = new FakeUtter("chat");
    x.s.speak(u);
    u.end();
    // Li's sentence, spoken by the chat (not through ownSpeech).
    x.queue.push(new FakeUtter("Li: bonjour"));
    x.s.cancel();
    expect(x.cancels()).toBe(0);
    expect(x.queue.map((q) => q.text)).toEqual(["chat", "Li: bonjour"]);
  });

  it("an error ends it too; nothing at all spoken: no cancel", () => {
    const x = setup();
    x.s.cancel();
    const u = new FakeUtter("chien");
    x.s.speak(u);
    u.fail();
    x.s.cancel();
    expect(x.cancels()).toBe(0);
  });

  it("no speechSynthesis: speak and cancel do nothing", () => {
    const s = ownSpeech<FakeUtter>(() => null);
    s.speak(new FakeUtter("x"));
    expect(s.busy()).toBe(false);
    s.cancel();
  });
});
