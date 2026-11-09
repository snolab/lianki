/**
 * The qa:all suites, in order, each tagged by whether its checks depend on
 * timing (docs/shipping.md, "Admission by load"). This list is the one place the
 * tags live.
 *
 * - `sensitive: false` runs straight away, beside anything else on the machine.
 * - `sensitive: true` waits for load-based admission to the machine-wide gate
 *   (scripts/dev/machine-lock-lib.ts). These are the suites that failed under load
 *   in the push logs of 2026-11-04..08: READ EPUB (waitFor timeouts), WORDS (a
 *   networkidle goto hit its timeout), READ SEL ONE (a double tap must land within
 *   350 ms), SYNC and PARTNER FRAME.
 *
 * `base: true` passes the Worker's URL as QA_BASE; `url: true` as LIANKI_URL
 * (Playwright runner suites). A suite with neither needs no Worker: when only
 * such suites are selected, qa:all skips the OpenNext build and wrangler dev.
 *
 * `id` names the suite for `qa-all.mjs --suites=<id>,…`. `paths` (globs) say
 * which files the suite covers, for the pre-push gate's affected-only run
 * (scripts/gate/affected.ts, docs/shipping.md "Only what changed"): a suite
 * runs when a file the change reaches through the import graph matches one of
 * them, or when its own entry file (or anything it imports) changed. Map route
 * trees, not libraries: a change to lib/words/x.ts reaches app/(app)/words/**
 * through the graph by itself.
 */
