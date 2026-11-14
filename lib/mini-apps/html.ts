/**
 * The file as the iframe gets it: the CSP <meta> (srcdoc mode) and the SDK's
 * <script> go first, before anything of the app's, so no app markup runs
 * ahead of either. Pure.
 */
const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function prepareHtml(html: string, o: { sdkSrc: string; cspMeta?: string }): string {
  const head =
    (o.cspMeta ? `<meta http-equiv="Content-Security-Policy" content="${esc(o.cspMeta)}">` : "") +
    `<script src="${esc(o.sdkSrc)}"></script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + head + html.slice(doctype[0].length);
  return head + html;
}
