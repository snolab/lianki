#!/usr/bin/env node
// lianki — command-line client for Lianki (https://lianki.com), made for agents.
// Plain ESM for Node >= 18 and Bun: no build step, no TypeScript at run time.
// Everything is in cli.mjs (commands) and auth.mjs (token storage, browser login).

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { fileConfig, listen, openUrl, tokenStore } from "./auth.mjs";
import { run } from "./cli.mjs";

const env = process.env;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

process.exitCode = await run(process.argv.slice(2), {
  env,
  version: createRequire(import.meta.url)("./package.json").version,
  fetch: globalThis.fetch,
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  store: tokenStore(env),
  config: fileConfig(env),
  listen,
  openUrl,
  hostname: hostname().replace(/\.local$/, ""),
  readStdin,
  readFile: (path) => readFile(path, "utf8"),
  ask,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  columns: process.stdout.columns,
  timeoutMs: 5 * 60_000,
  now: () => Date.now(),
});
