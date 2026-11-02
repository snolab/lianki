/**
 * /embed/partner is framable by any site, so it must mount none of the
 * owner's page boots (DebugEval: cookie socket, pairing / Allow UI, eval, hot
 * islands), and a lianki.com page framed by another site never connects
 * (docs/dev-debug-widget.md, "The frame"). The real route in a frame is
 * checked end to end by scripts/qa/qa-partner-frame-route.ts (in qa:all).
 */
import { describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { PARTNER_FRAME_HEADER, isPartnerFramePath } from "@/lib/app-locale";
import { frameContext } from "@/lib/frame-context";
import { readFileSync } from "node:fs";

/** What middleware hands the layout as a request header (NextResponse.next({request:{headers}})). */
const passed = (res: Response, h: string) => res.headers.get(`x-middleware-request-${h}`);

describe("the partner frame route gets no owner boots", () => {
  it("middleware marks /embed/partner, and only it, for the root layout", () => {
    expect(isPartnerFramePath("/embed/partner")).toBe(true);
    expect(isPartnerFramePath("/embed/partner/x")).toBe(true);
    expect(isPartnerFramePath("/embed/partnerx")).toBe(false);
    expect(isPartnerFramePath("/words")).toBe(false);
    const frame = middleware(new NextRequest("https://lianki.com/embed/partner"));
    expect(passed(frame, PARTNER_FRAME_HEADER)).toBe("1");
  });

  it("a request can neither set the mark on another page nor clear it on the frame", () => {
    const spoofOn = middleware(
      new NextRequest("https://lianki.com/words", { headers: { [PARTNER_FRAME_HEADER]: "1" } }),
    );
    expect(passed(spoofOn, PARTNER_FRAME_HEADER)).toBeNull();
    const spoofOff = middleware(
      new NextRequest("https://lianki.com/embed/partner", {
        headers: { [PARTNER_FRAME_HEADER]: "0" },
      }),
    );
    expect(passed(spoofOff, PARTNER_FRAME_HEADER)).toBe("1");
  });

  it("the root layout mounts DebugEval (and its islands) only through OwnerBoots, skipped on the mark", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).not.toMatch(/<DebugEval\b/);
    expect(layout).not.toMatch(/<ServiceWorkerRegistration\b|<NewVersionNotice\b/);
    expect(layout).toMatch(/partnerFrame \? null : <OwnerBoots /);
    expect(layout).toMatch(/get\(PARTNER_FRAME_HEADER\) === "1"/);
    // The frame's own page never imports DebugEval or the islands either.
    for (const f of ["app/embed/partner/page.tsx", "app/embed/partner/PartnerFrame.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/DebugEval|useIslands|islands/);
    }
  });
});

describe("middleware's other paths (unchanged, covered here)", () => {
  it("redirects www, /cn and legacy locale-prefixed app routes; passes /next; sets ?lang=", () => {
    const www = middleware(
      new NextRequest("https://www.lianki.com/words", { headers: { host: "www.lianki.com" } }),
    );
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe("https://lianki.com/words");
    expect(middleware(new NextRequest("https://lianki.com/cn/blog")).headers.get("location")).toBe(
      "https://lianki.com/zh/blog",
    );
    const legacy = middleware(new NextRequest("https://lianki.com/ja/list?x=1"));
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe("https://lianki.com/list?x=1&lang=ja");
    expect(middleware(new NextRequest("https://lianki.com/en/list")).headers.get("location")).toBe(
      "https://lianki.com/list",
    );
    expect(middleware(new NextRequest("https://lianki.com/next")).status).toBe(200);
    const lang = middleware(new NextRequest("https://lianki.com/words?lang=ja"));
    expect(lang.headers.get("set-cookie")).toContain("lang=ja");
    const cookie = middleware(
      new NextRequest("https://lianki.com/words", { headers: { cookie: "lang=ko" } }),
    );
    expect(passed(cookie, "x-lianki-lang")).toBe("ko");
    const landing = middleware(new NextRequest("https://lianki.com/ja"));
    expect(landing.headers.get("set-cookie") ?? "").toContain("lang=ja");
  });
});

describe("frameContext", () => {
  const loc = (origin: string, anc?: string[]) => ({ origin, ancestorOrigins: anc });
  it("top, same-origin frame, foreign frame; unknown counts as foreign", () => {
    const w = { location: loc("https://lianki.com") } as Record<string, unknown>;
    w.self = w;
    w.top = w;
    expect(frameContext(w)).toBe("top");
    expect(frameContext(null as never)).toBe("top");
    const self = {};
    expect(
      frameContext({ self, top: {}, location: loc("https://lianki.com", ["https://lianki.com"]) }),
    ).toBe("same");
    expect(
      frameContext({
        self,
        top: {},
        location: loc("https://lianki.com", ["https://lianki.com", "https://evil.example"]),
      }),
    ).toBe("foreign");
    expect(frameContext({ self, top: {}, location: loc("https://lianki.com", []) })).toBe(
      "foreign",
    );
    // No ancestorOrigins: a cross-origin top throws on read.
    const crossTop = {
      get location(): never {
        throw new Error("cross-origin");
      },
    };
    expect(frameContext({ self, top: crossTop, location: loc("https://lianki.com") })).toBe(
      "foreign",
    );
    expect(
      frameContext({
        self,
        top: { location: { origin: "https://lianki.com" } },
        location: loc("https://lianki.com"),
      }),
    ).toBe("same");
  });
});
