/**
 * Resend's webhook (lib/resend-webhook.ts): the Svix signature (valid, wrong
 * key, stale, malformed, several v1 entries), bounces and complaints into
 * `invite_email_suppression`, a complaint about an invite counting toward its
 * inviter's report block, idempotence, and nothing logged that holds an
 * address. Fake addresses and a throwaway key only; no mail leaves.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { SendEmailInput } from "../lib/email";
import { EMAIL_INVITE, INVITE_LOG_TAG } from "../lib/referrals/email-invite-config";
import {
  type EmailInviteDeps,
  type InviteDb,
  sendEmailInvite,
} from "../lib/referrals/email-invite";
import { recipientHash } from "../lib/referrals/recipient-hash";
import {
  TOLERANCE_MS,
  applyResendEvent,
  handleResendWebhook,
  inviteLogTag,
  resetResendWebhookState,
  signingKey,
  verifySvix,
} from "../lib/resend-webhook";

const DIR = new URL("../db/migrations/", import.meta.url);
const SCHEMA = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"))
  .join("\n");

const BASE = "https://lianki.com";
const T0 = 1_800_000_000_000;
const FRIEND = "friend.one@example.org";
const KEY_BYTES = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const OTHER = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;

let raw: ReturnType<typeof createTestD1>;
let now: number;
let secret: string | undefined;
let logs: string[];
let errSpy: ReturnType<typeof spyOn>;

const rows = (sql: string, ...args: (string | number)[]) =>
  raw
    .raw()
    .prepare(sql)
    .all(...args)
    .map((r) => ({ ...r })) as Record<string, unknown>[];

async function sign(key: string, id: string, ts: string, body: string) {
  const bytes = Uint8Array.from(atob(key.slice(6)), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

let n = 0;
async function delivery(
  event: unknown,
  o: {
    key?: string;
    ts?: number;
    id?: string;
    sig?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  const id = o.id ?? `msg_${++n}`;
  const ts = String(Math.floor((o.ts ?? now) / 1000));
  const sig = o.sig ?? `v1,${await sign(o.key ?? SECRET, id, ts, body)}`;
  return new Request(`${BASE}/api/email/resend-webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
      ...o.headers,
    },
    body,
  });
}

const deps = () => ({
  secret: () => secret,
  db: () => raw as unknown as InviteDb,
  now: () => now,
});
const hook = async (event: unknown, o: Parameters<typeof delivery>[1] = {}) =>
  handleResendWebhook(await delivery(event, o), deps());

const bounced = (to: string | string[], extra: Record<string, unknown> = {}) => ({
  type: "email.bounced",
  created_at: "2027-01-15T08:00:00.000Z",
  data: {
    email_id: "re_email_1",
    to: Array.isArray(to) ? to : [to],
    bounce: { type: "Permanent", subType: "General", message: "x" },
    ...extra,
  },
});
const complained = (to: string, extra: Record<string, unknown> = {}) => ({
  type: "email.complained",
  data: { email_id: "re_email_2", to: [to], ...extra },
});

const suppression = async (email: string) =>
  rows(
    "SELECT reason FROM invite_email_suppression WHERE recipientHash = ?",
    await recipientHash(email),
  )[0]?.reason ?? null;

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  now = T0;
  secret = SECRET;
  logs = [];
  resetResendWebhookState();
  errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});
afterEach(() => errSpy.mockRestore());

describe("signature", () => {
  const H = (id: string, ts: string, signature: string) => ({ id, timestamp: ts, signature });
  const ts = () => String(Math.floor(now / 1000));

  test("valid: accepted", async () => {
    const key = (await signingKey(SECRET))!;
    const sig = await sign(SECRET, "msg_a", ts(), "{}");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${sig}`), "{}", now)).toBe("ok");
  });

  test("a secret without the whsec_ prefix reads the same key", async () => {
    const key = (await signingKey(SECRET.slice(6)))!;
    const sig = await sign(SECRET, "msg_a", ts(), "{}");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${sig}`), "{}", now)).toBe("ok");
  });

  test("wrong key, changed body or changed id: refused", async () => {
    const key = (await signingKey(SECRET))!;
    const other = await sign(OTHER, "msg_a", ts(), "{}");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${other}`), "{}", now)).toBe("bad");
    const sig = await sign(SECRET, "msg_a", ts(), "{}");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${sig}`), "{ }", now)).toBe("bad");
    expect(await verifySvix(key, H("msg_b", ts(), `v1,${sig}`), "{}", now)).toBe("bad");
  });

  test("stale or future timestamp: refused, even with a good signature", async () => {
    const key = (await signingKey(SECRET))!;
    for (const off of [-TOLERANCE_MS - 1000, TOLERANCE_MS + 1000]) {
      const t = String(Math.floor((now + off) / 1000));
      const sig = await sign(SECRET, "msg_a", t, "{}");
      expect(await verifySvix(key, H("msg_a", t, `v1,${sig}`), "{}", now)).toBe("stale");
    }
    // Inside the window is fine.
    const t = String(Math.floor((now - TOLERANCE_MS + 5000) / 1000));
    const sig = await sign(SECRET, "msg_a", t, "{}");
    expect(await verifySvix(key, H("msg_a", t, `v1,${sig}`), "{}", now)).toBe("ok");
  });

  test("malformed headers: refused", async () => {
    const key = (await signingKey(SECRET))!;
    const sig = await sign(SECRET, "msg_a", ts(), "{}");
    const bad = [
      { id: null, timestamp: ts(), signature: `v1,${sig}` },
      { id: "msg_a", timestamp: null, signature: `v1,${sig}` },
      { id: "msg_a", timestamp: ts(), signature: null },
      H("msg_a", "12.5", `v1,${sig}`),
      H("msg_a", "abc", `v1,${sig}`),
      H("x".repeat(300), ts(), `v1,${sig}`),
      H("msg_a", ts(), "x".repeat(5000)),
      H("msg_a", ts(), sig), // no version
      H("msg_a", ts(), `v2,${sig}`), // unknown version
      H("msg_a", ts(), "v1,not*base64"),
      H("msg_a", ts(), "v1,AAAA"), // wrong length
      H("msg_a", ts(), ""),
    ];
    for (const h of bad) expect(await verifySvix(key, h, "{}", now)).toBe("bad");
  });

  test("several v1 signatures (key rotation): any one that matches is enough", async () => {
    const key = (await signingKey(SECRET))!;
    const good = await sign(SECRET, "msg_a", ts(), "{}");
    const old = await sign(OTHER, "msg_a", ts(), "{}");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${old} v1,${good}`), "{}", now)).toBe("ok");
    expect(await verifySvix(key, H("msg_a", ts(), `v1a,xyz v1,${good}`), "{}", now)).toBe("ok");
    expect(await verifySvix(key, H("msg_a", ts(), `v1,${old} v1,${old}`), "{}", now)).toBe("bad");
  });

  test("a secret that is not base64 (or too short) is no key", async () => {
    expect(await signingKey("whsec_***")).toBeNull();
    expect(await signingKey("whsec_AAAA")).toBeNull();
    expect(await signingKey("whsec_A")).toBeNull(); // bad length: atob throws
    expect(await signingKey(undefined)).toBeNull();
    expect(await signingKey("")).toBeNull();
  });
});

describe("the endpoint", () => {
  test("no secret: 503, logged once, nothing written", async () => {
    secret = undefined;
    expect((await hook(bounced(FRIEND))).status).toBe(503);
    expect((await hook(bounced(FRIEND))).status).toBe(503);
    expect(logs.filter((l) => l.includes("resend-webhook.no-secret"))).toHaveLength(1);
    expect(await suppression(FRIEND)).toBeNull();
  });

  test("a malformed secret is treated as none", async () => {
    secret = "whsec_***";
    expect((await hook(bounced(FRIEND))).status).toBe(503);
  });

  test("bad signature, wrong key or stale: 401, nothing written", async () => {
    expect((await hook(bounced(FRIEND), { key: OTHER })).status).toBe(401);
    expect((await hook(bounced(FRIEND), { ts: now - 10 * 60_000 })).status).toBe(401);
    expect((await hook(bounced(FRIEND), { sig: "v1,AAAA" })).status).toBe(401);
    expect(await suppression(FRIEND)).toBeNull();
  });

  test("too large: 413", async () => {
    const res = await hook({ type: "email.sent", pad: "x".repeat(300 * 1024) });
    expect(res.status).toBe(413);
  });

  test("a signed body that is not JSON: 400", async () => {
    expect((await hook("not json")).status).toBe(400);
  });

  test("other events: 204, ignored", async () => {
    for (const type of ["email.sent", "email.delivered", "email.opened", "email.delivery_delayed"])
      expect((await hook({ type, data: { to: [FRIEND] } })).status).toBe(204);
    expect((await hook({ type: "email.bounced" })).status).toBe(204); // no data
    expect(await suppression(FRIEND)).toBeNull();
  });

  test("hard bounce: suppressed with reason bounce", async () => {
    const res = await hook(bounced(FRIEND));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "done", reason: "bounce", linked: false });
    expect(await suppression(FRIEND)).toBe("bounce");
    // The canonical form is what is hashed: the same mailbox in another spelling.
    expect(await suppression("Friend.One@Example.org")).toBe("bounce");
  });

  test("a bounce with no bounce type is taken as hard", async () => {
    const e = bounced(FRIEND);
    delete (e.data as { bounce?: unknown }).bounce;
    expect((await hook(e)).status).toBe(200);
    expect(await suppression(FRIEND)).toBe("bounce");
  });

  test("soft bounce: 204, nothing written", async () => {
    for (const type of ["Transient", "Undetermined"]) {
      const res = await hook(bounced(FRIEND, { bounce: { type, subType: "MailboxFull" } }));
      expect(res.status).toBe(204);
    }
    expect(await suppression(FRIEND)).toBeNull();
  });

  test("complaint: suppressed with reason complaint, over an unsubscribe or a bounce", async () => {
    await hook(bounced(FRIEND));
    expect((await hook(complained(FRIEND))).status).toBe(200);
    expect(await suppression(FRIEND)).toBe("complaint");
    // A later bounce does not weaken it.
    await hook(bounced(FRIEND));
    expect(await suppression(FRIEND)).toBe("complaint");
    // An abuse report stays an abuse report.
    raw
      .raw()
      .prepare("INSERT INTO invite_email_suppression VALUES (?, 'abuse', 1)")
      .run(await recipientHash("other@example.org"));
    await hook(complained("other@example.org"));
    expect(await suppression("other@example.org")).toBe("abuse");
  });

  test("idempotent: the same event twice, or a replayed delivery, writes nothing new", async () => {
    await hook(bounced(FRIEND), { id: "msg_same" });
    const before = rows("SELECT * FROM invite_email_suppression");
    now += 1000;
    const again = await hook(bounced(FRIEND), { id: "msg_same" });
    expect(await again.json()).toEqual({ status: "duplicate" });
    now += 1000;
    await hook(bounced(FRIEND)); // a fresh delivery of the same news
    expect(rows("SELECT * FROM invite_email_suppression")).toEqual(before);
  });

  test("a delivery id is remembered only for the tolerance window", async () => {
    await hook(bounced(FRIEND), { id: "msg_old" });
    now += TOLERANCE_MS + 60_000;
    const res = await hook(bounced(FRIEND), { id: "msg_old" });
    expect(await res.json()).toMatchObject({ status: "done" });
  });

  test("the replay memory stays bounded", async () => {
    for (let i = 0; i < 1005; i++) await hook({ type: "email.sent" }, { id: `m${i}` });
    // Still answers, and the newest id is remembered.
    const res = await hook(bounced(FRIEND), { id: "m1004" });
    expect(await res.json()).toEqual({ status: "duplicate" });
  });

  test("several recipients, junk ones skipped; a bare string recipient works", async () => {
    await hook(bounced(["a@example.org", "b@example.org", 42 as never, "no-at-sign"]));
    expect(await suppression("a@example.org")).toBe("bounce");
    expect(await suppression("b@example.org")).toBe("bounce");
    expect(rows("SELECT * FROM invite_email_suppression")).toHaveLength(2);
    await applyResendEvent(
      raw as never,
      { type: "email.complained", data: { to: "c@example.org" } },
      now,
    );
    expect(await suppression("c@example.org")).toBe("complaint");
  });

  test("no log line holds an address or the body", async () => {
    await hook(bounced(FRIEND));
    await hook(complained(FRIEND));
    await hook(bounced(FRIEND), { key: OTHER });
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l).not.toContain("@");
      expect(l).not.toContain("re_email");
    }
  });
});

describe("tags", () => {
  const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
  test("object (Resend's form) and array forms; anything else is no link", () => {
    expect(inviteLogTag({ [INVITE_LOG_TAG]: ID })).toBe(ID);
    expect(
      inviteLogTag([
        { name: "x", value: "y" },
        { name: INVITE_LOG_TAG, value: ID },
      ]),
    ).toBe(ID);
    expect(inviteLogTag({ [INVITE_LOG_TAG]: "not-an-id" })).toBeNull();
    expect(inviteLogTag({ [INVITE_LOG_TAG]: 5 })).toBeNull();
    expect(inviteLogTag([null])).toBeNull();
    expect(inviteLogTag("str")).toBeNull();
    expect(inviteLogTag(undefined)).toBeNull();
  });
});

describe("an invite mail's complaint counts against its inviter", () => {
  let mails: SendEmailInput[];
  let inviteDeps: EmailInviteDeps;

  beforeEach(() => {
    raw
      .raw()
      .prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical, proEndsAt) VALUES ('pro', 'N', 'pro.user@example.com', 1, 'x', 'x', 'pro.user@example.com', ?)",
      )
      .run(new Date(T0 + 30 * 86_400_000).toISOString());
    mails = [];
    inviteDeps = {
      who: async () => ({ id: "pro", email: "pro.user@example.com" }),
      db: () => raw as unknown as InviteDb,
      send: async (m) => {
        mails.push(m);
        return { id: `re_sent_${mails.length}` };
      },
      mailOn: () => true,
      secret: () => "x".repeat(40),
      flags: async () => ({ [EMAIL_INVITE.flag]: true }),
      isAdmin: () => false,
      origin: () => BASE,
      now: () => now,
    };
  });

  const invite = (email: string) =>
    sendEmailInvite(
      new Request(`${BASE}/api/invite/email`, {
        method: "POST",
        headers: {
          host: "lianki.com",
          origin: BASE,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email }),
      }),
      inviteDeps,
    );
  const reported = () =>
    rows("SELECT COUNT(*) AS n FROM invite_email_log WHERE reportedAt IS NOT NULL")[0]!.n;

  test("every invite mail carries its log id as a tag", async () => {
    await invite(FRIEND);
    const id = rows("SELECT id FROM invite_email_log")[0]!.id;
    expect(mails[0]!.tags).toEqual([{ name: INVITE_LOG_TAG, value: id as string }]);
  });

  test("by tag: suppressed and reportedAt stamped, once", async () => {
    await invite(FRIEND);
    const tags = { [INVITE_LOG_TAG]: mails[0]!.tags![0]!.value };
    const res = await hook(complained(FRIEND, { tags }));
    expect(await res.json()).toEqual({ status: "done", reason: "complaint", linked: true });
    expect(reported()).toBe(1);
    const at = rows("SELECT reportedAt FROM invite_email_log")[0]!.reportedAt;
    now += 60_000;
    await hook(complained(FRIEND, { tags }));
    expect(rows("SELECT reportedAt FROM invite_email_log")[0]!.reportedAt).toBe(at);
    expect(await suppression(FRIEND)).toBe("complaint");
  });

  test("by Resend's email id when there is no tag; the log's hash is used even with no `to`", async () => {
    await invite(FRIEND);
    const res = await hook({ type: "email.complained", data: { email_id: "re_sent_1" } });
    expect(await res.json()).toMatchObject({ linked: true });
    expect(reported()).toBe(1);
    expect(await suppression(FRIEND)).toBe("complaint");
  });

  test("a bounce on an invite suppresses but is not a report", async () => {
    await invite(FRIEND);
    const tags = { [INVITE_LOG_TAG]: mails[0]!.tags![0]!.value };
    await hook(bounced(FRIEND, { tags }));
    expect(reported()).toBe(0);
    expect(await suppression(FRIEND)).toBe("bounce");
  });

  test("two complaints block the inviter; the suppressed friend gets no second mail", async () => {
    await invite("a@example.org");
    await invite("b@example.org");
    for (const m of mails)
      await hook(complained(m.to, { tags: { [INVITE_LOG_TAG]: m.tags![0]!.value } }));
    expect(reported()).toBe(EMAIL_INVITE.blockAfterReports);
    const before = mails.length;
    await invite("c@example.org");
    expect(mails.length).toBe(before);
    expect(rows("SELECT status FROM invite_email_log ORDER BY createdAt, rowid").at(-1)).toEqual({
      status: "skipped-blocked",
    });
  });

  test("a tag naming no log row: suppression by address only", async () => {
    const tags = { [INVITE_LOG_TAG]: "0f0e0d0c-0b0a-4908-8706-050403020100" };
    const res = await hook(complained(FRIEND, { tags }));
    expect(await res.json()).toMatchObject({ linked: false });
    expect(await suppression(FRIEND)).toBe("complaint");
  });
});