const SHELL = [
  "app/layout.tsx",
  "app/(app)/layout.tsx",
  "app/[locale]/layout.tsx",
  "app/components/**",
  "app/globals.css",
];
const AUTH = ["app/api/auth/**", "app/auth/**", "app/(app)/sign-in/**", "lib/auth-*.ts"];
const USERSCRIPT = ["src/**", "lianki.user.js", "public/lianki.user.js", "packages/core/**"];
const READ = ["app/(app)/reader/**", "app/api/read/**", "lib/read/**", "lib/epub/**"];
// affected-gate: imports-only — the args below are run, not loaded here
// (scripts/gate/affected-lib.ts; each suite's entry is matched on its own).
export const SUITES = [
  // First: every suite after it relies on this layer, with nothing on the Mac behind it.
  {
    name: "AUDIO-FREE (qa-audio-free)",
    cmd: "bun",
    args: ["scripts/qa/qa-audio-free.mjs"],
    id: "audio-free",
    paths: ["scripts/qa/silent.mjs"],
    sensitive: false,
  },
  {
    name: "API  (qa-api)",
    cmd: "bun",
    args: ["scripts/qa/qa-api.mjs"],
    base: true,
    id: "api",
    paths: ["app/api/**", "app/*.ts"],
    sensitive: false,
  },
  {
    name: "UI   (qa-ui)",
    cmd: "bun",
    args: ["scripts/qa/qa-ui.mjs"],
    base: true,
    id: "ui",
    paths: [
      ...SHELL,
      ...AUTH,
      "app/[locale]/**",
      "app/(app)/{home,list,roadmap,profile,preferences,dev/roadmap}/**",
      "app/api/{roadmap,preferences,prefs,profile}/**",
    ],
    sensitive: false,
  },
  // The menu's Sign out on the Worker build, Chromium + WebKit (lib/sign-out.ts).
  {
    name: "SIGN OUT (qa-sign-out)",
    cmd: "bun",
    args: ["scripts/qa/qa-sign-out.mjs"],
    base: true,
    id: "sign-out",
    paths: [...SHELL, ...AUTH, "app/(app)/profile/**", "lib/sign-out.ts"],
    sensitive: false,
  },
  // The account's UI language on the first response of a new device; ?lang= still wins (lib/account-locale.ts).
  {
    name: "ACCOUNT LOCALE (qa-account-locale)",
    cmd: "bun",
    args: ["scripts/qa/qa-account-locale.mjs"],
    base: true,
    id: "account-locale",
    paths: [
      "app/layout.tsx",
      "app/(app)/layout.tsx",
      "app/components/LanguageSwitcher.tsx",
      "app/components/LanguageSettings.tsx",
      "app/components/AccountLocaleAdopt.tsx",
      "app/components/language-settings.content.ts",
      "middleware.ts",
      "lib/account-locale*.ts",
      "lib/app-locale*.ts",
      "app/(app)/preferences/**",
    ],
    sensitive: false,
  },
  // The disclaimer before another website: asks, Cancel, both bypasses, own hosts (docs/external-links.md).
  {
    name: "EXTERNAL LINKS (qa-external-link)",
    cmd: "bun",
    args: ["scripts/qa/qa-external-link.mjs"],
    base: true,
    id: "external-link",
    paths: [
      "app/layout.tsx",
      "app/components/ExternalLink*.tsx",
      "app/components/external-link.content.ts",
      "lib/external-link.ts",
      "packages/core/src/externalLink.ts",
    ],
    sensitive: false,
  },
  // Serverless: familiarity underlines keep their colours inside the reader's selection (WebKit + Chromium).
  {
    name: "READ SEL UNDERLINES",
    cmd: "bun",
    args: ["scripts/qa/qa-read-sel-underlines.ts"],
    id: "read-sel-underlines",
    // Serverless: only what its entry imports or reads (globals.css, select-mark).
    paths: [],
    sensitive: false,
  },
  {
    name: "USERSCRIPT (guest)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/userscript-guest.spec.ts"],
    url: true,
    id: "userscript-guest",
    paths: USERSCRIPT,
    sensitive: false,
  },
  {
    name: "USERSCRIPT (redirect)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/userscript-redirect.spec.ts"],
    url: true,
    id: "userscript-redirect",
    paths: [...USERSCRIPT, "lib/normalizeUrl.ts"],
    sensitive: false,
  },
  {
    name: "WORDS (qa-words)",
    cmd: "bun",
    args: ["scripts/qa/qa-words.mjs"],
    base: true,
    id: "words",
    paths: ["app/(app)/words/**", "app/(app)/alphabet/**", "app/api/words/**", "lib/words/**"],
    sensitive: true,
  },
  {
    name: "READ EPUB (qa-read-epub)",
    cmd: "bun",
    args: ["scripts/qa/qa-read-epub.mjs"],
    base: true,
    id: "read-epub",
    paths: READ,
    sensitive: true,
  },
  // Import a word list on /import (docs/import-material.md, M1): flag gate, preview counts, a /words list.
  {
    name: "IMPORT WORDLIST (qa-import-wordlist)",
    cmd: "bun",
    args: ["scripts/qa/qa-import-wordlist.mjs"],
    base: true,
    id: "import-wordlist",
    paths: [
      "app/(app)/import/**",
      "app/api/import/words/**",
      "app/api/import/jobs/**",
      "lib/import/**",
    ],
    sensitive: false,
  },
  // The app-icon badge (docs/app-badge.md): flag gate, counts, the setting persists, setAppBadge mocked.
  {
    name: "APP BADGE (qa-app-badge)",
    cmd: "bun",
    args: ["scripts/qa/qa-app-badge.mjs"],
    base: true,
    id: "app-badge",
    paths: [
      "app/components/AppBadge*.tsx",
      "app/components/app-badge.content.ts",
      "app/api/badge/**",
      "lib/app-badge*.ts",
      "public/sw.js",
    ],
    sensitive: false,
  },
  // Invite by email on /membership (docs/payments.md, "Invite by email"): gate, one address, neutral answer, stubbed send.
  {
    name: "EMAIL INVITE (qa-email-invite)",
    cmd: "bun",
    args: ["scripts/qa/qa-email-invite.mjs"],
    base: true,
    id: "email-invite",
    paths: [
      "app/(app)/membership/**",
      "app/api/invite/email/**",
      "lib/referrals/**",
      "lib/signup-locale*.ts",
    ],
    sensitive: false,
  },
  // Pre-grants on /dev/users (docs/payments.md, "Pre-grants"): preview → apply → pending row → revoke; the verified-only claim.
  {
    name: "PRE-GRANTS (qa-pregrant)",
    cmd: "bun",
    args: ["scripts/qa/qa-pregrant.mjs"],
    base: true,
    id: "pregrant",
    paths: [
      "app/(app)/dev/users/**",
      "app/api/dev/pregrants/**",
      "lib/referrals/pregrant.ts",
      "auth-impl.ts",
    ],
    sensitive: false,
  },
  // The mail template editor (docs/mail-templates.md): edit → live preview → save → test send (stub) → diff → rollback; desktop + phone, light + dark.
  {
    name: "MAIL TEMPLATES (qa-templates)",
    cmd: "bun",
    args: ["scripts/qa/qa-templates.mjs"],
    base: true,
    id: "templates",
    paths: ["app/(app)/dev/templates/**", "app/api/dev/templates/**", "lib/mail-templates/**"],
    sensitive: false,
  },
  // The send log at /dev/mails (docs/mail-templates.md, "Send log"): search, filter, re-render, Resend (stub), Suppress, suppression list; 360 px light + dark.
  {
    name: "MAIL LOG (qa-mails)",
    cmd: "bun",
    args: ["scripts/qa/qa-mails.mjs"],
    base: true,
    id: "mails",
    paths: [
      "app/(app)/dev/mails/**",
      "app/api/dev/mails/**",
      "lib/mail-log/**",
      "lib/mail-templates/**",
      "lib/resend-webhook.ts",
      "db/migrations/0065_mail_log.sql",
    ],
    sensitive: false,
  },
  // The marble plan cards on /membership: marble by default, 360 px, measured text contrast over the stone.
  {
    name: "MEMBERSHIP MARBLE (qa-membership-marble)",
    cmd: "bun",
    args: ["scripts/qa/qa-membership-marble.mjs"],
    base: true,
    id: "membership-marble",
    paths: ["app/(app)/membership/**", "public/membership/**", "lib/plan-skin.ts"],
    sensitive: false,
  },
  // The credits usage page: one tap from the wallet card and the account menu, empty state, filters, CSV, AA, 360 px.
  {
    name: "CREDITS USAGE (qa-credits-usage)",
    cmd: "bun",
    args: ["scripts/qa/qa-credits-usage.mjs"],
    base: true,
    id: "credits-usage",
    paths: [
      "app/(app)/membership/**",
      "app/api/payments/credits/**",
      "lib/payments/credit-usage*.ts",
      "app/components/ProfileMenu.tsx",
    ],
    sensitive: false,
  },
  // YouTube songs (docs/youtube-song-examples.md): flag gate, the ▶ per line, the popup's close rules.
  // Every YouTube host blocked: no video, no sound, no network.
  {
    name: "YT SONGS (qa-yt-songs)",
    cmd: "bun",
    args: ["scripts/qa/qa-yt-songs.mjs"],
    base: true,
    id: "yt-songs",
    paths: [
      "app/(app)/reader/youtube/**",
      "app/api/read/youtube/**",
      "app/components/yt-clip/**",
      "lib/yt-songs/**",
      "lib/read/book-word-list.ts",
      "lib/repos/wordEntriesD1.ts",
    ],
    sensitive: false,
  },
  // Serverless: a tap on another word moves the selection, never two drawn (WebKit + Chromium).
  {
    name: "READ SEL ONE",
    id: "read-sel-one",
    paths: [], // serverless: its entry's own imports (use-reader-select, reader-select)
    cmd: "bun",
    args: ["scripts/qa/qa-read-sel-one.ts"],
    sensitive: true,
  },
  // Serverless: "New version · Refresh" only when the current page's code changed.
  {
    name: "SMART REFRESH",
    id: "smart-refresh",
    paths: [], // serverless: its entry's own imports (VersionNotice, lib/smart-refresh, the hub)
    cmd: "bun",
    args: ["scripts/qa/qa-smart-refresh.ts"],
    sensitive: false,
  },
  {
    name: "SYNC (db-sync-matrix)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/db-sync-matrix.spec.ts"],
    url: true,
    id: "sync",
    paths: [...USERSCRIPT, "app/api/fsrs/**", "app/(app)/list/**", "app/[locale]/**"],
    sensitive: true,
  },
  // The real /embed/partner in a frame on another origin: ready, ticket, private keys, no owner boots.
  {
    name: "PARTNER FRAME (route)",
    cmd: "bun",
    args: ["scripts/qa/qa-partner-frame-route.ts"],
    base: true,
    id: "partner-frame",
    paths: [
      "app/embed/**",
      "src/partner*.ts",
      "packages/debug-chat/**",
      "lib/partner-*.ts",
      "app/api/chat/**",
    ],
    sensitive: true,
  },
  // Li chat from the userscript pill on a hostile page: default deny, trusted clicks only,
  // the frame unreachable, a navigated frame torn down (docs/userscript-li-chat.md). No Worker.
  {
    name: "PILL CHAT (hostile page)",
    cmd: "bun",
    args: ["scripts/qa/qa-pill-chat.ts"],
    id: "pill-chat",
    paths: ["src/pill-chat*.ts", "src/partner*.ts", "packages/debug-chat/src/embed/**"],
    sensitive: true,
  },
];
