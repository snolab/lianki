/**
 * scripts/dev/boxes-ingress.ts: the shared box tunnel's ingress, from the box
 * env files. Only hosts lianki.com's own rule accepts, exact, then 404.
 */
import { describe, expect, test } from "bun:test";
import { boxRoutes, ingressYaml, isBoxEnvFile, readBoxEnv } from "../scripts/dev/boxes-ingress";

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
