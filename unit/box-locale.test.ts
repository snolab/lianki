/**
 * The box's language at sign-in (docs/box-oauth.md, "The box's language"):
 * the account's pick first, then the browser's languages, written to the
 * box's own cookies before /home loads.
 */
import { describe, expect, test } from "bun:test";
import {
  accountLocaleFrom,
  adoptAccountLocale,
  boxLocale,
  localeCookieLines,
} from "@/lib/box-oauth/locale";
import { tokenMayCall } from "@/lib/box-oauth/rules";
import { BLOG_LOCALES } from "@/lib/constants";

const prefs = (value: unknown) => ({ prefs: { "ui.locale": { value, hlc: "x" } }, cursor: 1 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function run(answer: () => Promise<Response>, languages: readonly string[]) {
  const lines: string[] = [];
  const asked: string[] = [];
  const done = adoptAccountLocale({
    fetch: (url) => {
      asked.push(url);
      return answer();
    },
    languages,
    setCookie: (l) => lines.push(l),
  });
  return { done, lines, asked };
}

describe("boxLocale", () => {
  test("the account's pick wins over the browser, for every locale we have", () => {
    for (const l of BLOG_LOCALES) expect(boxLocale(l, ["fr-FR", "fr"])).toBe(l);
  });
  test("no pick: the first of the browser's languages we have, region dropped", () => {
    expect(boxLocale(null, ["zh-CN", "fr"])).toBe("zh");
    expect(boxLocale(undefined, ["xx", "ja-JP"])).toBe("ja");
  });
  test("an unknown pick is ignored; nothing known: the default", () => {
    expect(boxLocale("xx", ["de"])).toBe("de");
    expect(boxLocale(42, [])).toBe("en");
  });
});

describe("accountLocaleFrom", () => {
  test("reads ui.locale from an /api/prefs answer", () => {
    expect(accountLocaleFrom(prefs("zh"))).toBe("zh");
  });
  test("absent, unknown or odd: null", () => {
    expect(accountLocaleFrom({ prefs: {}, cursor: 0 })).toBeNull();
    expect(accountLocaleFrom(prefs("xx"))).toBeNull();
    expect(accountLocaleFrom(prefs(1))).toBeNull();
    expect(accountLocaleFrom(null)).toBeNull();
    expect(accountLocaleFrom({ prefs: "zh" })).toBeNull();
  });
});

describe("adoptAccountLocale", () => {
  test("the account's zh beats a French browser, and both cookies stick", async () => {
    const r = run(async () => json(prefs("zh")), ["fr-FR", "fr"]);
    expect(await r.done).toBe("zh");
    expect(r.asked).toEqual(["/api/prefs"]);
    expect(r.lines).toEqual(localeCookieLines("zh"));
    expect(r.lines.map((l) => l.split("=")[0]).sort()).toEqual(["NEXT_LOCALE", "lang"]);
    for (const l of r.lines) expect(l).toContain("path=/");
  });
  test("no pick on the account: the browser's languages", async () => {
    const r = run(async () => json({ prefs: {}, cursor: 0 }), ["ko-KR", "en"]);
    expect(await r.done).toBe("ko");
    expect(r.lines).toEqual(localeCookieLines("ko"));
  });
  test("lianki.com refuses or is unreachable: the browser's languages, never a throw", async () => {
    expect(await run(async () => json({ error: "x" }, 401), ["es"]).done).toBe("es");
    expect(await run(async () => new Response("not json"), ["pt-BR"]).done).toBe("pt");
    expect(
      await run(async () => {
        throw new Error("offline");
      }, ["de"]).done,
    ).toBe("de");
  });
  test("a read-only box token may read the account's prefs", () => {
    expect(tokenMayCall("GET", "/api/prefs", ["box:read"])).toEqual({ ok: true });
  });
});
