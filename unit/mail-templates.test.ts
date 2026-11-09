import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestD1Database } from "@/lib/d1/testDb";
import { MAIL_BRAND, MAIL_BRAND_ZH, mailBrand } from "@/lib/mail-templates/brand";
import { composeMail, renderBuiltin, renderWith } from "@/lib/mail-templates/compose";
import {
  MAIL_TEMPLATE_IDS,
  MAIL_TEMPLATES,
  SAMPLE_SETS,
  isMailTemplateId,
  lockedVars,
} from "@/lib/mail-templates/defs";
import {
  TemplateRenderError,
  escapeHtml,
  placeholders,
  renderSource,
  validateSource,
  type TemplateSource,
  type VarSpecs,
} from "@/lib/mail-templates/engine";
import {
  MAIL_LOCALES,
  isMailLocale,
  mailLocaleOf,
  pickMailLocale,
} from "@/lib/mail-templates/locales";
import {
  accountLocaleTags,
  recipientMailLocale,
  requestLocaleTags,
} from "@/lib/mail-templates/recipient-locale";
import {
  activateVersion,
  activeMap,
  activeStored,
  activeVersionNumber,
  listVersions,
  saveVersion,
  type TemplateDb,
} from "@/lib/mail-templates/store";

const VARS: VarSpecs = {
  url: { kind: "url", required: true },
  name: { kind: "text", required: true },
  extra: { kind: "text", required: false },
};
const ok: TemplateSource = {
  subject: "Hi {name}",
  html: '<p>Hello {name}, <a href="{url}">open</a></p>',
  text: "Hello {name}\n{url}",
};
const codes = (s: TemplateSource, v: VarSpecs = VARS) => validateSource(s, v).map((e) => e.code);

describe("validation: locked variables", () => {
  test("a valid source has no errors", () => {
    expect(validateSource(ok, VARS)).toEqual([]);
  });

  test("a required variable missing from html or text is refused", () => {
    expect(codes({ ...ok, text: "Hello {name}" })).toContain("missing-var");
    const e = validateSource({ ...ok, html: '<p><a href="{url}">open</a></p>' }, VARS);
    expect(e).toContainEqual({ field: "html", code: "missing-var", detail: "name" });
  });

  test("a link variable must be a link in the html", () => {
    const e = validateSource({ ...ok, html: "<p>{name} {url}</p>" }, VARS);
    expect(e).toContainEqual({ field: "html", code: "link-var-not-link", detail: "url" });
  });

  test("unknown and malformed placeholders are refused", () => {
    expect(codes({ ...ok, subject: "Hi {who}" })).toContain("unknown-var");
    expect(codes({ ...ok, subject: "Hi {na me}" })).toContain("malformed-placeholder");
    expect(codes({ ...ok, subject: "Hi {name" })).toContain("malformed-placeholder");
    expect(codes({ ...ok, text: "Hello {name}} {url}" })).toContain("malformed-placeholder");
    expect(codes({ ...ok, subject: "Hi {}" })).toContain("malformed-placeholder");
  });

  test("global brand variables are allowed everywhere", () => {
    expect(validateSource({ ...ok, subject: "{brand}: {brandLong}" }, VARS)).toEqual([]);
  });

  test("empty fields, long fields, and a multi-line subject are refused", () => {
    expect(codes({ ...ok, subject: "  " })).toContain("empty");
    expect(codes({ ...ok, text: "x".repeat(40_000) + "{name}{url}" })).toContain("too-long");
    expect(codes({ ...ok, subject: "a\nb" })).toContain("subject-newline");
    expect(codes({ ...ok, html: undefined as unknown as string })).toContain("empty");
  });

  test("placeholders() names what it finds", () => {
    expect(placeholders("{a} and {b2}")).toEqual({ names: ["a", "b2"], malformed: [] });
    expect(placeholders("{1x} }").malformed).toEqual(["{1x}", "}"]);
  });
});

