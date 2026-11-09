"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import type { Library, LibraryOffer } from "@/lib/books/libraries";
import { FIND_SECTION_ID, LIBRARIES_SECTION_ID } from "@/lib/books/toc";

/** What /api/books/resolve answers. */
type Check =
  | { state: "checking" }
  | { state: "error"; text: string }
  | {
      state: "done";
      ok: true;
      curated: boolean;
      ownedId?: string;
      book: { key: string; title: string; author: string; page: string; site: string };
    }
  | { state: "done"; ok: false; reason: string; title?: string; author?: string; page?: string };

interface Hit {
  url: string;
  title: string;
  author: string;
  site: string;
}

/**
 * Below the /books list: find more books. A search the server runs against
 * the libraries themselves, a box for a book's link from one of them, and
 * the guide to the libraries (lib/books/libraries.ts), grouped by language.
 * Search and paste go through the one resolve path; a book is importable only
 * when its source states every fact the public-domain check needs. All
 * actions here are secondary (the page has no primary action).
 */
export function BookFinder({
  libraries,
}: {
  /** [language code, its display name, its libraries], in page order. */
  libraries: [string, string, Library[]][];
}) {
  const t = useIntlayer("books-page");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [link, setLink] = useState("");
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");

  const reasonText = (reason: string): string => {
    switch (reason) {
      case "translation":
        return t.reasonTranslation.value;
      case "not-public-domain-us":
        return t.reasonNotUs.value;
      case "not-public-domain-origin":
        return t.reasonNotOrigin.value;
      case "not-public-domain-here":
        return t.errNotHere.value;
      case "not-found":
        return t.reasonNotFound.value;
      case "bad-link":
        return t.reasonBadLink.value;
      default:
        return t.reasonFacts.value;
    }
  };

  const check = async (url: string) => {
    setChecks((c) => ({ ...c, [url]: { state: "checking" } }));
    try {
      const res = await fetch("/api/books/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const next: Check =
        res.ok && data
          ? ({ state: "done", ...data } as Check)
          : {
              state: "error",
              text: data?.error === "rate-limited" ? t.errRateLimited.value : t.errFailed.value,
            };
      setChecks((c) => ({ ...c, [url]: next }));
    } catch {
      setChecks((c) => ({ ...c, [url]: { state: "error", text: t.errFailed.value } }));
    }
  };

  const search = async () => {
    if (!q.trim()) return;
    setSearching(true);
    setError("");
    try {
      const res = await fetch(`/api/books/search?q=${encodeURIComponent(q.trim())}`);
      const data = (await res.json().catch(() => null)) as { hits?: Hit[]; error?: string } | null;
      if (!res.ok || !data?.hits) {
        setError(data?.error === "rate-limited" ? t.errRateLimited.value : t.errFailed.value);
        setHits(null);
        return;
      }
      setHits(data.hits);
      // Check a few at a time, so the libraries are not asked all at once.
      const queue = [...data.hits];
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          for (let h = queue.shift(); h; h = queue.shift()) await check(h.url);
        }),
      );
    } finally {
      setSearching(false);
    }
  };

  const add = async (url: string) => {
    setAdding(url);
    setError("");
    try {
      const res = await fetch("/api/books/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res.ok || !data?.id) {
        setError(
          data?.error === "rate-limited"
            ? t.errRateLimited.value
            : data?.error === "not-public-domain-here"
              ? t.errNotHere.value
              : t.errFailed.value,
        );
        return;
      }
      router.push(`/reader/${encodeURIComponent(data.id)}`);
    } catch {
      setError(t.errFailed.value);
    } finally {
      setAdding("");
    }
  };

  const offerText = (o: LibraryOffer): string =>
    ({
      literature: t.offerLiterature.value,
      classics: t.offerClassics.value,
      documents: t.offerDocuments.value,
      polished: t.offerPolished.value,
      scans: t.offerScans.value,
      scholarly: t.offerScholarly.value,
    })[o];

  const secondary =
    "shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 border border-blue-600/40 text-blue-700 dark:text-blue-300 hover:bg-blue-600/10";
  const field =
    "flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white/60 dark:bg-gray-900/60 px-4 py-2 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none";

  const status = (url: string) => {
    const c = checks[url];
    if (!c) return null;
    if (c.state === "checking")
      return <span className="text-xs text-gray-500 dark:text-gray-400">{t.checking}</span>;
    if (c.state === "error")
      return <span className="text-xs text-red-700 dark:text-red-400">{c.text}</span>;
    if (!c.ok)
      return (
        <span className="text-xs text-gray-600 dark:text-gray-400" data-testid="books-find-refused">
          <b className="font-medium">
            {c.reason.startsWith("not-public-domain") ? t.notPd : t.cannotConfirm}
          </b>
          {" · "}
          {reasonText(c.reason)}
        </span>
      );
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {c.curated ? t.inLibrary : t.canAdd}
        </span>
        {c.ownedId ? (
          <a href={`/reader/${encodeURIComponent(c.ownedId)}`} className={secondary}>
            {t.owned}
          </a>
        ) : (
          <button
            type="button"
            className={secondary}
            disabled={!!adding}
            onClick={() => void add(url)}
            data-testid="books-find-add"
          >
            {adding === url ? t.adding : t.add}
          </button>
        )}
      </span>
    );
  };

  // Books that can be added first, then those still being checked, the refused last.
  const rank = (url: string) => {
    const c = checks[url];
    if (!c || c.state === "checking") return 1;
    if (c.state === "error") return 2;
    return c.ok ? 0 : 3;
  };
  const sortedHits = (hits ?? [])
    .map((h, i) => [h, i] as const)
    .sort((a, b) => rank(a[0].url) - rank(b[0].url) || a[1] - b[1])
    .map(([h]) => h);

  const pasted = link.trim();
  const pastedCheck = pasted ? checks[pasted] : undefined;

  return (
    <section
      id={FIND_SECTION_ID}
      className="mt-12 border-t border-gray-200 dark:border-gray-700 pt-8 scroll-mt-16"
      data-testid="books-find"
    >
      <h2 className="text-xl font-semibold mb-2">{t.findTitle}</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{t.findIntro}</p>

      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.searchPlaceholder.value}
          aria-label={t.searchPlaceholder.value}
          className={field}
          data-testid="books-search"
        />
        <button type="submit" className={secondary} disabled={searching || !q.trim()}>
          {searching ? t.searching : t.searchButton}
        </button>
      </form>
      {hits && hits.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.noHits}</p>
      )}
      {hits && hits.length > 0 && (
        <ul className="mb-6" data-testid="books-hits">
          {sortedHits.map((h) => (
            <li
              key={h.url}
              className="py-3 border-b border-gray-200 dark:border-gray-700 last:border-b-0"
            >
              <a
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                {h.title}
              </a>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {h.author ? `${h.author} · ` : ""}
                {h.site}
              </p>
              <div className="mt-1">{status(h.url)}</div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex gap-2 mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (pasted) void check(pasted);
        }}
      >
        <input
          type="url"
          inputMode="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={t.pastePlaceholder.value}
          aria-label={t.pastePlaceholder.value}
          className={field}
          data-testid="books-paste"
        />
        <button
          type="submit"
          className={secondary}
          disabled={!pasted || pastedCheck?.state === "checking"}
        >
          {t.check}
        </button>
      </form>
      {pasted && pastedCheck && (
        <div className="mt-3" data-testid="books-paste-result">
          {pastedCheck.state === "done" &&
            (pastedCheck.ok ? pastedCheck.book.title : pastedCheck.title) && (
              <p className="font-medium">
                {pastedCheck.ok ? pastedCheck.book.title : pastedCheck.title}
                <span className="font-normal text-gray-600 dark:text-gray-400">
                  {" · "}
                  {pastedCheck.ok ? pastedCheck.book.author : pastedCheck.author}
                </span>
              </p>
            )}
          {status(pasted)}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div id={LIBRARIES_SECTION_ID} className="mt-10 scroll-mt-16" data-testid="books-libraries">
        <h3 className="text-lg font-semibold mb-1">{t.librariesTitle}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{t.librariesIntro}</p>
        {libraries.map(([lang, name, list]) => (
          <div key={lang} className="mb-5" data-testid="books-libraries-lang" data-lang={lang}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {lang === "mul" ? t.manyLanguages : name}
            </h4>
            <ul>
              {list.map((l) => (
                <li
                  key={l.id}
                  className="py-2 border-b border-gray-200 dark:border-gray-700 last:border-b-0"
                  data-testid="books-library"
                  data-support={l.support}
                >
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium underline text-blue-700 dark:text-blue-300"
                    >
                      {l.name}
                    </a>
                    <span
                      className={`text-xs rounded-full px-2 py-0.5 ${
                        l.support === "paste"
                          ? "bg-blue-600/10 text-blue-700 dark:text-blue-300"
                          : "bg-gray-500/10 text-gray-600 dark:text-gray-400"
                      }`}
                    >
                      {l.support === "paste" ? t.supportPaste : t.supportGuide}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {l.offers.map((o) => offerText(o)).join(" · ")}
                    </span>
                  </p>
                  {l.why && (
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                      {l.why === "terms"
                        ? t.whyTerms
                        : l.why === "no-facts"
                          ? t.whyNoFacts
                          : t.whyNoReader}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t.licence}: {l.licence}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
