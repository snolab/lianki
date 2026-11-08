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
 * (Playwright runner suites).
 */
export const SUITES = [
  // First: every suite after it relies on this layer, with nothing on the Mac behind it.
  {
    name: "AUDIO-FREE (qa-audio-free)",
    cmd: "bun",
    args: ["scripts/qa/qa-audio-free.mjs"],
    sensitive: false,
  },
  {
    name: "API  (qa-api)",
    cmd: "bun",
    args: ["scripts/qa/qa-api.mjs"],
    base: true,
    sensitive: false,
  },
  {
    name: "UI   (qa-ui)",
    cmd: "bun",
    args: ["scripts/qa/qa-ui.mjs"],
    base: true,
    sensitive: false,
  },
  // The menu's Sign out on the Worker build, Chromium + WebKit (lib/sign-out.ts).
  {
    name: "SIGN OUT (qa-sign-out)",
    cmd: "bun",
    args: ["scripts/qa/qa-sign-out.mjs"],
    base: true,
    sensitive: false,
  },
  // Serverless: familiarity underlines keep their colours inside the reader's selection (WebKit + Chromium).
  {
    name: "READ SEL UNDERLINES",
    cmd: "bun",
    args: ["scripts/qa/qa-read-sel-underlines.ts"],
    sensitive: false,
  },
  {
    name: "USERSCRIPT (guest)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/userscript-guest.spec.ts"],
    url: true,
    sensitive: false,
  },
  {
    name: "USERSCRIPT (redirect)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/userscript-redirect.spec.ts"],
    url: true,
    sensitive: false,
  },
  {
    name: "WORDS (qa-words)",
    cmd: "bun",
    args: ["scripts/qa/qa-words.mjs"],
    base: true,
    sensitive: true,
  },
  {
    name: "READ EPUB (qa-read-epub)",
    cmd: "bun",
    args: ["scripts/qa/qa-read-epub.mjs"],
    base: true,
    sensitive: true,
  },
  // Serverless: a tap on another word moves the selection, never two drawn (WebKit + Chromium).
  { name: "READ SEL ONE", cmd: "bun", args: ["scripts/qa/qa-read-sel-one.ts"], sensitive: true },
  {
    name: "SYNC (db-sync-matrix)",
    cmd: "bunx",
    args: ["playwright", "test", "tests/db-sync-matrix.spec.ts"],
    url: true,
    sensitive: true,
  },
  // The real /embed/partner in a frame on another origin: ready, ticket, private keys, no owner boots.
  {
    name: "PARTNER FRAME (route)",
    cmd: "bun",
    args: ["scripts/qa/qa-partner-frame-route.ts"],
    base: true,
    sensitive: true,
  },
];
