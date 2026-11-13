/**
 * The profile's raw session dump is internals: a normal user's profile never
 * shows it; only an account with dev access (the /dev gate) does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionDetailsCard } from "../app/(app)/my/profile/SessionDetailsCard";
import { clearPermissionCache, grantAll } from "./support/grants";

const now = new Date("2026-11-09T00:00:00Z");
const session = {
  session: { expiresAt: now, createdAt: now, updatedAt: now },
  user: {
    name: "A",
    email: "user@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    id: "u1",
  },
};
const render = (viewerEmail: string | null) =>
  renderToStaticMarkup(
    createElement(SessionDetailsCard, { viewerEmail, title: "Session Details", session }),
  );

afterEach(() => clearPermissionCache());

describe("profile session details", () => {
  test("a normal user's profile has no session-details block", () => {
    grantAll(["dev@example.com"]);
    const html = render("user@example.com");
    expect(html).toBe("");
    expect(html).not.toContain("session-details");
  });

  test("a guest or unknown gate state shows nothing (fail closed)", () => {
    expect(render(null)).toBe("");
    expect(render("dev@example.com")).toBe(""); // no snapshot yet
  });

  test("an account with dev access sees it, without the token", () => {
    grantAll(["dev@example.com"]);
    const html = render("dev@example.com");
    expect(html).toContain('data-testid="session-details"');
    expect(html).toContain("Session Details");
    expect(html).not.toContain("token");
  });
});
