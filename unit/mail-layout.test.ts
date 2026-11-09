/**
 * The shared mail layout and the unsubscribe classes (docs/mail-templates.md,
 * "Layout and colours", "Unsubscribe"): oklch tokens turned into hex for mail
 * only, AA contrast in light and dark, every template × language in the one
 * layout (snapshots), the footer of each class, a stored edit from before the
 * layout still sent, the one-click token, the unsubscribe route, and a mail
 * the account turned off suppressed in the send path. Renders only: no mail
 * leaves (every send here is a stub).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { SendEmailInput } from "../lib/email";
import { withMailLog } from "../lib/mail-log/send";
import type { MailLogDb } from "../lib/mail-log/store";
import { contrast, hexifyOklch, oklchToHex } from "../lib/mail-templates/color";
import { renderBuiltin, renderWith } from "../lib/mail-templates/compose";
import { MAIL_TEMPLATE_IDS, MAIL_TEMPLATES } from "../lib/mail-templates/defs";
import { MAIL_KINDS, mailPrefOf, oneClickKinds, type MailKind } from "../lib/mail-templates/kinds";
import { MAIL_BUTTON, MAIL_TOKENS, previewDoc } from "../lib/mail-templates/layout";
import { MAIL_LOCALES } from "../lib/mail-templates/locales";
import { setKindOn, unsubscribePost } from "../lib/mail-templates/unsubscribe";
import {
  signUnsubscribe,
  unsubscribeLinks,
  verifyUnsubscribe,
} from "../lib/mail-templates/unsubscribe-token";

const SECRET = "k".repeat(40);
const hex = (c: string) => oklchToHex(c)!;

describe("colours: oklch tokens, hex in mail", () => {
  test("oklch → hex", () => {
    expect(oklchToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(oklchToHex("oklch(0 0 0)")).toBe("#000000");
    expect(oklchToHex("oklch(0.53 0.207 22.3)")).toBe("#c8102e");
    expect(oklchToHex("oklch(50% 0 0 / 0.5)")).toMatch(/^#[0-9a-f]{6}$/);
    expect(oklchToHex("red")).toBeNull();
    expect(hexifyOklch(`a{color:oklch(1 0 0)} b{x:oklch(0 0 0)}`)).toBe(
      "a{color:#ffffff} b{x:#000000}",
    );
  });

  test("text pairs pass WCAG AA (4.5:1) in light and dark", () => {
    for (const t of [MAIL_TOKENS.light, MAIL_TOKENS.dark]) {
      expect(contrast(hex(t.ink), hex(t.card))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(t.muted), hex(t.card))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(t.seal), hex(t.card))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(t.ink), hex(t.codeBg))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(t.goldInk), hex(t.goldSoft))).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(hex(MAIL_BUTTON.fg), hex(MAIL_BUTTON.bg))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("every template, every language, in the one layout", () => {
  for (const id of MAIL_TEMPLATE_IDS)
    test(id, () => {
      const out: Record<string, string> = {};
      for (const l of MAIL_LOCALES) {
        const m = renderBuiltin(id, l, MAIL_TEMPLATES[id].samples.typical);
        expect(m.html.startsWith("<!doctype html>")).toBe(true);
        // Mail clients do not read oklch(): none is left.
        expect(m.html).not.toContain("oklch(");
        expect(m.html).toContain('class="lk-body"');
        expect(m.html).toContain(`lang="${l}"`);
        expect(m.html).toContain(`dir="${l === "ar" || l === "ur" ? "rtl" : "ltr"}"`);
        expect(m.html).toContain("@media (prefers-color-scheme: dark)");
        expect(m.html).toContain("LXGW WenKai TC");
        expect(m.html).toContain("Yuji Syuku");
        out[l] = `${m.subject}\n---\n${m.text}`;
      }
      expect(out).toMatchSnapshot();
    });

  test("the security notice's HTML (en, zh, ar)", () => {
    for (const l of ["en", "zh", "ar"] as const)
      expect(
        renderBuiltin("login-notice", l, MAIL_TEMPLATES["login-notice"].samples.typical).html,
      ).toMatchSnapshot();
  });
});

describe("footer per class (kinds.ts)", () => {
  const typical = (id: (typeof MAIL_TEMPLATE_IDS)[number]) =>
    renderBuiltin(id, "en", MAIL_TEMPLATES[id].samples.typical);

  test("every template is classified", () => {
    for (const id of MAIL_TEMPLATE_IDS) expect(MAIL_KINDS[id]).toBeDefined();
    expect(mailPrefOf("signin-code")).toBeNull();
    expect(mailPrefOf("login-notice")).toBe("mail.loginNotice");
    expect(mailPrefOf("invite")).toBeNull();
  });

  test("required: always sent, no unsubscribe", () => {
    const m = typical("signin-code");
    expect(m.text).toContain("so it is always sent");
    expect(m.html).not.toContain("Unsubscribe");
    expect(m.headers).toBeUndefined();
  });

  test("security: its own label and icon (not red alone), off only in preferences", () => {
    const m = typical("login-notice");
    expect(m.html).toContain('class="lk-badge"');
    expect(m.html).toContain("&#128737;&#65039;</span> Security notice");
    expect(m.html).toContain('href="https://lianki.com/my/preferences#mail"');
    expect(m.text).toContain("https://lianki.com/my/preferences#mail");
    expect(m.headers).toBeUndefined();
    expect(typical("signin-link").html).not.toContain(`class="lk-badge"`);
  });

  test("invite: its own opt-out footer, by address", () => {
    const m = typical("invite");
    expect(m.html).toContain("Unsubscribe: never get a Lianki invite again");
    expect(m.text).not.toContain("always sent");
  });

  test("one-click: footer link and RFC 8058 headers when a kind has one", () => {
    // No user mail is one-click yet; the layout adds both the moment one is.
    expect(oneClickKinds()).toEqual([]);
    const kinds: Record<string, MailKind> = {
      digest: { class: "optional", optOut: "one-click", pref: "mail.loginNotice", why: "test" },
    };
    expect(oneClickKinds(kinds)).toEqual(["digest"]);
    expect(mailPrefOf("digest", kinds)).toBe("mail.loginNotice");
  });
});

test("a stored edit from before the layout is still sent, in the layout, as hex", () => {
  const old = {
    subject: "Code {code}",
    html: `<div style="font-family:system-ui;max-width:560px"><p>Your code</p><p style="font-size:28px">{code}</p><p style="color:oklch(0.45 0 0)">15 min</p></div>`,
    text: "Your code {code}",
  };
  const m = renderWith("signin-code", "en", old, { code: "123456" });
  expect(m.html).toContain("<p>Your code</p>");
  expect(m.html).toContain(">123456</p>");
  expect(m.html).not.toContain("oklch(");
  expect(m.html).toContain('class="lk-card"');
});

test("the preview switches the layout's dark rules on", () => {
  const m = renderBuiltin("signin-code", "en", { code: "1" });
  expect(previewDoc(m.html, true)).toContain('class="lk-dark"');
  expect(previewDoc(m.html, false)).toContain('class="lk-light"');
  expect(previewDoc("<p>x</p>", true)).toBe("<p>x</p>");
});

describe("one-click token", () => {
  test("round trip; another kind, account or secret fails; tampering fails", async () => {
    const t = await signUnsubscribe(SECRET, "user-1", "digest");
    expect(t).toMatch(/^u1\.[A-Za-z0-9_-]+\.digest\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyUnsubscribe(SECRET, t)).toEqual({ userId: "user-1", kind: "digest" });
    expect(await verifyUnsubscribe("x".repeat(40), t)).toBeNull();
    expect(await verifyUnsubscribe(SECRET, t.replace(".digest.", ".news."))).toBeNull();
    const [, , kind, sig] = t.split(".");
    const other = `u1.${btoa("user-2").replace(/=+$/, "")}.${kind}.${sig}`;
    expect(await verifyUnsubscribe(SECRET, other)).toBeNull();
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(await verifyUnsubscribe(SECRET, flipped)).toBeNull();
    expect(await verifyUnsubscribe(SECRET, null)).toBeNull();
    expect(await verifyUnsubscribe(SECRET, "u1..digest.")).toBeNull();
  });

  test("never with a short or missing secret", async () => {
    await expect(signUnsubscribe("short", "u", "digest")).rejects.toThrow();
    expect(await verifyUnsubscribe(undefined, "u1.dQ.digest." + "A".repeat(43))).toBeNull();
  });

  test("links: page with the token in the fragment, one-click endpoint in the query", () => {
    const l = unsubscribeLinks("https://lianki.com", "zh-Hant", "u1.a.b.c");
    expect(l.pageUrl).toBe("https://lianki.com/mail/unsubscribe?lang=zh#t=u1.a.b.c");
    expect(l.oneClickUrl).toBe("https://lianki.com/api/mail/unsubscribe?t=u1.a.b.c");
  });
});

// ── D1: suppression in the send path, the unsubscribe route ────────────────────

const DIR = new URL("../db/migrations/", import.meta.url);
const SCHEMA = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"))
  .join("\n");
const T0 = Date.parse("2027-01-15T03:00:00Z");

let raw: ReturnType<typeof createTestD1>;
let spies: ReturnType<typeof spyOn>[];
const rows = (q: string, ...a: (string | number)[]) =>
  raw
    .raw()
    .prepare(q)
    .all(...a)
    .map((r) => ({ ...r })) as Record<string, unknown>[];
const setPref = (userId: string, key: string, value: unknown) =>
  raw
    .raw()
    .prepare(
      "INSERT INTO user_prefs (user_id, key, value, hlc_ts, hlc_counter, device_id, updated_ms) VALUES (?, ?, ?, 1, 0, 'd', 1)",
    )
    .run(userId, key, JSON.stringify(value));

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  raw
    .raw()
    .prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical) VALUES ('u1', 'N', 'me.user@example.com', 1, 'x', 'x', 'me.user@example.com')",
    )
    .run();
  spies = [
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "log").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("the send path honours the account's switch", () => {
  const notice = (): SendEmailInput => ({
    to: "me.user@example.com",
    subject: "s",
    text: "t",
    log: { template: "login-notice", version: 0, locale: "en", userId: "u1" },
  });
  const run = async (mail: SendEmailInput) => {
    const sent: SendEmailInput[] = [];
    const res = await withMailLog(
      () => raw as unknown as MailLogDb,
      async (m) => {
        sent.push(m);
        return { id: "re_1" };
      },
      () => T0,
    )(mail);
    return { res, sent };
  };

  test("on (default): sent", async () => {
    const { res, sent } = await run(notice());
    expect(sent).toHaveLength(1);
    expect(res).toEqual({ id: "re_1" });
    expect(rows("SELECT status FROM mail_log")).toEqual([{ status: "sent" }]);
  });

  test("off: not sent, logged as suppressed with the pref, no address in the reason", async () => {
    setPref("u1", "mail.loginNotice", false);
    const { res, sent } = await run(notice());
    expect(sent).toHaveLength(0);
    expect(res).toEqual({ id: "", suppressed: "mail.loginNotice" });
    expect(rows("SELECT status, reason, user_id FROM mail_log")).toEqual([
      { status: "suppressed", reason: "pref:mail.loginNotice", user_id: "u1" },
    ]);
  });

  test("a required mail is sent whatever the prefs say", async () => {
    setPref("u1", "mail.loginNotice", false);
    const { sent } = await run({
      ...notice(),
      log: { template: "signin-code", version: 0, locale: "en", userId: "u1" },
    });
    expect(sent).toHaveLength(1);
  });

  test("another account's switch does not count", async () => {
    raw
      .raw()
      .prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical) VALUES ('u2', 'N', 'other@example.com', 1, 'x', 'x', 'other@example.com')",
      )
      .run();
    setPref("u2", "mail.loginNotice", false);
    const { sent } = await run(notice());
    expect(sent).toHaveLength(1);
  });
});

describe("POST /api/mail/unsubscribe", () => {
  const kinds: Record<string, MailKind> = {
    ...MAIL_KINDS,
    digest: { class: "optional", optOut: "one-click", pref: "mail.loginNotice", why: "test" },
  };
  const deps = {
    db: () => raw as never,
    secret: () => SECRET,
    origin: () => "https://lianki.com",
    now: () => T0,
    kinds,
  };
  const pref = () =>
    rows("SELECT value FROM user_prefs WHERE user_id = 'u1' AND key = 'mail.loginNotice'");

  test("RFC 8058 one-click turns the kind off; no sign-in", async () => {
    const t = await signUnsubscribe(SECRET, "u1", "digest");
    const body = new URLSearchParams({ "List-Unsubscribe": "One-Click" });
    const res = await unsubscribePost(
      new Request(`https://lianki.com/api/mail/unsubscribe?t=${encodeURIComponent(t)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(pref()).toEqual([{ value: "false" }]);
  });

  test("the page: unsubscribe, then undo", async () => {
    const t = await signUnsubscribe(SECRET, "u1", "digest");
    const post = (action: string) =>
      unsubscribePost(
        new Request("https://lianki.com/api/mail/unsubscribe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://lianki.com",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({ token: t, action }),
        }),
        { ...deps, now: action === "undo" ? () => T0 + 1000 : () => T0 },
      );
    expect((await post("unsubscribe")).status).toBe(200);
    expect(pref()).toEqual([{ value: "false" }]);
    expect((await post("undo")).status).toBe(200);
    expect(pref()).toEqual([{ value: "true" }]);
  });

  test("a bad token, or a kind that cannot be turned off this way, changes nothing", async () => {
    const one = (t: string) =>
      unsubscribePost(
        new Request(`https://lianki.com/api/mail/unsubscribe?t=${encodeURIComponent(t)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }),
        }),
        deps,
      );
    expect((await one("u1.dTE.digest." + "A".repeat(43))).status).toBe(400);
    // The security notice is off only in preferences, never by a link.
    expect((await one(await signUnsubscribe(SECRET, "u1", "login-notice"))).status).toBe(400);
    expect((await one(await signUnsubscribe(SECRET, "u1", "signin-code"))).status).toBe(400);
    expect(pref()).toEqual([]);
    expect(await setKindOn(raw as never, "u1", "invite", false, T0, kinds)).toBe(false);
  });
});
