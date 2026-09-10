import { describe, expect, it } from "bun:test";
import { pickNextDue } from "@/lib/next-card";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const at = (iso: string) => ({ url: iso, card: { due: iso } });

describe("pickNextDue", () => {
  it("takes the most recently due card, not the oldest", () => {
    // Same rule as the server's NEXT_DUE_SORT. Oldest-first buries you in a
    // backlog whose end you never reach; the card that came due most recently
    // is the one you most recently decided was worth remembering.
    const cards = [
      at("2026-01-01T00:00:00Z"),
      at("2026-09-09T00:00:00Z"),
      at("2026-06-01T00:00:00Z"),
    ];
    expect(pickNextDue(cards, NOW)?.url).toBe("2026-09-09T00:00:00Z");
  });

  it("ignores cards scheduled for later", () => {
    const cards = [at("2026-12-01T00:00:00Z"), at("2026-09-01T00:00:00Z")];
    expect(pickNextDue(cards, NOW)?.url).toBe("2026-09-01T00:00:00Z");
  });

  it("counts a card due exactly now", () => {
    expect(pickNextDue([at(new Date(NOW).toISOString())], NOW)).not.toBeNull();
  });

  it("returns null when nothing is due", () => {
    expect(pickNextDue([at("2027-01-01T00:00:00Z")], NOW)).toBeNull();
    expect(pickNextDue([], NOW)).toBeNull();
  });

  it("skips a card with an unreadable due date instead of serving it forever", () => {
    // NaN loses every comparison. Were it treated as due at the epoch it would
    // win nothing here, but a `!(due > now)` style test would make it always
    // due — and an undeletable card that reappears is the exact failure this
    // whole area keeps producing.
    const cards = [{ url: "broken", card: { due: "not a date" } }, at("2026-09-01T00:00:00Z")];
    expect(pickNextDue(cards, NOW)?.url).toBe("2026-09-01T00:00:00Z");
    expect(pickNextDue([{ url: "broken", card: { due: "not a date" } }], NOW)).toBeNull();
  });

  it("accepts Date objects as well as strings, since the mirror holds both", () => {
    const cards = [{ url: "d", card: { due: new Date("2026-09-05T00:00:00Z") } }];
    expect(pickNextDue(cards, NOW)?.url).toBe("d");
  });
});
