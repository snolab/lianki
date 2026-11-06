/**
 * The owner's dev-server switch in the account menu (lib/dev-server-switch.ts):
 * decided on the server for the owner only, one check when the menu opens and
 * no polling, the single-use handoff posted in a form body, and the way back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { clearOwnerCache, setOwnerSnapshot } from "../lib/owner";
import { readFileSync } from "node:fs";
import {
  DEV_SERVER_ORIGIN,
  backUrl,
  devServerUp,
  devSwitchMode,
  postToDevServer,
  previewEntryUrl,
  safePreviewPath,
  signInReturnPath,
  signInUrlForPreview,
  switchToDevServer,
} from "../lib/dev-server-switch";
import { devSwitchFor } from "../lib/dev-server-switch.server";

describe("signed out on the entry: sign in, then back to it", () => {
  test("only the preview entry on lianki.com comes back, rebuilt from its parts", () => {
    expect(signInReturnPath("/dev/preview?to=%2Fen%2Fread")).toBe("/dev/preview?to=%2Fen%2Fread");
    expect(signInReturnPath("/dev/preview")).toBe("/dev/preview?to=%2F");
    expect(signInReturnPath("/dev/preview?to=%2F%2Fevil.example")).toBe("/dev/preview?to=%2F");
    expect(signInReturnPath("/dev/preview?to=%2Fx&evil=1")).toBe("/dev/preview?to=%2Fx");
    expect(signInReturnPath("/dev/preview?to=%2Fx%3Ftoken%3Dlkdev_abc")).toBe(
      "/dev/preview?to=%2Fx",
    );
  });

  test("everything else is null: sign-in lands on /home as before (no open redirect)", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "/home",
      "/en/read",
      "/dev/tokens",
      "/dev/preview/x",
      "https://evil.example/dev/preview",
      "https://lianki.com/dev/preview",
      "//evil.example/dev/preview",
      "/\\evil.example/dev/preview",
      "/\t/evil.example/dev/preview",
      "/dev/preview\n",
      "javascript:alert(1)",
      "dev/preview",
      `/dev/preview?to=${"a".repeat(2001)}`,
    ])
      expect([bad, signInReturnPath(bad)]).toEqual([bad, null]);
  });

  test("the entry's sign-in URL carries the return path, never a token", () => {
    expect(signInUrlForPreview("/en/read")).toBe(
      "/sign-in?next=%2Fdev%2Fpreview%3Fto%3D%252Fen%252Fread",
    );
    const u = new URL(signInUrlForPreview("/en/read"), "https://lianki.com");
    expect(signInReturnPath(u.searchParams.get("next"))).toBe("/dev/preview?to=%2Fen%2Fread");
    expect(decodeURIComponent(signInUrlForPreview(`/x?token=lkdev_${"g".repeat(43)}`))).not.toMatch(
      /lkdev_|token=/,
    );
  });

  test("sign-in reads the return path only through the helper", () => {
    const src = readFileSync("app/(app)/sign-in/SignInClient.tsx", "utf8");
    expect(src).toContain('signInReturnPath(raw) ?? "/home"');
    expect(src).not.toMatch(/callbackURL:\s*"\/home"/);
  });
});

describe("the entry from the gate page: `to` is a relative path only", () => {
  test("paths and queries on the preview origin are kept", () => {
    expect(safePreviewPath("/en/read")).toBe("/en/read");
    expect(safePreviewPath("/words?list=all")).toBe("/words?list=all");
    expect(safePreviewPath("/")).toBe("/");
    expect(safePreviewPath("/en/read#x")).toBe("/en/read");
  });

  test("anything that could leave the site is refused (no open redirect)", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\u0000x",
      "javascript:alert(1)",
      "en/read",
      "https://preview.lianki.com/en/read",
      "/_lk/dev-auth",
      "/_lk/sign-out",
      `/${"a".repeat(2001)}`,
    ])
      expect([bad, safePreviewPath(bad)]).toEqual([bad, null]);
  });

  test("a token never travels in it: such a query is dropped, such a path refused", () => {
    expect(safePreviewPath(`/en/read?token=lkdev_${"g".repeat(43)}`)).toBe("/en/read");
    expect(safePreviewPath("/en/read?handoff=x")).toBe("/en/read");
    expect(safePreviewPath("/en/read?a=1&token=x")).toBe("/en/read");
    expect(safePreviewPath(`/en/read?x=lkhand_${"h".repeat(43)}`)).toBe("/en/read");
    expect(safePreviewPath(`/en/read?x=%6Ckdev_abc`)).toBe("/en/read");
    expect(safePreviewPath(`/lkdev_${"g".repeat(43)}`)).toBeNull();
  });

  test("the entry URL is lianki.com's owner route, with `to` encoded", () => {
    expect(previewEntryUrl("/en/read?list=all")).toBe(
      "https://lianki.com/dev/preview?to=%2Fen%2Fread%3Flist%3Dall",
    );
    expect(previewEntryUrl("//evil.example")).toBe("https://lianki.com/dev/preview?to=%2F");
    expect(previewEntryUrl(`/x?token=lkdev_${"g".repeat(43)}`)).not.toContain("lkdev_");
  });

  test("the route is owner-only and lands via the switch, never a token in a URL", () => {
    const page = readFileSync("app/(app)/dev/preview/page.tsx", "utf8");
    expect(page).toContain("notFound()");
    expect(page).toContain("isOwner(");
    expect(page).toContain("safePreviewPath(");
    const client = readFileSync("app/(app)/dev/preview/PreviewEntryClient.tsx", "utf8");
    expect(client).toContain("switchToDevServer(");
    expect(client).not.toMatch(/location\.(href|assign|replace)/);
  });
});

const OWNERS = {};
const labels = () => ({ name: "n", off: "f", checking: "c" });

describe("who gets it (server side)", () => {
  beforeEach(() => setOwnerSnapshot(["owner@example.com"]));
  afterAll(() => clearOwnerCache());

  test("guests and other users: nothing at all, not even the strings", () => {
    expect(devSwitchFor(null, labels, OWNERS)).toBeUndefined();
    expect(devSwitchFor("friend@example.com", labels, OWNERS)).toBeUndefined();
    clearOwnerCache();
    expect(devSwitchFor("owner@example.com", labels, OWNERS)).toBeUndefined();
    setOwnerSnapshot(["owner@example.com"]);
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
    expect(shell).not.toMatch(/isOwner|site_role/);
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
    expect(shell).toContain("<DevSwitchItem sw={devSwitch}>");
    // One preview control: Live view is a chip inside it, not a second switch.
    expect(shell).not.toContain("LiveViewItem");
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
