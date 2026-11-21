import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createSequencer } from "../lib/words/sequence";
import { useFocusedReading, type FocusedSpeech } from "../lib/words/use-focused-reading";
import { stubGlobals } from "./support/globals";

async function rig() {
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const log: string[] = [];
  let sounding: string | null = null;
  const seq = createSequencer<string>({
    say: (part) => {
      sounding = part;
      log.push(part);
    },
    cancel: () => {
      sounding = null;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const speech: FocusedSpeech<string> = {
    once: (parts, _force, options) => {
      if (options?.yieldToHold && seq.playing() === "hold") return;
      seq.play(parts);
    },
    loop: (parts) => {
      seq.play(parts, { loop: true });
      return seq.stop;
    },
    stop: seq.stop,
  };
  const quietFocus = { current: null as number | null };
  let state = { touch: true, active: true, focus: 0, holding: false, parts: ["alpha"], speech };
  function Probe() {
    useFocusedReading({
      ...state,
      parts: [...state.parts],
      speech: { ...state.speech },
      quietFocus,
    });
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.createElement("div") as never);
  const render = async (patch: Partial<typeof state> = {}) => {
    state = { ...state, ...patch };
    await act(() => root.render(createElement(Probe)));
  };
  const close = async () => {
    await act(() => root.unmount());
    expect(sounding).toBeNull();
    restore();
    await win.happyDOM.close();
  };
  return { render, close, log, seq, speech, quietFocus, sounding: () => sounding };
}

test("touch reading survives a new speech facade and unrelated renders", async () => {
  const r = await rig();
  try {
    await r.render();
    expect(r.sounding()).toBe("alpha");
    await r.render();
    expect(r.log).toEqual(["alpha"]);
    expect(r.sounding()).toBe("alpha");
    await r.render({ focus: 1, parts: ["beta"] });
    expect(r.log).toEqual(["alpha", "beta"]);
    expect(r.sounding()).toBe("beta");
  } finally {
    await r.close();
  }
});

test("returning to a visible page resumes the same touch card without another tap", async () => {
  const r = await rig();
  try {
    await r.render();
    await r.render({ active: false });
    expect(r.sounding()).toBeNull();
    await r.render({ active: true });
    expect(r.log).toEqual(["alpha", "alpha"]);
    expect(r.sounding()).toBe("alpha");
  } finally {
    await r.close();
  }
});

test("a changed voice callback retries the focused touch card", async () => {
  const r = await rig();
  try {
    await r.render();
    await r.render({ speech: { ...r.speech, once: (...args) => r.speech.once(...args) } });
    expect(r.log).toEqual(["alpha", "alpha"]);
    expect(r.sounding()).toBe("alpha");
  } finally {
    await r.close();
  }
});

test("a tap that moved focus speaks once and is not canceled by the focus effect", async () => {
  const r = await rig();
  try {
    await r.render();
    r.quietFocus.current = 1;
    r.speech.once(["beta"], true);
    await r.render({ focus: 1, parts: ["beta"] });
    expect(r.log).toEqual(["alpha", "beta"]);
    expect(r.sounding()).toBe("beta");
    await r.render({ speech: { ...r.speech, once: (...args) => r.speech.once(...args) } });
    expect(r.log).toEqual(["alpha", "beta", "beta"]);
  } finally {
    await r.close();
  }
});

test("a long press keeps its pass when the finger lifts or speech callbacks change", async () => {
  const r = await rig();
  try {
    await r.render();
    r.seq.play(["held example"], { loop: true, tag: "hold" });
    await r.render({ holding: true });
    r.seq.finish();
    await r.render({
      holding: false,
      speech: { ...r.speech, once: (...args) => r.speech.once(...args) },
    });
    expect(r.sounding()).toBe("held example");
    expect(r.log).toEqual(["alpha", "held example"]);
  } finally {
    await r.close();
  }
});

test("desktop focus still loops, stops in the background, and resumes", async () => {
  const r = await rig();
  try {
    await r.render({ touch: false });
    expect(r.sounding()).toBe("alpha");
    await r.render({ active: false });
    expect(r.sounding()).toBeNull();
    await r.render({ active: true, focus: 1, parts: ["beta"] });
    expect(r.sounding()).toBe("beta");
  } finally {
    await r.close();
  }
});
