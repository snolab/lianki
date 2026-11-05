import { describe, expect, it } from "bun:test";
import {
  activeTitleRules,
  cleanTitle,
  DEFAULT_TITLE_RULES,
  dropCountSeenChanging,
  isTitleHost,
  isTitlePattern,
  parseTitleRulesPref,
  titleHostOf,
  titleRuleId,
} from "@lianki/core/titleClean";
import { displayTitle } from "@/lib/titles/client";

const YT = "https://www.youtube.com/watch?v=x";
const ZH = "https://www.zhihu.com/question/1";
const OTHER = "https://example.com/a";

/** Counters: [title, url, what is left]. */
const COUNTERS: [string, string, string][] = [
  [
    "(99+ 封私信 / 38 条消息) 怎么能让书里的信息成为自己的知识呢？ - 知乎",
    ZH,
    "怎么能让书里的信息成为自己的知识呢？ - 知乎",
  ],
  ["(38 条消息) 标题 - 知乎", ZH, "标题 - 知乎"],
  ["(2 封私信) 标题 - 知乎", "https://zhuanlan.zhihu.com/p/1", "标题 - 知乎"],
  ["（38 条消息）标题 - 知乎", ZH, "标题 - 知乎"],
  ["(3) YouTube", YT, "YouTube"],
  ["(12) Some video - YouTube", YT, "Some video - YouTube"],
  ["(3) (5) Some video - YouTube", YT, "Some video - YouTube"],
  ["(3) Home / X", "https://x.com/home", "Home / X"],
  ["(20+) Facebook", "https://www.facebook.com/", "Facebook"],
  ["(1) Feed | LinkedIn", "https://www.linkedin.com/feed/", "Feed | LinkedIn"],
  // Every site, whatever the host: the shape says it.
  ["(99+) Inbox", OTHER, "Inbox"],
  ["（999+）Inbox", OTHER, "Inbox"],
  ["(3 messages) Forum", OTHER, "Forum"],
  ["(1 New Message) Forum", OTHER, "Forum"],
  ["(12 notifications) Forum", OTHER, "Forum"],
  ["(3 条消息) 论坛", OTHER, "论坛"],
  ["(3条新消息) 论坛", OTHER, "论坛"],
  ["(1200 封私信) 论坛", OTHER, "论坛"],
  ["(３ 件の通知) フォーラム", OTHER, "フォーラム"],
  ["  (99+)  Inbox", OTHER, "Inbox"],
];

/** Real titles: each stays exactly as it is. */
const REAL: [string, string | null][] = [
  ["(1984) film review", OTHER],
  ["(1984) film review - YouTube", YT],
  ["(2024) 年度总结", OTHER],
  ["(2024) 年度总结 - 知乎", ZH],
  ["(Part 2) The sequel", OTHER],
  ["(Part 2) The sequel - YouTube", YT],
  ["(18+) A film rating", OTHER],
  ["(18+) A film rating - YouTube", YT],
  ["(13+) Teen guide", null],
  ["(3) Reasons to read", OTHER],
  ["(1) Introduction", OTHER],
  ["(2) 第二章", null],
  ["(100) Best songs - YouTube", YT],
  ["(3 New Songs) Album", OTHER],
  ["(发了 3 条消息) 怎么办", OTHER],
  ["(如何发 100 条消息) 教程 - 知乎", ZH],
  ["(2024) 总结：3 条消息) 后记 - 知乎", ZH],
  ["Song (3)", YT],
  ["3 messages", OTHER],
  ["C (programming language)", OTHER],
  ["(a) first", OTHER],
];

/** Nothing would be left: unchanged. */
const WOULD_EMPTY: [string, string][] = [
  ["(3)", YT],
  ["(3) ", YT],
  ["(3) - ", YT],
  ["(99+)", OTHER],
  ["(99+ 封私信 / 38 条消息)", ZH],
  ["(3) (5)", YT],
];

describe("cleanTitle: the corpus", () => {
  for (const [title, url, want] of COUNTERS)
    it(`cleans ${title}`, () => expect(cleanTitle(title, { url })).toBe(want));
  for (const [title, url] of REAL)
    it(`keeps ${title}`, () => expect(cleanTitle(title, { url })).toBe(title));
  for (const [title, url] of WOULD_EMPTY)
    it(`would be empty, keeps "${title}"`, () => expect(cleanTitle(title, { url })).toBe(title));

  it("a site's bare count applies on that site only, subdomains included", () => {
    expect(cleanTitle("(3) Foo", { url: "https://m.youtube.com/" })).toBe("Foo");
    expect(cleanTitle("(3) Foo", { url: "https://notyoutube.com/" })).toBe("(3) Foo");
    expect(cleanTitle("(3) Foo", { url: null })).toBe("(3) Foo");
    expect(cleanTitle("(3) Foo", { url: "not a url" })).toBe("(3) Foo");
  });

  it("cleaning again changes nothing", () => {
    for (const [title, url] of COUNTERS) {
      const once = cleanTitle(title, { url });
      expect(cleanTitle(once, { url })).toBe(once);
    }
  });

  it("empty input comes back", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle(null as unknown as string)).toBe(null as unknown as string);
  });
});

