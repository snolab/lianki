#!/usr/bin/env bun
/**
 * Upload (and optionally publish) the extension through the Chrome Web Store API.
 *
 *   bun scripts/publish-extension.ts --auth        # one-time: mint a refresh token
 *   bun scripts/publish-extension.ts               # build + upload as a draft
 *   bun scripts/publish-extension.ts --publish     # ...and submit it for review
 *
 * Why an API and not the developer console: Chrome refuses CDP navigation to
 * the Web Store console, so the browser cannot be driven there — verified, it
 * answers `Protocol error (Page.navigate): Not allowed`. That makes clicking
 * through the console a human-only path, and a release step that only a human
 * can do is a release step that drifts.
 *
 * Secrets come from the environment (see packages/ext/README.md for how to
 * obtain them once):
 *
 *   CWS_CLIENT_ID      OAuth 2.0 client (type: Desktop app)
 *   CWS_CLIENT_SECRET
 *   CWS_REFRESH_TOKEN  from --auth
 *   CWS_ITEM_ID        the store item; omitted on the very first upload, which
 *                      creates it and prints the id to save
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const ZIP = join(ROOT, "packages/ext/dist/lianki-extension.zip");
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
// Loopback, because Google retired the out-of-band flow. The redirect will fail
// to load — nothing is listening on the browser's machine — but the address bar
// then holds the code, which is all we need.
const REDIRECT = "http://localhost:8976/";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see packages/ext/README.md`);
  return v;
}

async function json(res: Response, what: string) {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what}: ${res.status} — ${text.slice(0, 400)}`);
  }
  if (!res.ok) throw new Error(`${what}: ${res.status} — ${JSON.stringify(body).slice(0, 600)}`);
  return body as Record<string, unknown>;
}

/** One-time: walk the consent flow and print a refresh token. */
async function auth() {
  const clientId = env("CWS_CLIENT_ID");
  const clientSecret = env("CWS_CLIENT_SECRET");
  const code = argv.find((a) => a.startsWith("--code="))?.slice("--code=".length);

  if (!code) {
    const url =
      `https://accounts.google.com/o/oauth2/auth?response_type=code` +
      `&scope=${encodeURIComponent(SCOPE)}` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&access_type=offline&prompt=consent`;
    console.log("1. Open this and approve:\n");
    console.log(`   ${url}\n`);
    console.log("2. The browser will land on a localhost page that fails to load.");
    console.log("   That is expected. Copy the `code` from its address bar and run:\n");
    console.log("   bun scripts/publish-extension.ts --auth --code=<the code>\n");
    return;
  }

  const body = await json(
    await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: decodeURIComponent(code),
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }),
    }),
    "token exchange",
  );
  if (!body.refresh_token) {
    throw new Error(
      "no refresh_token in the response — the code was already used, or consent " +
        "was granted before without access_type=offline. Re-run --auth for a fresh code.",
    );
  }
  console.log(`CWS_REFRESH_TOKEN=${body.refresh_token}`);
  console.log("\nSave that in .env.local. It does not expire unless revoked.");
}

async function accessToken(): Promise<string> {
  const body = await json(
    await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("CWS_CLIENT_ID"),
        client_secret: env("CWS_CLIENT_SECRET"),
        refresh_token: env("CWS_REFRESH_TOKEN"),
        grant_type: "refresh_token",
      }),
    }),
    "refresh",
  );
  return String(body.access_token);
}

async function main() {
  if (has("auth")) return auth();

  if (!existsSync(ZIP)) {
    throw new Error(`${ZIP} is missing — run: bun scripts/build-extension.ts`);
  }
  const zip = readFileSync(ZIP);
  const manifestVersion = JSON.parse(
    readFileSync(join(ROOT, "packages/ext/dist/manifest.json"), "utf8"),
  ).version as string;

  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" };
  let itemId = process.env.CWS_ITEM_ID;

  if (!itemId) {
    // First upload: create the item. The store assigns the id, and it is the
    // one thing that must be kept — every later upload targets it.
    const created = await json(
      await fetch("https://www.googleapis.com/upload/chromewebstore/v1.1/items", {
        method: "POST",
        headers,
        body: new Uint8Array(zip),
      }),
      "create item",
    );
    itemId = String(created.id);
    console.log(`Created item ${itemId}`);
    console.log(`Save it:  CWS_ITEM_ID=${itemId}\n`);
  } else {
    const up = await json(
      await fetch(
        `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${itemId}?uploadType=media`,
        { method: "PUT", headers, body: new Uint8Array(zip) },
      ),
      "upload",
    );
    // The API answers 200 for a rejected package; the verdict is in the body.
    if (up.uploadState !== "SUCCESS") {
      throw new Error(`upload ${up.uploadState}: ${JSON.stringify(up.itemError ?? up)}`);
    }
    console.log(`Uploaded v${manifestVersion} to ${itemId}`);
  }

  if (!has("publish")) {
    console.log("\nDraft only. Add --publish to submit it for review.");
    return;
  }

  const target = has("testers") ? "trustedTesters" : "default";
  const res = await json(
    await fetch(
      `https://www.googleapis.com/chromewebstore/v1.1/items/${itemId}/publish?publishTarget=${target}`,
      { method: "POST", headers: { ...headers, "content-length": "0" } },
    ),
    "publish",
  );
  console.log(`Publish (${target}): ${JSON.stringify(res.status ?? res)}`);
  if (Array.isArray(res.statusDetail) && res.statusDetail.length) {
    for (const d of res.statusDetail) console.log(`  ${d}`);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
