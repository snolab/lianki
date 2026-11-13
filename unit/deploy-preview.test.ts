import { describe, expect, test } from "bun:test";
import { executePreview, previewPlan, previewSettings } from "../scripts/dev/preview-plan";
import previewPush from "../workers/push/src/preview";

const settings = {
  PREVIEW_ORIGIN: "https://lianki-preview.example.workers.dev",
  PREVIEW_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
};

describe("preview deployment isolation", () => {
  test("uses only preview origin and explicit deploy configs", () => {
    expect(previewSettings(settings).publishUrl).toBe(
      "https://lianki-push-preview.example.workers.dev/internal/publish",
    );
    for (const command of previewPlan().filter((command) => command.includes("deploy"))) {
      expect(command).toContain("--config");
      expect(command.at(-1)).toContain("preview");
    }
  });
  test("refuses production origins and database", () => {
    for (const origin of [
      "https://lianki.com",
      "https://lianki.example.workers.dev",
      "http://lianki-preview.example.workers.dev",
      `${settings.PREVIEW_ORIGIN}/other`,
    ])
      expect(() => previewSettings({ ...settings, PREVIEW_ORIGIN: origin })).toThrow();
    expect(() =>
      previewSettings({
        ...settings,
        PREVIEW_D1_DATABASE_ID: "a2c6b8cf-8a94-4cdc-99fd-bbbf6b679f4c",
      }),
    ).toThrow();
  });
  test("broadcast runs after all successful steps", async () => {
    const events: string[] = [];
    await executePreview(
      [["build"], ["deploy"]],
      async ([name]) => {
        events.push(name);
      },
      async () => {
        events.push("publish");
      },
    );
    expect(events).toEqual(["build", "deploy", "publish"]);
  });
  test("any failure stops deployment and broadcast", async () => {
    for (const fail of ["build", "deploy"]) {
      const events: string[] = [];
      await expect(
        executePreview(
          [["build"], ["deploy"]],
          async ([name]) => {
            events.push(name);
            if (name === fail) throw new Error("failed");
          },
          async () => {
            events.push("publish");
          },
        ),
      ).rejects.toThrow("failed");
      expect(events).not.toContain("publish");
    }
  });
});

test("preview push authenticates external publish before reaching the hub", async () => {
  const calls: Request[] = [];
  const env = {
    PREVIEW_PUBLISH_TOKEN: "a".repeat(32),
    HUB: {
      idFromName: () => "version",
      get: () => ({
        fetch: async (req: Request) => {
          calls.push(req);
          return Response.json({ build: await req.text() });
        },
      }),
    },
  };
  const post = (authorization?: string) =>
    new Request("https://lianki-push-preview.example.workers.dev/internal/publish", {
      method: "POST",
      body: "build",
      headers: authorization ? { authorization } : {},
    });
  const fetch = (request: Request, token: string | undefined = env.PREVIEW_PUBLISH_TOKEN) =>
    previewPush.fetch(request, { ...env, PREVIEW_PUBLISH_TOKEN: token } as unknown as Parameters<
      typeof previewPush.fetch
    >[1]);
  expect((await fetch(post())).status).toBe(403);
  expect((await fetch(post(`Bearer ${"b".repeat(32)}`))).status).toBe(403);
  expect(calls).toHaveLength(0);
  expect((await fetch(post(`Bearer ${env.PREVIEW_PUBLISH_TOKEN}`))).status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(
    (
      await previewPush.fetch(post(), {
        ...env,
        PREVIEW_PUBLISH_TOKEN: undefined,
      } as unknown as Parameters<typeof previewPush.fetch>[1])
    ).status,
  ).toBe(503);
  expect(
    (
      await fetch(
        new Request("https://lianki-push/internal/publish", { method: "POST", body: "internal" }),
      )
    ).status,
  ).toBe(200);
  expect((await fetch(new Request("https://preview.example/api/version/ws"))).status).toBe(426);
  expect(
    (
      await fetch(
        new Request("https://preview.example/api/version/ws", {
          headers: { upgrade: "websocket" },
        }),
      )
    ).status,
  ).toBe(200);
  expect((await fetch(new Request("https://preview.example/internal/publish"))).status).toBe(404);
  expect((await fetch(new Request("https://preview.example/api/version/debug"))).status).toBe(404);
});

test("the actual CLI dry-run needs no credentials and performs no deploy", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      new URL("../scripts/dev/deploy-preview.ts", import.meta.url).pathname,
      "--dry-run",
    ],
    { env: settings },
  );
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("opennextjs-cloudflare build");
  expect(output).toContain("route-fingerprints.ts");
  expect(output).toContain("lianki-push-preview.example.workers.dev/internal/publish");
  expect(result.stderr.toString()).toBe("");
});
