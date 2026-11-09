"use client";

import { previewDoc } from "@/lib/mail-templates/layout";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { LOCALE_LABELS } from "@/lib/constants";

/**
 * /dev/mails: the send log (docs/mail-templates.md, "Send log") through
 * /api/dev/mails. List with filters and per-day counts, one mail's detail
 * re-rendered from its template (in a sandboxed frame: no script, no
 * same-origin), Resend and Suppress behind a confirmation, and the
 * suppressed-addresses list.
 */

type Status =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "unsubscribed"
  | "failed"
  | "suppressed";

type Item = {
  id: string;
  createdAt: number;
  template: string;
  version: number;
  locale: string;
  recipient: string;
  masked: boolean;
  status: Status;
  reason: string | null;
  providerId: string | null;
  resendOf: string | null;
};
type ListAnswer = {
  rows: Item[];
  total: number;
  page: number;
  pageSize: number;
  perDay: { day: string; status: Status; n: number }[];
  templates: string[];
  locales: string[];
  statuses: Status[];
};
type Detail = {
  mail: Item & {
    userId: string | null;
    inviterId: string | null;
    recipientHash: string;
    vars: Record<string, string> | null;
  };
  rendered:
    | { ok: true; mail: { subject: string; html: string; text: string }; placeholders: string[] }
    | { ok: false; error: "test-draft" | "unknown-template" | "version-missing" | "render-failed" };
  resend: string;
  suppressed: boolean;
};
type Suppression = {
  recipientHash: string;
  reason: string;
  createdAt: number;
  recipient: string | null;
  masked: boolean | null;
};

const JST = 9 * 3600_000;
const fmt = (ms: number) => new Date(ms + JST).toISOString().slice(0, 16).replace("T", " ");
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const camel = (id: string) => id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

const BTN =
  "min-h-9 px-3 rounded bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)] disabled:opacity-40";
const BTN2 = "min-h-9 px-3 rounded border disabled:opacity-40";
const FIELD = "border rounded px-2 min-h-9 bg-transparent max-w-full min-w-0";
const ERR = "text-sm text-[oklch(0.5_0.2_27)] dark:text-[oklch(0.75_0.15_27)]";
const OK = "text-sm text-[oklch(0.45_0.12_150)] dark:text-[oklch(0.8_0.12_150)]";

/** Badge colours per status: light tint + dark text, or the reverse in dark mode (AA both). */
const BADGE: Record<Status, string> = {
  queued:
    "bg-[oklch(0.93_0_0)] text-[oklch(0.3_0_0)] dark:bg-[oklch(0.32_0_0)] dark:text-[oklch(0.92_0_0)]",
  sent: "bg-[oklch(0.93_0.04_250)] text-[oklch(0.35_0.12_250)] dark:bg-[oklch(0.32_0.06_250)] dark:text-[oklch(0.9_0.05_250)]",
  delivered:
    "bg-[oklch(0.93_0.05_150)] text-[oklch(0.35_0.1_150)] dark:bg-[oklch(0.32_0.06_150)] dark:text-[oklch(0.9_0.06_150)]",
  bounced:
    "bg-[oklch(0.93_0.06_70)] text-[oklch(0.4_0.1_60)] dark:bg-[oklch(0.33_0.06_70)] dark:text-[oklch(0.92_0.07_80)]",
  complained:
    "bg-[oklch(0.92_0.05_27)] text-[oklch(0.42_0.16_27)] dark:bg-[oklch(0.33_0.08_27)] dark:text-[oklch(0.9_0.06_27)]",
  unsubscribed:
    "bg-[oklch(0.93_0.04_300)] text-[oklch(0.38_0.12_300)] dark:bg-[oklch(0.32_0.06_300)] dark:text-[oklch(0.9_0.05_300)]",
  failed:
    "bg-[oklch(0.92_0.05_27)] text-[oklch(0.42_0.16_27)] dark:bg-[oklch(0.33_0.08_27)] dark:text-[oklch(0.9_0.06_27)]",
  suppressed:
    "bg-[oklch(0.93_0.04_85)] text-[oklch(0.38_0.07_70)] dark:bg-[oklch(0.32_0.04_80)] dark:text-[oklch(0.9_0.06_85)]",
};