describe("the pattern syntax", () => {
  const rules = (pattern: string, host = "") => [{ host, pattern }];
  const run = (title: string, pattern: string) => cleanTitle(title, { rules: rules(pattern) });

  it("# is 1 or 2 digits, ## up to 4 with an optional +", () => {
    expect(run("(12) a", "(#)")).toBe("a");
    expect(run("(123) a", "(#)")).toBe("(123) a");
    expect(run("(12+) a", "(#)")).toBe("(12+) a");
    expect(run("(1234) a", "(##)")).toBe("a");
    expect(run("(1234+) a", "(##)")).toBe("a");
    expect(run("(12345) a", "(##)")).toBe("(12345) a");
  });

  it("* stops at the literal after it, and never crosses a closing bracket", () => {
    expect(run("[x y z] a", "[*]")).toBe("a");
    expect(run("(1 x) b) a", "(#*b)")).toBe("(1 x) b) a");
  });

  it("a space matches any spacing or none; case and full-width forms fold", () => {
    expect(run("[NEW]a", "[new] ")).toBe("a");
    expect(run("【NEW】　a", "[new] ")).toBe("a");
    expect(run("[ new ] a", "[ new ]")).toBe("a");
  });

  it("\\ makes a token literal", () => {
    expect(run("# a", "\\#")).toBe("a");
    expect(run("* a", "\\*")).toBe("a");
    expect(run("3 a", "\\#")).toBe("3 a");
  });

  it("refuses what cannot be used", () => {
    for (const bad of [
      "",
      "   ",
      "*",
      "*)",
      "(*",
      "(*#)",
      "a\\",
      "(*a*b*c*d)",
      "x".repeat(49),
      "https://evil.example/x",
      null,
      3,
      {},
    ])
      expect(isTitlePattern(bad)).toBe(false);
    for (const good of ["(#)", "(##)", "(##*条消息)", "[Unread]", "\\* ", "(*)"])
      expect(isTitlePattern(good)).toBe(true);
    for (const { pattern } of DEFAULT_TITLE_RULES) expect(isTitlePattern(pattern)).toBe(true);
  });

  it("a pattern it refuses is skipped, not thrown on", () => {
    expect(run("(3) a", "(*")).toBe("(3) a");
  });
});

describe("hostile patterns and titles stay fast", () => {
  // The classic regex killers, written as rules and as titles. None of them is
  // a regex here: `(a+)+$` is literal text, so it cannot backtrack.
  const NASTY_PATTERNS = [
    "(a+)+$",
    "(a|a)*b",
    "(.*)*x",
    "^(([a-z])+.)+[A-Z]([a-z])+$",
    "a*a*a*b",
    "(#*#*#*x)",
    "(*a*a*a)",
    "a*a*a*b",
    "##########",
  ];
  const NASTY_TITLES = [
    "a".repeat(100_000),
    `${"a".repeat(100_000)}!`,
    `(${"a".repeat(100_000)}`,
    `(${"1".repeat(100_000)}`,
    " ".repeat(100_000),
    "(".repeat(100_000),
    `(1 ${"条消".repeat(50_000)}`,
    `${"(1) ".repeat(25_000)}x`,
  ];
  const elapsed = (fn: () => void) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("worst rules on worst titles, within a frame or so", () => {
    const rules = [
      ...DEFAULT_TITLE_RULES,
      ...Array.from({ length: 10 }, (_, i) => ({
        host: "",
        pattern: `(a*a*a*${"b".repeat(30)}${i})`,
      })),
      ...NASTY_PATTERNS.map((pattern) => ({ host: "", pattern })),
    ];
    for (const title of NASTY_TITLES) {
      const ms = elapsed(() => cleanTitle(title, { url: YT, rules }));
      expect(ms).toBeLessThan(50);
    }
  });

  it("regex syntax in a rule means itself", () => {
    expect(cleanTitle("aaaa b", { rules: [{ host: "", pattern: "a+" }] })).toBe("aaaa b");
    expect(cleanTitle("a+ b", { rules: [{ host: "", pattern: "a+" }] })).toBe("b");
    expect(cleanTitle("xyz b", { rules: [{ host: "", pattern: ".*" }] })).toBe("xyz b");
  });

  it("never builds a RegExp from a rule", () => {
    const Real = globalThis.RegExp;
    let built = 0;
    globalThis.RegExp = new Proxy(Real, {
      construct(t, a) {
        built++;
        return Reflect.construct(t, a);
      },
      apply(t, _, a) {
        built++;
        return Reflect.apply(t, undefined, a);
      },
    });
    try {
      cleanTitle("(3) Foo", { url: YT, rules: [{ host: "", pattern: "(a+)+$" }] });
    } finally {
      globalThis.RegExp = Real;
    }
    expect(built).toBe(0);
  });

  it("a stored preference of junk reads as defaults, and caps hold", () => {
    expect(parseTitleRulesPref(null)).toEqual({ off: [], add: [] });
    expect(parseTitleRulesPref({ off: "x", add: 3 })).toEqual({ off: [], add: [] });
    const add = Array.from({ length: 500 }, () => ({ host: "", pattern: "(#)", extra: 1 }));
    const parsed = parseTitleRulesPref({ off: ["nope", "abcd1234"], add });
    expect(parsed.off).toEqual(["abcd1234"]);
    expect(parsed.add.length).toBe(10);
    expect(parsed.add[0]).toEqual({ host: "", pattern: "(#)" });
    expect(
      parseTitleRulesPref({ add: [{ host: "x.ts.net", pattern: "(#)" }, { pattern: "(#)" }, 1] })
        .add,
    ).toEqual([]);
  });
});

