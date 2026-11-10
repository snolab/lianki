import { describe, expect, it } from "bun:test";
import words from "@/app/(app)/words/page.content";
import wordsImportAnkiweb from "@/app/(app)/words/import/ankiweb.content";
import importWordlist from "@/app/(app)/import/wordlist-import.content";
import importPage from "@/app/(app)/import/page.content";
import importSections from "@/app/(app)/import/import-sections.content";
import wordsImportPanel from "@/app/(app)/words/import-panel.content";
import myFiles from "@/app/(app)/my/files/my-files.content";
import bottomNav from "@/app/components/bottom-nav.content";
import learningPartner from "@/app/components/learning-partner.content";
import devSwitch from "@/app/components/dev-switch.content";
import liveView from "@/app/components/live-view.content";
import reviewPage from "@/app/(app)/review/page.content";
import navHome from "@/app/(app)/home/page.content";
import appShell from "@/app/components/app-shell.content";
import myPage from "@/app/(app)/my/page.content";
import landing from "@/app/[locale]/page.content";
import learn from "@/app/(app)/learn/page.content";
import polyglot from "@/app/(app)/lab/polyglot/page.content";
import selfIntro from "@/app/(app)/self-intro/page.content";
import wordsImport from "@/app/(app)/words/import/page.content";
import wordsPhrases from "@/app/(app)/words/phrases.content";
import wordsVoiceMode from "@/app/(app)/words/voice-mode.content";
import wordsListPreview from "@/app/(app)/words/list-preview.content";
import wordsStatus from "@/app/(app)/words/words-status.content";
import leaveGuard from "@/app/components/leave-guard.content";
import creditsUsage from "@/app/(app)/membership/credits/credits-usage.content";
import devPermissions from "@/app/(app)/dev/permissions/permissions.content";
import devTemplates from "@/app/(app)/dev/templates/templates.content";
import devMails from "@/app/(app)/dev/mails/mails.content";
import devUsers from "@/app/(app)/dev/users/users.content";
import devPregrant from "@/app/(app)/dev/users/pregrant.content";
import textSize from "@/app/components/text-size.content";
import boxSignIn from "@/app/(app)/sign-in/box-sign-in.content";
import blogPage from "@/app/[locale]/blog/page.content";
import walletCard from "@/app/(app)/membership/wallet-card.content";
import inviteCard from "@/app/(app)/membership/invite-card.content";
import emailInvite from "@/app/(app)/membership/email-invite.content";
import inviteMail from "@/lib/referrals/invite-mail.content";
import mailSignIn from "@/lib/mail-templates/sign-in-mail.content";
import mailLoginNotice from "@/lib/mail-templates/login-notice-mail.content";
import mailEmailChange from "@/lib/mail-templates/email-change-mail.content";
import creditUnits from "@/app/(app)/membership/credit-units.content";
import readEpub from "@/app/(app)/reader/read-epub.content";
import readGdoc from "@/app/(app)/reader/read-gdoc.content";
import vibePage from "@/app/(app)/vibe/page.content";
import readPolish from "@/app/(app)/reader/read-polish.content";
import readPlayer from "@/app/(app)/reader/read-player.content";
import readWords from "@/app/(app)/reader/read-words.content";
import readReader from "@/app/(app)/reader/read-reader.content";
import readSelect from "@/app/(app)/reader/read-select.content";
import readGradeHandle from "@/app/(app)/reader/read-grade-handle.content";
import cliLogin from "@/app/(app)/cli-login/page.content";
import connectionsPage from "@/app/(app)/connections/page.content";
import readGdocDrive from "@/app/(app)/reader/read-gdoc-drive.content";
import drivePick from "@/app/(app)/connections/drive-pick.content";
import readRowMenu from "@/app/(app)/reader/read-row-menu.content";
import readList from "@/app/(app)/reader/read-list.content";
import selfIntroImport from "@/app/(app)/self-intro/import.content";
import booksPage from "@/app/(app)/library/page.content";
import myBooks from "@/app/(app)/books/my-books.content";
import readFormTags from "@/app/(app)/reader/read-form-tags.content";
import learnerLevels from "@/app/components/level-badge.content";
import learnerLevelUi from "@/app/components/level-ui.content";
import profileEdit from "@/app/(app)/my/profile/profile-edit.content";
import profileSession from "@/app/(app)/my/profile/session-basics.content";
import preferencesPage from "@/app/(app)/my/preferences/page.content";
import byokSettings from "@/app/components/byok-settings.content";
import titleRules from "@/app/components/title-rules.content";
import externalLink from "@/app/components/external-link.content";
import virtualList from "@/app/components/virtual-list.content";
import dontAsk from "@/app/components/dont-ask.content";
import appBadge from "@/app/components/app-badge.content";
import languageSettings from "@/app/components/language-settings.content";
import preferredLangs from "@/app/components/preferred-langs.content";
import privacyPage from "@/app/(app)/privacy/privacy.content";
import apiTokens from "@/app/components/api-tokens.content";
import agentGuide from "@/lib/agent-guide.content";
import roadmapPage from "@/app/(app)/roadmap/page.content";
import chatHistoryPage from "@/app/(app)/chat/history/page.content";
import devDesign from "@/app/(app)/dev/design/page.content";
import devRoadmap from "@/app/(app)/dev/roadmap/page.content";
import devPages from "@/app/(app)/dev/dev-pages.content";
import ytSongs from "@/app/components/yt-clip/yt-songs.content";
import pillChat from "@/app/components/pill-chat.content";
import signInErrors from "@/app/(app)/sign-in/errors.content";
import activityTally from "@/app/(app)/list/components/activity-tally.content";
import devFlagToast from "@/app/(app)/dev/flags/flag-toast.content";
import devConfig from "@/app/(app)/dev/config/config-admin.content";
import statsPage from "@/app/(app)/stats/page.content";
import membershipPage from "@/app/(app)/membership/membership-page.content";
import sitesPage from "@/app/(app)/sites/page.content";
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
  ["import-wordlist", importWordlist],
  ["import-page", importPage],
  ["import-sections", importSections],
  ["words-import-panel", wordsImportPanel],
  ["bottom-nav", bottomNav],
  ["learning-partner", learningPartner],
  ["dev-switch", devSwitch],
  ["live-view", liveView],
  ["review-page", reviewPage],
  ["nav-home", navHome],
  ["app-shell", appShell],
  ["my-page", myPage],
  ["landing-page", landing],
  ["learn-page", learn],
  ["blog-page", blogPage],
  ["polyglot-page", polyglot],
  ["self-intro-page", selfIntro],
  ["words-import", wordsImport],
  ["words-phrases", wordsPhrases],
  ["words-voice-mode", wordsVoiceMode],
  ["words-list-preview", wordsListPreview],
  ["words-status", wordsStatus],
  ["leave-guard", leaveGuard],
  ["dev-permissions", devPermissions],
  ["dev-templates", devTemplates],
  ["dev-mails", devMails],
  ["dev-users", devUsers],
  ["dev-pregrant", devPregrant],
  ["text-size", textSize],
  ["box-sign-in", boxSignIn],
  ["wallet-card", walletCard],
  ["credits-usage", creditsUsage],
  ["invite-card", inviteCard],
  ["email-invite", emailInvite],
  ["invite-mail", inviteMail],
  ["mail-sign-in", mailSignIn],
  ["mail-login-notice", mailLoginNotice],
  ["mail-email-change", mailEmailChange],
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
  ["read-list", readList],
  ["self-intro-import", selfIntroImport],
  ["books-page", booksPage],
  ["my-books", myBooks],
  ["read-form-tags", readFormTags],
  ["learner-levels", learnerLevels],
  ["learner-level-ui", learnerLevelUi],
  ["profile-edit", profileEdit],
  ["profile-session", profileSession],
  ["byok-settings", byokSettings],
  ["title-rules", titleRules],
  ["external-link", externalLink],
  ["virtual-list", virtualList],
  ["dont-ask", dontAsk],
  ["app-badge", appBadge],
  ["language-settings", languageSettings],
  ["preferred-langs", preferredLangs],
  ["sign-in-errors", signInErrors],
  ["privacy-page", privacyPage],
  ["api-tokens", apiTokens],
  ["agent-guide", agentGuide],
  ["roadmap-page", roadmapPage],
  ["chat-history-page", chatHistoryPage],
  ["dev-design", devDesign],
  ["dev-roadmap", devRoadmap],
  ["dev-pages", devPages],
  ["yt-songs", ytSongs],
  ["pill-chat", pillChat],
  ["my-files", myFiles],
  ["activity-tally", activityTally],
  ["dev-flag-toast", devFlagToast],
  ["dev-config", devConfig],
  ["stats-page", statsPage],
  ["membership-page", membershipPage],
  ["home-page", sitesPage],
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

// preferences-page adopts the pattern key by key ("Only recent keys have a line
// so far"), so it is not in the full list above; its newer keys are held here.
describe("preferences-page: keys that already carry context", () => {
  const context = keyContext(preferencesPage.description);
  it.each(["paperHeading", "resetSection"])("%s has a line of 5+ words", (k) => {
    expect((context[k] ?? "").split(/\s+/).length).toBeGreaterThanOrEqual(5);
  });
  it("the Paper heading is a translated key, not the old hardcoded '紙紋 Paper'", () => {
    const tr = (
      preferencesPage.content as unknown as {
        paperHeading: { translation: Record<string, string> };
      }
    ).paperHeading.translation;
    expect(Object.keys(tr)).toHaveLength(16);
    expect(Object.values(tr)).not.toContain("紙紋 Paper");
  });
});
