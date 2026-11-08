import { describe, expect, it } from "bun:test";
import words from "@/app/(app)/words/page.content";
import wordsImportAnkiweb from "@/app/(app)/words/import/ankiweb.content";
import bottomNav from "@/app/components/bottom-nav.content";
import learningPartner from "@/app/components/learning-partner.content";
import devSwitch from "@/app/components/dev-switch.content";
import liveView from "@/app/components/live-view.content";
import reviewPage from "@/app/(app)/review/page.content";
import navHome from "@/app/(app)/home/page.content";
import appShell from "@/app/components/app-shell.content";
import landing from "@/app/[locale]/page.content";
import learn from "@/app/(app)/learn/page.content";
import polyglot from "@/app/(app)/lab/polyglot/page.content";
import selfIntro from "@/app/(app)/self-intro/page.content";
import wordsImport from "@/app/(app)/words/import/page.content";
import wordsPhrases from "@/app/(app)/words/phrases.content";
import wordsVoiceMode from "@/app/(app)/words/voice-mode.content";
import wordsListPreview from "@/app/(app)/words/list-preview.content";
import leaveGuard from "@/app/components/leave-guard.content";
import devPermissions from "@/app/(app)/dev/permissions/permissions.content";
import textSize from "@/app/components/text-size.content";
import boxSignIn from "@/app/(app)/sign-in/box-sign-in.content";
import walletCard from "@/app/(app)/membership/wallet-card.content";
import inviteCard from "@/app/(app)/membership/invite-card.content";
import creditUnits from "@/app/(app)/membership/credit-units.content";
import readEpub from "@/app/(app)/read/read-epub.content";
import readGdoc from "@/app/(app)/read/read-gdoc.content";
import vibePage from "@/app/(app)/vibe/page.content";
import readPolish from "@/app/(app)/read/read-polish.content";
import readPlayer from "@/app/(app)/read/read-player.content";
import readWords from "@/app/(app)/read/read-words.content";
import readReader from "@/app/(app)/read/read-reader.content";
import readSelect from "@/app/(app)/read/read-select.content";
import readGradeHandle from "@/app/(app)/read/read-grade-handle.content";
import cliLogin from "@/app/(app)/cli-login/page.content";
import connectionsPage from "@/app/(app)/connections/page.content";
import readGdocDrive from "@/app/(app)/read/read-gdoc-drive.content";
import drivePick from "@/app/(app)/connections/drive-pick.content";
import readRowMenu from "@/app/(app)/read/read-row-menu.content";
import selfIntroImport from "@/app/(app)/self-intro/import.content";
import booksPage from "@/app/(app)/books/page.content";
import readFormTags from "@/app/(app)/read/read-form-tags.content";
import learnerLevels from "@/app/components/level-badge.content";
import learnerLevelUi from "@/app/components/level-ui.content";
import profileEdit from "@/app/(app)/profile/profile-edit.content";
import byokSettings from "@/app/components/byok-settings.content";
import titleRules from "@/app/components/title-rules.content";
import privacyPage from "@/app/(app)/privacy/privacy.content";
import apiTokens from "@/app/components/api-tokens.content";
import roadmapPage from "@/app/(app)/roadmap/page.content";
import chatHistoryPage from "@/app/(app)/chat/history/page.content";
import devDesign from "@/app/(app)/dev/design/page.content";
import devRoadmap from "@/app/(app)/dev/roadmap/page.content";
import ytSongs from "@/app/components/yt-clip/yt-songs.content";
import { describeKeys, flattenContext, keyContext } from "@/lib/i18n-context";

// Owner rule (2026-10-30): a short string is never translated on its own —
// "Undo", "New swipe" or "Experimental" each read several ways. Every key
// carries context (where it appears, what it is for, how it is used) in the
// dictionary's description, which `intlayer fill` and translating agents read
// together with the source text. docs/i18n.md.

