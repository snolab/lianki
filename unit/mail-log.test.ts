/**
 * The send log (lib/mail-log, docs/mail-templates.md "Send log"): the row
 * written in the one send path (queued → sent / failed), that sign-in codes,
 * links and tokens never reach it, status moves from Resend's webhook and the
 * invite opt-out (forward only), deletion with the account, the masked copy of
 * old invite rows, and /api/dev/mails: the gate, list, filters, per-day
 * counts, re-render, suppression, and the Resend rules. Fake addresses only;
 * every send is a stub — no mail leaves.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { SendEmailInput } from "../lib/email";
import { withMailLog } from "../lib/mail-log/send";
import {
  applyEventStatus,
  findForEvent,
  markSent,
  shortReason,
  type MailLogDb,
} from "../lib/mail-log/store";
import {
  RESENDS,
  jstDay,
  mailsGet,
  mailsPost,
  type MailsDb,
  type MailsDeps,
} from "../lib/mail-log/route";
import {
  MAIL_LOG_TAG,
  parseVars,
  placeholderUrl,
  rerenderValues,
  storedVars,
} from "../lib/mail-log/vars";
import { composeMail } from "../lib/mail-templates/compose";
import type { TemplateDb } from "../lib/mail-templates/store";
import {
  applyOptOut,
  sendEmailInvite,
  type EmailInviteDeps,
  type InviteDb,
} from "../lib/referrals/email-invite";
import { recipientHash } from "../lib/referrals/recipient-hash";
import { applyResendEvent, mailLogTag } from "../lib/resend-webhook";

const DIR = new URL("../db/migrations/", import.meta.url);
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(new URL(f, DIR), "utf8");
const SCHEMA = FILES.map(sql).join("\n");

const BASE = "https://lianki.com";
const T0 = Date.parse("2027-01-15T03:00:00Z"); // 12:00 JST
const SECRET = "s".repeat(40);
const FRIEND = "friend.one@example.org";
const ME = "me.user@example.com";

let raw: ReturnType<typeof createTestD1>;
let now: number;
let sent: SendEmailInput[];
let failSend: boolean;
let logs: string[];
let spies: ReturnType<typeof spyOn>[];

const db = () => raw as unknown as MailsDb;
const rows = (q: string, ...args: (string | number)[]) =>
  raw
    .raw()
    .prepare(q)
    .all(...args)
    .map((r) => ({ ...r })) as Record<string, any>[];
const exec = (q: string, ...args: (string | number | null)[]) =>
  raw
    .raw()
    .prepare(q)
    .run(...args);
const addUser = (id: string, email: string, name = "N", proDays: number | null = null) =>
  exec(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical, proEndsAt) VALUES (?, ?, ?, 1, 'x', 'x', ?, ?)",
    id,
    name,
    email,
    email,
    proDays === null ? null : new Date(T0 + proDays * 86_400_000).toISOString(),
  );

const fakeSend = async (m: SendEmailInput) => {
  if (failSend) throw new Error(`provider down for ${m.to}`);
  sent.push(m);
  return { id: `re_${sent.length}` };
};
const logged = () =>
  withMailLog(
    () => db(),
    fakeSend,
    () => now,
  );

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  now = T0;
  sent = [];
  failSend = false;
  logs = [];
  const keep = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  spies = [
    spyOn(console, "error").mockImplementation(keep),
    spyOn(console, "log").mockImplementation(keep),
  ];
  addUser("me", ME, "Me", 30);
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

const noAddressLogged = () => {
  for (const l of logs) expect(l).not.toMatch(/@example\.(org|com)/);
};

// ── Variables ────────────────────────────────────────────────────────────────

describe("what is kept of a mail's variables", () => {
  test("sign-in code and link, confirm link: nothing", () => {
    expect(storedVars("signin-code", { code: "482913" })).toBeNull();
    expect(storedVars("signin-link", { url: "https://lianki.com/x?token=abc" })).toBeNull();
    expect(storedVars("email-confirm", { url: "https://lianki.com/c#t" })).toBeNull();
  });
  test("invite: never its links or tokens, never the address (the row has it)", () => {
    const v = storedVars("invite", {
      inviter: "snomiao",
      address: FRIEND,
      inviteUrl: "https://lianki.com/i/CODE",
      unsubscribeUrl: "https://lianki.com/u?t=tok",
      reportUrl: "https://lianki.com/r?t=tok",
      extraDays: 7,
      postal: "",
      site: null,
    });
    expect(v).toEqual({ inviter: "snomiao", extraDays: "7" });
  });
  test("login notice keeps its lines; long values are cut; unknown template or no values: null", () => {
    const v = storedVars("login-notice", {
      time: "t",
      location: "x".repeat(900),
      browser: "b",
      contactUrl: "https://lianki.com/contact",
      extra: "no",
    })!;
    expect(Object.keys(v).sort()).toEqual(["browser", "contactUrl", "location", "time"]);
    expect(v.location!.length).toBe(500);
    expect(storedVars("nope", { a: "b" })).toBeNull();
    expect(storedVars("login-notice", null)).toBeNull();
  });
  test("re-render: placeholders for what was not kept, the recipient as an invite's address", () => {
    const code = rerenderValues("signin-code", null, ME);
    expect(code).toEqual({ values: { code: "{code}" }, placeholders: ["code"] });
    const link = rerenderValues("signin-link", { url: "https://evil.example/" }, ME);
    expect(link.values.url).toBe(placeholderUrl("url"));
    const inv = rerenderValues("invite", { inviter: "snomiao", address: "x" }, FRIEND);
    expect(inv.values.address).toBe(FRIEND);
    expect(inv.values.inviter).toBe("snomiao");
    expect(inv.placeholders.sort()).toEqual(["inviteUrl", "reportUrl", "unsubscribeUrl"]);
  });
  test("parseVars: a flat object of strings, anything else dropped", () => {
    expect(parseVars(null)).toBeNull();
    expect(parseVars("{bad")).toBeNull();
    expect(parseVars("[1]")).toBeNull();
    expect(parseVars("null")).toBeNull();
    expect(parseVars('{"a":"b","n":1}')).toEqual({ a: "b" });
  });
  test("shortReason cuts addresses and length", () => {
    expect(shortReason(`no mailbox ${FRIEND} here`)).toBe("no mailbox <address> here");
    expect(shortReason("x".repeat(300)).length).toBe(200);
  });
});

// ── The send path ────────────────────────────────────────────────────────────

describe("the send path writes the log", () => {
  test("a sign-in code: queued → sent, message id, tag; the code and link are stored nowhere", async () => {
    const tdb = raw as unknown as TemplateDb;
    const code = await composeMail(tdb, "signin-code", "en", { code: "482913" });
    const link = await composeMail(tdb, "signin-link", "ja", {
      url: "https://lianki.com/api/auth/magic-link/verify?token=SECRETTOKEN",
    });
    const send = logged();
    expect(await send({ to: ME, ...code })).toEqual({ id: "re_1" });
    await send({ to: ME, ...link });
    const r = rows("SELECT * FROM mail_log ORDER BY created_at, template");
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({
      template: "signin-code",
      version: 0,
      locale: "en",
      recipient: ME,
      recipient_hash: await recipientHash(ME),
      status: "sent",
      provider_id: "re_1",
      vars: null,
    });
    expect(r[1]).toMatchObject({ template: "signin-link", locale: "ja", vars: null });
    const dump = JSON.stringify(rows("SELECT * FROM mail_log"));
    expect(dump).not.toContain("482913");
    expect(dump).not.toContain("SECRETTOKEN");
    // The tag names the row; `log` never reaches the provider.
    expect(sent[0]!.tags).toEqual([{ name: MAIL_LOG_TAG, value: r[0]!.id }]);
    expect("log" in sent[0]!).toBe(false);
    noAddressLogged();
  });

  test("whatever a caller passes, only allow-listed variables are written", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: { template: "signin-code", version: 0, locale: "en", vars: { code: "999111" } },
    });
    expect(rows("SELECT vars FROM mail_log")[0]!.vars).toBeNull();
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: {
        template: "login-notice",
        version: 3,
        locale: "de",
        vars: { time: "t", secret: "no" },
        userId: "me",
      },
    });
    const r = rows("SELECT * FROM mail_log WHERE template = 'login-notice'")[0]!;
    expect(JSON.parse(r.vars)).toEqual({ time: "t" });
    expect(r.version).toBe(3);
    expect(r.user_id).toBe("me");
  });

  test("a refused send: failed with a short reason (no address), and the error is thrown", async () => {
    failSend = true;
    await expect(
      logged()({ to: FRIEND, subject: "s", text: "t", tags: [{ name: "a", value: "b" }] }),
    ).rejects.toThrow("provider down");
    const r = rows("SELECT * FROM mail_log")[0]!;
    expect(r.status).toBe("failed");
    expect(r.template).toBe("unknown");
    expect(r.reason).toContain("<address>");
    expect(r.reason).not.toContain(FRIEND);
  });

  test("no D1: the mail goes out untagged and unlogged; a D1 error never blocks it", async () => {
    await withMailLog(() => null, fakeSend)({ to: ME, subject: "s", text: "t" });
    expect(sent[0]!.tags).toBeUndefined();
    const broken = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as MailLogDb;
    await withMailLog(() => broken, fakeSend)({ to: ME, subject: "s", text: "t" });
    expect(sent.length).toBe(2);
    expect(logs.some((l) => l.includes("mail-log.write-failed"))).toBe(true);
    noAddressLogged();
  });

  test("the status write after the send fails: reported, the mail's outcome stands", async () => {
    const flaky = {
      prepare: (q: string) => {
        if (q.trimStart().startsWith("UPDATE")) throw new Error("d1 busy");
        return raw.prepare(q);
      },
    } as unknown as MailLogDb;
    expect(await withMailLog(() => flaky, fakeSend)({ to: ME, subject: "s", text: "t" })).toEqual({
      id: "re_1",
    });
    failSend = true;
    await expect(
      withMailLog(() => flaky, fakeSend)({ to: ME, subject: "s", text: "t" }),
    ).rejects.toThrow("provider down");
    expect(logs.filter((l) => l.includes("mail-log.write-failed")).length).toBe(2);
    noAddressLogged();
  });

  test("a provider answer without an id: sent, no message id", async () => {
    const odd = withMailLog(
      () => db(),
      async () => "ok",
      () => now,
    );
    expect(await odd({ to: ME, subject: "s", text: "t" })).toEqual({ id: "" });
    expect(rows("SELECT status, provider_id FROM mail_log")[0]).toEqual({
      status: "sent",
      provider_id: null,
    });
  });
});

// ── Status ───────────────────────────────────────────────────────────────────

async function oneRow(extra: Partial<SendEmailInput> = {}) {
  await logged()({
    to: FRIEND,
    subject: "s",
    text: "t",
    log: { template: "login-notice", version: 0, locale: "en", userId: "me" },
    ...extra,
  });
  return rows("SELECT id FROM mail_log ORDER BY rowid DESC LIMIT 1")[0]!.id as string;
}
const statusOf = (id: string) => rows("SELECT status FROM mail_log WHERE id = ?", id)[0]!.status;

describe("status only moves forward", () => {
  test("delivered → complained; a late delivered or bounce changes nothing", async () => {
    const id = await oneRow();
    expect(await applyEventStatus(db(), { id }, "delivered", now)).toBe(true);
    expect(statusOf(id)).toBe("delivered");
    expect(await applyEventStatus(db(), { id }, "complained", now, "complaint")).toBe(true);
    expect(await applyEventStatus(db(), { id }, "delivered", now)).toBe(false);
    expect(await applyEventStatus(db(), { id }, "bounced", now)).toBe(false);
    expect(statusOf(id)).toBe("complained");
    // The provider's late answer keeps the status, records the id.
    await markSent(db(), id, "re_late", now);
    expect(rows("SELECT status, provider_id FROM mail_log WHERE id = ?", id)[0]).toEqual({
      status: "complained",
      provider_id: "re_late",
    });
  });
  test("a failed mail stays failed", async () => {
    failSend = true;
    await oneRow().catch(() => {});
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    expect(await applyEventStatus(db(), { id }, "delivered", now)).toBe(false);
    expect(statusOf(id)).toBe("failed");
  });
  test("findForEvent: by tag, else by message id, else nothing", async () => {
    const id = await oneRow();
    expect(await findForEvent(db(), id, null)).toBe(id);
    expect(await findForEvent(db(), "00000000-0000-0000-0000-000000000000", "re_1")).toBe(id);
    expect(await findForEvent(db(), null, "re_none")).toBeNull();
    expect(await findForEvent(db(), null, null)).toBeNull();
  });
});

describe("Resend's webhook moves the row", () => {
  test("email.delivered by tag (object or array form); bounce and complaint by message id", async () => {
    const a = await oneRow();
    const b = await oneRow();
    const c = await oneRow();
    expect(mailLogTag({ [MAIL_LOG_TAG]: a })).toBe(a);
    expect(mailLogTag([{ name: MAIL_LOG_TAG, value: a }])).toBe(a);
    expect(mailLogTag({ [MAIL_LOG_TAG]: "nope" })).toBeNull();
    const r = await applyResendEvent(
      raw as never,
      { type: "email.delivered", data: { tags: { [MAIL_LOG_TAG]: a } } },
      now,
    );
    expect(r).toEqual({ status: "done", reason: "delivered", linked: true });
    expect(statusOf(a)).toBe("delivered");
    await applyResendEvent(
      raw as never,
      {
        type: "email.bounced",
        data: { email_id: "re_2", to: [FRIEND], bounce: { type: "Permanent" } },
      },
      now,
    );
    expect(statusOf(b)).toBe("bounced");
    expect(rows("SELECT reason FROM mail_log WHERE id = ?", b)[0]!.reason).toBe("hard-bounce");
    await applyResendEvent(
      raw as never,
      { type: "email.complained", data: { tags: [{ name: MAIL_LOG_TAG, value: c }] } },
      now,
    );
    expect(statusOf(c)).toBe("complained");
    // A delivery after the complaint does not undo it.
    await applyResendEvent(
      raw as never,
      { type: "email.delivered", data: { tags: { [MAIL_LOG_TAG]: c } } },
      now,
    );
    expect(statusOf(c)).toBe("complained");
  });
  test("a delivery for no logged mail, or a soft bounce: ignored", async () => {
    const id = await oneRow();
    expect(
      await applyResendEvent(
        raw as never,
        { type: "email.delivered", data: { email_id: "x" } },
        now,
      ),
    ).toEqual({ status: "ignored" });
    expect(
      await applyResendEvent(
        raw as never,
        { type: "email.bounced", data: { email_id: "re_1", bounce: { type: "Transient" } } },
        now,
      ),
    ).toEqual({ status: "ignored" });
    expect(statusOf(id)).toBe("sent");
  });
});

// ── Invites: opt-out, resend ─────────────────────────────────────────────────

const post = (body: unknown, h: Record<string, string> = {}) =>
  new Request(`${BASE}/api/dev/mails`, {
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

const inviteDeps = (): EmailInviteDeps => ({
  who: async () => ({ id: "me", email: ME }),
  db: () => raw as unknown as InviteDb,
  send: logged(),
  mailOn: () => true,
  secret: () => SECRET,
  flags: async () => ({}),
  isAdmin: () => true,
  origin: () => BASE,
  now: () => now,
});
const invite = (email = FRIEND) =>
  sendEmailInvite(post({ email }, {}), inviteDeps()).then((r) => r.json());

describe("invites in the log", () => {
  test("an invite row: inviter, invite log id, no link kept; unsubscribe and report move it", async () => {
    await invite();
    await invite("other.friend@example.org");
    const r = rows("SELECT * FROM mail_log ORDER BY created_at, recipient");
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ template: "invite", inviter_id: "me", status: "sent" });
    expect(JSON.parse(r[0]!.vars)).toEqual(
      expect.not.objectContaining({ inviteUrl: expect.anything() }),
    );
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("/i/");
    expect(dump).not.toContain("opt-out");
    const ids = r.map((x) => x.invite_log_id as string);
    await applyOptOut(raw as unknown as InviteDb, ids[0]!, "unsubscribe", now);
    await applyOptOut(raw as unknown as InviteDb, ids[1]!, "report", now);
    expect(rows("SELECT status FROM mail_log WHERE invite_log_id = ?", ids[0]!)[0]!.status).toBe(
      "unsubscribed",
    );
    expect(rows("SELECT status, reason FROM mail_log WHERE invite_log_id = ?", ids[1]!)[0]).toEqual(
      {
        status: "complained",
        reason: "abuse-report",
      },
    );
  });
});

// ── Deletion, old rows ───────────────────────────────────────────────────────

describe("with the account, and before the log", () => {
  test("deleting a user deletes mail to it, about it, and its invites", async () => {
    addUser("other", "other.user@example.com");
    await oneRow({ to: "OTHER.user@example.com" }); // to it, by address
    await logged()({
      to: FRIEND,
      subject: "s",
      text: "t",
      log: { template: "email-changed", version: 0, locale: "en", userId: "other" },
    });
    await logged()({
      to: FRIEND,
      subject: "s",
      text: "t",
      log: { template: "invite", version: 0, locale: "en", inviterId: "other" },
    });
    await oneRow(); // someone else's
    expect(rows("SELECT COUNT(*) AS n FROM mail_log")[0]!.n).toBe(4);
    exec("DELETE FROM user WHERE id = 'other'");
    expect(rows("SELECT COUNT(*) AS n FROM mail_log")[0]!.n).toBe(1);
  });

  test("old invite rows are copied masked, statuses mapped, skipped ones left out", () => {
    const d = createTestD1(
      FILES.filter((f) => f < "0066")
        .map(sql)
        .join("\n"),
    );
    const ins = (id: string, status: string, reportedAt: number | null) =>
      d
        .raw()
        .prepare(
          "INSERT INTO invite_email_log (id, inviterId, recipientHash, recipientMasked, locale, status, providerId, createdAt, reportedAt) VALUES (?, 'u', 'h', 'f***@example.com', 'zh', ?, 'p', 5, ?)",
        )
        .run(id, status, reportedAt);
    d.raw()
      .prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u', 'U', 'u@example.com', 1, 'x', 'x')",
      )
      .run();
    ins("a", "sent", null);
    ins("b", "pending", null);
    ins("c", "sent", 9);
    ins("d", "skipped-recent", null);
    ins("e", "failed", null);
    d.raw().exec(sql(FILES.find((f) => f.startsWith("0066"))!));
    const got = d
      .raw()
      .prepare(
        "SELECT id, status, recipient, recipient_masked AS m, invite_log_id AS l FROM mail_log ORDER BY id",
      )
      .all()
      .map((r) => ({ ...r }));
    expect(got).toEqual([
      { id: "a", status: "sent", recipient: "f***@example.com", m: 1, l: "a" },
      { id: "b", status: "queued", recipient: "f***@example.com", m: 1, l: "b" },
      { id: "c", status: "complained", recipient: "f***@example.com", m: 1, l: "c" },
      { id: "e", status: "failed", recipient: "f***@example.com", m: 1, l: "e" },
    ]);
  });
});

// ── /api/dev/mails ───────────────────────────────────────────────────────────

const who = { id: "dev1" };
const deps = (o: Partial<MailsDeps> = {}): MailsDeps => ({
  db: () => db(),
  send: logged(),
  origin: () => BASE,
  secret: () => SECRET,
  now: () => now,
  ...o,
});
const get = async (q = "", w: typeof who | null = who, d = deps()) => {
  const r = await mailsGet(new Request(`${BASE}/api/dev/mails${q}`), w, d);
  return {
    status: r.status,
    body: r.status === 404 && !(await r.clone().text()) ? null : await r.json(),
  };
};
const act = async (body: unknown, h: Record<string, string> = {}, d = deps()) => {
  const r = await mailsPost(post(body, h), who, d);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

describe("/api/dev/mails", () => {
  test("gate: not a developer, or no D1 — an empty 404, read or write", async () => {
    expect((await get("", null)).status).toBe(404);
    expect((await get("", who, deps({ db: () => null }))).status).toBe(404);
    expect((await mailsPost(post({ op: "resend" }), null, deps())).status).toBe(404);
    expect((await act({ op: "resend" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await act({ op: "nope" })).status).toBe(400);
    expect((await act({ op: "resend", id: "missing" })).status).toBe(404);
    expect((await act({ op: "resend", id: 5 })).status).toBe(404);
  });

  test("list: newest first, filters, search by address or message id, paging, per-day counts (JST)", async () => {
    await oneRow();
    now += 60_000;
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: { template: "signin-code", version: 0, locale: "ja" },
    });
    now = T0 + 86_400_000;
    failSend = true;
    await oneRow({ to: "x_y%z@example.net" }).catch(() => {});
    failSend = false;
    const all = await get();
    expect(all.body.total).toBe(3);
    expect(all.body.rows.map((r: any) => r.status)).toEqual(["failed", "sent", "sent"]);
    expect(all.body.rows[1].recipient).toBe(ME);
    expect(all.body.perDay).toEqual([
      { day: "2027-01-16", status: "failed", n: 1 },
      { day: "2027-01-15", status: "sent", n: 2 },
    ]);
    expect((await get("?template=signin-code")).body.total).toBe(1);
    expect((await get("?status=failed")).body.total).toBe(1);
    expect((await get("?locale=ja")).body.total).toBe(1);
    expect((await get("?from=2027-01-16")).body.total).toBe(1);
    expect((await get("?to=2027-01-15")).body.total).toBe(2);
    expect((await get("?q=ME.USER")).body.total).toBe(1);
    expect((await get("?q=re_1")).body.total).toBe(1);
    expect((await get("?q=x_y%25z")).body.total).toBe(1);
    expect((await get("?q=_")).body.total).toBe(1); // `_` is literal, not a wildcard
    // Longer than D1's 50-byte LIKE limit: still found (instr, not LIKE).
    const long = `qa+notice-desktop-light-1794225234752-x@example.net`;
    await oneRow({ to: long });
    expect((await get(`?q=${encodeURIComponent(long)}`)).body.total).toBe(1);
    // Bad filters are ignored, not errors.
    expect((await get("?template=x&status=y&locale=zz&from=bad&page=-1")).body.total).toBe(4);
    expect((await get("?page=1")).body.rows).toEqual([]);
    expect(jstDay("2027-01-15")).toBe(Date.parse("2027-01-14T15:00:00Z"));
    expect(jstDay("2027-13-45")).toBeNull();
    expect(jstDay(null)).toBeNull();
  });

  test("detail: a login notice re-rendered from its kept variables", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: {
        template: "login-notice",
        version: 0,
        locale: "en",
        userId: "me",
        vars: {
          time: "2027-01-15 12:00",
          location: "Tokyo",
          browser: "Firefox",
          contactUrl: "https://lianki.com/contact",
        },
      },
    });
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    const d = (await get(`?id=${id}`)).body;
    expect(d.mail.recipient).toBe(ME);
    expect(d.mail.vars.location).toBe("Tokyo");
    expect(d.rendered.ok).toBe(true);
    expect(d.rendered.placeholders).toEqual([]);
    expect(d.rendered.mail.text).toContain("Tokyo");
    expect(d.resend).toBe("ok");
    expect(d.suppressed).toBe(false);
    expect((await get("?id=nope")).status).toBe(404);
    expect((await get(`?id=${"x".repeat(80)}`)).status).toBe(404);
  });

  test("detail: a sign-in code shows placeholders, never a code", async () => {
    const code = await composeMail(raw as unknown as TemplateDb, "signin-code", "en", {
      code: "482913",
    });
    await logged()({ to: ME, ...code });
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    const d = (await get(`?id=${id}`)).body;
    expect(d.rendered.placeholders).toEqual(["code"]);
    expect(d.rendered.mail.text).toContain("{code}");
    expect(JSON.stringify(d)).not.toContain("482913");
    expect(d.resend).toBe("not-resendable");
  });

  test("detail: a stored version, a missing one, a broken one, a test draft, an unknown template", async () => {
    exec(
      "INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, note, created_by, created_at) VALUES ('email-taken', 'en', 1, 1, 'Taken v1', '<p>v1</p>', 'v1 text', NULL, 'dev', 1)",
    );
    exec(
      "INSERT INTO mail_template_version (template, locale, version, schema, subject, html, text, note, created_by, created_at) VALUES ('email-taken', 'en', 2, 1, 'Broken', '<script>x</script>', 't', NULL, 'dev', 1)",
    );
    const mk = async (template: string, version: number, locale = "en") => {
      await logged()({ to: ME, subject: "s", text: "t", log: { template, version, locale } });
      return rows("SELECT id FROM mail_log ORDER BY rowid DESC LIMIT 1")[0]!.id;
    };
    const v1 = (await get(`?id=${await mk("email-taken", 1)}`)).body;
    expect(v1.rendered.mail.subject).toBe("Taken v1");
    expect((await get(`?id=${await mk("email-taken", 7)}`)).body.rendered).toEqual({
      ok: false,
      error: "version-missing",
    });
    expect((await get(`?id=${await mk("email-taken", 2)}`)).body.rendered.error).toBe(
      "render-failed",
    );
    const draft = (await get(`?id=${await mk("invite", -1)}`)).body;
    expect(draft.rendered.error).toBe("test-draft");
    expect(draft.resend).toBe("not-resendable");
    expect((await get(`?id=${await mk("weird", 0)}`)).body.rendered.error).toBe("unknown-template");
    expect((await get(`?id=${await mk("email-taken", 0, "xx")}`)).body.rendered.error).toBe(
      "unknown-template",
    );
  });

  test("suppress, the suppression list, unsuppress", async () => {
    const id = await oneRow();
    exec(
      "INSERT INTO invite_email_suppression (recipientHash, reason, createdAt) VALUES (?, 'bounce', 1)",
      "f".repeat(64),
    );
    expect((await act({ op: "suppress", id })).body).toEqual({ status: "suppressed" });
    expect((await get(`?id=${id}`)).body.suppressed).toBe(true);
    const list = (await get("?view=suppression")).body;
    expect(list.total).toBe(2);
    expect(list.rows[0]).toMatchObject({ reason: "manual", recipient: FRIEND, masked: false });
    expect(list.rows[1]).toMatchObject({ reason: "bounce", recipient: null, masked: null });
    expect((await act({ op: "unsuppress", hash: "nope" })).status).toBe(400);
    const hash = await recipientHash(FRIEND);
    expect((await act({ op: "unsuppress", hash })).body).toEqual({ removed: true });
    expect((await act({ op: "unsuppress", hash })).body).toEqual({ removed: false });
    expect(
      rows("SELECT kind FROM security_audit WHERE kind LIKE 'mail-log.%' ORDER BY id").map(
        (r) => r.kind,
      ),
    ).toEqual(["mail-log.suppress", "mail-log.unsuppress"]);
  });
});

describe("Resend rules", () => {
  test("a login notice goes again: same address, kept variables, linked to the first", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: {
        template: "login-notice",
        version: 0,
        locale: "en",
        userId: "me",
        vars: { time: "T", location: "Tokyo", browser: "B", contactUrl: "https://lianki.com/c" },
      },
    });
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    expect((await act({ op: "resend", id })).body).toEqual({ status: "sent" });
    expect(sent[1]!.to).toBe(ME);
    expect(sent[1]!.text).toContain("Tokyo");
    const again = rows("SELECT * FROM mail_log WHERE resend_of = ?", id)[0]!;
    expect(again).toMatchObject({ template: "login-notice", user_id: "me", status: "sent" });
    expect(
      rows("SELECT kind, subject FROM security_audit WHERE kind LIKE 'mail-log.%'")[0],
    ).toEqual({
      kind: "mail-log.resend",
      subject: id,
    });
    noAddressLogged();
  });

  test("refused: sign-in mail, masked address, suppressed address, missing values, unknown inviter", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: { template: "signin-link", version: 0, locale: "en" },
    });
    const link = rows("SELECT id FROM mail_log")[0]!.id;
    expect(await act({ op: "resend", id: link })).toEqual({
      status: 409,
      body: { error: "not-resendable" },
    });
    exec(
      "INSERT INTO mail_log (id, created_at, updated_at, template, version, locale, recipient, recipient_masked, recipient_hash, status) VALUES ('old', 1, 1, 'invite', 0, 'zh', 'f***@example.com', 1, 'h', 'sent')",
    );
    expect((await act({ op: "resend", id: "old" })).body.error).toBe("no-address");
    const notice = await oneRow(); // login notice, no variables kept
    expect(await act({ op: "resend", id: notice })).toEqual({
      status: 422,
      body: { error: "cannot-render" },
    });
    await act({ op: "suppress", id: notice });
    expect((await act({ op: "resend", id: notice })).body.error).toBe("suppressed");
    await logged()({
      to: "x@example.net",
      subject: "s",
      text: "t",
      log: { template: "invite", version: 0, locale: "en" },
    });
    const orphan = rows("SELECT id FROM mail_log WHERE recipient = 'x@example.net'")[0]!.id;
    expect((await act({ op: "resend", id: orphan })).body.error).toBe("no-inviter");
    expect(sent.length).toBe(3); // the originals only
  });

  test("the provider fails: 502, the row says failed", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: { template: "email-taken", version: 0, locale: "en" },
    });
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    failSend = true;
    expect((await act({ op: "resend", id })).status).toBe(502);
    expect(rows("SELECT status FROM mail_log WHERE resend_of = ?", id)[0]!.status).toBe("failed");
  });

  test("a developer's resends are rate-limited", async () => {
    await logged()({
      to: ME,
      subject: "s",
      text: "t",
      log: { template: "email-taken", version: 0, locale: "en" },
    });
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    for (let i = 0; i < RESENDS.max; i++)
      expect((await act({ op: "resend", id })).status).toBe(200);
    expect((await act({ op: "resend", id })).body.error).toBe("rate-limited");
  });

  test("an invite: under every invite limit — the address's window refuses it, then the daily slots", async () => {
    await invite();
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    // Within the 30-day window of the first mail: skipped, nothing sent.
    const r = await act({ op: "resend", id });
    expect(r).toEqual({ status: 409, body: { error: "invite-skipped", why: "skipped-recent" } });
    expect(sent.length).toBe(1);
    // Past the window it goes, as a new invite linked to the first.
    now += 31 * 86_400_000;
    expect((await act({ op: "resend", id })).body).toEqual({ status: "sent" });
    const again = rows("SELECT * FROM mail_log WHERE resend_of = ?", id)[0]!;
    expect(again).toMatchObject({ template: "invite", inviter_id: "me", recipient: FRIEND });
    // Use up the inviter's daily slots: the next one is refused.
    for (let i = 0; i < 5; i++) await invite(`f${i}@example.org`);
    expect((await act({ op: "resend", id })).body.error).toBe("invite-limit");
  });

  test("an invite whose send fails: 502", async () => {
    await invite();
    const id = rows("SELECT id FROM mail_log")[0]!.id;
    now += 31 * 86_400_000;
    failSend = true;
    expect((await act({ op: "resend", id })).body.error).toBe("send-failed");
  });
});
