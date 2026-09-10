import { describe, expect, it } from "bun:test";
import { groupByHost } from "@/app/lib/notesAdmin";

const NOW = Date.parse("2026-09-10T00:00:00Z");
const past = "2026-01-01T00:00:00Z";
const future = "2027-01-01T00:00:00Z";

describe("groupByHost", () => {
  it("counts cards and due cards per host", () => {
    // The shape of the report that made the dead site visible: a host with many
    // cards, a good number of them due, all sharing one cause.
    const rows = [
      { url: "https://brainstorm.snomiao.dev/faq?q=1", due: past },
      { url: "https://brainstorm.snomiao.dev/faq?q=2", due: past },
      { url: "https://brainstorm.snomiao.dev/other", due: future },
      { url: "https://example.com/a", due: future },
    ];
    expect(groupByHost(rows, NOW)).toEqual([
      {
        host: "brainstorm.snomiao.dev",
        count: 3,
        due: 2,
        sampleUrl: "https://brainstorm.snomiao.dev/faq?q=1",
      },
      { host: "example.com", count: 1, due: 0, sampleUrl: "https://example.com/a" },
    ]);
  });

  it("orders by card count, so the sites worth cleaning come first", () => {
    const rows = [
      { url: "https://a.test/1", due: null },
      { url: "https://b.test/1", due: null },
      { url: "https://b.test/2", due: null },
      { url: "https://c.test/1", due: null },
      { url: "https://c.test/2", due: null },
      { url: "https://c.test/3", due: null },
    ];
    expect(groupByHost(rows, NOW).map((g) => g.host)).toEqual(["c.test", "b.test", "a.test"]);
  });

  it("breaks count ties by name, so the list does not reshuffle between loads", () => {
    const rows = [{ url: "https://z.test/1" }, { url: "https://a.test/1" }];
    expect(groupByHost(rows, NOW).map((g) => g.host)).toEqual(["a.test", "z.test"]);
  });

  it("keeps the port, since a different port is a different server", () => {
    const rows = [{ url: "https://example.com:8443/a" }, { url: "https://example.com/a" }];
    expect(
      groupByHost(rows, NOW)
        .map((g) => g.host)
        .sort(),
    ).toEqual(["example.com", "example.com:8443"]);
  });

  it("surfaces unparseable urls instead of dropping them", () => {
    // A card you cannot see is a card you cannot delete — which is the whole
    // problem this view exists to solve.
    const rows = [{ url: "not a url" }, { url: "" }, { url: "https://ok.test/a" }];
    const groups = groupByHost(rows, NOW);
    expect(groups.find((g) => g.host === "(unparseable)")).toMatchObject({ count: 2 });
  });

  it("counts a card due exactly now as due", () => {
    const rows = [{ url: "https://a.test/1", due: new Date(NOW) }];
    expect(groupByHost(rows, NOW)[0].due).toBe(1);
  });

  it("treats a missing due date as not due rather than throwing", () => {
    const rows = [{ url: "https://a.test/1" }, { url: "https://a.test/2", due: null }];
    expect(groupByHost(rows, NOW)[0]).toMatchObject({ count: 2, due: 0 });
  });

  it("returns nothing for an empty deck", () => {
    expect(groupByHost([], NOW)).toEqual([]);
  });
});
