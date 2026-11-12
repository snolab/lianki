import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(root, ".wrangler/preview/wrangler.json");
const pushConfig = resolve(root, "workers/push/wrangler.preview.json");

export function previewSettings(env: Record<string, string | undefined>) {
  const origin = env.PREVIEW_ORIGIN ?? "";
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    !/^lianki-preview\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("PREVIEW_ORIGIN must be https://lianki-preview.<subdomain>.workers.dev");
  const databaseId = env.PREVIEW_D1_DATABASE_ID ?? "";
  if (
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId) ||
    databaseId.toLowerCase() === "a2c6b8cf-8a94-4cdc-99fd-bbbf6b679f4c"
  )
    throw new Error("PREVIEW_D1_DATABASE_ID must identify a separate preview database");
  return {
    origin: url.origin,
    publishUrl: `${url.origin.replace("//lianki-preview.", "//lianki-push-preview.")}/internal/publish`,
    databaseId,
  };
}

export function previewPlan() {
  return [
    ["bun", "scripts/build-partner-embed.ts"],
    ["bunx", "opennextjs-cloudflare", "build"],
    ["bun", "scripts/build/route-fingerprints.ts", "--out", ".open-next/assets/_lk/route-fp.json"],
    ["bun", "scripts/security/check-public-dir.ts", ".open-next/assets"],
    ["bunx", "wrangler", "deploy", "--config", pushConfig],
    ["bunx", "wrangler", "deploy", "--config", configPath],
  ];
}

/** Fail immediately: a failed deploy must never advertise a build. */
export async function executePreview(
  commands: string[][],
  run: (command: string[]) => Promise<void>,
  publish: () => Promise<void>,
) {
  for (const command of commands) await run(command);
  await publish();
}
