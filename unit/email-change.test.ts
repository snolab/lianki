/**
 * Changing the sign-in address (lib/profile/email-change.ts): nothing applies
 * before the new address confirms; the user row and every email-keyed table move
 * in one transaction or not at all; an address held by anyone else, in any form,
 * is refused without telling; the owner's role is safe; rate limits; no address or
 * token in a log line.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createTestD1 } from "../lib/d1/testDb";
import type { SendEmailInput } from "../lib/email";
import { PROFILE } from "../lib/profile/config";
import {
  EMAIL_KEYED_TABLES,
  type EmailDb,
  type EmailDeps,
  cleanEmail,
  confirmEmailChange,
  requestEmailChange,
} from "../lib/profile/email-change";

const DIR = new URL("../db/migrations/", import.meta.url);
const SCHEMA = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"))
  .join("\n");

const BASE = "https://lianki.com";
const OLD = "ada@example.com";
const NEW = "ada.new@example.org";
const T0 = 1_800_000_000_000;

let raw: ReturnType<typeof createTestD1>;
let mails: SendEmailInput[];
let mailOn: boolean;
let failSend: ((m: SendEmailInput) => boolean) | null;
let me: { id: string; email: string; sessionCreatedMs: number } | null;
let now: number;
let deps: EmailDeps;
let errors: ReturnType<typeof spyOn>;

const rows = (sql: string, ...args: (string | number)[]) =>
  raw
    .raw()
    .prepare(sql)
    .all(...args)
    .map((r) => ({ ...r }));
const grant = (email: string) =>
  raw
    .raw()
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES (?, 'admin', 't', 1)",
    )
    .run(email);
const addUser = (id: string, email: string, canonical = email) =>
  raw
    .raw()
    .prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, email_canonical) VALUES (?, 'N', ?, 1, 'x', 'x', ?)",
    )
    .run(id, email, canonical);

/** One row in each email-keyed table, whatever its other columns. */
function seed(email: string, salt: string) {
  for (const t of EMAIL_KEYED_TABLES) {
    const cols = raw.raw().prepare(`PRAGMA table_info(${t})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];
    const used = cols.filter((c) => c.name === "email" || c.pk || (c.notnull && !c.dflt_value));
    const values = used.map((c) =>
      c.name === "email"
        ? email
        : c.name === "kind"
          ? "token"
          : /INT|REAL/i.test(c.type)
            ? 1
            : `${salt}-${c.name}`,
    );
    raw
      .raw()
      .prepare(
        `INSERT INTO ${t} (${used.map((c) => c.name).join(",")}) VALUES (${used.map(() => "?").join(",")})`,
      )
      .run(...values);
  }
}
const countAt = (email: string) =>
  EMAIL_KEYED_TABLES.map(
    (t) => (rows(`SELECT COUNT(*) AS n FROM ${t} WHERE email = ?`, email)[0] as { n: number }).n,
  );

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
const ask = (email: unknown = NEW, h?: Record<string, string>) =>
  requestEmailChange(post("/api/profile/email", { email }, h), deps);
const confirm = (token: unknown, h?: Record<string, string>) =>
  confirmEmailChange(post("/api/profile/email/confirm", { token }, h), deps);
const tokenFrom = (m: SendEmailInput) => /email-confirm#(\S+)/.exec(m.text)![1]!;
const errorOf = async (r: Response) => ((await r.json()) as { error?: string }).error;

beforeEach(() => {
  raw = createTestD1(SCHEMA);
  raw.raw().exec("PRAGMA foreign_keys = OFF"); // seed() makes rows with made-up user ids
  grant("owner+admin@gmail.com");
  addUser("u1", OLD);
  mails = [];
  mailOn = true;
  failSend = null;
  now = T0;
  me = { id: "u1", email: OLD, sessionCreatedMs: T0 - 60_000 };
  deps = {
    who: async () => me,
    db: () => raw as unknown as EmailDb,
    send: async (m) => {
      if (failSend?.(m)) throw new Error(`Resend refused ${m.to}`);
      mails.push(m);
    },
    mailOn: () => mailOn,
    origin: () => BASE,
    now: () => now,
  };
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("what has to hold before anything starts", () => {
  test("guest, another site, mail off", async () => {
    expect((await ask(NEW, { origin: "https://evil.example" })).status).toBe(403);
    mailOn = false;
    expect(await errorOf(await ask())).toBe("mail-off");
    mailOn = true;
    me = null;
    expect((await ask()).status).toBe(401);
    expect(mails).toEqual([]);
  });
  test("a bad or unchanged address is refused", async () => {
    for (const v of ["", "nope", "a@b", "a b@c.de", 7, null, `${"a".repeat(250)}@b.cd`])
      expect(await errorOf(await ask(v))).toBe("invalid");
    expect(await errorOf(await ask(" ADA@example.com "))).toBe("same");
    expect(mails).toEqual([]);
  });
  test("cleanEmail lowercases and trims", () => {
    expect(cleanEmail("  A@B.Co ")).toBe("a@b.co");
  });
  test("an old session has to sign in again", async () => {
    me!.sessionCreatedMs = T0 - PROFILE.emailFreshMs;
    expect(await errorOf(await ask())).toBe("sign-in-again");
    expect(mails).toEqual([]);
  });
  test("a revoked owner is an ordinary user again", async () => {
    raw
      .raw()
      .exec("UPDATE account_permission SET revoked_at = 2 WHERE email = 'owner+admin@gmail.com'");
    me = { id: "u1", email: "owner+admin@gmail.com", sessionCreatedMs: T0 };
    expect(await (await ask()).json()).toEqual({ status: "sent" });
  });
  test("owner means the exact address: an alias's own account is not refused as one", async () => {
    me = { id: "u1", email: "owner@gmail.com", sessionCreatedMs: T0 };
    expect((await ask()).status).toBe(200);
  });
  test("the owner list can't be read: nothing happens", async () => {
    const real = deps.db();
    deps.db = () =>
      new Proxy(real, {
        get(t, k) {
          if (k !== "prepare") {
            const v = Reflect.get(t, k);
            return typeof v === "function" ? v.bind(t) : v;
          }
          return (q: string) => {
            if (q.includes("account_permission")) throw new Error("D1 down");
            return t.prepare(q);
          };
        },
      });
    await expect(ask()).rejects.toThrow("D1 down");
    expect(mails).toEqual([]);
  });
  test("the owner's address can't move: the role goes by it, with its reason", async () => {
    me = { id: "u1", email: "owner+admin@gmail.com", sessionCreatedMs: T0 };
    const r = await ask();
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toBe("owner");
  });
});

describe("the request", () => {
  test("a link to the new address, a notice to the old, and nothing has changed", async () => {
    seed(OLD, "a");
    const r = await ask();
    expect(await r.json()).toEqual({ status: "sent" });
    expect(mails.map((m) => m.to)).toEqual([NEW, OLD]);
    expect(mails[0]!.text).toContain(`${BASE}/profile/email-confirm#u1.`);
    expect(mails[1]!.text).not.toContain(NEW);
    expect(mails[1]!.text).not.toContain("email-confirm");
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
    expect(countAt(OLD).every((n) => n === 1)).toBe(true);
    // Only the hash is stored.
    const [stored] = rows("SELECT tokenHash FROM email_change_request") as { tokenHash: string }[];
    expect(stored!.tokenHash).not.toBe(tokenFrom(mails[0]!).split(".")[1]);
  });
  test.each([
    ["exact", "taken@example.org", "taken@example.org", "taken@example.org"],
    ["another case", "taken@example.org", "taken@example.org", "TAKEN@example.org"],
    ["canonical form", "someone@gmail.com", "someone@gmail.com", "some.one+x@gmail.com"],
    ["the owner's", "x@example.org", "x@example.org", "owner@gmail.com"],
  ])(
    "an address held already (%s) answers the same, and tells only its mailbox",
    async (_w, e, c, asked) => {
      addUser("u2", e, c);
      const free = await (await ask("free@example.org")).json();
      mails = [];
      now += 1;
      const r = await ask(asked);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(free);
      // Two mails either way, to the same two parties.
      expect(mails.map((m) => m.to)).toEqual([asked.toLowerCase(), OLD]);
      expect(mails[0]!.text).not.toContain("email-confirm");
      expect(rows("SELECT newEmail FROM email_change_request")).toEqual([
        { newEmail: "free@example.org" },
      ]);
    },
  );
  test("one's own alias is fine: no one else holds it", async () => {
    me = { id: "u1", email: OLD, sessionCreatedMs: T0 };
    expect(await (await ask("ADA+x@example.com")).json()).toEqual({ status: "sent" });
    expect(mails[0]!.text).toContain("email-confirm");
  });
  test("a failed mail is reported, and no address reaches the log", async () => {
    failSend = (m) => m.to === NEW;
    const r = await ask();
    expect(r.status).toBe(502);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("@");
  });
  test("rate limited per user", async () => {
    for (let i = 0; i < PROFILE.emailLimit.max; i++)
      expect((await ask(`n${i}@example.org`)).status).toBe(200);
    const r = await ask("again@example.org");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  test("one mailbox isn't flooded: past its limit the answer is the same, with no mail", async () => {
    for (let i = 0; i < PROFILE.emailTargetLimit.max; i++) await ask();
    mails = [];
    const r = await ask();
    expect(await r.json()).toEqual({ status: "sent" });
    expect(mails).toEqual([]);
  });
});

describe("the confirmation", () => {
  const start = async () => {
    await ask();
    const token = tokenFrom(mails[0]!);
    mails = [];
    return token;
  };

  test("moves the user and every email-keyed row, leaves others alone", async () => {
    addUser("u2", "other@example.org");
    seed(OLD, "a");
    seed("other@example.org", "b");
    const token = await start();
    me = null; // the mail may be opened anywhere
    const r = await confirm(token);
    expect(await r.json()).toEqual({ status: "changed" });
    expect(rows("SELECT email, email_canonical, emailVerified FROM user WHERE id = 'u1'")).toEqual([
      { email: NEW, email_canonical: "ada.new@example.org", emailVerified: 1 },
    ]);
    expect(countAt(NEW).every((n) => n === 1)).toBe(true);
    expect(countAt(OLD).every((n) => n === 0)).toBe(true);
    expect(countAt("other@example.org").every((n) => n === 1)).toBe(true);
    expect(rows("SELECT * FROM email_change_request")).toEqual([]);
    // A notice to the old address, without the new one in full.
    expect(mails.map((m) => m.to)).toEqual([OLD]);
    expect(mails[0]!.text).not.toContain(NEW);
    expect(
      rows("SELECT kind, actor, subject, detail FROM security_audit WHERE kind = 'email.change'"),
    ).toEqual([{ kind: "email.change", actor: "u1", subject: null, detail: null }]);
  });
  test("a mixed-case stored address moves its rows too", async () => {
    raw.raw().exec(`UPDATE user SET email = 'Ada@Example.com' WHERE id = 'u1'`);
    me = { id: "u1", email: "Ada@Example.com", sessionCreatedMs: T0 };
    seed("ada@example.com", "a"); // study_day and friends keep the lowercase
    const token = await start();
    expect((await confirm(token)).status).toBe(200);
    expect(countAt(NEW).every((n) => n === 1)).toBe(true);
  });
  test("works once", async () => {
    const token = await start();
    expect((await confirm(token)).status).toBe(200);
    expect(await errorOf(await confirm(token))).toBe("invalid");
  });
  test("a newer request replaces the older link", async () => {
    const first = await start();
    now += 1000;
    await ask("later@example.org");
    const second = tokenFrom(mails[0]!);
    expect(await errorOf(await confirm(first))).toBe("invalid");
    expect((await confirm(second)).status).toBe(200);
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([
      { email: "later@example.org" },
    ]);
  });
  test("expired, wrong and malformed all read the same", async () => {
    const token = await start();
    const [uid] = token.split(".");
    for (const bad of [`${uid}.${"0".repeat(64)}`, `nobody.${"0".repeat(64)}`, "x", "", 5, null])
      expect(await errorOf(await confirm(bad))).toBe("invalid");
    now += PROFILE.emailLinkMs;
    expect(await errorOf(await confirm(token))).toBe("invalid");
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
  });
  test("the user's address moved meanwhile: the link is dead", async () => {
    const token = await start();
    raw.raw().exec(`UPDATE user SET email = 'elsewhere@example.org' WHERE id = 'u1'`);
    expect(await errorOf(await confirm(token))).toBe("invalid");
  });
  test("taken between the mail and the press: refused, nothing moves", async () => {
    seed(OLD, "a");
    const token = await start();
    addUser("u2", NEW);
    const r = await confirm(token);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toBe("unavailable");
    expect(countAt(OLD).every((n) => n === 1)).toBe(true);
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
  });
  test("the new address was made an owner's after the request: refused", async () => {
    const token = await start();
    grant(NEW);
    expect(await errorOf(await confirm(token))).toBe("unavailable");
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
  });
  test("the old address was made an owner's after the request: refused", async () => {
    const token = await start();
    grant(OLD);
    expect(await errorOf(await confirm(token))).toBe("unavailable");
  });
  test("a grant landing between the checks and the batch still stops it, and the link stays", async () => {
    seed(OLD, "a");
    const token = await start();
    const real = deps.db();
    deps.db = () =>
      new Proxy(real, {
        get(t, k) {
          if (k !== "batch") {
            const v = Reflect.get(t, k);
            return typeof v === "function" ? v.bind(t) : v;
          }
          return (stmts: never[]) => {
            grant(NEW);
            return t.batch(stmts);
          };
        },
      });
    const r = await confirm(token);
    expect(r.status).toBe(409);
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
    expect(countAt(OLD).every((n) => n === 1)).toBe(true);
    expect(rows("SELECT userId FROM email_change_request")).toEqual([{ userId: "u1" }]);
    expect(rows("SELECT * FROM security_audit WHERE kind = 'email.change'")).toEqual([]);
  });
  test("a key conflict half way rolls the whole change back", async () => {
    seed(OLD, "a");
    // A stray row at the new address, with the same primary key as a row that moves.
    const key = rows("SELECT id FROM word_lists WHERE email = ?", OLD)[0] as { id: string };
    raw
      .raw()
      .prepare(
        "INSERT INTO word_lists SELECT ? , id" +
          ", " +
          wordListRest() +
          " FROM word_lists WHERE id = ?",
      )
      .run(NEW, key.id);
    const token = await start();
    const r = await confirm(token);
    expect(r.status).toBe(409);
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: OLD }]);
    expect(countAt(OLD).every((n) => n === 1)).toBe(true);
    // The link still works once the stray row is gone.
    expect(rows("SELECT userId FROM email_change_request")).toEqual([{ userId: "u1" }]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("@");
  });
  test("a notice that fails doesn't undo the change, and logs no address", async () => {
    const token = await start();
    failSend = () => true;
    expect((await confirm(token)).status).toBe(200);
    expect(rows("SELECT email FROM user WHERE id = 'u1'")).toEqual([{ email: NEW }]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("@");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
  });
  test("another site, and too many tries from one IP", async () => {
    const token = await start();
    expect((await confirm(token, { origin: "https://evil.example" })).status).toBe(403);
    for (let i = 0; i < PROFILE.emailConfirmLimit.max; i++)
      await confirm("x", { "cf-connecting-ip": "203.0.113.9" });
    expect((await confirm(token, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(429);
    expect((await confirm(token, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(200);
  });
});

function wordListRest() {
  const cols = raw.raw().prepare("PRAGMA table_info(word_lists)").all() as { name: string }[];
  return cols
    .map((c) => c.name)
    .filter((n) => n !== "email" && n !== "id")
    .join(", ");
}

describe("edges", () => {
  test("a body that isn't JSON is refused", async () => {
    const bad = (path: string) =>
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          host: "lianki.com",
          origin: BASE,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{",
      });
    expect(await errorOf(await requestEmailChange(bad("/api/profile/email"), deps))).toBe(
      "invalid",
    );
    expect(await errorOf(await confirmEmailChange(bad("/api/profile/email/confirm"), deps))).toBe(
      "invalid",
    );
  });
  test("mails follow the reader's language, and the old address never sees the link", async () => {
    await ask(NEW, { "accept-language": "zh-CN" });
    expect(mails[0]!.subject).toContain("炼記");
    expect(mails[1]!.subject).toContain("炼記");
    const token = tokenFrom(mails[0]!);
    expect(mails[1]!.html).not.toContain(token);
    mails = [];
    await confirm(token, { "accept-language": "zh-CN" });
    expect(mails[0]!.subject).toContain("炼記");
  });
  test("an address in a mail is escaped in its HTML", async () => {
    addUser("u2", "a@example.org");
    await ask("<b>x</b>@example.org");
    expect(mails[0]!.html).not.toContain("<b>x</b>");
  });
});

describe("the list of email-keyed tables", () => {
  /** Columns named email that hold something else, or aren't keys of user data. */
  // user: moved by its own statement. site_role, account_permission: a
  // permission holder's address never moves.
  // pending_membership: the address an admin typed for a pre-grant, owned by no
  // account until claimed (then by claimed_user_id) — nothing to move.
  const NOT_A_KEY = new Set(["user", "site_role", "account_permission", "pending_membership"]);
  test("covers every table with an `email` column", () => {
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'") as {
      name: string;
    }[];
    const withEmail = tables
      .map((t) => t.name)
      .filter((t) => !t.startsWith("sqlite_") && !t.startsWith("_"))
      .filter((t) =>
        (rows(`PRAGMA table_info(${t})`) as { name: string }[]).some((c) => c.name === "email"),
      )
      .filter((t) => !NOT_A_KEY.has(t));
    expect(withEmail.sort()).toEqual([...EMAIL_KEYED_TABLES].sort());
  });
});
