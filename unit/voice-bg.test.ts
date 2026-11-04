import { describe, expect, it } from "bun:test";
import {
  baseTitle,
  hiddenSilences,
  hideStops,
  hintedTitle,
  isDesktop,
  keepHub,
  onTakeover,
  sttMayReopen,
  titleHint,
  voiceBusy,
} from "@lianki/debug-chat/voice-bg";

const quiet = { mic: false, speaking: false, queued: 0 };
const mic = { mic: true, speaking: false, queued: 0 };
const reading = { mic: false, speaking: true, queued: 2 };

describe("voice-bg: a computer keeps the voice in a background tab", () => {
  it("a computer is a fine primary pointer that can hover; no matchMedia is not one", () => {
    expect(isDesktop((q) => ({ matches: q.includes("pointer: fine") }))).toBe(true);
    expect(isDesktop(() => ({ matches: false }))).toBe(false);
    expect(isDesktop(null)).toBe(false);
    expect(
      isDesktop(() => {
        throw new Error("no");
      }),
    ).toBe(false);
  });

  it("hiding stops the reading and silences lines on a phone only", () => {
    expect(hideStops(true)).toBe(false);
    expect(hideStops(false)).toBe(true);
    expect(hiddenSilences({ hidden: true, desktop: true })).toBe(false);
    expect(hiddenSilences({ hidden: true, desktop: false })).toBe(true);
    expect(hiddenSilences({ hidden: false, desktop: false })).toBe(false);
  });

  it("the voice is busy with the mic on, or something read or queued", () => {
    expect(voiceBusy(quiet)).toBe(false);
    expect(voiceBusy(mic)).toBe(true);
    expect(voiceBusy(reading)).toBe(true);
    expect(voiceBusy({ mic: false, speaking: false, queued: 1 })).toBe(true);
  });

  it("the hub socket stays while hidden only on a computer with the voice running", () => {
    expect(keepHub({ visible: true, desktop: false, busy: false })).toBe(true);
    expect(keepHub({ visible: false, desktop: true, busy: true })).toBe(true);
    expect(keepHub({ visible: false, desktop: true, busy: false })).toBe(false);
    expect(keepHub({ visible: false, desktop: false, busy: true })).toBe(false);
  });

  it("the local STT socket reopens while hidden on a computer", () => {
    expect(sttMayReopen({ visible: false, desktop: true })).toBe(true);
    expect(sttMayReopen({ visible: false, desktop: false })).toBe(false);
    expect(sttMayReopen({ visible: true, desktop: false })).toBe(true);
  });
});

describe("voice-bg: the title hint", () => {
  it("shows on a computer while the voice runs in a tab he is not looking at", () => {
    const at = { desktop: true, visible: false, focused: false };
    expect(titleHint({ ...at, voice: mic })).toBe("mic");
    expect(titleHint({ ...at, voice: reading })).toBe("reading");
    expect(titleHint({ ...at, voice: quiet })).toBeNull();
    // Visible but the window unfocused (another app in front): shown too.
    expect(titleHint({ ...at, visible: true, voice: mic })).toBe("mic");
    // Looking at it: none. A phone: none.
    expect(titleHint({ ...at, visible: true, focused: true, voice: mic })).toBeNull();
    expect(titleHint({ ...at, desktop: false, voice: mic })).toBeNull();
  });

  it("goes before the page's title and comes off again, never twice", () => {
    const w = "Lianki voice on";
    const t = hintedTitle("Read · Lianki", w, "mic");
    expect(t).toBe("🎙 Lianki voice on · Read · Lianki");
    expect(hintedTitle(t, w, "reading")).toBe("🔊 Lianki voice on · Read · Lianki");
    expect(hintedTitle(t, w, null)).toBe("Read · Lianki");
    expect(baseTitle("Plain", w)).toBe("Plain");
  });
});

describe("voice-bg: another tab takes the voice over", () => {
  it("another tab's mic: this mic goes off and the reading stops", () => {
    expect(onTakeover("mic", { mic: true, looking: false })).toEqual({
      micOff: true,
      stopReading: true,
    });
    expect(onTakeover("mic", { mic: false, looking: false })).toEqual({
      micOff: false,
      stopReading: true,
    });
  });

  it("another tab focused: a reading with the mic off stops here unless he looks at this tab", () => {
    expect(onTakeover("focus", { mic: false, looking: false })).toEqual({
      micOff: false,
      stopReading: true,
    });
    expect(onTakeover("focus", { mic: false, looking: true })).toEqual({
      micOff: false,
      stopReading: false,
    });
    // The mic tab keeps the voice whichever tab is focused.
    expect(onTakeover("focus", { mic: true, looking: false })).toEqual({
      micOff: false,
      stopReading: false,
    });
  });
});