describe("the preference", () => {
  it("removing a default and adding your own", () => {
    const yt = DEFAULT_TITLE_RULES.find((r) => r.host === "youtube.com")!;
    const rules = activeTitleRules({
      off: [titleRuleId(yt)],
      add: [{ host: "example.com", pattern: "(#)" }],
    });
    expect(cleanTitle("(3) Foo", { url: YT, rules })).toBe("(3) Foo");
    expect(cleanTitle("(3) Foo", { url: OTHER, rules })).toBe("Foo");
    expect(cleanTitle("(99+) Foo", { url: YT, rules })).toBe("Foo");
  });

  it("nothing stored is the defaults themselves", () => {
    expect(activeTitleRules(undefined)).toBe(DEFAULT_TITLE_RULES);
    expect(activeTitleRules({ off: [], add: [] })).toBe(DEFAULT_TITLE_RULES);
  });

  it("default ids are unique", () => {
    const ids = DEFAULT_TITLE_RULES.map(titleRuleId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(64);
  });

  it("the largest value fits the 2 KB a preference may hold", () => {
    const pref = {
      off: Array.from({ length: 64 }, () => "abcd1234"),
      add: Array.from({ length: 10 }, () => ({
        host: "h".repeat(40),
        pattern: "p".repeat(48),
      })),
    };
    expect(JSON.stringify(pref).length).toBeLessThanOrEqual(2048);
  });

  it("a host is a public site in one stored form", () => {
    expect(titleHostOf("https://www.Zhihu.com/question/1")).toBe("zhihu.com");
    expect(titleHostOf("zhihu.com")).toBe("zhihu.com");
    for (const bad of [
      "",
      "localhost",
      "taku.onca-tint.ts.net",
      "192.168.31.96",
      "127.0.0.1",
      "foo",
      "printer.local",
      "a b.com",
      `${"a".repeat(50)}.com`,
      3,
    ])
      expect(titleHostOf(bad)).toBeNull();
    expect(isTitleHost("")).toBe(true);
    expect(isTitleHost("zhihu.com")).toBe(true);
    expect(isTitleHost("www.zhihu.com")).toBe(false);
    expect(isTitleHost("https://zhihu.com")).toBe(false);
  });
});

describe("dropCountSeenChanging: the page was seen before", () => {
  it("the number changed, or was not there", () => {
    expect(dropCountSeenChanging("(5) Foo", "(3) Foo")).toBe("Foo");
    expect(dropCountSeenChanging("(5) Foo", "Foo")).toBe("Foo");
    expect(dropCountSeenChanging("(12+) Foo", "(3) Foo")).toBe("Foo");
  });

  it("no evidence, no change", () => {
    expect(dropCountSeenChanging("(5) Foo", "(5) Foo")).toBe("(5) Foo");
    expect(dropCountSeenChanging("(5) Foo", "Bar")).toBe("(5) Foo");
    expect(dropCountSeenChanging("(5) Foo", null)).toBe("(5) Foo");
    expect(dropCountSeenChanging("Foo", "(3) Foo")).toBe("Foo");
    expect(dropCountSeenChanging("(5)", "(3)")).toBe("(5)");
  });
});

describe("displayTitle", () => {
  it("cleans by the card's url, keeps null", () => {
    expect(displayTitle("(3) Foo", YT)).toBe("Foo");
    expect(displayTitle("(3) Foo", OTHER)).toBe("(3) Foo");
    expect(displayTitle("(99+) Foo")).toBe("Foo");
    expect(displayTitle(null, YT)).toBeNull();
    expect(displayTitle(undefined, YT)).toBeNull();
    expect(displayTitle("", YT)).toBe("");
  });

  it("follows this device's copy of the preference, junk included", () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
    };
    try {
      store.set("lk:title-rules", JSON.stringify({ off: [], add: [{ host: "", pattern: "[x]" }] }));
      expect(displayTitle("[x] Foo")).toBe("Foo");
      store.set("lk:title-rules", "{not json");
      expect(displayTitle("[x] Foo")).toBe("[x] Foo");
      expect(displayTitle("(99+) Foo")).toBe("Foo");
    } finally {
      g.localStorage = before;
    }
  });
});
