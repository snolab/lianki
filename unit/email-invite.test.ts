/**
 * Invite by email (lib/referrals/email-invite.ts): who may send, the per-inviter
 * daily limit, the per-address window across inviters, one address per request,
 * neutral answers, suppression via one-click and the opt-out page, report-based
 * blocking, masking and hashing, the mail's language and content. No mail leaves:
 * `send` is a stub. Fake addresses only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { SendEmailInput } from "../lib/email";
import type { FlagValues } from "../lib/flags";
import { EMAIL_INVITE } from "../lib/referrals/email-invite-config";
import {
  type EmailInviteDeps,
  type InviteDb,
  canEmailInvite,
  emailInviteStatus,
  inviteOptOut,
  inviterLocale,
  optOutGet,
  oneAddress,
  sendEmailInvite,
  signOptOut,
  verifyOptOut,
} from "../lib/referrals/email-invite";
import { mailDisplayName, previewInviteMail, renderInviteMail } from "../lib/referrals/invite-mail";
import {
  inviterMailLocale,
  mailTemplateLocale,
  normaliseLocaleTag,
  signupLocaleFrom,
} from "../lib/signup-locale";
import { recordSignupLocale } from "../lib/signup-locale-d1";
import { isLocalOrigin } from "../lib/referrals/local-origin";

const DIR = new URL("../db/migrations/", import.meta.url);
const SCHEMA = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"))
  .join("\n");

const BASE = "https://lianki.com";
const SECRET = "x".repeat(40);
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const FRIEND = "friend.one@example.org";

let raw: ReturnType<typeof createTestD1>;
let mails: SendEmailInput[];
let me: { id: string; email: string } | null;
let admins: string[];
let flags: FlagValues;
let now: number;
let failSend: boolean;
let deps: EmailInviteDeps;
let errors: ReturnType<typeof spyOn>;

const rows = (sql: string, ...args: (string | number)[]) =>
  raw
    .raw()
    .prepare(sql)
    .all(...args)
    .map((r) => ({ ...r })) as Record<string, unknown>[];
const addUser = (
  id: string,
  email: string,
  o: { name?: string; proDays?: number; signupLocale?: string; canonical?: string } = {},
) =>
  raw
    .raw()
    .prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical, proEndsAt, signupLocale) VALUES (?, ?, ?, 1, 'x', 'x', ?, ?, ?)",
    )
    .run(
      id,
      o.name ?? "N",
      email,
      o.canonical ?? email,
      o.proDays === undefined ? null : new Date(T0 + o.proDays * DAY).toISOString(),
      o.signupLocale ?? null,
    );
const setUiLocale = (id: string, locale: string) =>
  raw
    .raw()
    .prepare(
      "INSERT INTO user_prefs (user_id, key, value, hlc_ts, hlc_counter, device_id, updated_ms) VALUES (?, 'ui.locale', ?, 1, 0, 'd', 1)",
    )
    .run(id, JSON.stringify(locale));

const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      host: "lianki.com",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...h,
    },
    body: JSON.stringify(body),
  });
const invite = (email: unknown = FRIEND, extra: Record<string, unknown> = {}) =>
  sendEmailInvite(post("/api/invite/email", { email, ...extra }), deps);
const oneClick = (token: string) =>
  inviteOptOut(
    new Request(`${BASE}/api/invite/email/opt-out?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "1.1.1.1",
      },
      body: "List-Unsubscribe=One-Click",
    }),
    deps,
  );
const pageAction = (token: string, action: string, h: Record<string, string> = {}) =>
  inviteOptOut(post("/api/invite/email/opt-out", { token, action }, h), deps);
const tokenOf = (m: SendEmailInput) => /[?&]t=([^&>]+)/.exec(m.headers!["List-Unsubscribe"]!)![1]!;
const status = async () => (await (await emailInviteStatus(deps)).json()) as Record<string, any>;

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  addUser("pro", "pro.user@example.com", { name: "snomiao", proDays: 30 });
  addUser("trial", "trial.user@example.com", { name: "Tri" });
  addUser("admin", "admin.user@example.com", { name: "Adm" });
  addUser("pro2", "pro.two@example.com", { name: "Second", proDays: 30 });
  mails = [];
  admins = ["admin.user@example.com"];
  flags = { "membership.email-invite": true };
  me = { id: "pro", email: "pro.user@example.com" };
  now = T0;
  failSend = false;
  deps = {
    who: async () => me,
    db: () => raw as unknown as InviteDb,
    send: async (m) => {
      if (failSend) throw new Error("provider down");
      mails.push(m);
      return { id: `msg-${mails.length}` };
    },
    mailOn: () => true,
    secret: () => SECRET,
    flags: async () => flags,
    isAdmin: (e) => admins.includes(e),
    origin: () => BASE,
    now: () => now,
  };
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("language: account setting → signupLocale → en", () => {
  test("Chinese tags keep their script", () => {
    for (const t of ["zh", "zh-CN", "zh-cn", "zh-Hans", "zh-Hans-CN", "zh-SG", "zh_CN"])
      expect({ t, n: normaliseLocaleTag(t) }).toEqual({ t, n: "zh-Hans" });
    for (const t of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"])
      expect({ t, n: normaliseLocaleTag(t) }).toEqual({ t, n: "zh-Hant" });
  });
  test("other tags: the base locale when supported, else nothing", () => {
    expect(normaliseLocaleTag("en-US")).toBe("en");
    expect(normaliseLocaleTag("ja-JP")).toBe("ja");
    expect(normaliseLocaleTag("pt-BR")).toBe("pt");
    expect(normaliseLocaleTag("nl-NL")).toBeNull();
    expect(normaliseLocaleTag("")).toBeNull();
    expect(normaliseLocaleTag("*")).toBeNull();
    expect(normaliseLocaleTag(42)).toBeNull();
  });
  test("Accept-Language: q-weights, first supported, the tag only", () => {
    expect(signupLocaleFrom("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-Hans");
    expect(signupLocaleFrom("zh-TW,zh;q=0.9")).toBe("zh-Hant");
    expect(signupLocaleFrom("nl-NL,ja;q=0.5,en;q=0.7")).toBe("en");
    expect(signupLocaleFrom("en;q=0,fr")).toBe("fr");
    expect(signupLocaleFrom("nl")).toBeNull();
    expect(signupLocaleFrom(null)).toBeNull();
  });
  test("template locale: Simplified for zh / zh-CN / zh-Hans — never a Traditional template", () => {
    for (const t of ["zh", "zh-CN", "zh-Hans"]) expect(mailTemplateLocale(t)).toBe("zh");
    // There is one Chinese template, Simplified; zh-Hant reads it too.
    expect(mailTemplateLocale("zh-Hant")).toBe("zh");
    expect(mailTemplateLocale("ko-KR")).toBe("ko");
    expect(mailTemplateLocale("xx")).toBeNull();
  });
  test("order: the account's language, then signupLocale, then en", () => {
    expect(inviterMailLocale({ accountLocale: "ja", signupLocale: "zh-Hans" })).toBe("ja");
    expect(inviterMailLocale({ accountLocale: null, signupLocale: "zh-Hans" })).toBe("zh");
    expect(inviterMailLocale({ accountLocale: "nope", signupLocale: "de" })).toBe("de");
    expect(inviterMailLocale({})).toBe("en");
  });
  test("signupLocale is written once and never overwritten", async () => {
    addUser("new", "new.user@example.com");
    const db = raw as unknown as InviteDb;
    expect(await recordSignupLocale(db, "new", "zh-CN,zh;q=0.9")).toBe("zh-Hans");
    await recordSignupLocale(db, "new", "en-US");
    expect(rows("SELECT signupLocale FROM user WHERE id = 'new'")[0]!.signupLocale).toBe("zh-Hans");
    expect(await recordSignupLocale(db, "trial", null)).toBeNull();
    expect(rows("SELECT signupLocale FROM user WHERE id = 'trial'")[0]!.signupLocale).toBeNull();
  });
  test("the mail goes out in the inviter's account language", async () => {
    setUiLocale("pro", "zh");
    expect((await invite()).status).toBe(200);
    expect(mails[0]!.subject).toBe("snomiao 邀请你加入炼記（Lianki）");
    expect(mails[0]!.text.split("\n")[0]).toBe("邀请人：snomiao");
  });
  test("no account language: signupLocale; neither: English", async () => {
    raw.raw().prepare("UPDATE user SET signupLocale = 'zh-Hans' WHERE id = 'pro'").run();
    await invite("a.friend@example.org");
    expect(mails[0]!.subject).toContain("邀请你");
    raw.raw().prepare("UPDATE user SET signupLocale = NULL WHERE id = 'pro'").run();
    await invite("b.friend@example.org");
    expect(mails[1]!.subject).toBe("snomiao invited you to Lianki");
  });
});

describe("who may send", () => {
  test("the rule: admins always, Pro only with the flag", () => {
    const on = { "membership.email-invite": true } as FlagValues;
    expect(canEmailInvite({ admin: true, pro: false, flags: {} })).toBe(true);
    expect(canEmailInvite({ admin: false, pro: true, flags: on })).toBe(true);
    expect(canEmailInvite({ admin: false, pro: true, flags: {} })).toBe(false);
    expect(canEmailInvite({ admin: false, pro: false, flags: on })).toBe(false);
  });
  test("trial user: 404, status says not allowed", async () => {
    me = { id: "trial", email: "trial.user@example.com" };
    expect((await invite()).status).toBe(404);
    expect(await status()).toEqual({ allowed: false });
    expect(mails).toHaveLength(0);
  });
  test("Pro with the flag off: 404; admin with it off: sends", async () => {
    flags = {};
    expect((await invite()).status).toBe(404);
    me = { id: "admin", email: "admin.user@example.com" };
    expect((await invite()).status).toBe(200);
    expect(mails).toHaveLength(1);
  });
  test("expired Pro: 404", async () => {
    now = T0 + 31 * DAY;
    expect((await invite()).status).toBe(404);
  });
  test("guest 401, another site 403, no mail provider 503", async () => {
    me = null;
    expect((await invite()).status).toBe(401);
    me = { id: "pro", email: "pro.user@example.com" };
    const cross = sendEmailInvite(
      post(
        "/api/invite/email",
        { email: FRIEND },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      ),
      deps,
    );
    expect((await cross).status).toBe(403);
    deps.mailOn = () => false;
    expect((await invite()).status).toBe(503);
  });
});

describe("one address per request", () => {
  test("lists, display-name forms and junk are refused", async () => {
    for (const bad of [
      "a.one@example.org,b.two@example.org",
      "a.one@example.org; b.two@example.org",
      "a.one@example.org b.two@example.org",
      "Ann <a.one@example.org>",
      "not-an-address",
      ["a.one@example.org"],
      "",
    ]) {
      expect(oneAddress(bad)).toBeNull();
      expect((await invite(bad)).status).toBe(400);
    }
    expect(mails).toHaveLength(0);
    expect(oneAddress(" Friend.One@Example.org ")).toBe("friend.one@example.org");
  });
});

describe("per-inviter daily limit", () => {
  test(`${EMAIL_INVITE.perInviterPerDay} a day, then 429; the window rolls`, async () => {
    for (let i = 0; i < EMAIL_INVITE.perInviterPerDay; i++)
      expect((await invite(`f${i}@example.org`)).status).toBe(200);
    const over = await invite("one.more@example.org");
    expect(over.status).toBe(429);
    expect(mails).toHaveLength(EMAIL_INVITE.perInviterPerDay);
    expect((await status()).remaining).toBe(0);
    now = T0 + DAY + 1;
    expect((await invite("one.more@example.org")).status).toBe(200);
  });
  test("skipped addresses count too (no probing), failed sends do not", async () => {
    addUser("has", "has.account@example.org");
    await invite("has.account@example.org");
    expect((await status()).remaining).toBe(EMAIL_INVITE.perInviterPerDay - 1);
    failSend = true;
    expect((await invite("x.friend@example.org")).status).toBe(502);
    expect((await status()).remaining).toBe(EMAIL_INVITE.perInviterPerDay - 1);
    failSend = false;
    // A failed send gave the address's window back.
    expect((await invite("x.friend@example.org")).status).toBe(200);
    expect(mails).toHaveLength(1);
  });
});

describe("one invite per address per window, from anyone", () => {
  test(`a second inviter within ${EMAIL_INVITE.perRecipientDays} days: neutral, no mail`, async () => {
    await invite("dot.ted@gmail.com");
    me = { id: "pro2", email: "pro.two@example.com" };
    // The same mailbox in another form (lib/canonical-email.ts).
    const again = await invite("dotted+x@gmail.com");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "sent" });
    expect(mails).toHaveLength(1);
    now = T0 + EMAIL_INVITE.perRecipientDays * DAY + 1;
    flags = { "membership.email-invite": true };
    raw
      .raw()
      .prepare("UPDATE user SET proEndsAt = ? WHERE id = 'pro2'")
      .run(new Date(now + DAY).toISOString());
    expect((await invite("dotted@gmail.com")).status).toBe(200);
    expect(mails).toHaveLength(2);
  });
  test("an address with an account, or the inviter's own: the same neutral answer, no mail", async () => {
    addUser("has", "has.account@example.org");
    const a = await invite("has.account@example.org");
    const b = await invite("pro.user@example.com");
    const c = await invite("fresh.friend@example.org");
    const body = async (r: Response) => {
      const j = (await r.json()) as Record<string, unknown>;
      delete j.remaining;
      return j;
    };
    expect(await body(a)).toEqual(await body(c));
    expect(a.status).toBe(b.status);
    expect(mails.map((m) => m.to)).toEqual(["fresh.friend@example.org"]);
    expect(
      rows("SELECT status FROM invite_email_log ORDER BY createdAt, rowid").map((r) => r.status),
    ).toEqual(["skipped-account", "skipped-account", "sent"]);
  });
});

describe("unsubscribe, report, suppression", () => {
  test("RFC 8058 one-click suppresses the address; idempotent; every later invite skips it", async () => {
    await invite();
    const token = decodeURIComponent(tokenOf(mails[0]!));
    expect((await oneClick(token)).status).toBe(200);
    expect((await oneClick(token)).status).toBe(200);
    expect(rows("SELECT reason FROM invite_email_suppression")).toEqual([
      { reason: "unsubscribe" },
    ]);
    now = T0 + 400 * DAY;
    me = { id: "admin", email: "admin.user@example.com" };
    expect((await invite(FRIEND)).status).toBe(200);
    expect(mails).toHaveLength(1);
  });
  test("tokens cannot be forged or moved to another mail", async () => {
    await invite();
    const token = decodeURIComponent(tokenOf(mails[0]!));
    const [id] = token.split(".");
    expect(await verifyOptOut(SECRET, token)).toBe(id!);
    expect(await verifyOptOut("y".repeat(40), token)).toBeNull();
    const other = await signOptOut("y".repeat(40), id!);
    expect((await oneClick(other)).status).toBe(400);
    expect((await oneClick(`${crypto.randomUUID()}.${token.split(".")[1]}`)).status).toBe(400);
    expect(rows("SELECT * FROM invite_email_suppression")).toHaveLength(0);
  });
  test("one-click needs its form body; the page needs same-origin JSON", async () => {
    await invite();
    const token = decodeURIComponent(tokenOf(mails[0]!));
    const noBody = await inviteOptOut(
      new Request(`${BASE}/api/invite/email/opt-out?t=${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      deps,
    );
    expect(noBody.status).toBe(400);
    const cross = await pageAction(token, "unsubscribe", {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(cross.status).toBe(403);
    expect((await pageAction(token, "unsubscribe")).status).toBe(200);
  });
  test(`a report suppresses and marks; ${EMAIL_INVITE.blockAfterReports} reports block the inviter, quietly`, async () => {
    for (let i = 0; i < EMAIL_INVITE.blockAfterReports; i++) {
      await invite(`victim${i}@example.org`);
      const token = decodeURIComponent(tokenOf(mails[i]!));
      expect((await pageAction(token, "report")).status).toBe(200);
    }
    expect(rows("SELECT reason FROM invite_email_suppression").map((r) => r.reason)).toEqual(
      Array(EMAIL_INVITE.blockAfterReports).fill("abuse"),
    );
    const n = mails.length;
    const blocked = await invite("another.one@example.org");
    expect(blocked.status).toBe(200);
    expect(mails).toHaveLength(n);
    expect(
      rows("SELECT status FROM invite_email_log ORDER BY createdAt DESC, rowid DESC LIMIT 1")[0]!
        .status,
    ).toBe("skipped-blocked");
  });
  test("unsubscribe, then report: the reason becomes abuse", async () => {
    await invite();
    const token = decodeURIComponent(tokenOf(mails[0]!));
    await pageAction(token, "unsubscribe");
    await pageAction(token, "report");
    expect(rows("SELECT reason FROM invite_email_suppression")).toEqual([{ reason: "abuse" }]);
  });
});

describe("masking and hashing", () => {
  test("no table and no log line holds the address; history is masked and the inviter's own", async () => {
    await invite("secret.friend@example.org");
    const dump = JSON.stringify(
      [
        "invite_email_log",
        "invite_email_recipient",
        "invite_email_suppression",
        "auth_throttle",
      ].map((t) => rows(`SELECT * FROM ${t}`)),
    );
    expect(dump).not.toContain("secret.friend@example.org");
    expect(dump).not.toContain("secret.friend");
    const s = await status();
    expect(s.history).toEqual([{ to: "s***@example.org", at: T0 }]);
    me = { id: "pro2", email: "pro.two@example.com" };
    expect((await status()).history).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("@");
  });
});

describe("the mail", () => {
  test("who invited, the link, the footer and the headers", async () => {
    await invite();
    const m = mails[0]!;
    expect(m.subject).toBe("snomiao invited you to Lianki");
    expect(m.text.split("\n")[0]).toBe("Invited by snomiao");
    const code = rows("SELECT code FROM invite_code WHERE userId = 'pro'")[0]!.code as string;
    expect(m.text).toContain(`${BASE}/i/${code}`);
    expect(m.html).toContain(`${BASE}/i/${code}`);
    expect(m.text).toContain("Unsubscribe");
    expect(m.text).toContain("Report abuse");
    expect(m.text).toContain("https://lianki.com/contacts");
    expect(m.text).toContain("one-time invitation");
    expect(m.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.headers!["List-Unsubscribe"]).toMatch(
      /^<https:\/\/lianki\.com\/api\/invite\/email\/opt-out\?t=.+>$/,
    );
    // The page links carry the token in the fragment only.
    expect(m.text).toMatch(/invite-opt-out\?lang=en#t=/);
  });
  test("a name that reads like a link or an address is not put into the mail", () => {
    expect(mailDisplayName("snomiao")).toBe("snomiao");
    expect(mailDisplayName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    for (const bad of ["visit evil.com", "http://x", "me@example.org", "www.spam", "", null, "‮"])
      expect(mailDisplayName(bad)).toBeNull();
    const m = previewInviteMail({ locale: "zh", inviterName: "win at spam.biz" });
    expect(m.subject).toBe("一位朋友 邀请你加入炼記（Lianki）");
    expect(m.html).not.toContain("spam.biz");
  });
  test("HTML is escaped; Arabic and Urdu are right-to-left", () => {
    const m = renderInviteMail({
      locale: "ar",
      inviterName: "A&B \"x\" 'y'",
      inviteUrl: `${BASE}/i/ABCD`,
      optOutUrl: `${BASE}/o#t=1`,
      reportUrl: `${BASE}/o#t=1&report=1`,
      oneClickUrl: `${BASE}/api/invite/email/opt-out?t=1`,
    });
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain("A&amp;B &quot;x&quot; &#39;y&#39;");
  });
  test("every locale renders fully, with no placeholder left", () => {
    for (const l of [
      "en",
      "zh",
      "hi",
      "es",
      "fr",
      "ar",
      "bn",
      "pt",
      "ru",
      "ur",
      "id",
      "de",
      "ja",
      "sw",
      "mr",
      "ko",
    ] as const) {
      const m = previewInviteMail({ locale: l, inviterName: "snomiao", code: "ABCD2345" });
      expect({ l, left: /\{\w+\}/.test(m.subject + m.text) }).toEqual({ l, left: false });
      expect(m.subject).toContain("snomiao");
      expect(m.text).toContain("/i/ABCD2345");
    }
  });
  test("zh: complete and Simplified", () => {
    const m = previewInviteMail({ locale: "zh", inviterName: "snomiao" });
    expect(m.text).toContain("邀请人：snomiao");
    expect(m.text).toContain("退订");
    expect(m.text).toContain("举报滥用");
    expect(m.text).toContain("120 天");
    // Traditional-only forms must not appear (炼記 is the brand's own spelling).
    expect(m.text).not.toMatch(/請|們|這|郵|訂|舉|濫/);
  });
});

describe("a local server never mails anyone", () => {
  test("localhost / 127.0.0.1 origins are stubbed; deployed ones are not", () => {
    expect(isLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:8787/")).toBe(true);
    expect(isLocalOrigin("https://lianki.com")).toBe(false);
    expect(isLocalOrigin("https://localhost.evil.example")).toBe(false);
  });
});

describe("malformed input and failures fail closed", () => {
  test("a stored ui.locale that is not JSON, or a prefs read that throws: the next fallback", async () => {
    raw.raw().prepare("UPDATE user SET signupLocale = 'ja-JP' WHERE id = 'pro'").run();
    raw
      .raw()
      .prepare(
        "INSERT INTO user_prefs (user_id, key, value, hlc_ts, hlc_counter, device_id, updated_ms) VALUES ('pro', 'ui.locale', '{not json', 1, 0, 'd', 1)",
      )
      .run();
    const db = raw as unknown as InviteDb;
    expect(await inviterLocale(db, "pro")).toBe("ja");
    const throwing = {
      prepare: (sql: string) =>
        sql.includes("user_prefs")
          ? { bind: () => ({ first: () => Promise.reject(new Error("d1 down")) }) }
          : db.prepare(sql),
    } as unknown as InviteDb;
    expect(await inviterLocale(throwing, "pro")).toBe("ja");
  });
  test("a send body that is not JSON, too long, or already read: 400, nothing sent", async () => {
    const bad = (body: string) =>
      new Request(`${BASE}/api/invite/email`, {
        method: "POST",
        headers: {
          host: "lianki.com",
          origin: BASE,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body,
      });
    expect((await sendEmailInvite(bad("{nope"), deps)).status).toBe(400);
    expect((await sendEmailInvite(bad(" ".repeat(3000)), deps)).status).toBe(400);
    const used = bad(JSON.stringify({ email: FRIEND }));
    await used.text();
    expect((await sendEmailInvite(used, deps)).status).toBe(400);
    expect(mails).toHaveLength(0);
  });
  test("opt-out: unknown content type, bad JSON, broken form, unknown action: 400", async () => {
    const req = (type: string, body: string) =>
      new Request(`${BASE}/api/invite/email/opt-out?t=x`, {
        method: "POST",
        headers: {
          host: "lianki.com",
          origin: BASE,
          "sec-fetch-site": "same-origin",
          "content-type": type,
        },
        body,
      });
    expect((await inviteOptOut(req("text/plain", "x"), deps)).status).toBe(400);
    expect((await inviteOptOut(req("application/json", "{nope"), deps)).status).toBe(400);
    expect((await inviteOptOut(req("multipart/form-data", "garbage"), deps)).status).toBe(400);
    expect((await pageAction("x", "delete-everything")).status).toBe(400);
  });
  test("opt-out: a short or missing secret verifies nothing", async () => {
    await invite();
    const token = decodeURIComponent(tokenOf(mails[0]!));
    expect(await verifyOptOut(undefined, token)).toBeNull();
    expect(await verifyOptOut("short", token)).toBeNull();
    expect(await verifyOptOut(SECRET, 42)).toBeNull();
  });
  test("opt-out: past the per-IP limit, 429", async () => {
    for (let i = 0; i < EMAIL_INVITE.optOutPerIp.max; i++) await oneClick("x");
    expect((await oneClick("x")).status).toBe(429);
  });
  test("a GET on the one-click URL only redirects to the page, in the mail's language", () => {
    const r = optOutGet(new Request(`${BASE}/api/invite/email/opt-out?t=abc&lang=zh`), BASE);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${BASE}/membership/invite-opt-out?lang=zh#t=abc`);
    const en = optOutGet(new Request(`${BASE}/api/invite/email/opt-out`), BASE);
    expect(en.headers.get("location")).toBe(`${BASE}/membership/invite-opt-out?lang=en#t=`);
  });
});
