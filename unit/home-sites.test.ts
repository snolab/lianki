import { describe, expect, it } from "bun:test";
import { rankSites, siteStats } from "@/lib/home-sites";

const NOW = Date.parse("2026-09-14T12:00:00Z");

describe("siteStats", () => {
  it("groups subdomains of one publisher together and counts what is due", () => {
    const stats = siteStats(
      [
        { url: "https://movie.douban.com/subject/1", due: "2026-09-14T11:00:00Z" },
        { url: "https://book.douban.com/subject/2", due: "2026-09-15T00:00:00Z" },
        { url: "https://www.zhihu.com/question/3", due: null },
        { url: "not a url", due: "2026-09-14T00:00:00Z" },
      ],
      NOW,
    );
    expect(stats.get("douban.com")).toEqual({
      site: "douban.com",
      count: 2,
      due: 1,
      sampleUrl: "https://movie.douban.com/subject/1",
    });
    expect(stats.get("zhihu.com")?.count).toBe(1);
    expect(stats.get("zhihu.com")?.due).toBe(0);
    expect(stats.size).toBe(2);
  });
});

describe("rankSites", () => {
  it("puts sites with due cards first, then the biggest, then alphabetical", () => {
    const stats = siteStats(
      [
        { url: "https://a.example/1" },
        { url: "https://a.example/2" },
        { url: "https://b.example/1", due: "2026-01-01T00:00:00Z" },
        { url: "https://c.example/1" },
      ],
      NOW,
    );
    expect(rankSites(stats).map((s) => s.site)).toEqual(["b.example", "a.example", "c.example"]);
  });
});
