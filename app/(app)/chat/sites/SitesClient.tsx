"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { type PartnerClient, createPartnerClient } from "@lianki/debug-chat/embed/partner-client";
import type { SiteThread } from "@/lib/li-thread";

export type SitesLabels = {
  metaTitle: string;
  title: string;
  intro: string;
  empty: string;
  loading: string;
  failed: string;
  retry: string;
  back: string;
  noLines: string;
  you: string;
  signIn: string;
  openSite: string;
  message: string;
  send: string;
  connecting: string;
  /** The assistant's name (learning-partner `name`). */
  agent: string;
};

const muted = "text-[oklch(0.5_0.01_260)] dark:text-[oklch(0.7_0.01_260)]";
const bad = "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]";
const red =
  "bg-[oklch(0.55_0.198_22.3)] text-[oklch(0.99_0_0)] dark:bg-[oklch(0.6_0.176_22.3)] disabled:opacity-50";
const line = "border-[oklch(0.9_0.005_260)] dark:border-[oklch(0.35_0.02_260)]";

/** The site as people read it: the host, with the scheme only when it is not https. */
export function siteName(origin: string): string {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" ? u.host : origin;
  } catch {
    return origin;
  }
}

function when(at: number, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(at),
    );
  } catch {
    return new Date(at).toISOString();
  }
}

/**
 * The list of his site chats, and one of them opened: a socket of his own
 * session (no ticket) to that site's thread (`?sub=`, debug.ts subThreadFor:
 * only a thread the hub holds under his own account), chat only.
 */
export default function SitesClient({
  labels,
  locale,
  installGuide,
  historyEnabled = true,
}: {
  labels: SitesLabels;
  locale: string;
  installGuide: ReactNode;
  historyEnabled?: boolean;
}) {
  const [threads, setThreads] = useState<SiteThread[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<SiteThread | null>(null);
  const load = async () => {
    if (!historyEnabled) {
      setThreads([]);
      return;
    }
    setFailed(false);
    try {
      const r = await fetch("/api/chat/sites", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setThreads(((await r.json()) as { threads: SiteThread[] }).threads);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (open)
    return (
      <div className="mx-auto flex max-w-2xl flex-col px-4 py-6">
        <button
          type="button"
          onClick={() => {
            setOpen(null);
            void load();
          }}
          className={`tap-40 mb-3 self-start rounded-full border px-3 py-1.5 text-sm ${line}`}
        >
          ← {labels.back}
        </button>
        <h1 className="mb-4 text-xl font-bold break-all">{siteName(open.origin)}</h1>
        <SiteChat key={open.id} id={open.id} labels={labels} locale={locale} />
      </div>
    );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-bold">{labels.title}</h1>
      <p className={`mb-6 ${muted}`}>{labels.intro}</p>
      {installGuide}
      {failed ? (
        <div className="flex items-center gap-3">
          <p className={bad}>{labels.failed}</p>
          <button
            type="button"
            onClick={() => void load()}
            className={`tap-40 rounded-full px-3 py-1.5 text-sm ${red}`}
          >
            {labels.retry}
          </button>
        </div>
      ) : !threads ? (
        <p className={muted}>{labels.loading}</p>
      ) : !threads.length ? (
        <p className={muted}>{labels.empty}</p>
      ) : (
        <ul className={`divide-y rounded-xl border ${line}`} data-chat-sites>
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpen(t)}
                aria-label={labels.openSite.replace("{site}", t.origin)}
                className="tap-40 flex w-full flex-col gap-1 px-4 py-3 text-start hover:bg-[oklch(0.96_0.005_260)] dark:hover:bg-[oklch(0.3_0.02_260)]"
              >
                <span className="flex w-full items-baseline justify-between gap-3">
                  <span className="font-semibold break-all">{siteName(t.origin)}</span>
                  <span className={`shrink-0 text-xs ${muted}`}>{when(t.at, locale)}</span>
                </span>
                <span className={`line-clamp-2 text-sm ${muted}`}>
                  {t.last
                    ? `${t.last.from === "agent" ? labels.agent : labels.you}: ${t.last.text}`
                    : labels.noLines}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SiteChat({ id, labels, locale }: { id: string; labels: SitesLabels; locale: string }) {
  const [client, setClient] = useState<PartnerClient | null>(null);
  useEffect(() => {
    const c = createPartnerClient({
      url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/debug`,
      cookie: true,
      query: `&sub=${encodeURIComponent(id)}`,
      ticket: async () => null,
      open: (u, p) => new WebSocket(u, p.length ? p : undefined) as never,
      label: () => `${location.host}${location.pathname}`.slice(0, 300),
      doc: document,
    });
    setClient(c);
    return () => c.stop();
  }, [id]);
  if (!client) return null;
  return <Transcript client={client} labels={labels} locale={locale} />;
}

function Transcript({
  client,
  labels,
  locale,
}: {
  client: PartnerClient;
  labels: SitesLabels;
  locale: string;
}) {
  const s = useSyncExternalStore(client.subscribe, client.get, client.get);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [s.messages.length]);
  const send = () => {
    const text = draft.trim();
    if (text && client.send(text)) setDraft("");
  };
  return (
    <div className="flex flex-col gap-3" data-site-chat>
      {!s.messages.length && <p className={muted}>{labels.noLines}</p>}
      {s.messages.map((m) => (
        <div
          key={m.id}
          className={`max-w-[85%] rounded-2xl px-3 py-2 ${
            m.from === "agent"
              ? "self-start bg-[oklch(0.96_0.005_260)] dark:bg-[oklch(0.3_0.02_260)]"
              : "self-end bg-[oklch(0.93_0.04_22.3)] dark:bg-[oklch(0.36_0.08_22.3)]"
          }`}
        >
          <div className={`mb-0.5 text-xs ${muted}`}>
            {m.from === "agent" ? labels.agent : labels.you} · {when(m.at, locale)}
          </div>
          <div className="text-sm break-words whitespace-pre-wrap">{m.text}</div>
        </div>
      ))}
      {s.warning && <p className={bad}>{s.warning}</p>}
      <div ref={end} />
      {!s.live && <p className={`text-xs ${muted}`}>{labels.connecting}</p>}
      <form
        className="sticky bottom-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={labels.message}
          aria-label={labels.message}
          className={`min-h-11 flex-1 resize-none rounded-xl border bg-[oklch(1_0_0)] px-3 py-2 text-sm dark:bg-[oklch(0.22_0.01_260)] ${line}`}
        />
        <button
          type="submit"
          disabled={!s.live || !draft.trim()}
          className={`tap-40 min-h-11 rounded-xl px-4 text-sm font-semibold ${red}`}
        >
          {labels.send}
        </button>
      </form>
    </div>
  );
}
