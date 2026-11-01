/**
 * The owner's dev-server switch in the account menu (lib/dev-server-switch.ts):
 * decided on the server for the owner only, one check when the menu opens and
 * no polling, the single-use handoff posted in a form body, and the way back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEV_SERVER_ORIGIN,
  backUrl,
  devServerUp,
  devSwitchMode,
  postToDevServer,
  switchToDevServer,
} from "../lib/dev-server-switch";
import { devSwitchFor } from "../lib/dev-server-switch.server";

const OWNERS = { OWNER_EMAILS: "owner@example.com" };
const labels = () => ({ open: "o", off: "f", checking: "c", back: "b", badge: "g" });

describe("who gets it (server side)", () => {
  test("guests and other users: nothing at all, not even the strings", () => {
    expect(devSwitchFor(null, labels, OWNERS)).toBeUndefined();
    expect(devSwitchFor("friend@example.com", labels, OWNERS)).toBeUndefined();
    expect(devSwitchFor("owner@example.com", labels, { OWNER_EMAILS: "" })).toBeUndefined();
    let asked = 0;
    devSwitchFor("friend@example.com", () => (asked++, labels()), OWNERS);
    expect(asked).toBe(0); // the strings are never even looked up for them
  });

  test("the owner on lianki.com: go; on the dev server: back", () => {
    expect(devSwitchFor("Owner@Example.com", labels, OWNERS)).toEqual({
      mode: "go",
      labels: labels(),
    });
    const dev = { ...OWNERS, LIANKI_DEV_WHOLE_PAGE: "1", NODE_ENV: "development" };
    expect(devSwitchFor("owner@example.com", labels, dev)?.mode).toBe("back");
    expect(devSwitchMode({ owner: false, devServer: true })).toBeNull();
  });

  test("the layout passes it from the server, the shell never decides it", () => {
    const layout = readFileSync(new URL("../app/(app)/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/devSwitch=\{devSwitchFor\(\s*user\?\.email,/);
    const shell = readFileSync(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).not.toMatch(/isOwner|OWNER_EMAILS/);
  });
});

describe("up or down: one check, no polling", () => {
  test("one fetch to the gate's /_lk/up, credentials omitted, with a timeout", async () => {
    const calls: [string, RequestInit][] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return new Response("gate up", { status: 503, headers: { "x-lianki-gate": "1" } });
    }) as unknown as typeof fetch;
    expect(await devServerUp(f)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${DEV_SERVER_ORIGIN}/_lk/up`);
    expect(calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(calls[0][1].signal).toBeDefined();
  });

  test("Cloudflare's own error (tunnel down), or no answer: down", async () => {
    const cf530 = (async () => new Response("1033", { status: 530 })) as unknown as typeof fetch;
    const dead = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await devServerUp(cf530)).toBe(false);
    expect(await devServerUp(dead)).toBe(false);
  });

  test("nothing in the switch sets a timer or an interval", () => {
    for (const f of ["../lib/dev-server-switch.ts", "../app/components/DevSwitchItem.tsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect({ f, timers: /setInterval|setTimeout|requestAnimationFrame/.test(src) }).toEqual({
        f,
        timers: false,
      });
    }
  });

  test("the check runs from the menu item's mount (the menu opening), not from the shell", () => {
    const item = readFileSync(
      new URL("../app/components/DevSwitchItem.tsx", import.meta.url),
      "utf8",
    );
    expect(item).toContain("devServerUp()");
    const shell = readFileSync(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("{devSwitch && <DevSwitchItem sw={devSwitch} />}");
    expect(shell).not.toContain("devServerUp");
  });
});

describe("the jump", () => {
  test("a fresh handoff from lianki.com, posted with the same path and query", async () => {
    const calls: string[] = [];
    const posted: [string, string][] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push(`${init.method} ${u}`);
      return Response.json({ handoff: `lkhand_${"h".repeat(43)}` });
    }) as unknown as typeof fetch;
    const ok = await switchToDevServer(
      { pathname: "/words", search: "?list=all" },
      { fetch: f, post: (t, n) => posted.push([t, n]) },
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["POST /api/dev/dev-handoff"]);
    expect(posted).toEqual([[`lkhand_${"h".repeat(43)}`, "/words?list=all"]]);
  });

  test("not the owner (404): no jump", async () => {
    const f = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    let posted = false;
    expect(
      await switchToDevServer(
        { pathname: "/", search: "" },
        { fetch: f, post: () => (posted = true) },
      ),
    ).toBe(false);
    expect(posted).toBe(false);
  });

  test("the handoff goes in a POST body, never the URL", () => {
    const made: { tag: string; attrs: Record<string, unknown>; kids: Record<string, unknown>[] }[] =
      [];
    let submitted = false;
    const doc = {
      createElement(tag: string) {
        const el = {
          tag,
          attrs: {} as Record<string, unknown>,
          kids: [] as Record<string, unknown>[],
          style: {},
        };
        const proxy: Record<string, unknown> = new Proxy(el as unknown as Record<string, unknown>, {
          set(t, k, v) {
            (t as { attrs: Record<string, unknown> }).attrs[String(k)] = v;
            return true;
          },
          get(t, k) {
            if (k === "appendChild")
              return (c: { attrs: Record<string, unknown> }) => el.kids.push(c.attrs);
            if (k === "submit") return () => (submitted = true);
            if (k === "remove") return () => {};
            if (k === "style") return el.style;
            return (t as Record<string | symbol, unknown>)[k];
          },
        });
        if (tag === "form") made.push(el);
        return proxy;
      },
      body: { appendChild() {} },
    } as unknown as Document;
    const h = `lkhand_${"h".repeat(43)}`;
    postToDevServer(h, "/words?list=all", doc);
    const form = made[0];
    expect(submitted).toBe(true);
    expect(form.attrs.method).toBe("POST");
    expect(form.attrs.action).toBe(`${DEV_SERVER_ORIGIN}/_lk/dev-auth`);
    expect(String(form.attrs.action)).not.toContain(h);
    expect(form.attrs.referrerPolicy).toBe("no-referrer");
    expect(form.kids).toContainEqual(expect.objectContaining({ name: "handoff", value: h }));
    expect(form.kids).toContainEqual(
      expect.objectContaining({ name: "next", value: "/words?list=all" }),
    );
  });

  test("back: the same path and query on lianki.com", () => {
    expect(backUrl({ pathname: "/words", search: "?list=all" })).toBe(
      "https://lianki.com/words?list=all",
    );
  });
});
