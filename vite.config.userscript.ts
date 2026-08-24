import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import monkey from "vite-plugin-monkey";

const headerKeyMap: Record<string, string> = {
  name: "name",
  namespace: "namespace",
  match: "match",
  grant: "grant",
  version: "version",
  author: "author",
  description: "description",
  "run-at": "runAt",
  downloadURL: "downloadURL",
  updateURL: "updateURL",
  connect: "connect",
};

function parseUserscriptHeader(source: string) {
  const userscript: Record<string, string | string[]> = {};
  const inHeader = source.includes("// ==UserScript==");
  if (!inHeader) return userscript;
  for (const line of source.split("\n")) {
    if (line.trim() === "// ==/UserScript==") break;
    const match = line.match(/^\/\/\s*@(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = headerKeyMap[match[1]];
    if (!key) continue;
    const value = match[2].trim();
    const current = userscript[key];
    if (current === undefined) {
      userscript[key] = value;
    } else {
      userscript[key] = Array.isArray(current) ? [...current, value] : [current, value];
    }
  }
  return userscript;
}

function stripUserscriptHeader(): Plugin {
  return {
    name: "strip-userscript-header",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("src/lianki.user.ts")) return;
      return code.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, "");
    },
  };
}

const source = readFileSync("src/lianki.user.ts", "utf-8");

export default defineConfig({
  plugins: [
    stripUserscriptHeader(),
    monkey({
      entry: "src/lianki.user.ts",
      userscript: parseUserscriptHeader(source),
      build: {
        externalGlobals: {},
      },
    }),
  ],
  server: {
    port: 3002,
    strictPort: true,
    allowedHosts: [".trycloudflare.com"],
  },
});
