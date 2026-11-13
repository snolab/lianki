/**
 * What a browser gets at lianki.com/mcp (owner, 2026-11-14 00:0x JST: "我直接打开，
 * 它应该给我一个教程，引导我去配置 token 的地方"): a short page on how to connect,
 * with the link to where tokens are made. MCP clients POST and never see it.
 * Chinese for a zh browser, English otherwise; no script, no external assets.
 */

type Copy = {
  lang: string;
  title: string;
  lead: string;
  steps: [string, string, string];
  tokenLink: string;
  codeTitle: string;
  jsonTitle: string;
  note: string;
};

const EN: Copy = {
  lang: "en",
  title: "Lianki MCP server",
  lead: "This address is for AI apps (Claude, Cursor, Codex…). Connect one to your Lianki cards and chat in three steps.",
  steps: [
    "Make an API token: open Preferences → API tokens, give it a name, tick what the AI may do (cards, chat), set an expiry.",
    "Copy the token (it is shown once).",
    "Add a remote MCP server in your AI app with the address below and the header Authorization: Bearer <your token>.",
  ],
  tokenLink: "Open Preferences → API tokens",
  codeTitle: "Claude Code",
  jsonTitle: "Other apps (mcpServers JSON)",
  note: "The tools the app sees follow the token's permissions. Revoke the token any time on the same page.",
};

const ZH: Copy = {
  lang: "zh",
  title: "Lianki MCP 服务",
  lead: "这个地址是给 AI 应用（Claude、Cursor、Codex 等）连接用的。三步把它接到你的 Lianki 卡片和聊天：",
  steps: [
    "建一个 API token：打开 偏好设置 → API tokens，起个名字，勾上允许 AI 做的事（卡片、聊天），设一个有效期。",
    "复制这个 token（只显示一次）。",
    "在 AI 应用里添加远程 MCP 服务器：地址填下面这个，请求头填 Authorization: Bearer <你的 token>。",
  ],
  tokenLink: "打开 偏好设置 → API tokens",
  codeTitle: "Claude Code",
  jsonTitle: "其他应用（mcpServers JSON）",
  note: "应用能看到哪些工具，由 token 的权限决定。随时可以在同一页撤销 token。",
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A browser asking for a page (not an MCP client): Accept prefers text/html. */
export const wantsGuide = (req: Request) =>
  req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");

export function guide(req: Request, origin: string): Response {
  const c = /^\s*zh/i.test(req.headers.get("accept-language") ?? "") ? ZH : EN;
  const url = `${origin}/mcp`;
  const cli = `claude mcp add --transport http lianki ${url} --header "Authorization: Bearer <TOKEN>"`;
  const json = JSON.stringify(
    { mcpServers: { lianki: { url, headers: { Authorization: "Bearer <TOKEN>" } } } },
    null,
    2,
  );
  const html = `<!doctype html>
<html lang="${c.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)}</title>
<style>
:root{--bg:oklch(0.99 0 0);--fg:oklch(0.25 0 0);--mute:oklch(0.5 0 0);--seal:oklch(0.55 0.2 27);--code:oklch(0.95 0 0)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.18 0 0);--fg:oklch(0.92 0 0);--mute:oklch(0.7 0 0);--seal:oklch(0.68 0.17 27);--code:oklch(0.25 0 0)}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 16px}
h1{font-size:1.5rem;margin:0 0 .5rem;color:var(--seal)}
p,li{color:var(--fg)} .mute{color:var(--mute);font-size:.9rem}
a.btn{display:inline-block;margin:.5rem 0 1rem;padding:.6rem 1rem;border-radius:.6rem;background:var(--seal);color:oklch(0.99 0 0);text-decoration:none;font-weight:600}
pre{background:var(--code);padding:.75rem;border-radius:.5rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-all}
code{font-family:ui-monospace,monospace}
</style></head><body><main>
<h1>${esc(c.title)}</h1>
<p>${esc(c.lead)}</p>
<ol>${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<a class="btn" href="${origin}/my/preferences">${esc(c.tokenLink)}</a>
<p><strong>URL</strong></p><pre><code>${esc(url)}</code></pre>
<p><strong>${esc(c.codeTitle)}</strong></p><pre><code>${esc(cli)}</code></pre>
<p><strong>${esc(c.jsonTitle)}</strong></p><pre><code>${esc(json)}</code></pre>
<p class="mute">${esc(c.note)}</p>
</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      vary: "accept, accept-language",
    },
  });
}
