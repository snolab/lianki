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
  chatgpt: string;
  chatgptSteps: string;
  codeTitle: string;
  jsonTitle: string;
  note: string;
};

const EN: Copy = {
  lang: "en",
  title: "Lianki MCP server",
  lead: "This address is for AI apps (Claude, Cursor, Codex…). Connect one to your Lianki cards, chat and task list in three steps.",
  steps: [
    "Make an API token: open Preferences → API tokens, give it a name, tick what the AI may do (cards, chat, progress reports), set an expiry.",
    "Copy the token (it is shown once).",
    "Add a remote MCP server in your AI app with the address below and the header Authorization: Bearer <your token>.",
  ],
  tokenLink: "Open Preferences → API tokens",
  chatgpt: "ChatGPT",
  chatgptSteps:
    "Create a dedicated token with only the permissions you need and an expiry. In its one-time box, choose Copy MCP connection URL. In ChatGPT, add a custom MCP server, paste the URL and select No authentication, then install the resulting plugin. Treat the entire URL as a password; never post it in a chat. If you lost the secret, revoke it and create a new token.",
  codeTitle: "Claude Code",
  jsonTitle: "Other apps (mcpServers JSON)",
  note: "The tools the app sees follow the token's permissions. Revoke the token any time on the same page.",
};

const ZH: Copy = {
  lang: "zh",
  title: "Lianki MCP 服务",
  lead: "这个地址是给 AI 应用（Claude、Cursor、Codex 等）连接用的。三步把它接到你的 Lianki 卡片和聊天：",
  steps: [
    "建一个 API token：打开 偏好设置 → API tokens，起个名字，勾上允许 AI 做的事（卡片、聊天、汇报进度），设一个有效期。",
    "复制这个 token（只显示一次）。",
    "在 AI 应用里添加远程 MCP 服务器：地址填下面这个，请求头填 Authorization: Bearer <你的 token>。",
  ],
  tokenLink: "打开 偏好设置 → API tokens",
  chatgpt: "ChatGPT",
  chatgptSteps:
    "创建专用 token，只勾选所需权限并设置有效期。在仅显示一次的凭证框中选择「复制 MCP 连接地址」。在 ChatGPT 添加自定义 MCP 服务器，粘贴地址，认证选择 No authentication（无认证），然后安装生成的插件。整个地址等同密码，不要发到聊天里。若丢失凭证，请撤销并重新创建 token。",
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
<a class="btn" href="${origin}/my/preferences#tokens">${esc(c.tokenLink)}</a>
<h2>${esc(c.chatgpt)}</h2><p>${esc(c.chatgptSteps)}</p>
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
