/**
 * /profile "This sign-in" (app/(app)/profile/SessionBasicsCard.tsx): every
 * signed-in user sees when this browser's session began and when it expires,
 * in the request's time zone with the zone named — and nothing else from the
 * session (no token, IP or user agent; the raw dump stays dev-only).
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionBasicsCard, sessionWhen } from "@/app/(app)/profile/SessionBasicsCard";
import profileSession from "@/app/(app)/profile/session-basics.content";

const labels = {
  heading: "This sign-in",
  since: "Signed in since {date}",
  expires: "This session expires {date}",
  hint: "Using Lianki keeps you signed in; signing out ends it on this device.",
};
const session = {
  createdAt: new Date("2026-11-09T09:15:00Z"),
  expiresAt: "2026-11-16T09:15:00Z",
  // What better-auth's session also carries: never shown.
  token: "secret-session-token",
  ipAddress: "203.0.113.7",
  userAgent: "QA-Agent/1.0",
};
const render = (p: Partial<Parameters<typeof SessionBasicsCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionBasicsCard, {
      session,
      locale: "en",
      timeZone: "Asia/Tokyo",
      labels,
      ...p,
    }),
  );

describe("sessionWhen", () => {
  it("writes the date out, with the time and its zone (JST for Tokyo)", () => {
    const s = sessionWhen(session.createdAt, "en", "Asia/Tokyo");
    expect(s).toContain("November 9, 2026");
    expect(s).toMatch(/6:15\s?PM/);
    expect(s).toMatch(/GMT\+9|JST/);
    expect(sessionWhen(session.createdAt, "ja", "Asia/Tokyo")).toBe("2026年11月9日 18:15 JST");
  });

  it("falls back to UTC when the zone is unknown or not a real zone", () => {
    expect(sessionWhen(session.createdAt, "en")).toMatch(/9:15\s?AM/);
    expect(sessionWhen(session.createdAt, "en")).toContain("UTC");
    expect(sessionWhen(session.createdAt, "en", "Not/AZone")).toContain("UTC");
  });
});

describe("SessionBasicsCard", () => {
  it("shows since and expires for an ordinary user, no internals", () => {
    const html = render();
    expect(html).toContain('data-testid="session-basics"');
    expect(html).toContain("This sign-in");
    expect(html).toContain("Signed in since November 9, 2026");
    expect(html).toContain("This session expires November 16, 2026");
    expect(html).toContain(labels.hint);
    for (const secret of [session.token, session.ipAddress, session.userAgent])
      expect(html).not.toContain(secret);
    expect(html).not.toContain("{date}");
  });

  it("renders nothing without a session", () => {
    expect(render({ session: null })).toBe("");
    expect(render({ session: undefined })).toBe("");
  });
});

describe("profile-session strings", () => {
  type Leaf = { translation: Record<string, string> };
  const c = profileSession.content as unknown as Record<string, Leaf>;
  it("16 locales each, and the dated lines keep {date}", () => {
    for (const k of Object.keys(c)) expect(Object.keys(c[k].translation)).toHaveLength(16);
    for (const k of ["since", "expires"])
      for (const [loc, text] of Object.entries(c[k].translation))
        expect([k, loc, text.includes("{date}")]).toEqual([k, loc, true]);
  });
});
