#!/usr/bin/env bun
/** Manual broadcast only. Deployment continues to announce through announceBuild. */
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitVersionNews } from "../../lib/version-publish";
import { FINGERPRINTS_HEADER, parseFingerprints } from "../../lib/smart-refresh";

export type Send = (url: string, init?: RequestInit) => Promise<Response>;

export const PUBLISH_URL = "https://lianki-push/internal/publish";
const USAGE =
  "bun scripts/dev/broadcast-version.ts --build <id> [--shell-changed] [--routes <json>] [--url <trusted-local-publish-url>]";
export function parseArgs(args: string[]) {
  let build = "",
    shell = false,
    routes: unknown = {},
    url: string | undefined;
  let explicit = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(`duplicate option: ${key}`);
    seen.add(key);
    if (key === "--shell-changed") {
      shell = true;
      explicit = true;
      continue;
    }
    if (!["--build", "--routes", "--url"].includes(key)) throw new Error(`unknown option: ${key}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value: ${key}`);
    if (key === "--build") build = value;
    if (key === "--routes") {
      routes = JSON.parse(value);
      explicit = true;
    }
    if (key === "--url") {
      const target = new URL(value);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        target.pathname !== "/internal/publish"
      )
        throw new Error("url must be a trusted HTTP(S) /internal/publish endpoint");
      url = target.href;
    }
  }
  const news = explicitVersionNews({ build, shell, routes });
  return {
    build,
    url,
    init: {
      method: "POST",
      body: explicit ? JSON.stringify(news) : build,
      headers: { "content-type": explicit ? "application/json" : "text/plain" },
    } satisfies RequestInit,
  };
}

/** Fetch is injectable so tests exercise the real hub without Cloudflare credentials. */
export async function previewHeaders(
  build: string,
  url: string | undefined,
  env: { PREVIEW_PUBLISH_TOKEN?: string; PREVIEW_ORIGIN?: string } = {
    PREVIEW_PUBLISH_TOKEN: process.env.PREVIEW_PUBLISH_TOKEN,
    PREVIEW_ORIGIN: process.env.PREVIEW_ORIGIN,
  },
  read = () => readFile(".open-next/assets/_lk/route-fp.json", "utf8"),
): Promise<Record<string, string>> {
  if (!url || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) return {};
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !/^lianki-push-preview\.[a-z0-9-]+\.workers\.dev$/.test(target.hostname)
  )
    throw new Error("remote URL must name an HTTPS lianki-push-preview Worker");
  const token = env.PREVIEW_PUBLISH_TOKEN;
  const origin = env.PREVIEW_ORIGIN;
  if (!token || !origin || new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new Error("PREVIEW_PUBLISH_TOKEN and HTTPS PREVIEW_ORIGIN are required");
  const fp = parseFingerprints(JSON.parse(await read()));
  if (!fp || fp.build !== build) throw new Error("preview fingerprints do not match build");
  return {
    authorization: `Bearer ${token}`,
    origin,
    [FINGERPRINTS_HEADER]: encodeURIComponent(JSON.stringify(fp)),
  };
}

export async function broadcast(args: string[], send: Send) {
  const options = parseArgs(args);
  const headers = {
    ...options.init.headers,
    ...(await previewHeaders(options.build, options.url)),
  };
  const response = await send(options.url ?? PUBLISH_URL, {
    ...options.init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`publish failed: HTTP ${response.status}`);
  const result = (await response.json()) as { build?: unknown; pushed?: unknown };
  if (
    result.build !== options.build ||
    !Number.isSafeInteger(result.pushed) ||
    (result.pushed as number) < 0
  )
    throw new Error("invalid publish acknowledgement");
  return result;
}

export async function main(args: string[], send: Send = fetch) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const options = parseArgs(args); // reject invalid input before opening any binding
  if (options.url) {
    console.log(JSON.stringify(await broadcast(args, send)));
    return;
  }
  // Ephemeral remote service binding: no public publish route, Worker deploy or secret.
  const dir = await mkdtemp(join(tmpdir(), "lianki-broadcast-"));
  let dispose: (() => Promise<void>) | undefined;
  try {
    const configPath = join(dir, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "lianki-broadcast-cli",
        compatibility_date: "2026-10-01",
        services: [{ binding: "PUSH", service: "lianki-push", remote: true }],
      }),
    );
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy<{ PUSH: { fetch: Send } }>({
      configPath,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    dispose = proxy.dispose;
    console.log(
      JSON.stringify(await broadcast(args, (url, init) => proxy.env.PUSH.fetch(url, init))),
    );
  } finally {
    await dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
}
export function cliError(error: Error) {
  console.error(error.message);
  process.exitCode = 1;
}
if (import.meta.main) main(process.argv.slice(2)).catch(cliError);
