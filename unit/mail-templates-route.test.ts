import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestD1Database } from "@/lib/d1/testDb";
import { DIFF_MAX_CELLS, htmlLines, lineDiff } from "@/lib/mail-templates/diff";
import {
  TEST_SENDS,
  templatesGet,
  templatesPost,
  type TemplatesDb,
  type TemplatesDeps,
} from "@/lib/mail-templates/route";
import type { SendEmailInput } from "@/lib/email";

const ORIGIN = "http://localhost:3000";
const who = { id: "dev1", email: "dev@example.test" };

async function setup() {
  const db = new TestD1Database();
  await db.exec(readFileSync(join(process.cwd(), "db/migrations/0064_mail_templates.sql"), "utf8"));
  await db.exec(
    `CREATE TABLE auth_throttle (key TEXT PRIMARY KEY, count INTEGER, windowStart INTEGER, lockedUntil INTEGER);
     CREATE TABLE security_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER, kind TEXT, actor TEXT, subject TEXT, detail TEXT);`,
  );
  const sent: SendEmailInput[] = [];
  let now = 1_000_000;
  const deps: TemplatesDeps = {
    db: () => db as unknown as TemplatesDb,
    send: async (m) => {
      sent.push(m);
      return { id: "stub" };
    },
    now: () => now,
  };
  return { db, deps, sent, tick: (ms: number) => (now += ms) };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/dev/templates`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const get = (q = "") => new Request(`${ORIGIN}/api/dev/templates${q}`);

const good = { subject: "Code {code}", html: "<p>{code}</p>", text: "{code}" };

describe("/api/dev/templates", () => {
  let log: ReturnType<typeof spyOn>;
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  test("not a developer, or no D1: an empty 404", async () => {
    const { deps } = await setup();
    expect((await templatesGet(get(), null, deps)).status).toBe(404);
    expect((await templatesPost(post({}), null, deps)).status).toBe(404);
    expect((await templatesGet(get(), who, { ...deps, db: () => null })).status).toBe(404);
  });

  test("lists templates with their variables, then one template's detail", async () => {
    const { deps } = await setup();
    const list = await (await templatesGet(get(), who, deps)).json();
    expect(list.templates).toHaveLength(8);
    expect(list.locales).toContain("zh-Hant");
    expect(list.active).toEqual({});
    const one = await (await templatesGet(get("?id=invite&locale=zh-Hant"), who, deps)).json();
    expect(one).toMatchObject({ id: "invite", locale: "zh-Hant", versions: [], active: 0 });
    expect(one.builtin.html).toContain('href="{inviteUrl}"');
    expect((await templatesGet(get("?id=nope&locale=en"), who, deps)).status).toBe(400);
  });

  test("edit → save → test-send (stubbed, own address) → rollback, audited", async () => {
    const { db, deps, sent } = await setup();
    const save = await templatesPost(
      post({ op: "save", id: "signin-code", locale: "ja", ...good, note: "first" }),
      who,
      deps,
    );
    expect(await save.json()).toEqual({ version: 1 });
    const save2 = await templatesPost(
      post({ op: "save", id: "signin-code", locale: "ja", ...good, subject: "Two {code}" }),
      who,
      deps,
    );
    expect(await save2.json()).toEqual({ version: 2 });

    const t = await templatesPost(
      post({
        op: "test",
        id: "signin-code",
        locale: "ja",
        sample: "long",
        ...good,
        to: "victim@x.test",
      }),
      who,
      deps,
    );
    expect(await t.json()).toEqual({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(who.email);
    expect(sent[0].subject).toBe("[test] Code 000000");

    const back = await templatesPost(
      post({ op: "activate", id: "signin-code", locale: "ja", version: 1 }),
      who,
      deps,
    );
    expect(await back.json()).toEqual({ version: 1 });
    const one = await (await templatesGet(get("?id=signin-code&locale=ja"), who, deps)).json();
    expect(one.active).toBe(1);
    expect(one.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const { results } = await db
      .prepare("SELECT kind, subject, detail FROM security_audit ORDER BY id")
      .all();
    expect(results).toEqual([
      { kind: "mail-template.save", subject: "signin-code:ja", detail: "v1" },
      { kind: "mail-template.save", subject: "signin-code:ja", detail: "v2" },
      { kind: "mail-template.test-send", subject: "signin-code:ja", detail: null },
      { kind: "mail-template.activate", subject: "signin-code:ja", detail: "v1" },
    ]);
  });

  test("an invalid template is refused with its errors; nothing is saved or sent", async () => {
    const { deps, sent } = await setup();
    const bad = { subject: "x", html: "<p onclick=x>{code}</p>", text: "no code" };
    const r = await templatesPost(
      post({ op: "save", id: "signin-code", locale: "en", ...bad }),
      who,
      deps,
    );
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.errors.map((e: { code: string }) => e.code)).toEqual(
      expect.arrayContaining(["missing-var", "html-event-handler"]),
    );
    expect(
      (
        await templatesPost(
          post({ op: "test", id: "signin-code", locale: "en", ...bad }),
          who,
          deps,
        )
      ).status,
    ).toBe(422);
    expect(sent).toHaveLength(0);
  });

  test("test sends are rate-limited per developer", async () => {
    const { deps, sent, tick } = await setup();
    const send = () =>
      templatesPost(
        post({
          op: "test",
          id: "email-taken",
          locale: "fr",
          subject: "s",
          html: "<p>x</p>",
          text: "x",
        }),
        who,
        deps,
      );
    for (let i = 0; i < TEST_SENDS.max; i++) expect((await send()).status).toBe(200);
    const r = await send();
    expect(r.status).toBe(429);
    expect((await r.json()).retryAfterMs).toBeGreaterThan(0);
    tick(TEST_SENDS.windowMs + 1);
    expect((await send()).status).toBe(200);
    expect(sent).toHaveLength(TEST_SENDS.max + 1);
  });

  test("a failing provider is a 502, logged without an address", async () => {
    const { deps } = await setup();
    const err = spyOn(console, "error").mockImplementation(() => {});
    const r = await templatesPost(
      post({
        op: "test",
        id: "email-taken",
        locale: "en",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
      }),
      who,
      { ...deps, send: async () => Promise.reject(new Error("down")) },
    );
    expect(r.status).toBe(502);
    expect(String(err.mock.calls[0][0])).not.toContain("@");
    err.mockRestore();
  });

  test("bad requests: cross-site, bad body, unknown op, bad version, missing version", async () => {
    const { deps } = await setup();
    expect(
      (await templatesPost(post({ op: "save" }, { "content-type": "text/plain" }), who, deps))
        .status,
    ).toBe(403);
    expect(
      (await templatesPost(post({ op: "save", id: "signin-code", locale: "xx" }), who, deps))
        .status,
    ).toBe(400);
    expect(
      (await templatesPost(post({ op: "save", id: "signin-code", locale: "en" }), who, deps))
        .status,
    ).toBe(400);
    expect(
      (await templatesPost(post({ op: "test", id: "signin-code", locale: "en" }), who, deps))
        .status,
    ).toBe(400);
    expect(
      (await templatesPost(post({ op: "nope", id: "signin-code", locale: "en" }), who, deps))
        .status,
    ).toBe(400);
    expect(
      (
        await templatesPost(
          post({ op: "activate", id: "signin-code", locale: "en", version: "1" }),
          who,
          deps,
        )
      ).status,
    ).toBe(400);
    const missing = await templatesPost(
      post({ op: "activate", id: "signin-code", locale: "en", version: 9 }),
      who,
      deps,
    );
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toBe("no-such-version");
    const bad = new Request(`${ORIGIN}/api/dev/templates`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: "localhost:3000" },
      body: "{",
    });
    expect((await templatesPost(bad, who, deps)).status).toBe(400);
  });
});

describe("line diff", () => {
  test("kept, removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { op: "=", line: "a" },
      { op: "-", line: "b" },
      { op: "+", line: "x" },
      { op: "=", line: "c" },
      { op: "+", line: "d" },
    ]);
    expect(lineDiff("a\nb", "a")).toEqual([
      { op: "=", line: "a" },
      { op: "-", line: "b" },
    ]);
    expect(lineDiff("", "")).toEqual([{ op: "=", line: "" }]);
  });

  test("too large: everything replaced", () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 1 }, (_, i) =>
      String(i),
    ).join("\n");
    const d = lineDiff(big, big);
    expect(d.every((l) => l.op !== "=")).toBe(true);
  });

  test("html is split after closing tags and <br>", () => {
    expect(htmlLines("<p>a</p><p>b<br>c</p>")).toBe("<p>a</p>\n<p>b<br>\nc</p>\n");
  });
});
