// Bombadil exploration spec for Lianki (docs/bombadil.md).
//
// Run through scripts/qa/bombadil.ts, never by hand against a shared server:
// the runner starts its own dev server on an empty in-memory MongoDB, a
// throwaway account, and a muted, headless Chromium with the silent-QA init
// script, then points `bombadil browser test-external` at it.
//
// Two runtimes: an `extract(...)` function runs inside the page, on every state
// Bombadil captures, so each one is self-contained (no references to anything
// else in this module). Property thunks and action generators run in
// Bombadil's own runtime and only read the extracted cells.
import { always, next, now, type JSON } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  registerCustomAction,
  weighted,
  type ActionTemplate,
} from "@antithesishq/bombadil/browser";
import {
  clicks,
  forward,
  inputs,
  reload,
  scroll,
} from "@antithesishq/bombadil/browser/defaults/actions";

// Uncaught exceptions, unhandled rejections, console.error: Bombadil's own.
export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

/**
 * Payment flows: the plan page and everything that takes money or a code. The
 * app may route here by itself (a Pro-gated button); once here, the only
 * action is to leave, and nothing on the page is clicked or typed into.
 */
const PAYMENT_PATH =
  /(^|\/)(membership|checkout|payments?|billing|gift-codes|pricing|upgrade)(\/|$|\?)/i;
/** Where a payment surface may never be: a checkout or payment step proper. */
const CHECKOUT_PATH = /(^|\/)(checkout|payments?|billing|gift-codes\/redeem)(\/|$|\?)/i;
/** Clicks that would end the session or the account; they only waste the run. */
const SESSION_ENDERS = /sign ?out|log ?out|delete (my )?account|退出|登出/i;
/** Buttons that start a purchase, whatever page they are on. */
const PAYMENT_LABEL = /\b(upgrade|buy|subscribe|checkout|purchase|pay)\b|购买|订阅|支付/i;

// ── Extractors (run in the page) ────────────────────────────────────────────

const loc = extract((state) => {
  const l = state.window.location;
  return { origin: l.origin, hostname: l.hostname, path: l.pathname + l.search, href: l.href };
});

/**
 * Every 5xx the page has seen: its own navigation and each fetch / script /
 * image. 502 and 504 are left out: they are the app reporting an upstream it
 * could not reach, and in this sandbox every upstream is unreachable on purpose
 * (the runner resolves no host but localhost).
 */
const serverErrors = extract((state) => {
  const out: string[] = [];
  const perf = state.window.performance;
  for (const type of ["navigation", "resource"]) {
    for (const e of perf.getEntriesByType(type)) {
      const status = (e as PerformanceResourceTiming).responseStatus ?? 0;
      if (status >= 500 && status !== 502 && status !== 504) out.push(`${status} ${e.name}`);
    }
  }
  return out;
});

/** The action that led to this state (null for the first). */
const lastAction = extract((state) => state.lastAction as JSON);

/** Anything of a payment provider loaded into the page (scripts, frames, forms). */
const paymentSurface = extract((state) => {
  const d = state.document;
  const hits: string[] = [];
  for (const el of d.querySelectorAll("script[src],iframe[src],form[action]")) {
    const src = el.getAttribute("src") ?? el.getAttribute("action") ?? "";
    if (/stripe\.com|paypal\.com|checkout\.|lemonsqueezy|paddle\.com/i.test(src)) hits.push(src);
  }
  return hits;
});

/** Same-origin back entry, so "Back" never leaves the app (the first entry is about:blank). */
const canGoBackInApp = extract((state) => {
  const prev = state.navigationHistory.back.at(-1);
  if (!prev) return false;
  return prev.url.startsWith(state.window.location.origin + "/");
});

/**
 * What /words makes observable: the progress rings, the rendered slips, their
 * grade stamps, and which terms this page has seen graded. "Seen graded" is
 * remembered on the window, so it lasts as long as the page does (a reload or a
 * navigation starts a new session, as it does for the learner).
 */
const words = extract((state) => {
  const d = state.document;
  const w = state.window as Window & {
    __lkBombadil?: { list: string; graded: Record<string, number> };
  };
  const onWords = state.window.location.pathname
    .replace(/^\/[a-z]{2}(-[A-Za-z]+)?(?=\/)/, "")
    .startsWith("/words");
  const progress = [...d.querySelectorAll("[data-progress]")].map((el) =>
    Number(el.getAttribute("data-progress")),
  );
  const list = d.querySelector('[role="list"]');
  const rows = list ? [...list.querySelectorAll('[role="listitem"][data-i]')] : [];
  const indices = rows.map((r) => Number(r.getAttribute("data-i")));
  const multiStamp: number[] = [];
  const newAfterGraded: string[] = [];
  // One session = one list on one page load; another list or leaving /words starts over.
  const listId = new URLSearchParams(state.window.location.search).get("list") ?? "";
  if (!onWords || w.__lkBombadil?.list !== listId) delete w.__lkBombadil;
  const mem = (w.__lkBombadil ??= { list: listId, graded: {} });
  for (const r of rows) {
    const i = Number(r.getAttribute("data-i"));
    const stamps = r.querySelectorAll(".lk-stamp").length;
    if (stamps > 1) multiStamp.push(i);
    const termEl = r.querySelector(".slip-term");
    const term = termEl?.getAttribute("title") ?? termEl?.textContent?.trim() ?? "";
    if (!term) continue;
    const isNew = !!termEl && /\btext-blue-600\b/.test(termEl.className);
    const at = mem.graded[term];
    if (stamps > 0 && at === undefined) mem.graded[term] = i;
    else if (stamps === 0 && isNew && at !== undefined && at !== i)
      newAfterGraded.push(`${term}: graded at #${at}, new again at #${i}`);
  }
  return { onWords, progress, indices, multiStamp, newAfterGraded };
});

