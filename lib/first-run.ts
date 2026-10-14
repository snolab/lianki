/**
 * The first-run choice: use Lianki locally, or make an account.
 *
 * Signed-out visitors already get a working app — the Local (IndexedDB) store
 * backs list, read and data — but nothing ever said so. A first-time visitor
 * saw an app that looked like it needed an account, with no hint that cloud
 * sync is free when they do make one. So ask once, plainly, and record the
 * answer.
 *
 * The decision is pure and lives here rather than in the component, because
 * "when do we interrupt someone" is the part worth testing: asking twice is
 * annoying, and asking on the sign-in page is absurd.
 */

/** localStorage key holding the recorded answer. */
export const FIRST_RUN_KEY = "lk:first-run";

/** What the visitor chose, or `null` when they have not been asked yet. */
export type FirstRunChoice = "local" | "account";

/**
 * Paths where the prompt must never appear.
 *
 * `sign-in` lives inside the app group, so without this the prompt would offer
 * "sign in or sign up" on top of the sign-in form. The marketing landing page
 * is outside the group and so never reaches this code.
 */
const SUPPRESSED = ["/sign-in", "/sign-up"];

export function isSuppressedPath(pathname: string): boolean {
  // Locale prefixes (/fr/sign-in) and trailing slashes both have to match.
  return SUPPRESSED.some(
    (p) => pathname === p || pathname.endsWith(p) || pathname.includes(`${p}/`),
  );
}

/** `localStorage` value → a choice, ignoring anything we did not write. */
export function parseChoice(raw: string | null | undefined): FirstRunChoice | null {
  return raw === "local" || raw === "account" ? raw : null;
}

export function shouldAsk(input: {
  /** Whether a session exists. A signed-in visitor has already answered. */
  signedIn: boolean;
  pathname: string;
  /** The stored answer; `null` when unset, unreadable, or not ours. */
  stored: FirstRunChoice | null;
  /**
   * False until the component has mounted. Reading `localStorage` during SSR
   * is impossible, so the prompt must not render on the server — it would
   * flash for people who already answered, and mismatch on hydration.
   */
  mounted: boolean;
}): boolean {
  if (!input.mounted) return false;
  if (input.signedIn) return false;
  if (input.stored !== null) return false;
  return !isSuppressedPath(input.pathname);
}
