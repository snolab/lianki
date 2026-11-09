import { describe, expect, it } from "bun:test";
import {
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ASK_MAX_TTL_MS,
  askState,
  askText,
  checkChoices,
  parseAsk,
} from "@lianki/debug-chat/ask";

const now = 1_000_000;
const id = () => "gen1";

describe("parseAsk", () => {
  it("one question: ids made up, the first option recommended as marked", () => {
    const r = parseAsk(
      { question: " Apply? ", options: [{ label: "Yes", recommended: true }, "No"] },
      now,
      id,
    );
    expect(r).toEqual({
      ok: true,
      ask: {
        askId: "gen1",
        questions: [
          {
            id: "q1",
            question: "Apply?",
            options: [
              { id: "o1", label: "Yes", recommended: true },
              { id: "o2", label: "No" },
            ],
          },
        ],
      },
    });
  });

  it("a batch keeps its ids, multi and a capped expiry", () => {
    const r = parseAsk(
      {
        askId: "cal",
        expiresAt: now + 10 * ASK_MAX_TTL_MS,
        questions: [
          { id: "tz", question: "Time zone?", options: [{ id: "utc", label: "UTC" }, "Local"] },
          { question: "Days?", options: ["Mon", "Tue"], multi: true },
        ],
      },
      now,
      id,
    );
    expect(r.ok && r.ask.askId).toBe("cal");
    expect(r.ok && r.ask.expiresAt).toBe(now + ASK_MAX_TTL_MS);
    expect(r.ok && r.ask.questions.map((q) => [q.id, q.multi ?? false, q.options[0]!.id])).toEqual([
      ["tz", false, "utc"],
      ["q2", true, "o1"],
    ]);
  });

  it("refuses what cannot be a card", () => {
    const bad = (m: Record<string, unknown>) => {
      const r = parseAsk(m, now, id);
      return r.ok ? "ok" : r.error;
    };
    expect(bad({ question: "", options: ["a"] })).toContain("needs text");
    expect(bad({ question: "q", options: [] })).toContain("at least one option");
    expect(bad({ question: "q", options: Array(ASK_MAX_OPTIONS + 1).fill("x") })).toContain(
      "at most",
    );
    expect(bad({ question: "q", options: [{ label: "" }] })).toContain("needs a label");
    expect(
      bad({
        question: "q",
        options: [
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ],
      }),
    ).toContain("must differ");
    expect(bad({ questions: [] })).toContain("needs a question");
    expect(
      bad({ questions: Array(ASK_MAX_QUESTIONS + 1).fill({ question: "q", options: ["a"] }) }),
    ).toContain("at most");
    expect(
      bad({
        questions: [
          { id: "x", question: "a", options: ["1"] },
          { id: "x", question: "b", options: ["1"] },
        ],
      }),
    ).toContain("must differ");
    expect(bad({ question: "q", options: ["a"], expiresAt: now - 1 })).toContain("already past");
  });
});

describe("checkChoices and askState", () => {
  const r = parseAsk(
    {
      askId: "b",
      questions: [
        { id: "a", question: "Days?", options: ["Mon", "Tue"], multi: true },
        { id: "b", question: "OK?", options: ["Yes", "No"] },
      ],
    },
    now,
    id,
  );
  const ask = r.ok ? r.ask : (null as never);

  it("every question answered, with its own option ids, one unless multi", () => {
    expect(checkChoices(ask, { a: ["o2", "o1", "o2"], b: "o1" })).toEqual({
      a: ["o2", "o1"],
      b: ["o1"],
    });
    expect(checkChoices(ask, { a: ["o1"] })).toBeNull();
    expect(checkChoices(ask, { a: ["o9"], b: "o1" })).toBeNull();
    expect(checkChoices(ask, { a: ["o1"], b: ["o1", "o2"] })).toBeNull();
    expect(checkChoices(ask, { a: [], b: "o1" })).toBeNull();
    expect(checkChoices(ask, [1])).toBeNull();
    expect(checkChoices(ask, null)).toBeNull();
  });

  it("open, answered, expired; askText for pages without cards", () => {
    expect(askState({ ask }, now)).toBe("open");
    expect(askState({ ask: { ...ask, expiresAt: now } }, now)).toBe("expired");
    expect(
      askState(
        { ask, answer: { choices: {}, source: "tap", thread: "owner", label: "", at: 1 } },
        now,
      ),
    ).toBe("answered");
    expect(askText(ask)).toBe("Days? — Mon / Tue (+1 more)");
  });
});
