import { describe, expect, it } from "bun:test";
import {
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_KEY,
  inQuietWindow,
  isLoud,
  isQuiet,
  parseHm,
  quietHours,
  quietNow,
  readQuietHours,
  setQuietHours,
  silenceFor,
} from "@lianki/debug-chat/quiet-hours";
import { type Voice, gateVoice } from "@lianki/debug-chat/voice";

const hm = (s: string) => parseHm(s) as number;
/** A local Date at HH:MM today (the device's own time zone). */
const at = (s: string) => {
  const d = new Date(2026, 9, 31);
  d.setHours(Math.floor(hm(s) / 60), hm(s) % 60, 0, 0);
  return d;
};

describe("quiet hours: the window", () => {
  it("parses HH:MM and refuses anything else", () => {
    expect(parseHm("00:00")).toBe(0);
    expect(parseHm("8:05")).toBe(485);
    expect(parseHm("23:59")).toBe(1439);
    for (const bad of ["24:00", "12:60", "noon", "", "1230", 7, null])
      expect(parseHm(bad)).toBeNull();
  });

  it("wraps past midnight: 23:00–08:00 holds 23:00 to 07:59, not 08:00 or 22:59", () => {
    const [from, to] = [hm("23:00"), hm("08:00")];
    for (const t of ["23:00", "23:30", "00:00", "03:15", "07:59"])
      expect(inQuietWindow(hm(t), from, to)).toBe(true);
    for (const t of ["08:00", "12:00", "22:59"]) expect(inQuietWindow(hm(t), from, to)).toBe(false);
  });

  it("a same-day window holds [from, to); from = to is empty", () => {
    const [from, to] = [hm("13:00"), hm("14:30")];
    expect(inQuietWindow(hm("13:00"), from, to)).toBe(true);
    expect(inQuietWindow(hm("14:29"), from, to)).toBe(true);
    expect(inQuietWindow(hm("14:30"), from, to)).toBe(false);
    expect(inQuietWindow(hm("12:59"), from, to)).toBe(false);
    expect(inQuietWindow(hm("09:00"), hm("09:00"), hm("09:00"))).toBe(false);
  });

  it("reads the device's local clock, and nothing when off", () => {
    expect(quietNow(DEFAULT_QUIET_HOURS, at("02:00"))).toBe(true);
    expect(quietNow(DEFAULT_QUIET_HOURS, at("09:00"))).toBe(false);
    expect(quietNow({ ...DEFAULT_QUIET_HOURS, on: false }, at("02:00"))).toBe(false);
  });
});

describe("quiet hours: the setting (device-local)", () => {
  it("defaults to on, 23:00–08:00; broken fields fall back one by one", () => {
    expect(readQuietHours(null)).toEqual({ on: true, from: "23:00", to: "08:00" });
    expect(readQuietHours("{oops")).toEqual(DEFAULT_QUIET_HOURS);
    expect(readQuietHours('{"on":false,"from":"22:30","to":"7:00"}')).toEqual({
      on: false,
      from: "22:30",
      to: "07:00",
    });
    expect(readQuietHours('{"on":"yes","from":"25:00","to":7}')).toEqual(DEFAULT_QUIET_HOURS);
  });

  it("saves under lk:agent-quiet-hours and reads it back", () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(setQuietHours({ on: true, from: "1:00", to: "06:00" }, s)).toEqual({
      on: true,
      from: "01:00",
      to: "06:00",
    });
    expect(JSON.parse(m.get(QUIET_HOURS_KEY) as string)).toEqual({
      on: true,
      from: "01:00",
      to: "06:00",
    });
    expect(quietHours(s)).toEqual({ on: true, from: "01:00", to: "06:00" });
    expect(quietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
  });
});

describe("quiet hours: which agent lines are read aloud", () => {
  const night = { now: at("02:00"), hidden: false, hours: DEFAULT_QUIET_HOURS };
  const day = { ...night, now: at("15:00") };

  it("loud: say --loud or an ask card; quiet only when not loud", () => {
    expect(isLoud({ loud: true })).toBe(true);
    expect(isLoud({ ask: { questions: [] } })).toBe(true);
    expect(isLoud({ loud: "yes", ask: null })).toBe(false);
    expect(isQuiet({ quiet: true })).toBe(true);
    expect(isQuiet({ quiet: true, loud: true })).toBe(false);
    expect(isQuiet({ quiet: 1 })).toBe(false);
  });

  it("a quiet line is never read; a plain one not in quiet hours; a loud one always", () => {
    expect(silenceFor({ quiet: true }, day)).toBe("quiet");
    expect(silenceFor({}, day)).toBeNull();
    expect(silenceFor({}, night)).toBe("quiet-hours");
    expect(silenceFor({ loud: true }, night)).toBeNull();
    expect(silenceFor({ ask: { questions: [] } }, night)).toBeNull();
    expect(silenceFor({}, { ...night, hours: { ...DEFAULT_QUIET_HOURS, on: false } })).toBeNull();
  });

  it("a hidden page (screen locked) never speaks, not even a loud line", () => {
    expect(silenceFor({ loud: true }, { ...day, hidden: true })).toBe("hidden");
    expect(silenceFor({}, { ...day, hidden: true })).toBe("hidden");
  });

  it("gateVoice wraps the shared session once; a meta-less call (an older page) still gets the gate", () => {
    const heard: string[] = [];
    const logs: unknown[] = [];
    const v = {
      reply: (text: string) => (heard.push(text), true),
      log: (e: unknown) => void logs.push(e),
    } as unknown as Voice;
    let silence: "quiet" | null = null;
    const seen: unknown[] = [];
    const why = (m: object) => (seen.push(m), silence);
    gateVoice(v, why);
    const wrapped = v.reply;
    gateVoice(v, why);
    expect(v.reply).toBe(wrapped);
    expect(v.reply("hello")).toBe(true);
    expect(seen.at(-1)).toEqual({});
    silence = "quiet";
    expect(v.reply("shh", { quiet: true })).toBe(false);
    expect(seen.at(-1)).toEqual({ quiet: true });
    expect(heard).toEqual(["hello"]);
    expect(logs).toEqual([{ ev: "voice-silent", why: "quiet" }]);
  });
});
