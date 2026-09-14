import { describe, expect, it } from "bun:test";
import { hostOf, originOf, pickNextDue, siteOf } from "@/lib/next-card";

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

  it("prefers the origin you are on, even over a more recently due card elsewhere", () => {
    // A same-origin hop is a cheap navigation and no context switch, and FSRS
    // is indifferent to the order due cards are cleared in.
    const cards = [
      { url: "https://example.com/fresh", card: { due: "2026-09-10T11:59:00Z" } },
      { url: "https://www.youtube.com/watch?v=stale", card: { due: "2026-01-01T00:00:00Z" } },
      { url: "https://www.youtube.com/watch?v=later", card: { due: "2026-06-01T00:00:00Z" } },
    ];
    expect(pickNextDue(cards, NOW, "https://www.youtube.com")?.url).toBe(
      "https://www.youtube.com/watch?v=later",
    );
  });

  it("is exact: a subdomain, another scheme, or another port is a different origin", () => {
    // zhuanlan.zhihu.com and www.zhihu.com share a domain but are different
    // products with different content — moving between them is the context
    // switch the preference exists to avoid. Same for http vs https, and for
    // localhost:3000 vs localhost:5173.
    const fresh = { url: "https://example.com/fresh", card: { due: "2026-09-10T11:59:00Z" } };
    for (const [from, other] of [
      ["https://www.zhihu.com/question/1", "https://zhuanlan.zhihu.com/p/1"],
      ["https://snomiao.com/a", "http://snomiao.com/b"],
      ["http://localhost:3000/a", "http://localhost:5173/b"],
    ]) {
      const cards = [fresh, { url: other, card: { due: "2026-01-01T00:00:00Z" } }];
      expect(pickNextDue(cards, NOW, originOf(from))?.url).toBe(fresh.url);
    }
  });

  it("works for localhost and tunnel hosts, which have no registrable domain", () => {
    const cards = [
      { url: "https://example.com/fresh", card: { due: "2026-09-10T11:59:00Z" } },
      { url: "http://localhost:3000/b", card: { due: "2026-01-01T00:00:00Z" } },
      { url: "https://abc-def.trycloudflare.com/x", card: { due: "2026-02-01T00:00:00Z" } },
    ];
    expect(pickNextDue(cards, NOW, "http://localhost:3000")?.url).toBe("http://localhost:3000/b");
    expect(pickNextDue(cards, NOW, "https://abc-def.trycloudflare.com")?.url).toBe(
      "https://abc-def.trycloudflare.com/x",
    );
  });

  it("is a preference, not a filter: a drained origin falls through to the plain rule", () => {
    const cards = [
      { url: "https://example.com/fresh", card: { due: "2026-09-10T11:59:00Z" } },
      { url: "https://www.youtube.com/watch?v=x", card: { due: "2027-01-01T00:00:00Z" } },
    ];
    expect(pickNextDue(cards, NOW, "https://www.youtube.com")?.url).toBe("https://example.com/fresh");
    expect(pickNextDue(cards, NOW, "https://nothing.test")?.url).toBe("https://example.com/fresh");
  });

  it("originOf is the browser's origin: scheme, host, port; default port dropped", () => {
    expect(originOf("https://a.test:8443/x?y")).toBe("https://a.test:8443");
    expect(originOf("https://a.test:443/x")).toBe("https://a.test");
    expect(originOf("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("about:blank")).toBeNull(); // opaque origin, not a site
    expect(originOf(null)).toBeNull();
  });

  it("siteOf still groups by registrable domain, for callers that want the publisher", () => {
    expect(siteOf("https://zhuanlan.zhihu.com/p/1")).toBe("zhihu.com");
    expect(siteOf("https://cdn.p.recruit.co.jp/x")).toBe("recruit.co.jp");
    expect(siteOf("https://825dbd8d.comfy-qa.pages.dev/")).toBe("comfy-qa.pages.dev");
    expect(siteOf("https://127.0.0.1:3000/")).toBe("127.0.0.1");
    expect(siteOf("not a url")).toBeNull();
  });

  it("hostOf keeps the exact host, port included", () => {
    expect(hostOf("https://a.test:8443/x")).toBe("a.test:8443");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it("accepts Date objects as well as strings, since the mirror holds both", () => {
    const cards = [{ url: "d", card: { due: new Date("2026-09-05T00:00:00Z") } }];
    expect(pickNextDue(cards, NOW)?.url).toBe("d");
  });
});