describe("validation: html sanitising", () => {
  const html = (h: string) => codes({ ...ok, html: `${h}<p>{name}<a href="{url}">x</a></p>` });

  test("script, style, iframe, form, svg are refused", () => {
    for (const t of [
      "<script>alert(1)</script>",
      "<style>p{}</style>",
      "<iframe src=x>",
      "<form>",
      "<svg>",
    ])
      expect({ t, c: html(t) }).toEqual({ t, c: expect.arrayContaining(["html-tag"]) });
  });

  test("event handlers are refused", () => {
    expect(html('<p onclick="x()">a</p>')).toContain("html-event-handler");
    expect(html("<img src=https://x.test/a.png onerror=alert(1)>")).toContain("html-event-handler");
  });

  test("javascript: and other schemes in links are refused; https, http and mailto pass", () => {
    expect(html('<a href="javascript:alert(1)">a</a>')).toContain("html-href");
    expect(html('<a href="&#106;avascript:x">a</a>')).toContain("html-href");
    expect(html('<a href="data:text/html,x">a</a>')).toContain("html-href");
    expect(html('<a href="https://lianki.com/x">a</a><a href="mailto:a@b.c">m</a>')).toEqual([]);
  });

  test("images only from https; unknown attributes refused", () => {
    expect(html('<img src="http://x.test/a.png">')).toContain("html-src");
    expect(html('<img src="https://x.test/a.png" alt="a">')).toEqual([]);
    expect(html('<p srcdoc="x">a</p>')).toContain("html-attr");
    expect(html('<a href="https://x.test" formaction="x">a</a>')).toContain("html-attr");
  });

  test("dangerous inline styles are refused; plain ones pass", () => {
    expect(html('<p style="background:url(https://x.test/t.png)">a</p>')).toContain("html-style");
    expect(html('<p style="width:expression(alert(1))">a</p>')).toContain("html-style");
    expect(html('<p style="position:fixed">a</p>')).toContain("html-style");
    expect(html('<p style="color:oklch(0.5 0.1 200);font-weight:700">a</p>')).toEqual([]);
  });

  test("comments and stray < are refused", () => {
    expect(html("<!--[if mso]>x<![endif]-->")).toContain("html-comment");
    expect(html("<p>a < b</p>")).toContain("html-syntax");
  });

  test("a variable inside a tag only as a whole link", () => {
    expect(html('<p title="{name}">a</p>')).toContain("var-in-attr");
    expect(html('<p style="color:{name}">a</p>')).toContain("html-style");
    expect(html('<a href="{name}">a</a>')).toContain("var-in-attr");
    expect(html('<a href="https://x.test/?n={name}">a</a>')).toContain("var-in-attr");
  });

  test("closing tags and self-closing tags pass", () => {
    expect(html("<br/><hr /><table><tr><td colspan=2>a</td></tr></table>")).toEqual([]);
  });
});