describe("describeKeys / keyContext", () => {
  it("round-trips one line per key, whitespace folded", () => {
    const d = describeKeys("About.", { a: "Button  on\nthe toolbar.", b: "Heading." });
    expect(d.startsWith("About.\n")).toBe(true);
    expect(keyContext(d)).toEqual({ a: "Button on the toolbar.", b: "Heading." });
  });

  it("reads nested context back as group.key lines", () => {
    const flat = flattenContext({ nav: { home: "Sidebar link." }, a: { b: { c: "Deep." } } });
    expect(flat).toEqual({ "nav.home": "Sidebar link.", "a.b.c": "Deep." });
    expect(keyContext(describeKeys("About.", flat))).toEqual(flat);
  });

  it("reads nothing from a description without per-key context", () => {
    expect(keyContext(undefined)).toEqual({});
    expect(keyContext("Just a sentence.")).toEqual({});
  });
});

describe.each([
  ["words-page", words],
  ["words-import-ankiweb", wordsImportAnkiweb],
  ["bottom-nav", bottomNav],
  ["learning-partner", learningPartner],
  ["dev-switch", devSwitch],
  ["live-view", liveView],
  ["review-page", reviewPage],
  ["nav-home", navHome],
  ["app-shell", appShell],
  ["landing-page", landing],
  ["learn-page", learn],
  ["polyglot-page", polyglot],
  ["self-intro-page", selfIntro],
  ["words-import", wordsImport],
  ["words-phrases", wordsPhrases],
  ["words-voice-mode", wordsVoiceMode],
  ["words-list-preview", wordsListPreview],
  ["leave-guard", leaveGuard],
  ["dev-permissions", devPermissions],
  ["text-size", textSize],
  ["box-sign-in", boxSignIn],
  ["wallet-card", walletCard],
  ["invite-card", inviteCard],
  ["credit-units", creditUnits],
  ["read-epub", readEpub],
  ["read-gdoc", readGdoc],
  ["vibe-page", vibePage],
  ["read-polish", readPolish],
  ["read-player", readPlayer],
  ["read-words", readWords],
  ["read-reader", readReader],
  ["read-select", readSelect],
  ["read-grade-handle", readGradeHandle],
  ["cli-login-page", cliLogin],
  ["connections-page", connectionsPage],
  ["read-gdoc-drive", readGdocDrive],
  ["drive-pick", drivePick],
  ["read-row-menu", readRowMenu],
  ["self-intro-import", selfIntroImport],
  ["books-page", booksPage],
  ["read-form-tags", readFormTags],
  ["learner-levels", learnerLevels],
  ["learner-level-ui", learnerLevelUi],
  ["profile-edit", profileEdit],
  ["byok-settings", byokSettings],
  ["title-rules", titleRules],
  ["privacy-page", privacyPage],
  ["api-tokens", apiTokens],
  ["roadmap-page", roadmapPage],
  ["chat-history-page", chatHistoryPage],
  ["dev-design", devDesign],
  ["dev-roadmap", devRoadmap],
  ["yt-songs", ytSongs],
])("%s", (_name, dict) => {
  // Translation leaves, nested groups included, keyed `group.key`.
  type Node = { nodeType?: string; translation?: Record<string, string> };
  const leaves = (node: Record<string, unknown>, prefix = ""): [string, Node][] =>
    Object.entries(node).flatMap(([k, v]) =>
      (v as Node)?.nodeType === "translation"
        ? [[prefix + k, v as Node] as [string, Node]]
        : v && typeof v === "object" && !(v as Node).nodeType
          ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
          : [],
    );
  const byKey = Object.fromEntries(leaves(dict.content as Record<string, unknown>));
  const keys = Object.keys(byKey);
  const context = keyContext(dict.description);
  const en = (k: string) => byKey[k].translation!.en;

  it("gives every key its translation context", () => {
    expect(keys.filter((k) => !context[k])).toEqual([]);
  });

  it("has no context left for a key that is gone", () => {
    expect(Object.keys(context).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("says more than the string itself: where, what for, how (5+ words)", () => {
    const thin = keys.filter((k) => {
      const c = context[k] ?? "";
      return c.split(/\s+/).length < 5 || c.trim() === en(k).trim();
    });
    expect(thin).toEqual([]);
  });
});
