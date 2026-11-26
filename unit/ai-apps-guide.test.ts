/**
 * The public guide to connecting an AI chat app (/guides/ai-apps,
 * lib/ai-apps-guide.ts): a public app route, every locale keeps the
 * placeholders Lianki fills with its own labels, the other apps' content is
 * linked and never restated, and the token page and the agent guide point at it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import guideDict from "@/app/(app)/guides/ai-apps/ai-apps-guide.content";
import tokensDict from "@/app/components/api-tokens.content";
import agentDict from "@/lib/agent-guide.content";
import {
  AI_APPS,
  AI_APPS_FEEDBACK_PATH,
  AI_APPS_GUIDE_PATH,
  AI_APPS_GUIDE_URL,
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
const g = guideDict.content as unknown as Record<string, Tr>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const page = readFileSync("app/(app)/guides/ai-apps/page.tsx", "utf8");

describe("ai-apps guide", () => {
  it("is a public app route with a noun path", () => {
    expect(AI_APPS_GUIDE_PATH).toBe("/guides/ai-apps");
    expect(isAppRoute(AI_APPS_GUIDE_PATH)).toBe(true);
    expect(AI_APPS_GUIDE_URL).toBe("https://lianki.com/guides/ai-apps");
    expect(AI_APPS.map((a) => a.id)).toEqual(["chatgpt", "claude", "gemini"]);
    // No sign-in gate: the page reads no session.
    expect(page).not.toMatch(/authUser|signInRedirect|isAdmin|isDev|readFlags/);
  });

  it("every locale keeps the English placeholders, so Lianki's labels can be filled in", () => {
    for (const [key, node] of Object.entries(g)) {
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
    for (const loc of LOCALES) {
      const out = fillGuide(g.liankiStudy.translation[loc], {
        study: tk.scopeStudy.translation[loc],
      });
      expect(out).toContain(tk.scopeStudy.translation[loc]);
      expect(out).not.toContain("{study}");
    }
    expect(fillGuide("a {x} {y}", { x: 1 })).toBe("a 1 {y}");
  });

  it("links each app's own official page and restates none of its content", () => {
    expect(AI_APPS.map((a) => new URL(a.help).host)).toEqual([
      "help.openai.com",
      "support.claude.com",
      "support.google.com",
    ]);
    // Only Lianki's own facts: the sign-in choice the link needs, and @Lianki.
    expect(AI_APPS.map((a) => a.auth)).toEqual(["No authentication", "No sign in", null]);
    for (const loc of LOCALES) {
      expect(fillGuide(g.enterLink.translation[loc], { auth: "No sign in" })).toContain(
        "No sign in",
      );
      expect(g.callAt.translation[loc]).toContain("@Lianki");
    }
    // No restated menus, plans, countries or languages of the other apps.
    const all = Object.values(g)
      .map((n) => n.translation.en)
      .join("\n");
    for (const word of [
      "Plugins",
      "Customize",
      "Connected Apps",
      "Business",
      "Enterprise",
      "Pro",
      "Free",
      "in the US",
      "only in English",
      "Last checked",
    ])
      expect(all, word).not.toContain(word);
  });

  it("has a feedback link, so wrong steps are reported, not polled for", () => {
    expect(AI_APPS_FEEDBACK_PATH).toBe("/contact");
    expect(isAppRoute(AI_APPS_FEEDBACK_PATH)).toBe(true);
    expect(page).toContain("AI_APPS_FEEDBACK_PATH");
    expect(g.stepsWrong.translation.en).toContain("Tell us");
  });

  it("no token secret or prefix is shown on the page", () => {
    for (const node of Object.values(g))
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
