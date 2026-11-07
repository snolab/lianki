/**
 * scripts/dev/box-host.ts: devbox/host-tunnel.sh's check of DEVBOX_PUBLIC_URL,
 * the same rule as the Worker's (lib/box-oauth/rules.ts).
 */
import { describe, expect, test } from "bun:test";
import { boxHostOf, main } from "../scripts/dev/box-host";

describe("DEVBOX_PUBLIC_URL to a tunnel host", () => {
  test("a hex or named box URL gives its host", () => {
    expect(boxHostOf("https://my-0123456789abcdef.lianki.com")).toBe(
      "my-0123456789abcdef.lianki.com",
    );
    expect(boxHostOf("https://my-example.lianki.com/")).toBe("my-example.lianki.com");
  });

  test("the command prints the host and exits 0, or prints nothing and exits 1", () => {
    const out: string[] = [];
    expect(main("https://my-example.lianki.com", (s) => out.push(s))).toBe(0);
    expect(main("https://my-www.lianki.com", (s) => out.push(s))).toBe(1);
    expect(out).toEqual(["my-example.lianki.com"]);
  });

  test("anything else gives nothing, so the script refuses", () => {
    for (const u of [
      undefined,
      "",
      "my-example.lianki.com",
      "http://my-example.lianki.com",
      "https://my-example.lianki.com/x",
      "https://my-example.lianki.com.evil.com",
      "https://my-admin.lianki.com",
      "https://MY-EXAMPLE.lianki.com",
      "https://my-ab.lianki.com",
      '"https://my-example.lianki.com"',
    ])
      expect(boxHostOf(u)).toBeNull();
  });
});
