import { test, expect } from "bun:test";
import { publicSitePermissionResult } from "../lib/site-permission-result";
const g = {
  origin: "https://example.test",
  scope: "page.read",
  enabled: true,
  revision: 1,
} as const;
test("public permission responses rebuild every field and discard capability, account and extra metadata", () => {
  expect(
    publicSitePermissionResult({
      ok: true,
      kind: "list",
      grants: [{ ...g, sub: "private", ticket: "private" }],
      ticket: "private",
    }),
  ).toEqual({ ok: true, kind: "list", grants: [g] });
  expect(
    publicSitePermissionResult({
      ok: true,
      kind: "grant",
      grant: g,
      accountBinding: "A".repeat(22),
      ticket: "private",
    }),
  ).toEqual({ ok: true, kind: "grant", grant: g, accountBinding: "A".repeat(22) });
  expect(
    publicSitePermissionResult({
      ok: true,
      kind: "selection",
      revision: 1,
      selection: { text: "Chosen", title: "Page", url: g.origin + "/a?token=removed#x" },
      ticket: "private",
    }),
  ).toEqual({
    ok: true,
    kind: "selection",
    revision: 1,
    selection: { text: "Chosen", title: "Page", url: g.origin + "/a" },
  });
  for (const error of ["invalid", "replay", "denied", "busy", "unavailable"] as const)
    expect(publicSitePermissionResult({ ok: false, error, debug: "private" })).toEqual({
      ok: false,
      error,
    });
});
test("malformed grants, oversized lists, unsafe selected URLs and binding corruption are refused", () => {
  for (const value of [
    null,
    [],
    {},
    { ok: false, error: "new-error" },
    { ok: true, kind: "other" },
    { ok: true, kind: "list", grants: [null] },
    { ok: true, kind: "list", grants: Array(129).fill(g) },
    { ok: true, kind: "grant", grant: { ...g, origin: "http://example.test" } },
    { ok: true, kind: "grant", grant: g, accountBinding: "bad" },
    {
      ok: true,
      kind: "selection",
      revision: 1,
      selection: { text: "a", title: "b", url: "invalid" },
    },
    {
      ok: true,
      kind: "selection",
      revision: -1,
      selection: { text: "a", title: "b", url: g.origin },
    },
  ])
    expect(publicSitePermissionResult(value)).toBeNull();
});

test("non-string error codes cannot pass enum validation through coercion", () => {
  expect(publicSitePermissionResult({ ok: false, error: ["denied"] })).toBeNull();
  expect(publicSitePermissionResult({ ok: false, error: { toString: () => "denied" } })).toBeNull();
});
