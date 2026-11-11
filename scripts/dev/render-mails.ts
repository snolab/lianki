#!/usr/bin/env bun
/**
 * Render every transactional mail to HTML files, for looking at them — never
 * sends anything (docs/mail-templates.md, "Layout and colours").
 *
 *   bun scripts/dev/render-mails.ts [outDir] [--locales en,zh,ja]
 *
 * Writes `<outDir>/<template>.<locale>.<light|dark>.html` (the built-in, in
 * the shared layout, with the editor's sample values; the login notice with
 * values made the way a real send makes them, for its owner sample: Tokyo,
 * iPhone, the sign-in's own time zone) and `<outDir>/index.html`, which shows
 * them side by side at iPhone width (390 px), light and dark. Serve the
 * folder on the tailnet to look at it on a phone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBuiltin } from "@/lib/mail-templates/compose";
import { MAIL_TEMPLATE_IDS, MAIL_TEMPLATES, type MailTemplateId } from "@/lib/mail-templates/defs";
import { MAIL_KINDS } from "@/lib/mail-templates/kinds";
import { previewDoc } from "@/lib/mail-templates/layout";
import { MAIL_LOCALES, type MailLocale } from "@/lib/mail-templates/locales";
import { approximateLocation, loginNoticeValues } from "@/lib/security/login-notice";

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? "mail-preview";
const li = args.indexOf("--locales");
const locales: MailLocale[] =
  li >= 0
    ? (args[li + 1]
        .split(",")
        .filter((l) => (MAIL_LOCALES as readonly string[]).includes(l)) as MailLocale[])
    : [...MAIL_LOCALES];

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
/** The owner's sample: 2026-11-09 18:07 in Tokyo. */
const WHEN = new Date("2026-11-09T09:07:00Z");

function values(id: MailTemplateId, l: MailLocale): Record<string, string> {
  if (id !== "login-notice") return MAIL_TEMPLATES[id].samples.typical;
  return loginNoticeValues(l, {
    when: WHEN,
    location: approximateLocation({ city: "Tokyo", region: "Tokyo", country: "JP" }, null, l),
    userAgent: IPHONE_UA,
    eventTimeZone: "Asia/Tokyo",
  });
}

mkdirSync(outDir, { recursive: true });
const cards: string[] = [];
for (const id of MAIL_TEMPLATE_IDS) {
  for (const l of locales) {
    const m = renderBuiltin(id, l, values(id, l));
    for (const theme of ["light", "dark"] as const) {
      const file = `${id}.${l}.${theme}.html`;
      writeFileSync(join(outDir, file), previewDoc(m.html, theme === "dark"));
    }
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    cards.push(
      `<section data-t="${id}" data-l="${l}"><h2>${id} · ${l} <small>${MAIL_KINDS[id].class}</small></h2><p class="subj">${esc(m.subject)}</p><div class="pair">` +
        ["light", "dark"]
          .map(
            (t) =>
              `<figure><figcaption>${t}</figcaption><iframe loading="lazy" src="${id}.${l}.${t}.html" title="${id} ${l} ${t}"></iframe></figure>`,
          )
          .join("") +
        `</div><details><summary>plain text</summary><pre>${esc(m.text)}</pre></details></section>`,
    );
  }
}

const options = (xs: readonly string[]) => xs.map((x) => `<option>${x}</option>`).join("");
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lianki mail preview</title>
<style>
:root{color-scheme:light dark;--bg:oklch(0.97 0.01 85);--fg:oklch(0.21 0.01 60);--line:oklch(0.85 0.03 80)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.17 0.01 60);--fg:oklch(0.93 0.015 85);--line:oklch(0.35 0.02 70)}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line);z-index:1}
select{font:inherit;min-height:40px}
section{margin:24px 0;padding-bottom:16px;border-bottom:1px solid var(--line)}
h2{font-size:17px;margin:0} small{opacity:.7;font-weight:400} .subj{margin:4px 0 8px;opacity:.85}
.pair{display:flex;gap:16px;flex-wrap:wrap} figure{margin:0} figcaption{font-size:13px;opacity:.7}
iframe{width:390px;max-width:calc(100vw - 32px);height:720px;border:1px solid var(--line);border-radius:12px;background:white}
pre{white-space:pre-wrap;font-size:13px}
</style></head><body>
<header><b>Mail preview</b> · 390 px (iPhone), light + dark · rendered ${new Date().toISOString().slice(0, 16)} UTC · nothing is sent
<select id="t"><option value="">all mails</option>${options(MAIL_TEMPLATE_IDS)}</select>
<select id="l"><option value="">all languages</option>${options(locales)}</select></header>
${cards.join("\n")}
<script>
const t=document.getElementById("t"),l=document.getElementById("l");
const q=new URLSearchParams(location.search);t.value=q.get("t")??"login-notice";l.value=q.get("l")??"zh";
function f(){for(const s of document.querySelectorAll("section"))s.hidden=(t.value&&s.dataset.t!==t.value)||(l.value&&s.dataset.l!==l.value);
history.replaceState(null,"","?t="+t.value+"&l="+l.value)}
t.onchange=l.onchange=f;f();
</script></body></html>`,
);
console.log(`${cards.length} mails × 2 themes → ${outDir}/index.html`);