describe("rendering: escaping", () => {
  test("values are escaped in html, raw in text, one line in the subject", () => {
    const r = renderSource(ok, VARS, {
      name: `<b>"Tom" & 'Jerry'</b>\nX`,
      url: "https://lianki.com/a?b=1&c=2",
    });
    expect(r.html).toContain("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
    expect(r.html).toContain('href="https://lianki.com/a?b=1&amp;c=2"');
    expect(r.text).toContain(`<b>"Tom" & 'Jerry'</b>`);
    expect(r.subject).toBe(`Hi <b>"Tom" & 'Jerry'</b> X`);
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });

  test("a missing required value or a non-http link is refused", () => {
    expect(() => renderSource(ok, VARS, { url: "https://x.test" })).toThrow(TemplateRenderError);
    expect(() => renderSource(ok, VARS, { name: "a", url: "javascript:alert(1)" })).toThrow(
      /unsafe link/,
    );
    expect(() =>
      renderSource({ ...ok, html: "<script>" }, VARS, { name: "a", url: "https://x" }),
    ).toThrow(/invalid source/);
  });

  test("optional values default to empty; numbers become text", () => {
    const r = renderSource({ ...ok, text: "{name} {url} [{extra}]" }, VARS, {
      name: 7,
      url: "https://x.test",
      extra: null,
    });
    expect(r.text).toBe("7 https://x.test []");
  });
});

describe("built-in templates", () => {
  test("every template validates and renders in every language with every sample set", () => {
    for (const id of MAIL_TEMPLATE_IDS)
      for (const l of MAIL_LOCALES) {
        const def = MAIL_TEMPLATES[id];
        expect({ id, l, e: validateSource(def.builtin(l), def.vars) }).toEqual({ id, l, e: [] });
        for (const s of SAMPLE_SETS) {
          const r = renderBuiltin(id, l, def.samples[s]);
          expect(r.subject.length).toBeGreaterThan(0);
          expect(r.html).not.toMatch(/\{[a-zA-Z]+\}/);
          expect(r.text).not.toMatch(/\{[a-zA-Z]+\}/);
          for (const v of lockedVars(id)) {
            const value = def.samples[s][v];
            expect({ id, l, v, inText: r.text.includes(value) }).toEqual({
              id,
              l,
              v,
              inText: true,
            });
          }
        }
      }
  });

  test("the locked variables of each template", () => {
    expect(Object.fromEntries(MAIL_TEMPLATE_IDS.map((id) => [id, lockedVars(id)]))).toEqual({
      "signin-code": ["code"],
      "signin-link": ["url"],
      "login-notice": ["time", "location", "browser", "contactUrl"],
      "email-confirm": ["url"],
      "email-taken": [],
      "email-requested": ["address", "contactUrl"],
      "email-changed": ["address", "contactUrl"],
      invite: ["inviter", "address", "inviteUrl", "unsubscribeUrl", "reportUrl"],
    });
    expect(isMailTemplateId("invite")).toBe(true);
    expect(isMailTemplateId("nope")).toBe(false);
  });

  test("zh-Hant has its own text; zh stays Simplified", () => {
    const hans = renderBuiltin("signin-link", "zh", { url: "https://x.test" });
    const hant = renderBuiltin("signin-link", "zh-Hant", { url: "https://x.test" });
    expect(hant.subject).not.toBe(hans.subject);
    expect(hant.text).toMatch(/[登]入/);
    expect(hans.text).toContain("登录");
  });

  test("the brand is one constant: zh says it, other languages say Lianki", () => {
    expect(renderBuiltin("signin-code", "zh", { code: "1" }).subject).toContain(MAIL_BRAND_ZH);
    expect(renderBuiltin("signin-code", "en", { code: "1" }).subject).toContain(MAIL_BRAND);
    expect(mailBrand("zh-Hant").brandLong).toBe(`${MAIL_BRAND_ZH}（${MAIL_BRAND}）`);
    expect(mailBrand("ja")).toEqual({ brand: MAIL_BRAND, brandLong: MAIL_BRAND });
  });

  test("Arabic and Urdu mails are right-to-left", () => {
    expect(renderBuiltin("email-taken", "ar", {}).html).toContain('dir="rtl"');
    expect(renderBuiltin("email-taken", "en", {}).html).toContain('dir="ltr"');
  });
});

describe("recipient language", () => {
  test("tags map to mail locales, Chinese by script", () => {
    for (const t of ["zh", "zh-CN", "zh-Hans", "zh_SG"]) expect(mailLocaleOf(t)).toBe("zh");
    for (const t of ["zh-TW", "zh-HK", "zh-Hant", "zh-Hant-TW"])
      expect(mailLocaleOf(t)).toBe("zh-Hant");
    expect(mailLocaleOf("ko-KR")).toBe("ko");
    expect(mailLocaleOf("xx")).toBeNull();
    expect(mailLocaleOf(null)).toBeNull();
    expect(isMailLocale("zh-Hant")).toBe(true);
    expect(MAIL_LOCALES).toHaveLength(17);
  });

  test("account → signup → request → en", () => {
    expect(pickMailLocale("ja", "de", "fr")).toBe("ja");
    expect(pickMailLocale(null, "de", "fr")).toBe("de");
    expect(pickMailLocale(null, "nope", "fr")).toBe("fr");
    expect(pickMailLocale(null, undefined)).toBe("en");
    expect(pickMailLocale()).toBe("en");
  });

  test("a bare zh takes the script of the next source; an explicit one stays", () => {
    expect(pickMailLocale("zh", "zh-Hant")).toBe("zh-Hant");
    expect(pickMailLocale("zh", null, "zh-TW")).toBe("zh-Hant");
    expect(pickMailLocale("zh", "en", "zh-TW")).toBe("zh");
    expect(pickMailLocale("zh-Hans", "zh-Hant")).toBe("zh");
    expect(pickMailLocale("zh")).toBe("zh");
    expect(pickMailLocale("zh-Hant", "zh")).toBe("zh-Hant");
  });

  test("request tags: app header, then Accept-Language", () => {
    expect(requestLocaleTags(null)).toEqual([]);
    const h = new Headers({ "x-lianki-lang": "zh", "accept-language": "zh-TW,zh;q=0.9" });
    expect(requestLocaleTags(h)).toEqual(["zh", "zh-Hant"]);
    expect(pickMailLocale(...requestLocaleTags(h))).toBe("zh-Hant");
  });
});

const migration = readFileSync(
  join(process.cwd(), "db/migrations/0064_mail_templates.sql"),
  "utf8",
);

async function freshDb() {
  const db = new TestD1Database();
  await db.exec(migration);
  await db.exec(
    "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, signupLocale TEXT); CREATE TABLE user_prefs (user_id TEXT, key TEXT, value TEXT);",
  );
  return db;
}

describe("account language from D1", () => {
  test("ui.locale, then signupLocale; by id or by address", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO user VALUES ('u1','a@x.test','zh-Hant'), ('u2','b@x.test',NULL);
       INSERT INTO user_prefs VALUES ('u1','ui.locale','"zh"'), ('u2','ui.locale','"ja"');`,
    );
    expect(await accountLocaleTags(db, { userId: "u1" })).toEqual(["zh", "zh-Hant"]);
    expect(await recipientMailLocale(db, { userId: "u1" })).toBe("zh-Hant");
    expect(await recipientMailLocale(db, { email: " B@x.test " }, "fr")).toBe("ja");
    expect(await recipientMailLocale(db, { email: "new@x.test" }, "fr")).toBe("fr");
    expect(await recipientMailLocale(null, { email: "new@x.test" })).toBe("en");
  });

  test("a missing column or table never throws", async () => {
    const db = new TestD1Database();
    await db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT)");
    await db.exec("INSERT INTO user VALUES ('u1','a@x.test')");
    expect(await accountLocaleTags(db, { email: "a@x.test" })).toEqual([null, null]);
    expect(await accountLocaleTags(db, { userId: "u1" })).toEqual([null, null]);
    expect(await recipientMailLocale(db, { userId: "u1" }, "de")).toBe("de");
  });

  test("no user table at all: nothing, by address too", async () => {
    const db = new TestD1Database();
    expect(await accountLocaleTags(db, { email: "a@x.test" })).toEqual([null, null]);
    expect(await recipientMailLocale(db, { email: "a@x.test" }, "ko")).toBe("ko");
  });
});

describe("store: versions and rollback", () => {
  let db: TestD1Database;
  beforeEach(async () => {
    db = await freshDb();
  });
  const src = (id: "signin-code", word: string): TemplateSource => ({
    subject: `${word} {code}`,
    html: `<p>${word} <b>{code}</b></p>`,
    text: `${word} {code}`,
  });

  test("save appends a version and makes it active; rollback activates an older one", async () => {
    const t = db as unknown as TemplateDb;
    expect(await activeVersionNumber(t, "signin-code", "en")).toBe(0);
    expect(
      await saveVersion(t, {
        id: "signin-code",
        locale: "en",
        source: src("signin-code", "One"),
        by: "u",
        now: 1,
      }),
    ).toEqual({ ok: true, version: 1 });
    expect(
      await saveVersion(t, {
        id: "signin-code",
        locale: "en",
        source: src("signin-code", "Two"),
        note: " second ",
        by: "u",
        now: 2,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(await activeVersionNumber(t, "signin-code", "en")).toBe(2);
    const list = await listVersions(t, "signin-code", "en");
    expect(list.map((v) => [v.version, v.note])).toEqual([
      [2, "second"],
      [1, null],
    ]);
    expect((await composeMail(t, "signin-code", "en", { code: "9" })).subject).toBe("Two 9");

    expect(
      await activateVersion(t, { id: "signin-code", locale: "en", version: 1, by: "u" }),
    ).toEqual({ ok: true, version: 1 });
    expect((await composeMail(t, "signin-code", "en", { code: "9" })).subject).toBe("One 9");
    expect(await activeMap(t)).toEqual({ "signin-code": { en: 1 } });

    // Back to the built-in default.
    expect(
      await activateVersion(t, { id: "signin-code", locale: "en", version: 0, by: "u" }),
    ).toEqual({ ok: true, version: 0 });
    expect(await activeStored(t, "signin-code", "en")).toBeNull();
    expect((await composeMail(t, "signin-code", "en", { code: "9" })).version).toBe(0);
    expect(await activeMap(t)).toEqual({});
    // Another language is untouched.
    expect(await activeVersionNumber(t, "signin-code", "ja")).toBe(0);
  });

  test("an invalid save writes nothing", async () => {
    const t = db as unknown as TemplateDb;
    const r = await saveVersion(t, {
      id: "signin-code",
      locale: "en",
      source: { subject: "x", html: "<script>{code}</script>", text: "no code" },
      by: "u",
    });
    expect(r.ok).toBe(false);
    expect(await listVersions(t, "signin-code", "en")).toEqual([]);
  });

  test("activating a missing, old-schema or no-longer-valid version is refused", async () => {
    const t = db as unknown as TemplateDb;
    expect(
      await activateVersion(t, { id: "signin-code", locale: "en", version: 5, by: "u" }),
    ).toEqual({ ok: false, error: "no-such-version" });
    await db.exec(
      `INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, created_by, created_at)
       VALUES ('signin-code','en',1,0,'s {code}','<p>{code}</p>','{code}','u',1),
              ('signin-code','en',2,1,'s','<script>','x','u',1)`,
    );
    expect(
      await activateVersion(t, { id: "signin-code", locale: "en", version: 1, by: "u" }),
    ).toEqual({ ok: false, error: "old-schema" });
    const bad = await activateVersion(t, { id: "signin-code", locale: "en", version: 2, by: "u" });
    expect(bad.ok === false && bad.error).toBe("invalid");
  });

  test("versions are append-only", async () => {
    const t = db as unknown as TemplateDb;
    await saveVersion(t, {
      id: "signin-code",
      locale: "en",
      source: src("signin-code", "One"),
      by: "u",
    });
    await expect(db.exec("UPDATE mail_template_version SET subject = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.exec("DELETE FROM mail_template_version")).rejects.toThrow(/append-only/);
  });
});

describe("fail-safe at send time", () => {
  let err: ReturnType<typeof spyOn>;
  beforeEach(() => {
    err = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => err.mockRestore());

  const logged = () => err.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));

  test("a stored version that no longer validates sends the built-in, logged without addresses", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, created_by, created_at)
       VALUES ('signin-link','en',1,1,'s','<p>no link</p>','no link','u',1);
       INSERT INTO mail_template_active VALUES ('signin-link','en',1,'u',1);`,
    );
    const m = await composeMail(db as unknown as TemplateDb, "signin-link", "en", {
      url: "https://lianki.com/v?t=1",
    });
    expect(m.version).toBe(0);
    expect(m.subject).toBe(renderBuiltin("signin-link", "en", { url: "https://x" }).subject);
    expect(logged()).toEqual([
      expect.objectContaining({
        event: "mail.template.fallback",
        template: "signin-link",
        locale: "en",
        version: 1,
      }),
    ]);
    expect(JSON.stringify(logged())).not.toContain("@");
  });

  test("an old-schema version, a failing render and a failing store all fall back", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, created_by, created_at)
       VALUES ('signin-code','en',1,0,'s {code}','<p>{code}</p>','{code}','u',1),
              ('signin-link','en',1,1,'s','<p><a href="{url}">x</a></p>','{url}','u',1);
       INSERT INTO mail_template_active VALUES ('signin-code','en',1,'u',1), ('signin-link','en',1,'u',1);`,
    );
    const t = db as unknown as TemplateDb;
    expect((await composeMail(t, "signin-code", "en", { code: "1" })).version).toBe(0);
    // An unsafe link value makes the stored render throw: still the built-in? No — the
    // built-in refuses it too, so the error surfaces from the built-in render.
    expect((await composeMail(t, "signin-link", "en", { url: "https://ok.test" })).version).toBe(1);
    const broken = {
      prepare() {
        throw new Error("no such table");
      },
    } as unknown as TemplateDb;
    expect((await composeMail(broken, "signin-code", "en", { code: "1" })).version).toBe(0);
    const reasons = logged().map((l: { reason: string }) => l.reason);
    expect(reasons[0]).toBe("old-schema");
    expect(reasons[1]).toMatch(/^store: /);
  });

  test("a stored render that throws on values falls back to the built-in", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, created_by, created_at)
       VALUES ('login-notice','en',1,1,'s','<p>{time}{location}{browser}<a href="{contactUrl}">c</a></p>','{time}{location}{browser}{contactUrl}','u',1);
       INSERT INTO mail_template_active VALUES ('login-notice','en',1,'u',1);`,
    );
    const t = db as unknown as TemplateDb;
    const values = { time: "t", location: "l", browser: "b", contactUrl: "https://c.test" };
    expect((await composeMail(t, "login-notice", "en", values)).version).toBe(1);
    // A missing value fails both; the built-in's error is what surfaces (a code bug, not a template).
    await expect(composeMail(t, "login-notice", "en", { ...values, time: "" })).rejects.toThrow(
      TemplateRenderError,
    );
    expect(logged()[0].reason).toMatch(/missing value: time/);
  });

  test("no db: the built-in", async () => {
    expect((await composeMail(null, "email-taken", "fr", {})).locale).toBe("fr");
  });

  test("renderWith renders an editor's source as a send would", () => {
    const r = renderWith(
      "signin-code",
      "zh",
      { subject: "{brand} {code}", html: "<p>{code}</p>", text: "{code}" },
      { code: "42" },
    );
    expect(r.subject).toBe(`${MAIL_BRAND_ZH} 42`);
  });
});