function frameDoc(html: string, dark: boolean) {
  // A mail in the shared layout is a whole document with its own dark rules.
  if (/^<!doctype html>/i.test(html)) return previewDoc(html, dark);
  const bg = dark ? "oklch(0.2 0 0)" : "oklch(1 0 0)";
  const fg = dark ? "oklch(0.92 0 0)" : "oklch(0.2 0 0)";
  const link = dark ? "oklch(0.78 0.12 260)" : "oklch(0.45 0.18 260)";
  return `<!doctype html><html style="color-scheme:${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:${bg};color:${fg}}a{color:${link}}</style></head><body>${html}</body></html>`;
}

type Confirm = { text: string; yes: string; run: () => Promise<void> };
type Filters = {
  template: string;
  status: string;
  locale: string;
  from: string;
  to: string;
  q: string;
};
const NO_FILTERS: Filters = { template: "", status: "", locale: "", from: "", to: "", q: "" };

const REFUSAL_KEY: Record<string, string> = {
  "not-resendable": "notResendable",
  "no-address": "noAddress",
  suppressed: "suppressed",
  "no-inviter": "noInviter",
  "rate-limited": "rateLimited",
  "invite-limit": "inviteLimit",
  "invite-skipped": "inviteSkipped",
  "cannot-render": "cannotRender",
  "send-failed": "sendFailed",
};

