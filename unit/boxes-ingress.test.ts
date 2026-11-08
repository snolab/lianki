/**
 * scripts/dev/boxes-ingress.ts: the shared box tunnel's ingress, from the box
 * env files. Only hosts lianki.com's own rule accepts, exact, then 404.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boxRoutes,
  ingressYaml,
  isBoxEnvFile,
  main,
  readBoxEnv,
} from "../scripts/dev/boxes-ingress";

const env = (url: string, port = "3200", name = "a") =>
  `DEVBOX_NAME=${name}\nDEVBOX_DEV_PORT=${port}\nDEEPSEEK_API_KEY=sk-secret\nDEVBOX_PUBLIC_URL=${url}\n`;

describe("box env files to tunnel rules", () => {
  test("reads only the three keys", () => {
    expect(readBoxEnv(env("https://my-example.lianki.com"))).toEqual({
      DEVBOX_NAME: "a",
      DEVBOX_DEV_PORT: "3200",
      DEVBOX_PUBLIC_URL: "https://my-example.lianki.com",
    });
  });

  test("which files are boxes", () => {
    expect(
      [".env", ".env.snomiao", ".env.example", ".envrc", "env", ".env.A"].filter(isBoxEnvFile),
    ).toEqual([".env", ".env.snomiao"]);
  });

  test("one exact rule per box, then 404; no secret in the config", () => {
    const { routes, errors } = boxRoutes([
      { file: ".env", text: env("https://my-0123456789abcdef.lianki.com", "3200") },
      { file: ".env.b", text: env("https://my-example.lianki.com/", "3201", "b") },
      { file: ".env.local-only", text: env("", "3202") },
    ]);
    expect(errors).toEqual([]);
    const yaml = ingressYaml("00000000-0000-0000-0000-000000000000", "/c.json", routes);
    expect(yaml).toBe(
      [
        "tunnel: 00000000-0000-0000-0000-000000000000",
        "credentials-file: /c.json",
        "ingress:",
        "  - hostname: my-0123456789abcdef.lianki.com",
        "    service: http://127.0.0.1:3200",
        "  - hostname: my-example.lianki.com",
        "    service: http://127.0.0.1:3201",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );
    expect(yaml).not.toContain("sk-secret");
    expect(yaml).not.toContain("*");
  });

  test("the command reads a devbox dir, skips the example, refuses bad input", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxes-ingress-"));
    try {
      writeFileSync(join(dir, ".env"), env("https://my-example.lianki.com", "3200", "k"));
      writeFileSync(join(dir, ".env.example"), env("https://my-other.lianki.com", "3201"));
      writeFileSync(join(dir, "compose.yaml"), "x");
      const id = "00000000-0000-0000-0000-000000000000";
      const out: string[] = [];
      const err: string[] = [];
      expect(
        main(
          [dir, id, "/c.json"],
          (s) => out.push(s),
          (s) => err.push(s),
        ),
      ).toBe(0);
      expect(out.join("")).toContain("  - hostname: my-example.lianki.com\n");
      expect(out.join("")).not.toContain("my-other");
      expect(err).toEqual(["  .env: k -> 127.0.0.1:3200"]);

      expect(
        main(
          [dir, "not-an-id", "/c.json"],
          () => {},
          () => {},
        ),
      ).toBe(2);
      expect(
        main(
          [undefined, id, "/c.json"],
          () => {},
          () => {},
        ),
      ).toBe(2);
      writeFileSync(join(dir, ".env.bad"), env("https://dev.lianki.com", "3205"));
      const bad: string[] = [];
      expect(
        main(
          [dir, id, "/c.json"],
          () => {},
          (s) => bad.push(s),
        ),
      ).toBe(1);
      expect(bad).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a host lianki.com refuses, a bad port, or a clash is an error, not a rule", () => {
    const { routes, errors } = boxRoutes([
      { file: ".env", text: env("https://my-example.lianki.com", "3200") },
      { file: ".env.www", text: env("https://my-www.lianki.com", "3201") },
      { file: ".env.dev", text: env("https://dev.lianki.com", "3202") },
      { file: ".env.port", text: env("https://my-other.lianki.com", "80") },
      { file: ".env.dup", text: env("https://my-example.lianki.com", "3203") },
      { file: ".env.dupport", text: env("https://my-third.lianki.com", "3200") },
    ]);
    expect(routes.map((r) => r.file)).toEqual([".env"]);
    expect(errors).toHaveLength(5);
  });
});
