import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * A PII scanner that silently stops matching is worse than no scanner, because it
 * reports "clean" either way. Run the real script against planted fixtures.
 */
function scan(contents: string): { exitCode: number; output: string } {
  const file = join(mkdtempSync(join(tmpdir(), "pii-")), "fixture.txt");
  writeFileSync(file, contents);
  try {
    const output = execFileSync("bun", ["scripts/pii-scan.ts", file], {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { exitCode: err.status, output: `${err.stdout}${err.stderr}` };
  }
}

// Assembled at runtime, never written as literals: secretlint scans this file too
// and would (correctly) fail the commit on a credential-shaped string.
const j = (...parts: string[]) => parts.join("");

describe("pii-scan catches", () => {
  it.each([
    ["db-uri-with-password", j("mongodb+srv://", "admin", ":", "hunter2", "@db.example.net/x")],
    ["aws-access-key", j("AKIA", "IOSFODNN7EXAMPLE")],
    ["openai-key", j("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz012345")],
    ["github-token", j("ghp_", "a".repeat(36))],
    ["google-api-key", j("AIza", "b".repeat(35))],
    ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
    ["credit-card", "4111 1111 1111 1111"],
    ["email", j("real.person", "@", "gmail.com")],
    ["public-ip", "203.0.113.42"],
    ["phone-e164", "+1 415 555 0132"],
  ])("%s", (rule, sample) => {
    const { exitCode, output } = scan(sample);
    expect(exitCode).toBe(1);
    expect(output).toContain(rule);
  });
});

describe("pii-scan ignores", () => {
  it.each([
    ["private IPs", "192.168.1.10 and 10.0.0.5 and 127.0.0.1"],
    ["example-domain emails", "support@example.com"],
    ["semver strings", "version 2.23.19 released"],
    ["allowlisted project identities", "snomiao@gmail.com"],
    ["non-Luhn digit runs", "1234567890123456"],
  ])("%s", (_label, sample) => {
    expect(scan(sample).exitCode).toBe(0);
  });
});
