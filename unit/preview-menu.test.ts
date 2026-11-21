/**
 * The account menu's preview row (app/components/PreviewMenuItem.tsx) on the
 * landing page and the blog as in the app shell: one component in both
 * menus, decided on the server by the same `dev` grant, absent for everyone
 * else (lib/preview-menu.server.ts).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clearPermissionCache, grantAll } from "./support/grants";

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
const { previewMenuFor } = await import("@/lib/preview-menu.server");

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("who gets it (server side)", () => {
  beforeEach(() => grantAll(["owner@example.com"], ["dev"]));
  afterAll(() => clearPermissionCache());

  test("guests and accounts without `dev`: nothing", async () => {
    expect(await previewMenuFor(null, "en")).toEqual({
      devSwitch: undefined,
      liveView: undefined,
    });
    expect(await previewMenuFor("friend@example.com", "en")).toEqual({
      devSwitch: undefined,
      liveView: undefined,
    });
    grantAll(["owner@example.com"], ["admin"]);
    expect((await previewMenuFor("owner@example.com", "en")).devSwitch).toBeUndefined();
  });

  test("a `dev` holder gets the switch, with its strings", async () => {
    const p = await previewMenuFor("Owner@Example.com", "en");
    expect(p.devSwitch?.mode).toBe("go");
    expect(p.devSwitch?.labels.name).toBeDefined();
    expect(p.liveView).toBeDefined();
  });
});

describe("one component in both menus", () => {
  test("the row renders nothing without the server's switch", () => {
    expect(src("app/components/PreviewMenuItem.tsx")).toContain("if (!devSwitch) return null;");
  });

  test("ProfileMenu and Header both render PreviewMenuItem; neither decides the gate", () => {
    for (const f of ["app/components/ProfileMenu.tsx", "app/components/Header.tsx"]) {
      const s = src(f);
      expect(s).toContain("<PreviewMenuItem");
      expect(s).not.toMatch(/isDev|isAdmin|OWNER_EMAILS|<DevSwitchItem/);
    }
  });

  test("the landing page and the blog pass the server's decision to Header", () => {
    for (const f of [
      "app/[locale]/page.tsx",
      "app/[locale]/blog/page.tsx",
      "app/[locale]/blog/[slug]/page.tsx",
    ])
      expect([f, src(f)]).toEqual([
        f,
        expect.stringContaining("preview={await previewMenuFor(user?.email, locale)}"),
      ]);
  });
});
