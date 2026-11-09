/**
 * Files in the chat (files.ts; docs/dev-debug-widget.md, "Attachments and
 * the inbox"): the pending chips above the input, the files under a sent
 * line, and the Inbox list. Names are text nodes, never HTML; only an
 * INLINE_IMAGE type is drawn as <img>, and only from the host's URL (or, on
 * a pending chip, the file's own local object URL).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ChatFiles,
  type InboxEntry,
  type InboxUsage,
  type PendingFiles,
  formatSize,
  isInlineImage,
} from "./files";
import type { AttachmentRef, ChatStrings } from "./wire";

const keep = (e: { preventDefault(): void }) => e.preventDefault();
const CHIP_BG = "oklch(0.6 0.02 250 / 0.12)";
const BAR = "oklch(0.6 0.132 22.3)";
const BAD = "oklch(0.55 0.17 25)";

/** The pending files, live. */
export function usePending(p: PendingFiles) {
  return useSyncExternalStore(p.subscribe, p.get, p.get);
}

/** Above the input: one chip per file, with its progress and an ×. */
export function PendingChips({ t, pending }: { t: ChatStrings; pending: PendingFiles }) {
  const list = usePending(pending);
  if (!list.length) return null;
  return (
    <div
      data-testid="debug-chat-files"
      className="pointer-events-auto mb-1 flex flex-wrap gap-1"
    >
      {list.map((f) => {
        const note =
          f.state === "failed" ? t.attachFailed : f.state === "too-big" ? t.attachTooBig : "";
        const pct = f.size ? Math.min(100, Math.round((f.sent / f.size) * 100)) : 0;
        return (
          <div
            key={f.key}
            data-testid="debug-chat-file"
            data-state={f.state}
            title={f.state === "uploading" ? t.attachUploading : undefined}
            style={{ background: CHIP_BG }}
            className="relative flex max-w-[14rem] items-center gap-1.5 overflow-hidden rounded-lg py-1 ps-1 pe-0.5 fs-11 leading-snug"
          >
            {f.thumb ? (
              <img src={f.thumb} alt="" className="size-7 shrink-0 rounded object-cover" />
            ) : (
              <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded fs-10 opacity-70">
                {ext(f.name)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{f.name}</span>
              <span className="block fs-10 opacity-70" style={note ? { color: BAD } : undefined}>
                {note || formatSize(f.size)}
              </span>
            </span>
            <button
              type="button"
              data-testid="debug-chat-file-remove"
              aria-label={t.attachFileRemove}
              onPointerDown={keep}
              onClick={() => pending.remove(f.key)}
              className="tap-40 shrink-0 px-1.5 text-sm leading-6 text-gray-500"
            >
              ×
            </button>
            {f.state === "uploading" && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5"
                style={{ background: BAR, width: `${pct}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** "PDF", "ZIP": a file chip's stand-in for a thumbnail. */
function ext(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1]!.toUpperCase() : "FILE";
}

/** The host's actions on one file, as small buttons. */
function Actions({ r, files }: { r: AttachmentRef; files?: ChatFiles }) {
  const acts = files?.actions?.(r) ?? [];
  return acts.map((a) => (
    <button
      key={a.id}
      type="button"
      data-testid="debug-chat-file-action"
      data-action={a.id}
      onPointerDown={keep}
      onClick={a.run}
      className="tap-40 shrink-0 rounded-full px-2.5 py-1 fs-11 text-white"
      style={{ background: BAR }}
    >
      {a.label}
    </button>
  ));
}

/** Under a sent line: its images (inline) and files (links), from the host's URL, and the host's actions. */
export function SentFiles({ refs, files }: { refs: AttachmentRef[]; files?: ChatFiles }) {
  return (
    <span data-testid="debug-chat-sent-files" className="pointer-events-auto my-0.5 flex flex-wrap items-center gap-1">
      {refs.map((r) => {
        const href = files?.url(r);
        if (href && isInlineImage(r.type))
          return (
            <a key={r.id} href={href} target="_blank" rel="noopener noreferrer" title={r.name}>
              <img
                src={href}
                alt={r.name}
                loading="lazy"
                className="max-h-32 max-w-[10rem] rounded-lg object-cover"
              />
            </a>
          );
        const label = (
          <>
            <span className="truncate">{r.name}</span>
            <span className="shrink-0 opacity-70">{formatSize(r.size)}</span>
          </>
        );
        const cls = "flex max-w-[14rem] items-center gap-1.5 rounded-lg px-2 py-1 fs-11";
        const chip = href ? (
          <a
            key={r.id}
            href={href}
            rel="noopener noreferrer"
            download={r.name}
            style={{ background: CHIP_BG }}
            className={cls}
            data-testid="debug-chat-sent-file"
          >
            {label}
          </a>
        ) : (
          <span key={r.id} style={{ background: CHIP_BG }} className={cls} data-testid="debug-chat-sent-file">
            {label}
          </span>
        );
        return (
          <span key={r.id} className="flex items-center gap-1">
            {chip}
            <Actions r={r} files={files} />
          </span>
        );
      })}
    </span>
  );
}

/** The + menu's Inbox: the stored files, newest first, each deletable (confirmed). */
export function InboxPanel({
  t,
  files,
  onClose,
}: {
  t: ChatStrings;
  files: ChatFiles;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<InboxEntry[] | null>(null);
  const [usage, setUsage] = useState<InboxUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    files.list?.().then(
      (r) => {
        if (!on) return;
        setRows(r.items);
        setUsage(r.usage ?? null);
      },
      () => on && setFailed(true),
    );
    return () => {
      on = false;
    };
  }, [files]);
  const del = (id: string) => {
    setAsking(null);
    files.remove?.(id).then(
      () => {
        const gone = rows?.find((x) => x.id === id);
        setRows((r) => r?.filter((x) => x.id !== id) ?? r);
        if (gone)
          setUsage((u) => u && { ...u, bytes: Math.max(0, u.bytes - gone.size), items: Math.max(0, u.items - 1) });
      },
      () => setFailed(true),
    );
  };
  const btn = "tap-40 shrink-0 rounded-full px-2.5 py-1 fs-11";
  return (
    <div
      role="dialog"
      aria-label={t.inbox}
      data-testid="debug-chat-inbox"
      style={{ background: "var(--lk-chat-menu-bg, oklch(0.99 0.004 85 / 0.97))" }}
      className="pointer-events-auto absolute start-0 bottom-full z-10 mb-1 flex max-h-[min(24rem,60vh)] w-[min(20rem,100%)] flex-col overflow-hidden rounded-2xl p-1 text-gray-800 shadow-[0_12px_32px_-10px_oklch(0.22_0.015_65/0.45)] backdrop-blur-md dark:[--lk-chat-menu-bg:oklch(0.24_0.01_65/0.97)] dark:text-gray-100"
    >
      <div className="flex items-center px-2.5 pt-1">
        <span className="flex-1 fs-10 font-semibold uppercase tracking-wide opacity-60">{t.inbox}</span>
        <button type="button" onPointerDown={keep} onClick={onClose} className={btn} aria-label={t.inboxClose}>
          ×
        </button>
      </div>
      {usage && (
        <div data-testid="debug-chat-inbox-usage" className="px-2.5 pb-1 fs-11 opacity-70">
          {(usage.quota ? t.inboxUsageQuota : t.inboxUsage)
            .replace("{size}", formatSize(usage.bytes))
            .replace("{quota}", formatSize(usage.quota ?? 0))
            .replace("{n}", String(usage.items))}
        </div>
      )}
      <div className="min-h-0 overflow-y-auto">
        {failed && <div className="px-2.5 py-2 fs-12" style={{ color: BAD }}>{t.inboxFailed}</div>}
        {rows?.length === 0 && <div className="px-2.5 py-2 fs-12 opacity-70">{t.inboxEmpty}</div>}
        {rows?.map((r) =>
          asking === r.id ? (
            <div key={r.id} className="flex items-center gap-1 px-2.5 py-1.5 fs-12" data-testid="debug-chat-inbox-confirm">
              <span className="min-w-0 flex-1 truncate">{t.inboxDeleteConfirm}</span>
              <button
                type="button"
                data-testid="debug-chat-inbox-delete-yes"
                onPointerDown={keep}
                onClick={() => del(r.id)}
                className={`${btn} text-white`}
                style={{ background: BAD }}
              >
                {t.inboxDelete}
              </button>
              <button type="button" onPointerDown={keep} onClick={() => setAsking(null)} className={btn}>
                {t.inboxKeep}
              </button>
            </div>
          ) : (
            <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 fs-12" data-testid="debug-chat-inbox-row">
              <a
                href={files.url(r)}
                download={r.name}
                rel="noopener noreferrer"
                className="min-w-0 flex-1"
              >
                <span className="block truncate">{r.name}</span>
                <span className="block fs-10 opacity-70">
                  {formatSize(r.size)} · {new Date(r.at).toLocaleString()}
                  {r.processedAt ? ` · ${t.inboxProcessed}` : ""}
                </span>
              </a>
              <Actions r={r} files={files} />
              {files.remove && (
                <button
                  type="button"
                  data-testid="debug-chat-inbox-delete"
                  onPointerDown={keep}
                  onClick={() => setAsking(r.id)}
                  className={btn}
                  style={{ color: BAD }}
                >
                  {t.inboxDelete}
                </button>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
