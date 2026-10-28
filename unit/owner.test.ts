import { afterEach, describe, expect, it } from "bun:test";
import { isOwner, ownerEmails } from "@/lib/owner";

describe("ownerEmails", () => {
  it("splits, trims, lowercases and drops blanks", () => {
    expect(ownerEmails(" A@x.com, ,b@Y.com ,")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("is empty when unset", () => {
    expect(ownerEmails(undefined)).toEqual([]);
    expect(ownerEmails("")).toEqual([]);
  });
});

describe("isOwner", () => {
  const saved = process.env.OWNER_EMAILS;
  afterEach(() => {
    if (saved === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = saved;
  });

  it("matches a listed email case-insensitively", () => {
    expect(isOwner("Owner@Example.com", "owner@example.com,other@example.com")).toBe(true);
    expect(isOwner(" other@example.com ", "owner@example.com,other@example.com")).toBe(true);
  });

  it("rejects unlisted, empty and missing emails", () => {
    expect(isOwner("someone@example.com", "owner@example.com")).toBe(false);
    expect(isOwner("", "owner@example.com")).toBe(false);
    expect(isOwner(null, "owner@example.com")).toBe(false);
    expect(isOwner(undefined, "owner@example.com")).toBe(false);
  });

  it("fails closed when no owner is configured", () => {
    expect(isOwner("owner@example.com", "")).toBe(false);
    expect(isOwner("owner@example.com", " , ")).toBe(false);
  });

  it("reads OWNER_EMAILS from the environment by default", () => {
    process.env.OWNER_EMAILS = "env-owner@example.com";
    expect(isOwner("env-owner@example.com")).toBe(true);
    delete process.env.OWNER_EMAILS;
    expect(isOwner("env-owner@example.com")).toBe(false);
  });
});
