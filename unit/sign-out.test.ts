import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SIGN_OUT_KEEP_CACHES, SIGN_OUT_PATH, setSignOutSession, signOut } from "@/lib/sign-out";

function env(opts: { fail?: boolean; status?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const cacheNames = ["lianki-v2", "lianki-audio-v1", "lianki-v1"];
  const deleted: string[] = [];
  const replaced: string[] = [];
  return {
    calls,
    deleted,
    replaced,
    e: {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (opts.fail) throw new TypeError("offline");
        return new Response("{}", { status: opts.status ?? 200 });
      },
      caches: {
        keys: async () => cacheNames,
        delete: async (k: string) => {
          deleted.push(k);
          return true;
        },
      },
      replace: (u: string) => {
        replaced.push(u);
      },
    },
  };
}

describe("signOut (the menu's Sign out)", () => {
  it("POSTs better-auth's sign-out, drops the page caches, hard-navigates home", async () => {
    const t = env();
    expect(await signOut("/", t.e)).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe("/api/auth/sign-out");
    expect(t.calls[0].init?.method).toBe("POST");
    expect(t.calls[0].init?.credentials).toBe("same-origin");
    expect(t.deleted.sort()).toEqual(["lianki-v1", "lianki-v2"]);
    expect(t.replaced).toEqual(["/"]);
  });

  it("offline or refused: still clears the caches and leaves the page", async () => {
    for (const t of [env({ fail: true }), env({ status: 403 })]) {
      expect(await signOut("/", t.e)).toBe(false);
      expect(t.deleted).not.toContain("lianki-audio-v1");
      expect(t.replaced).toEqual(["/"]);
    }
  });

  it("in the browser: the page's own fetch, caches and location", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, caches: g.caches, location: g.location };
    const t = env();
    const replaced: string[] = [];
    try {
      g.fetch = t.e.fetch;
      g.caches = t.e.caches;
      g.location = { replace: (u: string) => replaced.push(u) };
      expect(await signOut()).toBe(true);
      expect(t.calls[0].url).toBe(SIGN_OUT_PATH);
      expect(t.deleted.sort()).toEqual(["lianki-v1", "lianki-v2"]);
      expect(replaced).toEqual(["/"]);
      // No Cache Storage (an old browser, a private window): still signs out.
      g.caches = undefined;
      expect(await signOut("/en")).toBe(true);
      expect(replaced).toEqual(["/", "/en"]);
    } finally {
      Object.assign(g, saved);
    }
  });

  it("on a box: the session set by BoxApiBridge ends instead of the cookie POST", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, caches: g.caches, location: g.location };
    const t = env();
    const replaced: string[] = [];
    let ended = 0;
    try {
      g.fetch = t.e.fetch;
      g.caches = t.e.caches;
      g.location = { replace: (u: string) => replaced.push(u) };
      setSignOutSession(async () => {
        ended++;
        return true;
      });
      expect(await signOut()).toBe(true);
      expect(ended).toBe(1);
      expect(t.calls).toEqual([]);
      expect(replaced).toEqual(["/"]);
      // Cleared (the bridge unmounted): back to better-auth's sign-out.
      setSignOutSession(undefined);
      await signOut();
      expect(t.calls[0].url).toBe(SIGN_OUT_PATH);
    } finally {
      setSignOutSession(undefined);
      Object.assign(g, saved);
    }
  });

  it("keeps exactly the caches public/sw.js keeps", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    const keep = /const KEEP_CACHES = (\[[^\]]*\])/.exec(sw)?.[1];
    expect(JSON.parse(keep ?? "null")).toEqual(SIGN_OUT_KEEP_CACHES);
    expect(SIGN_OUT_PATH).toBe("/api/auth/sign-out");
  });

  it("no menu links to a sign-out page any more: both menus call signOut()", () => {
    for (const f of ["app/components/ProfileMenu.tsx", "app/components/Header.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain('href="/auth/logout"');
      expect(src).toContain("signOut()");
    }
  });
});

describe("the user's own AI key at sign-out", () => {
  const forgetting = (opts: { fail?: boolean } = {}) => {
    const t = env(opts);
    const order: string[] = [];
    const e = {
      ...t.e,
      forgetByok: () => order.push("forget"),
      fetch: (u: string, i?: RequestInit) => {
        order.push("post");
        return t.e.fetch(u, i);
      },
    };
    return { e, order };
  };

  it("is forgotten first, before the network", async () => {
    const { e, order } = forgetting();
    await signOut("/", e);
    expect(order).toEqual(["forget", "post"]);
  });

  it("is forgotten when the sign-out request fails too", async () => {
    const { e, order } = forgetting({ fail: true });
    expect(await signOut("/", e)).toBe(false);
    expect(order).toContain("forget");
  });

  it("the default clears lk:byok, and every button goes through signOut", () => {
    expect(readFileSync("lib/sign-out.ts", "utf8")).toContain("forgetByok: () => removeDevice()");
    for (const f of [
      "app/components/ProfileMenu.tsx",
      "app/components/Header.tsx",
      "app/auth/logout/SignOutButton.tsx",
    ])
      expect(readFileSync(f, "utf8")).toContain('import { signOut } from "@/lib/sign-out"');
  });
});
