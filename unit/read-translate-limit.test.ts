// The per-user guard of the reader's translate, and the live doc's higher one.
import { describe, expect, it } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { AI_LIMIT_LIVE, translate } from "@/lib/read/translate-server";
import type { D1Batch } from "@/lib/read/reader-store";

const complete = async () => ({ choices: [{ message: { content: "译文" } }], usage: {} });

describe("translate's limit", () => {
  it("a caller's limit replaces the default guard", async () => {
    const db = createTestD1(testSchema()) as unknown as D1Batch;
    const limit = { windowMs: 60_000, max: 1 };
    const userId = `limit${Math.random()}`;
    const ask = (text: string) =>
      translate(db, { text, to: "zh", from: null }, { userId, limit, complete: complete as never });
    expect((await ask("first")).ok).toBe(true);
    expect(await ask("second")).toEqual({ ok: false, error: "busy" });
    // Asked before: the cache answers, whatever the limit.
    expect((await ask("first")).ok).toBe(true);
  });
  it("the live guard is well above the default's 60", () => {
    expect(AI_LIMIT_LIVE.max).toBeGreaterThan(60);
  });
});
