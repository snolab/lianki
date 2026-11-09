import type { Browser, BrowserContext, BrowserType, LaunchOptions } from "playwright";

export declare const MUTE_ARGS: string[];
export declare const FAKE_MIC_ARGS: string[];
export declare const FIREFOX_SILENT_PREFS: Record<string, string | boolean>;
export declare const SILENT_INIT: string;
/** Marks the /words walkthrough seen; skipped when a context passes `lkOnboarding: true`. */
export declare const ONBOARDING_SEEN_INIT: string;
export declare function launchSilent(type: BrowserType, options?: LaunchOptions): Promise<Browser>;
export declare function newSilentContext(
  browser: Browser,
  options?: Parameters<Browser["newContext"]>[0] & { lkOnboarding?: boolean },
): Promise<BrowserContext>;
export declare function launchPersistentSilent(
  type: BrowserType,
  userDataDir: string,
  options?: Parameters<BrowserType["launchPersistentContext"]>[1],
): Promise<BrowserContext>;
