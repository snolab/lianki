/**
 * The whole app: your word lists and what is due today, from lianki.com's
 * own /api. Same origin, so the browser sends your session cookie; there is
 * no token to handle. docs/custom-frontend.md, "The contract".
 */
type List = { id: string; name: string; lang?: string };

const app = document.getElementById("app")!;

function el(tag: string, text: string) {
  const e = document.createElement(tag);
  e.textContent = text; // never innerHTML with API data
  return e;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (r.status === 401 || r.status === 404) throw new Error("Sign in at lianki.com first");
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function main() {
  const { lists } = await api<{ lists: List[] }>("/api/words/lists");
  app.replaceChildren(el("h1", `My lists (${lists.length})`));
  const ul = document.createElement("ul");
  for (const l of lists) ul.append(el("li", `${l.name}${l.lang ? ` · ${l.lang}` : ""}`));
  app.append(ul);
}

main().catch((e: unknown) => app.replaceChildren(el("p", String(e))));
