/**
 * The public guide to connecting an AI chat app (/guides/ai-apps,
 * lib/ai-apps-guide.ts): a public app route, every locale keeps the
 * placeholders Lianki fills with its own labels, and the token page and the
 * agent guide both point at it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import guideDict from "@/app/(app)/guides/ai-apps/ai-apps-guide.content";
import tokensDict from "@/app/components/api-tokens.content";
import agentDict from "@/lib/agent-guide.content";
import {
  AI_APPS,
  AI_APPS_GUIDE_PATH,
  AI_APPS_GUIDE_URL,
  checkedOn,
  fillGuide,
} from "@/lib/ai-apps-guide";
import { agentGuide, guideStrings } from "@/lib/agent-guide";
import { isAppRoute } from "@/lib/app-locale";

const LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];
type Tr = { translation: Record<string, string> };
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("ai-apps guide", () => {
  it("is a public app route with a noun path", () => {
    expect(AI_APPS_GUIDE_PATH).toBe("/guides/ai-apps");
    expect(isAppRoute(AI_APPS_GUIDE_PATH)).toBe(true);
    expect(AI_APPS_GUIDE_URL).toBe("https://lianki.com/guides/ai-apps");
    expect(AI_APPS.map((a) => a.id)).toEqual(["chatgpt", "claude", "gemini"]);
    // No sign-in gate: the page reads no session.
    const page = readFileSync("app/(app)/guides/ai-apps/page.tsx", "utf8");
    expect(page).not.toMatch(/authUser|signInRedirect|isAdmin|isDev|readFlags/);
  });

  it("every locale keeps the English placeholders, so Lianki's labels can be filled in", () => {
    for (const [key, node] of Object.entries(guideDict.content) as [string, Tr][]) {
      const want = placeholders(node.translation.en);
      for (const loc of LOCALES) {
        const s = node.translation[loc];
        expect(typeof s, `${key}.${loc}`).toBe("string");
        expect(placeholders(s), `${key}.${loc}`).toEqual(want);
      }
    }
  });

  it("the placeholders are filled from the token page's own words", () => {
    const tk = tokensDict.content as unknown as Record<string, Tr>;
    const g = guideDict.content as unknown as Record<string, Tr>;
    for (const loc of LOCALES) {
      const out = fillGuide(g.liankiStudy.translation[loc], {
        study: tk.scopeStudy.translation[loc],
      });
      expect(out).toContain(tk.scopeStudy.translation[loc]);
      expect(out).not.toContain("{study}");
    }
    expect(fillGuide("a {x} {y}", { x: 1 })).toBe("a 1 {y}");
    expect(checkedOn("en")).toContain("2026");
    // An invalid locale tag falls back to the ISO date instead of throwing.
    expect(checkedOn("not a locale!")).toBe("2026-11-27");
  });

  it("each app links its maker's own official help page", () => {
    const hosts = AI_APPS.map((a) => new URL(a.help).host);
    expect(hosts).toEqual(["help.openai.com", "support.claude.com", "support.google.com"]);
    const g = guideDict.content as unknown as Record<string, Tr>;
    for (const k of ["availChatgpt", "availClaude", "availGemini", "availText", "claudeAuth"])
      expect(g[k], k).toBeDefined();
    expect(g.claudeAuth.translation.en).toContain("No sign in");
    // ChatGPT: install, then a Work chat with @ (OpenAI's plugin quickstart).
    expect(g.chatgptInstall.translation.en).toContain("install");
    expect(g.chatgptTry.translation.en).toMatch(/“Work”.*@/);
    // Gemini custom apps are English-only (Google's help page), said in every locale.
    for (const loc of LOCALES) expect(g.geminiNote.translation[loc]).toBeTruthy();
    expect(g.geminiNote.translation.en).toContain("only in English");
    // ...and in Gemini's "Who can use it" line, every locale (Google's help page).
    expect(g.availGemini.translation.en).toContain("only in English");
    for (const loc of LOCALES)
      expect(g.availGemini.translation[loc].length, loc).toBeGreaterThan(
        g.availGemini.translation[loc].indexOf("Gemini") + 60,
      );
    // No unconditional "about three minutes" promise in the intro.
    expect(g.intro.translation.en).not.toMatch(/minute/);
  });

  it("no token secret or prefix is shown on the page", () => {
    for (const node of Object.values(guideDict.content) as Tr[])
      for (const s of Object.values(node.translation)) expect(s).not.toMatch(/lk_/);
  });

  it("the token page links to it", () => {
    const src = readFileSync("app/(app)/my/preferences/TokenManager.tsx", "utf8");
    expect(src).toContain("AI_APPS_GUIDE_PATH");
    expect(
      (tokensDict.content as unknown as Record<string, Tr>).appsGuide.translation.en,
    ).toContain("ChatGPT");
  });

  it("the agent guide sends the user to it, in every locale", () => {
    for (const loc of LOCALES) {
      const t = guideStrings(agentDict.content, loc);
      expect(agentGuide({ scopes: ["study"], t })).toContain(AI_APPS_GUIDE_URL);
    }
  });
});
