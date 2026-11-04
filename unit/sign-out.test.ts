import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SIGN_OUT_KEEP_CACHES, SIGN_OUT_PATH, signOut } from "@/lib/sign-out";

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

  it("keeps exactly the caches public/sw.js keeps", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    const keep = /const KEEP_CACHES = (\[[^\]]*\])/.exec(sw)?.[1];
    expect(JSON.parse(keep ?? "null")).toEqual(SIGN_OUT_KEEP_CACHES);
    expect(SIGN_OUT_PATH).toBe("/api/auth/sign-out");
  });

  it("no menu links to a sign-out page any more: both menus call signOut()", () => {
    for (const f of ["app/components/AppShell.tsx", "app/components/Header.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain('href="/auth/logout"');
      expect(src).toContain("signOut()");
    }
  });
});