// ── Properties ──────────────────────────────────────────────────────────────

/** No 5xx from the app: page loads, API calls, assets. 4xx are left to the app. */
export const noServerErrors = always(() => serverErrors.current.length === 0);

/** Never off the loopback host, and never off the origin the run started on. */
export const staysOnLocalhost = now(() => {
  const start = loc.current.origin;
  return always(
    () =>
      loc.current.href === "about:blank" ||
      ((loc.current.hostname === "localhost" || loc.current.hostname === "127.0.0.1") &&
        loc.current.origin === start),
  );
});

/** No payment provider loaded on any page, and never on a checkout or payment step. */
export const neverInPaymentFlow = always(
  () => !CHECKOUT_PATH.test(loc.current.path) && paymentSurface.current.length === 0,
);

/** On a payment page (the plan page included) the next thing done is leaving it. */
export const leavesPaymentPagesAtOnce = always(
  now(() => PAYMENT_PATH.test(loc.current.path)).implies(
    next(() => lastAction.current === "Back" || isLeave(lastAction.current)),
  ),
);

/** /words: every progress ring is a whole percentage, 0–100. */
export const wordsProgressInRange = always(() =>
  words.current.progress.every((p) => Number.isInteger(p) && p >= 0 && p <= 100),
);

/** /words: the rendered slips are distinct rows (no index twice, none negative). */
export const wordsRowsDistinct = always(() => {
  const ix = words.current.indices;
  return ix.every((i) => Number.isInteger(i) && i >= 0) && new Set(ix).size === ix.length;
});

/** /words: a slip carries at most one grade stamp. */
export const wordsOneGradePerSlip = always(() => words.current.multiStamp.length === 0);

/** /words: a word graded in this session does not come back as a new word in another row. */
export const wordsGradedNotNewAgain = always(() => words.current.newAfterGraded.length === 0);

// ── Actions: only inside the app's origin ───────────────────────────────────

/** Whether a link's href stays on this origin and out of payment paths. */
function hrefAllowed(href: string | null): boolean {
  if (!href) return true;
  const origin = loc.current.origin;
  if (/^(mailto|tel|sms|javascript|data|blob):/i.test(href)) return false;
  let path = href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    const abs = href.startsWith("//") ? `${origin.split(":")[0]}:${href}` : href;
    if (abs !== origin && !abs.startsWith(origin + "/")) return false;
    path = abs.slice(origin.length) || "/";
  }
  return !PAYMENT_PATH.test(path);
}

function clickAllowed(a: ActionTemplate): boolean {
  if (typeof a !== "object" || !("Click" in a)) return true;
  const f = (
    a as {
      Click: {
        fingerprint: {
          href: string | null;
          accessibleName: string | null;
          textContent: string | null;
        };
      };
    }
  ).Click.fingerprint;
  if (!hrefAllowed(f.href)) return false;
  const label = `${f.accessibleName ?? ""} ${f.textContent ?? ""}`;
  return !SESSION_ENDERS.test(label) && !PAYMENT_LABEL.test(label);
}

const back = actions(() => (canGoBackInApp.current ? ["Back"] : []));

/** Out of a payment page with no in-app history to go back to: straight to /words. */
const leave = registerCustomAction("leavePaymentPage", async (_document, window) => {
  window.location.assign("/words");
});
function isLeave(a: JSON): boolean {
  return (
    typeof a === "object" &&
    a !== null &&
    !Array.isArray(a) &&
    "Custom" in a &&
    (a as { Custom: { name: string } }).Custom.name === "leavePaymentPage"
  );
}
/**
 * Back to the study list from anywhere else: /words with no ?list= reopens the
 * list this tab had open (docs/ui-state.md), so the /words invariants get slips
 * to look at however far the clicks wandered.
 */
const toWords = registerCustomAction("backToWords", async (_document, window) => {
  window.location.assign("/words");
});
const backToWords = actions(() => (words.current.onWords ? [] : [toWords()]));
const onPaymentPage = () => PAYMENT_PATH.test(loc.current.path);
const leavePayment = actions(() =>
  onPaymentPage() ? (canGoBackInApp.current ? ["Back"] : [leave()]) : [],
);

/** /words grading keys, while slips are on screen: 1–4, arrows, space, Z (undo). */
const wordsKeys = actions(() => {
  if (!words.current.onWords || words.current.indices.length === 0) return [];
  return [49, 50, 51, 52, 38, 40, 32, 90].map((code) => ({ PressKey: { code } }));
});

const inApp = () => !onPaymentPage();
export const exploreActions = weighted([
  [100, clicks.filter(clickAllowed).when(inApp)],
  [40, inputs.when(inApp)],
  [30, scroll.when(inApp)],
  [150, wordsKeys.when(inApp)],
  [10, backToWords.when(inApp)],
  [8, back.when(inApp)],
  [2, forward.when(inApp)],
  [2, reload.when(inApp)],
  [1000, leavePayment],
]);
