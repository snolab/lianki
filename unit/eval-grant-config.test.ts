/**
 * The owner's eval grant as live config (lib/eval-grant-config.ts), the
 * modal's sentence for it (wire.ts pairSentence / grantLength, in every
 * locale), and the page's rejoin rules (lib/debug-rejoin.ts).
 */
import { describe, expect, it } from "bun:test";
import { CONFIG, parseConfigValue } from "@/lib/config";
import {
  EVAL_GRANT_HOURS_DEFAULT,
  EVAL_GRANT_HOURS_KEY,
  EVAL_GRANT_HOURS_MAX,
  EVAL_GRANT_HOURS_MIN,
  EVAL_GRANT_PAGES_DEFAULT,
  EVAL_GRANT_PAGES_KEY,
  evalGrantHours,
  evalGrantMs,
  evalGrantPages,
  readEvalGrantConf,
} from "@/lib/eval-grant-config";
import { EVAL_GRANT_MS } from "@/lib/dev-eval";
import { grantLength, pairSentence } from "@lianki/debug-chat/wire";
import { UI_EN, UI_JA, UI_ZH, uiStrings } from "@lianki/debug-chat/ui-strings";
import { CHAT_LOCALES } from "@lianki/debug-chat/chat-ui-locales";
import { REJOIN_DELAYS_MS, devParts, mayRunEval, rejoinDelay } from "@/lib/debug-rejoin";

const DAY = 24 * 60 * 60_000;

describe("eval grant config", () => {
  it("the registry and the hub agree on keys, defaults and bounds", () => {
    const h = CONFIG[EVAL_GRANT_HOURS_KEY];
    expect(h.default).toBe(EVAL_GRANT_HOURS_DEFAULT);
    expect([h.min, h.max]).toEqual([EVAL_GRANT_HOURS_MIN, EVAL_GRANT_HOURS_MAX]);
    expect(h.audience).toBe("server");
    expect(CONFIG[EVAL_GRANT_PAGES_KEY].default).toBe(EVAL_GRANT_PAGES_DEFAULT);
    // The default is still the 8 hours in code; 30 days is a live value.
    expect(evalGrantMs(undefined)).toBe(EVAL_GRANT_MS);
    expect(parseConfigValue(EVAL_GRANT_HOURS_KEY, 720).ok).toBe(true);
    expect(parseConfigValue(EVAL_GRANT_HOURS_KEY, 721).ok).toBe(false);
    expect(parseConfigValue(EVAL_GRANT_PAGES_KEY, "all").ok).toBe(true);
    expect(parseConfigValue(EVAL_GRANT_PAGES_KEY, "every").ok).toBe(false);
  });

  it("reads a value the store could hold, and the default otherwise", () => {
    expect(evalGrantHours(720)).toBe(720);
    expect(evalGrantMs(720)).toBe(30 * DAY);
    for (const bad of [0, 721, 1.5, "720", null, undefined, Number.NaN])
      expect(evalGrantHours(bad)).toBe(8);
    expect(evalGrantPages("all")).toBe("all");
    expect(evalGrantPages("chosen")).toBe("chosen");
    expect(evalGrantPages("every")).toBe("chosen");
  });

  it("reads both through the binding, each falling back alone", async () => {
    const got = await readEvalGrantConf(async (k) => (k === EVAL_GRANT_HOURS_KEY ? 720 : "all"));
    expect(got).toEqual({ ms: 30 * DAY, allPages: true });
    const half = await readEvalGrantConf(async (k) => {
      if (k === EVAL_GRANT_PAGES_KEY) throw new Error("down");
      return 24;
    });
    expect(half).toEqual({ ms: DAY, allPages: false });
    expect(await readEvalGrantConf(undefined)).toEqual({ ms: EVAL_GRANT_MS, allPages: false });
  });
});

describe("the modal says how long, in the page's language", () => {
  it("hours and days", () => {
    expect(grantLength(60 * 60_000)).toBe("1 hour");
    expect(grantLength(EVAL_GRANT_MS)).toBe("8 hours");
    expect(grantLength(DAY)).toBe("24 hours");
    expect(grantLength(30 * DAY)).toBe("30 days");
    expect(grantLength(36 * 60 * 60_000)).toBe("36 hours");
    expect(grantLength(30 * DAY, UI_ZH)).toBe("30 天");
    expect(grantLength(EVAL_GRANT_MS, UI_JA)).toBe("8時間");
  });

  it("the sentence follows the hub's length and page scope", () => {
    expect(pairSentence({ label: "lane", scope: "eval" }, false)).toBe(
      "lane wants to run code on your pages for 8 hours.",
    );
    expect(pairSentence({ label: "lane", scope: "eval", grantMs: 30 * DAY }, false, UI_EN)).toBe(
      "lane wants to run code on your pages for 30 days.",
    );
    expect(
      pairSentence({ label: "lane", scope: "eval", grantMs: 30 * DAY, allPages: true }, false),
    ).toBe("lane wants to run code on all your pages, on every device, for 30 days.");
    expect(
      pairSentence(
        { label: "lane", scope: "eval", grantMs: 30 * DAY, allPages: true },
        false,
        UI_ZH,
      ),
    ).toBe("lane 想在你所有设备的所有页面上运行代码，为期 30 天。");
    // A nonsense length from an older or broken hub: the 8 hours it would grant.
    expect(pairSentence({ label: "x", scope: "eval", grantMs: -1 }, false)).toContain("8 hours");
  });

  it("every locale keeps its placeholders", () => {
    for (const loc of CHAT_LOCALES) {
      const s = uiStrings(loc);
      expect(s.pairEval).toContain("{label}");
      expect(s.pairEval).toContain("{time}");
      expect(s.pairEvalAll).toContain("{label}");
      expect(s.pairEvalAll).toContain("{time}");
      expect(s.grantHours).toContain("{n}");
      expect(s.grantDays).toContain("{n}");
      expect(s.grantHour).not.toContain("{n}");
      const said = pairSentence({ label: "L", scope: "eval", grantMs: 30 * DAY }, false, s);
      expect(said).not.toMatch(/\{(label|time|n)\}/);
      expect(said).toContain("30");
    }
  });
});

describe("rejoin after a reload (lib/debug-rejoin.ts)", () => {
  it("either fresh yes runs remote eval; debug mode is still needed", () => {
    expect(mayRunEval({ debug: true, dev: true, hubOwner: false })).toBe(true);
    expect(mayRunEval({ debug: true, dev: false, hubOwner: true })).toBe(true);
    expect(mayRunEval({ debug: true, dev: false, hubOwner: false })).toBe(false);
    expect(mayRunEval({ debug: false, dev: true, hubOwner: true })).toBe(false);
    expect(devParts({ dev: false, hubOwner: true })).toBe(true);
    expect(devParts({ dev: false, hubOwner: false })).toBe(false);
  });

  it("a friend verdict is asked again only with reason, a few times", () => {
    expect(rejoinDelay({ dev: false, wasOwner: false, tries: 0 })).toBeNull();
    expect(rejoinDelay({ dev: true, wasOwner: false, tries: 0 })).toBe(REJOIN_DELAYS_MS[0]);
    expect(rejoinDelay({ dev: false, wasOwner: true, tries: 1 })).toBe(REJOIN_DELAYS_MS[1]);
    expect(rejoinDelay({ dev: true, wasOwner: true, tries: REJOIN_DELAYS_MS.length })).toBeNull();
  });
});
