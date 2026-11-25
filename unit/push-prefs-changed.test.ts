import { describe, expect, it } from "bun:test";
import { notifyPrefsChanged, prefsNoticeDeps, URL_PREFS_CHANGED } from "@/lib/push-prefs-changed";

/** lib/push-prefs-changed.ts: an outside settings write nudges the account's pages via lianki-push. */
describe("notifyPrefsChanged", () => {
  it("posts only the user id to the hub, after the response", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const later: Promise<unknown>[] = [];
    notifyPrefsChanged("u1", {
      push: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          return new Response("{}");
        },
      },
      later: (p) => void later.push(p),
    });
    expect(later.length).toBe(1);
    await Promise.all(later);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_PREFS_CHANGED);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ user: "u1" });
  });

  it("does nothing without the binding or a user, and never throws on a failed hub", async () => {
    const later: Promise<unknown>[] = [];
    notifyPrefsChanged("u1", { push: null, later: (p) => void later.push(p) });
    notifyPrefsChanged("", {
      push: { fetch: async () => new Response("") },
      later: (p) => void later.push(p),
    });
    expect(later).toHaveLength(0);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      notifyPrefsChanged("u1", {
        push: { fetch: () => Promise.reject(new Error("down")) },
        later: (p) => void later.push(p),
      });
      notifyPrefsChanged("u1", {
        push: { fetch: async () => new Response("", { status: 500 }) },
        later: (p) => void later.push(p),
      });
      await Promise.all(later);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(2);
  });

  it("off the Worker (no Cloudflare context) it is a no-op", () => {
    expect(() => notifyPrefsChanged("u1")).not.toThrow();
    const none = prefsNoticeDeps(() => {
      throw new Error("no context");
    });
    expect(none.push).toBeNull();
    expect(() => none.later(Promise.resolve())).not.toThrow();
  });

  it("on the Worker: the PUSH binding, and the request's waitUntil", () => {
    const kept: Promise<unknown>[] = [];
    const push = { fetch: async () => new Response("{}") };
    const d = prefsNoticeDeps(() => ({
      env: { PUSH: push },
      ctx: { waitUntil: (p) => void kept.push(p) },
    }));
    expect(d.push).toBe(push);
    d.later(Promise.resolve(1));
    expect(kept).toHaveLength(1);
    expect(prefsNoticeDeps(() => ({ env: {}, ctx: { waitUntil() {} } })).push).toBeNull();
  });
});