export default function MailsLog() {
  const c = useIntlayer("dev-mails");
  const tpl = useIntlayer("dev-templates");
  const t = c as unknown as Record<string, { value: string }> & {
    statuses: Record<string, { value: string }>;
    reasons: Record<string, { value: string }>;
    refusals: Record<string, { value: string }>;
  };
  const names = (tpl as unknown as { names: Record<string, { value: string }> }).names;
  const tplName = (id: string) => names[camel(id)]?.value ?? c.unknownTemplate.value;

  const [tab, setTab] = useState<"log" | "suppression">("log");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [list, setList] = useState<ListAnswer | null>(null);
  const [supp, setSupp] = useState<{ rows: Suppression[]; total: number; page: number } | null>(
    null,
  );
  const [suppPage, setSuppPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    setDark(m.matches);
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const failText = useCallback(
    (status: number) => fill(c.errOther.value, { status }),
    [c.errOther.value],
  );

  const want = useRef("");
  const loadList = useCallback(async () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set("page", String(page));
    const key = p.toString();
    want.current = key;
    const r = await fetch(`/api/dev/mails?${key}`, { cache: "no-store" });
    if (r.status === 404) return location.reload();
    if (!r.ok) return setMsg({ ok: false, text: failText(r.status) });
    const d = (await r.json()) as ListAnswer;
    if (want.current === key) setList(d);
  }, [filters, page, failText]);

  const loadSupp = useCallback(async () => {
    const r = await fetch(`/api/dev/mails?view=suppression&page=${suppPage}`, {
      cache: "no-store",
    });
    if (!r.ok) return setMsg({ ok: false, text: failText(r.status) });
    setSupp(await r.json());
  }, [suppPage, failText]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetail(null);
      const r = await fetch(`/api/dev/mails?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!r.ok) return setMsg({ ok: false, text: failText(r.status) });
      setDetail(await r.json());
    },
    [failText],
  );

  useEffect(() => {
    if (tab === "log") void loadList();
    else void loadSupp();
  }, [tab, loadList, loadSupp]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  const setFilter = (k: keyof Filters, v: string) => {
    setPage(0);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/dev/mails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string; why?: string };
    return { ok: r.ok, status: r.status, ...d };
  };

  const refusalText = (code: string, why?: string) => {
    const k = REFUSAL_KEY[code];
    return k ? fill(t.refusals[k].value, { why: why ?? "" }) : code;
  };

  const doResend = (d: Detail) =>
    setConfirm({
      text: fill(c.resendConfirm.value, { address: d.mail.recipient }),
      yes: c.sendAgain.value,
      run: async () => {
        const r = await post({ op: "resend", id: d.mail.id });
        if (r.ok) setMsg({ ok: true, text: c.resent.value });
        else
          setMsg({
            ok: false,
            text: r.error ? refusalText(r.error, r.why) : failText(r.status),
          });
        await loadList();
      },
    });

  const doSuppress = (d: Detail) =>
    setConfirm({
      text: fill(c.suppressConfirm.value, { address: d.mail.recipient }),
      yes: c.suppress.value,
      run: async () => {
        const r = await post({ op: "suppress", id: d.mail.id });
        setMsg(
          r.ok ? { ok: true, text: c.suppressDone.value } : { ok: false, text: failText(r.status) },
        );
        await loadDetail(d.mail.id);
      },
    });

  const doUnsuppress = (s: Suppression) =>
    setConfirm({
      text: fill(c.removeConfirm.value, { address: s.recipient ?? s.recipientHash.slice(0, 12) }),
      yes: c.remove.value,
      run: async () => {
        const r = await post({ op: "unsuppress", hash: s.recipientHash });
        setMsg(
          r.ok ? { ok: true, text: c.removed.value } : { ok: false, text: failText(r.status) },
        );
        await loadSupp();
      },
    });

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.run();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  // Per-day counts: one row per day, total + each status present.
  const days = (() => {
    const m = new Map<string, { total: number; by: Partial<Record<Status, number>> }>();
    for (const r of list?.perDay ?? []) {
      const e = m.get(r.day) ?? { total: 0, by: {} };
      e.total += r.n;
      e.by[r.status] = (e.by[r.status] ?? 0) + r.n;
      m.set(r.day, e);
    }
    return [...m.entries()];
  })();
  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const tagOf = (r: Item) =>
    r.version < 0 ? c.testSend.value : r.version === 0 ? c.builtin.value : `v${r.version}`;

  const tabBtn = (k: "log" | "suppression", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === k}
      data-testid={`mails-tab-${k}`}
      onClick={() => {
        setMsg(null);
        setTab(k);
      }}
      className={`min-h-9 px-3 ${tab === k ? "bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)]" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4 min-w-0">
      <p className="text-sm opacity-80">{c.intro}</p>
      <div role="tablist" className="inline-flex rounded border overflow-hidden text-sm">
        {tabBtn("log", c.tabLog.value)}
        {tabBtn("suppression", c.tabSuppression.value)}
      </div>
      {msg && !confirm && (
        <p data-testid="mails-msg" role="status" className={msg.ok ? OK : ERR}>
          {msg.text}
        </p>
      )}

      {tab === "log" && (
        <>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="space-y-1 min-w-0">
              <span className="block font-medium">{c.template}</span>
              <select
                data-testid="mails-f-template"
                className={FIELD}
                value={filters.template}
                onChange={(e) => setFilter("template", e.target.value)}
              >
                <option value="">{c.allTemplates}</option>
                {(list?.templates ?? []).map((id) => (
                  <option key={id} value={id}>
                    {tplName(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 min-w-0">
              <span className="block font-medium">{c.status}</span>
              <select
                data-testid="mails-f-status"
                className={FIELD}
                value={filters.status}
                onChange={(e) => setFilter("status", e.target.value)}
              >
                <option value="">{c.allStatuses}</option>
                {(list?.statuses ?? []).map((s) => (
                  <option key={s} value={s}>
                    {t.statuses[s]?.value ?? s}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 min-w-0">
              <span className="block font-medium">{c.language}</span>
              <select
                data-testid="mails-f-locale"
                className={FIELD}
                value={filters.locale}
                onChange={(e) => setFilter("locale", e.target.value)}
              >
                <option value="">{c.allLanguages}</option>
                {(list?.locales ?? []).map((l) => (
                  <option key={l} value={l}>
                    {(LOCALE_LABELS as Record<string, string>)[l] ?? l}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 min-w-0">
              <span className="block font-medium">{c.from}</span>
              <input
                type="date"
                data-testid="mails-f-from"
                className={FIELD}
                value={filters.from}
                onChange={(e) => setFilter("from", e.target.value)}
              />
            </label>
            <label className="space-y-1 min-w-0">
              <span className="block font-medium">{c.to}</span>
              <input
                type="date"
                data-testid="mails-f-to"
                className={FIELD}
                value={filters.to}
                onChange={(e) => setFilter("to", e.target.value)}
              />
            </label>
          </div>
          <form
            className="flex flex-wrap gap-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("q", q.trim());
            }}
          >
            <input
              type="search"
              data-testid="mails-q"
              aria-label={c.searchPlaceholder.value}
              placeholder={c.searchPlaceholder.value}
              className={`${FIELD} flex-1 min-w-[10rem]`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="submit" className={BTN} data-testid="mails-search">
              {c.search}
            </button>
            <button
              type="button"
              className={BTN2}
              onClick={() => {
                setQ("");
                setPage(0);
                setFilters(NO_FILTERS);
              }}
            >
              {c.clear}
            </button>
          </form>

          {days.length > 0 && (
            <section className="space-y-1" data-testid="mails-per-day">
              <h2 className="text-sm font-semibold">{c.perDay}</h2>
              <ul className="text-xs space-y-0.5">
                {days.map(([day, e]) => (
                  <li key={day} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    <span className="font-mono">{day}</span>
                    <span className="font-semibold">{e.total}</span>
                    {Object.entries(e.by).map(([s, n]) => (
                      <span key={s} className="opacity-80">
                        {t.statuses[s]?.value ?? s} {n}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!list ? (
            <p className="text-sm opacity-70">{c.loading}</p>
          ) : (
            <section className="space-y-2">
              <p className="text-sm opacity-80" data-testid="mails-total">
                {fill(c.total.value, { n: list.total })}
              </p>
              {list.rows.length === 0 ? (
                <p className="text-sm opacity-70">{c.empty}</p>
              ) : (
                <ul
                  data-testid="mails-list"
                  className="divide-y divide-[oklch(0.88_0_0)] dark:divide-[oklch(0.35_0_0)] border-y border-[oklch(0.88_0_0)] dark:border-[oklch(0.35_0_0)]"
                >
                  {list.rows.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        data-testid="mails-row"
                        data-id={r.id}
                        onClick={() => {
                          setMsg(null);
                          setOpenId(r.id);
                        }}
                        className="w-full text-left py-2 px-1 text-sm grid gap-x-3 gap-y-0.5 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,14rem)_8rem] items-baseline hover:bg-[oklch(0.96_0_0)] dark:hover:bg-[oklch(0.27_0_0)]"
                      >
                        <span className="font-mono text-xs opacity-80">{fmt(r.createdAt)}</span>
                        <span className={`break-all ${r.masked ? "italic opacity-80" : ""}`}>
                          {r.recipient}
                        </span>
                        <span className="min-w-0">
                          {tplName(r.template)}{" "}
                          <span className="text-xs opacity-70">
                            {tagOf(r)} · {r.locale}
                          </span>
                        </span>
                        <span>
                          <span
                            data-testid="mails-status"
                            className={`inline-block px-1.5 rounded text-xs ${BADGE[r.status] ?? BADGE.queued}`}
                          >
                            {t.statuses[r.status]?.value ?? r.status}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  className={BTN2}
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  {c.newer}
                </button>
                <span className="opacity-80">
                  {fill(c.pageOf.value, { page: page + 1, pages })}
                </span>
                <button
                  type="button"
                  className={BTN2}
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {c.older}
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {tab === "suppression" && (
        <section className="space-y-2" data-testid="mails-suppression">
          {!supp ? (
            <p className="text-sm opacity-70">{c.loading}</p>
          ) : supp.rows.length === 0 ? (
            <p className="text-sm opacity-70">{c.noSuppression}</p>
          ) : (
            <ul className="divide-y divide-[oklch(0.88_0_0)] dark:divide-[oklch(0.35_0_0)] text-sm">
              {supp.rows.map((s) => (
                <li
                  key={s.recipientHash}
                  data-testid="supp-row"
                  className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span className={`break-all flex-1 min-w-[10rem] ${s.masked ? "italic" : ""}`}>
                    {s.recipient ?? (
                      <span className="opacity-70">
                        <code>{s.recipientHash.slice(0, 12)}</code> · {c.notInLog}
                      </span>
                    )}
                  </span>
                  <span className="opacity-80">{t.reasons[s.reason]?.value ?? s.reason}</span>
                  <span className="font-mono text-xs opacity-80">{fmt(s.createdAt)}</span>
                  <button
                    type="button"
                    className={BTN2}
                    data-testid="supp-remove"
                    onClick={() => doUnsuppress(s)}
                  >
                    {c.remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {supp && supp.total > 50 && (
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                className={BTN2}
                disabled={suppPage === 0}
                onClick={() => setSuppPage((p) => Math.max(0, p - 1))}
              >
                {c.newer}
              </button>
              <button
                type="button"
                className={BTN2}
                disabled={(suppPage + 1) * 50 >= supp.total}
                onClick={() => setSuppPage((p) => p + 1)}
              >
                {c.older}
              </button>
            </div>
          )}
        </section>
      )}

      {openId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={c.tabLog.value}
          className="fixed inset-0 z-40 bg-[oklch(0_0_0/0.45)] flex justify-end"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpenId(null);
          }}
        >
          <div
            data-testid="mails-detail"
            className="h-full w-full max-w-2xl overflow-y-auto bg-[oklch(1_0_0)] dark:bg-[oklch(0.2_0_0)] p-4 space-y-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold min-w-0">
                {detail ? tplName(detail.mail.template) : c.loading}
              </h2>
              <button
                type="button"
                className={BTN2}
                data-testid="mails-close"
                onClick={() => setOpenId(null)}
              >
                {c.close}
              </button>
            </div>
            {detail && (
              <>
                <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt className="opacity-70">{c.time}</dt>
                  <dd className="font-mono">{fmt(detail.mail.createdAt)}</dd>
                  <dt className="opacity-70">{c.recipient}</dt>
                  <dd className="break-all" data-testid="mails-d-recipient">
                    {detail.mail.recipient}
                    {detail.suppressed && (
                      <span
                        data-testid="mails-d-suppressed"
                        className={`ml-2 inline-block px-1.5 rounded text-xs ${BADGE.complained}`}
                      >
                        {c.suppressed}
                      </span>
                    )}
                    {detail.mail.masked && (
                      <span className="block text-xs opacity-70">{c.masked}</span>
                    )}
                  </dd>
                  <dt className="opacity-70">{c.status}</dt>
                  <dd>
                    <span
                      data-testid="mails-d-status"
                      className={`inline-block px-1.5 rounded text-xs ${BADGE[detail.mail.status] ?? BADGE.queued}`}
                    >
                      {t.statuses[detail.mail.status]?.value ?? detail.mail.status}
                    </span>
                  </dd>
                  {detail.mail.reason && (
                    <>
                      <dt className="opacity-70">{c.reason}</dt>
                      <dd className="break-all">{detail.mail.reason}</dd>
                    </>
                  )}
                  <dt className="opacity-70">{c.version}</dt>
                  <dd>
                    {tagOf(detail.mail)} · {detail.mail.locale}
                  </dd>
                  {detail.mail.providerId && (
                    <>
                      <dt className="opacity-70">{c.messageId}</dt>
                      <dd className="font-mono break-all">{detail.mail.providerId}</dd>
                    </>
                  )}
                  {detail.mail.userId && (
                    <>
                      <dt className="opacity-70">{c.user}</dt>
                      <dd className="font-mono break-all">{detail.mail.userId}</dd>
                    </>
                  )}
                  {detail.mail.inviterId && (
                    <>
                      <dt className="opacity-70">{c.inviter}</dt>
                      <dd className="font-mono break-all">{detail.mail.inviterId}</dd>
                    </>
                  )}
                  {detail.mail.resendOf && (
                    <>
                      <dt className="opacity-70">{c.resentFrom}</dt>
                      <dd>
                        <button
                          type="button"
                          className="underline font-mono break-all text-left"
                          onClick={() => setOpenId(detail.mail.resendOf)}
                        >
                          {detail.mail.resendOf}
                        </button>
                      </dd>
                    </>
                  )}
                </dl>
                {detail.mail.vars && (
                  <div>
                    <h3 className="font-medium">{c.keptVars}</h3>
                    <ul className="text-xs font-mono break-all">
                      {Object.entries(detail.mail.vars).map(([k, v]) => (
                        <li key={k}>
                          {k}: {v}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BTN}
                    data-testid="mails-resend"
                    disabled={detail.resend !== "ok" || busy}
                    onClick={() => doResend(detail)}
                  >
                    {c.resend}
                  </button>
                  <button
                    type="button"
                    className={BTN2}
                    data-testid="mails-suppress"
                    disabled={detail.suppressed || busy}
                    onClick={() => doSuppress(detail)}
                  >
                    {c.suppress}
                  </button>
                </div>
                {detail.resend !== "ok" && (
                  <p className="text-xs opacity-80" data-testid="mails-refusal">
                    {refusalText(detail.resend)}
                  </p>
                )}
                {msg && (
                  <p data-testid="mails-d-msg" role="status" className={msg.ok ? OK : ERR}>
                    {msg.text}
                  </p>
                )}
                {detail.rendered.ok ? (
                  <section className="space-y-2">
                    {detail.rendered.placeholders.length > 0 && (
                      <p className="text-xs opacity-80" data-testid="mails-placeholders">
                        {fill(c.placeholders.value, {
                          names: detail.rendered.placeholders.map((n) => `{${n}}`).join(" "),
                        })}
                      </p>
                    )}
                    <div className="rounded border overflow-hidden">
                      <div
                        data-testid="mails-d-subject"
                        className="px-3 py-2 font-medium border-b break-words"
                      >
                        {detail.rendered.mail.subject}
                      </div>
                      <iframe
                        title={detail.rendered.mail.subject}
                        sandbox=""
                        className="w-full h-[24rem] block"
                        srcDoc={frameDoc(detail.rendered.mail.html, dark)}
                      />
                    </div>
                    <h3 className="font-medium">{c.plainText}</h3>
                    <pre className="text-xs whitespace-pre-wrap break-words rounded border p-2 max-h-64 overflow-auto">
                      {detail.rendered.mail.text}
                    </pre>
                  </section>
                ) : (
                  <p className="opacity-80" data-testid="mails-no-render">
                    {detail.rendered.error === "test-draft"
                      ? c.testDraft
                      : detail.rendered.error === "version-missing"
                        ? c.versionMissing
                        : c.renderFailed}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {confirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={confirm.yes}
          className="fixed inset-0 z-50 bg-[oklch(0_0_0/0.5)] flex items-center justify-center p-4"
        >
          <div
            data-testid="mails-confirm"
            className="w-full max-w-sm rounded bg-[oklch(1_0_0)] dark:bg-[oklch(0.22_0_0)] p-4 space-y-3 text-sm"
          >
            <p className="break-words">{confirm.text}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={BTN2}
                data-testid="mails-confirm-no"
                onClick={() => setConfirm(null)}
              >
                {c.cancel}
              </button>
              <button
                type="button"
                className={BTN}
                data-testid="mails-confirm-yes"
                disabled={busy}
                onClick={runConfirm}
              >
                {confirm.yes}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
