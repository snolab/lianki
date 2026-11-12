#!/usr/bin/env bun
/** Local preview pipeline. --dry-run prints the plan without building or contacting Cloudflare. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executePreview, previewPlan, previewSettings } from "./preview-plan";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(root, ".wrangler/preview/wrangler.json");

export async function main(argv: string[], env: Record<string, string | undefined>) {
  if (argv.some((arg) => arg !== "--dry-run"))
    throw new Error("Usage: bun scripts/dev/deploy-preview.ts [--dry-run]");
  const settings = previewSettings(env);
  const commands = previewPlan();
  if (argv.includes("--dry-run")) {
    for (const command of commands) console.log(command.join(" "));
    console.log(`POST ${settings.publishUrl} (authenticated; only after successful deploy)`);
    return;
  }
  if (!(await Bun.file(resolve(root, "scripts/dev/broadcast-version.ts")).exists()))
    throw new Error(
      "Missing scripts/dev/broadcast-version.ts; install the broadcast integration before deploying",
    );
  const token = env.PREVIEW_PUBLISH_TOKEN;
  if (!token || token.length < 32)
    throw new Error("Set PREVIEW_PUBLISH_TOKEN (at least 32 characters)");
  // Unique even with uncommitted edits: never reuse HEAD's id for different assets.
  const build = randomBytes(10).toString("hex");
  const config = JSON.parse(await readFile(resolve(root, "wrangler.preview.json"), "utf8"));
  if (
    config.name !== "lianki-preview" ||
    config.routes.length ||
    config.services?.length !== 1 ||
    config.services[0].service !== "lianki-push-preview" ||
    config.d1_databases?.[0]?.database_name !== "lianki-preview" ||
    config.r2_buckets?.[0]?.bucket_name !== "lianki-preview-blobs"
  )
    throw new Error("Preview config must target only isolated preview resources");
  config.main = resolve(root, "worker.preview.ts");
  config.assets.directory = resolve(root, ".open-next/assets");
  config.d1_databases[0].database_id = settings.databaseId;
  config.d1_databases[0].migrations_dir = resolve(root, "db/migrations");
  config.vars.BETTER_AUTH_BASE_URL = settings.origin;
  // No migrations run implicitly: provision/schema setup is an explicit one-time operation.
  await mkdir(resolve(root, ".wrangler/preview"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await executePreview(
    commands,
    async (command) => {
      const child = Bun.spawn(command, {
        cwd: root,
        env: {
          ...env,
          CF_BUILD: "1",
          DB_BACKEND: "d1",
          GITHUB_SHA: build,
          BETTER_AUTH_BASE_URL: settings.origin,
        },
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await child.exited) !== 0)
        throw new Error(`Preview step failed: ${command[0]} ${command[1]}`);
    },
    async () => {
      const fingerprints = JSON.parse(
        await readFile(resolve(root, ".open-next/assets/_lk/route-fp.json"), "utf8"),
      );
      if (fingerprints.build !== build)
        throw new Error("Fingerprint build id does not match deploy");
      const broadcast = Bun.spawn(
        ["bun", "scripts/dev/broadcast-version.ts", "--build", build, "--url", settings.publishUrl],
        {
          cwd: root,
          env: { ...env, PREVIEW_ORIGIN: settings.origin, PREVIEW_PUBLISH_TOKEN: token },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      if ((await broadcast.exited) !== 0)
        throw new Error("Preview deployed, but version broadcast failed");
    },
  );
  console.log(`Preview deployed and announced: ${settings.origin} (${build})`);
}

if (import.meta.main)
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : "Preview deployment failed");
    process.exitCode = 1;
  });
