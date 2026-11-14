import { createAccountUploadLimiter } from "@/lib/inbox/rate";
import type { D1Like } from "@/lib/d1/types";
import { pushChatPort } from "./chat";
import type { MiniBucket, MiniConfig, MiniDeps } from "./handlers";
import type { MiniDb } from "./store";

type Key =
  | "miniApps.maxBytes"
  | "miniApps.storageBytes"
  | "miniApps.perAccount"
  | "miniApps.callsPerMinute"
  | "miniApps.cardWaitMs"
  | "miniApps.origin"
  | "miniApps.scriptOrigins"
  | "miniApps.styleOrigins"
  | "miniApps.fontOrigins"
  | "miniApps.prefKeys";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** Server adapters supplied by the routes: no global auth, DB or config in the rules. */
export function createMiniDeps(source: {
  user: () => Promise<{ id: string; email?: string | null } | null>;
  isDev: (email: string) => boolean;
  on: () => Promise<boolean>;
  db: () => unknown;
  bucket: () => unknown;
  value: (key: Key) => Promise<number | string>;
  push?: () => Fetcher | null;
  revoked?: (ids: string[]) => Promise<void>;
  secret?: () => string | undefined;
}): MiniDeps {
  const num = async (k: Key) => Number(await source.value(k));
  const str = async (k: Key) => String(await source.value(k));
  return {
    who: async () => {
      const u = await source.user();
      return u?.id && u.email ? { id: u.id, email: u.email, dev: source.isDev(u.email) } : null;
    },
    on: source.on,
    db: () => source.db() as MiniDb,
    bucket: () => source.bucket() as MiniBucket,
    config: async (): Promise<MiniConfig> => {
      const [maxBytes, storageBytes, perAccount, callsPerMinute, cardWaitMs] = await Promise.all([
        num("miniApps.maxBytes"),
        num("miniApps.storageBytes"),
        num("miniApps.perAccount"),
        num("miniApps.callsPerMinute"),
        num("miniApps.cardWaitMs"),
      ]);
      const [origin, scripts, styles, fonts, prefKeys] = await Promise.all([
        str("miniApps.origin"),
        str("miniApps.scriptOrigins"),
        str("miniApps.styleOrigins"),
        str("miniApps.fontOrigins"),
        str("miniApps.prefKeys"),
      ]);
      return {
        maxBytes,
        storageBytes,
        perAccount,
        callsPerMinute,
        cardWaitMs,
        origin,
        scripts,
        styles,
        fonts,
        prefKeys,
      };
    },
    chat: () =>
      pushChatPort({
        db: source.db() as D1Like,
        push: source.push?.() ?? null,
        revoked: source.revoked,
      }),
    secret: source.secret,
    allow: createAccountUploadLimiter(),
  };
}
