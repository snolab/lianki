import type { Browser, BrowserContext, BrowserType, LaunchOptions } from "playwright";

export declare const MUTE_ARGS: string[];
export declare const SILENT_INIT: string;
export declare function launchSilent(type: BrowserType, options?: LaunchOptions): Promise<Browser>;
export declare function newSilentContext(
  browser: Browser,
  options?: Parameters<Browser["newContext"]>[0],
): Promise<BrowserContext>;
export declare function launchPersistentSilent(
  type: BrowserType,
  userDataDir: string,
  options?: Parameters<BrowserType["launchPersistentContext"]>[1],
): Promise<BrowserContext>;
