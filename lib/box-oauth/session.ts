/**
 * The box's signed-in view, in the browser (docs/box-oauth.md, "The box's
 * signed-in view"). The box's own server has no session, so the page asks
 * lianki.com who its token belongs to (/api/box/me, through the box's fetch)
 * and the header, the account menu and the pages read that instead.
 */
import { FLAG_KEYS, type FlagValues } from "@/lib/flags";
import { isOwnAvatar } from "@/lib/profile/avatar";
import { BOX_ME_PATH } from "./rules";
import type { BoxMe } from "./me";

export type BoxSessionDeps = {
  /** A usable token in this tab's sessionStorage (client.ts). */
  hasTokens: () => boolean;
  /** Tokens lianki.com refused: forget them. */
  forget: () => void;
  /** The box's fetch (installBoxFetch): same-origin /api goes to lianki.com with the token. */
  fetch: (url: string) => Promise<Response>;
  /** A blob of an uploaded avatar as a URL the page can show; absent, no avatar. */
  objectUrl?: (b: Blob) => string;
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

/**
 * What the tab is signed in as: the account, and production's flags and owner
 * role for it ("Flags on a box"), so the box's pages decide as lianki.com
 * would rather than from the box's own local D1. Read once per page load.
 */
export type BoxAccount = { user: BoxMe; flags: FlagValues; owner: boolean };

/** Only registry keys, only booleans: an unknown or odd value is left out (off). */
export function boxFlagsFrom(raw: unknown): FlagValues {
  const out: FlagValues = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of FLAG_KEYS) if (typeof r[k] === "boolean") out[k] = r[k];
  return out;
}

export type FlagView = { flags: FlagValues | null | undefined; owner: boolean };

/**
 * The flags and owner role a page decides by. `box` is null off a box; on a
 * box signed in through lianki.com, production's answer for the bound account
 * wins over the box server's (its local D1, no session). A box tab not signed
 * in has no account to ask about: the server's answer stands.
 */
export function flagViewOn(box: { account: BoxAccount | null } | null, server: FlagView): FlagView {
  return box?.account ? { flags: box.account.flags, owner: box.account.owner } : server;
}

/** The account this tab is signed in as, or null: no token, refused, or lianki.com unreachable. */
export async function resolveBoxUser(d: BoxSessionDeps): Promise<BoxMe | null> {
  return (await resolveBoxAccount(d))?.user ?? null;
}

/** As resolveBoxUser, with production's flags and the owner role (none: all off, not owner). */
export async function resolveBoxAccount(d: BoxSessionDeps): Promise<BoxAccount | null> {
  if (!d.hasTokens()) return null;
  let res: Response;
  try {
    res = await d.fetch(BOX_ME_PATH);
  } catch {
    return null;
  }
  if (res.status === 401) {
    d.forget();
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    user?: Record<string, unknown>;
    flags?: unknown;
    owner?: unknown;
  } | null;
  const email = text(body?.user?.email, 320);
  if (!email) return null;
  const name = text(body?.user?.name, 200) || email;
  const image = await avatar(text(body?.user?.image, 2048), d);
  return {
    user: { name, email, image },
    flags: boxFlagsFrom(body?.flags),
    owner: body?.owner === true,
  };
}

/**
 * An upload of ours (/api/avatar/…) would load from the box's own server, which
 * has none; fetched through the box's fetch it comes from lianki.com. A
 * provider's picture (an absolute https URL) loads as it is.
 */
async function avatar(image: string | null, d: BoxSessionDeps): Promise<string | null> {
  if (!image) return null;
  if (isOwnAvatar(image)) {
    if (!d.objectUrl) return null;
    try {
      const r = await d.fetch(image);
      return r.ok ? d.objectUrl(await r.blob()) : null;
    } catch {
      return null;
    }
  }
  return image.startsWith("https://") ? image : null;
}
