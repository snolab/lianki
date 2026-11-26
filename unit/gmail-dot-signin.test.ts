import { describe, expect, test } from "bun:test";
import { canonicalEmail } from "@/lib/canonical-email";
import { gmailDotFallbackAdapter, gmailDotKey, withGmailDotFallback } from "@/lib/gmail-dot-signin";

type Row = { id: string; email: string };
type FindArgs = { model: string; where?: { field: string; value: unknown; operator?: string }[] };

/** A stand-in for the kysely adapter over a `user` table: exact matches only. */
function fakeAdapter(rows: Row[]) {
  const calls: FindArgs[] = [];
  const findOne = async (args: FindArgs) => {
    calls.push(args);
    if (args.model !== "user") return null;
    const hit = rows.find((r) =>
      (args.where ?? []).every((w) => (r as Record<string, unknown>)[w.field] === w.value),
    );
    return hit ? { ...hit } : null;
  };
  const adapter = {
    findOne,
    transaction: async <R>(cb: (trx: { findOne: typeof findOne }) => Promise<R>) =>
      cb({ findOne } as never),
  };
  const candidates = async (canonical: string) =>
    rows.filter((r) => canonicalEmail(r.email) === canonical);
  // oxlint-disable-next-line typescript/no-explicit-any
  const wrapped = withGmailDotFallback(adapter as any, candidates) as unknown as {
    findOne: (a: FindArgs) => Promise<Row | null>;
    transaction: <R>(
      cb: (trx: { findOne: (a: FindArgs) => Promise<Row | null> }) => Promise<R>,
    ) => Promise<R>;
  };
  return { wrapped, calls };
}

const byEmail = (email: string): FindArgs => ({
  model: "user",
  where: [{ field: "email", value: email }],
});

describe("gmailDotKey", () => {
  test("drops dots, keeps the +tag, maps googlemail to gmail", () => {
    expect(gmailDotKey("A.B.c@GMail.com")).toBe("abc@gmail.com");
    expect(gmailDotKey("a.b+x@googlemail.com")).toBe("ab+x@gmail.com");
  });
  test("other domains have no key", () => {
    expect(gmailDotKey("a.b@example.com")).toBeNull();
    expect(gmailDotKey("a.b@outlook.com")).toBeNull();
  });
});

describe("withGmailDotFallback", () => {
  test("a dotted address finds the undotted account", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "janedoe@gmail.com" }]);
    expect((await wrapped.findOne(byEmail("jane.doe@gmail.com")))?.id).toBe("u1");
  });

  test("an undotted address finds the dotted account", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe@gmail.com" }]);
    expect((await wrapped.findOne(byEmail("janedoe@gmail.com")))?.id).toBe("u1");
  });

  test("googlemail.com finds the gmail.com account", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe@gmail.com" }]);
    expect((await wrapped.findOne(byEmail("janedoe@googlemail.com")))?.id).toBe("u1");
  });

  test("a non-Gmail domain is not affected", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe@example.com" }]);
    expect(await wrapped.findOne(byEmail("janedoe@example.com"))).toBeNull();
  });

  test("two dots-only matches mean no fallback", async () => {
    const { wrapped } = fakeAdapter([
      { id: "u1", email: "jane.doe@gmail.com" },
      { id: "u2", email: "j.anedoe@gmail.com" },
    ]);
    expect(await wrapped.findOne(byEmail("janedoe@gmail.com"))).toBeNull();
  });

  test("an exact match wins over a dots-only one", async () => {
    const { wrapped, calls } = fakeAdapter([
      { id: "u1", email: "jane.doe@gmail.com" },
      { id: "u2", email: "janedoe@gmail.com" },
    ]);
    expect((await wrapped.findOne(byEmail("janedoe@gmail.com")))?.id).toBe("u2");
    expect(calls).toHaveLength(1);
  });

  test("a different +tag is not the same address here", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe@gmail.com" }]);
    expect(await wrapped.findOne(byEmail("janedoe+x@gmail.com"))).toBeNull();
  });

  test("the dots rule still applies with the same +tag", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe+x@gmail.com" }]);
    expect((await wrapped.findOne(byEmail("janedoe+x@gmail.com")))?.id).toBe("u1");
  });

  test("only a lookup of user by email alone falls back", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "jane.doe@gmail.com" }]);
    expect(
      await wrapped.findOne({
        model: "account",
        where: [{ field: "email", value: "janedoe@gmail.com" }],
      }),
    ).toBeNull();
    expect(
      await wrapped.findOne({
        model: "user",
        where: [
          { field: "email", value: "janedoe@gmail.com" },
          { field: "id", value: "u1" },
        ],
      }),
    ).toBeNull();
  });

  test("the adapter inside a transaction falls back too", async () => {
    const { wrapped } = fakeAdapter([{ id: "u1", email: "janedoe@gmail.com" }]);
    const found = await wrapped.transaction((trx) => trx.findOne(byEmail("jane.doe@gmail.com")));
    expect(found?.id).toBe("u1");
  });

  test("a failed candidate lookup means no fallback, not an error", async () => {
    const adapter = { findOne: async () => null };
    const wrapped = withGmailDotFallback(adapter as never, async () => {
      throw new Error("d1 down");
    }) as unknown as { findOne: (a: FindArgs) => Promise<Row | null> };
    const err = console.error;
    console.error = () => {};
    try {
      expect(await wrapped.findOne(byEmail("jane.doe@gmail.com"))).toBeNull();
    } finally {
      console.error = err;
    }
  });
});

describe("gmailDotFallbackAdapter", () => {
  test("every adapter the factory builds falls back", async () => {
    const rows: Row[] = [{ id: "u1", email: "janedoe@gmail.com" }];
    const base = {
      findOne: async (args: FindArgs) =>
        rows.find((r) =>
          (args.where ?? []).every((w) => (r as Record<string, unknown>)[w.field] === w.value),
        ) ?? null,
      transaction: async <R>(cb: (trx: unknown) => Promise<R>) => cb(base),
    };
    const factory = gmailDotFallbackAdapter(
      () => base as never,
      async (c) => rows.filter((r) => canonicalEmail(r.email) === c),
    );
    const adapter = factory({} as never) as unknown as {
      findOne: (a: FindArgs) => Promise<Row | null>;
    };
    expect((await adapter.findOne(byEmail("jane.doe@gmail.com")))?.id).toBe("u1");
  });
});
