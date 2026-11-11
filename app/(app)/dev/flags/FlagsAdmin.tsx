"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { useUi } from "@lianki/ui-state";
import { FLAGS, type FlagDef, type FlagKey } from "@/lib/flags";
import type { FlagLogEntry, FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";
import { card, Chevron, FlagCard, jst } from "./FlagCard";
import { FLAG_HIGHLIGHT_MS, scrollToFlag } from "./flag-anchor";
import {
  buildFlagView,
  filtersActive,
  groupDomId,
  groupOfRow,
  isGroupOpen,
  isShipped,
  RECENT_DAYS,
  resolveFlagAnchor,
  SHIPPED_GROUP,
  type StateFilter,
} from "./flag-view";
import { flagViewPrefs } from "./flag-view-store";
import { DevToast, type DevToastMsg } from "../DevToast";
import { SealStamp } from "@/app/components/SealSwitch";

type State = {
  flags: FlagRow[];
  /** The prerequisites each flag fails now (reason keys and texts only). */
  prereqs?: Partial<Record<FlagKey, PrereqFailure[]>>;
  log: FlagLogEntry[];
  cacheSeconds: number;
};

const STATE_FILTERS: [StateFilter, string][] = [
  ["all", "全部"],
  ["on", "开着"],
  ["off", "关着"],
];

/** Puts values into a string's {placeholders}. */
const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

const pill = (on: boolean) =>
  `rounded-full border px-3 py-1 text-xs ${
    on
      ? "border-transparent bg-primary text-on-primary"
      : "border-[oklch(0_0_0/0.15)] dark:border-[oklch(1_0_0/0.2)]"
  }`;

/** Every registry flag with a switch; each change is logged on the server. */
export default function FlagsAdmin() {
  const [state, setState] = useState<State | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const t = useIntlayer("dev-flag-toast");
  const [toast, setToast] = useState<DevToastMsg | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<FlagKey>>(new Set());
  const [pinned, setPinned] = useState<FlagKey | null>(null);
  const [linkGroup, setLinkGroup] = useState<string | null>(null);
  const [held, setHeld] = useState<ReadonlyMap<FlagKey, boolean>>(new Map());
  const [jump, setJump] = useState<{ key: FlagKey } | null>(null);
  const [now] = useState(() => Date.now());
  const stateFilter = useUi(flagViewPrefs, (s) => s.state);
  const recent = useUi(flagViewPrefs, (s) => s.recent);
  const open = useUi(flagViewPrefs, (s) => s.open);
  const loaded = state !== null;
  const latest = useRef({ state, held });

  useEffect(() => {
    latest.current = { state, held };
  }, [state, held]);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/dev/flags", { cache: "no-store" });
      if (r.ok) setState(await r.json());
      else setMsg(`HTTP ${r.status}`);
    })();
  }, []);

  // /dev/flags#<key>: the rows exist only after the fetch above, and the row may
  // be in a folded section or behind a filter. So open the way first (for this
  // visit only: the device's folded sections and filters stay as they were),
  // and scroll once that has rendered.
  useEffect(() => {
    if (!loaded) return;
    const goToHash = () => {
      const key = resolveFlagAnchor(window.location.hash);
      const { state: current, held: heldNow } = latest.current;
      const row = current?.flags.find((f) => f.key === key);
      if (!key || !row) return;
      setPinned(key);
      setLinkGroup(groupOfRow(row, { prereqs: current?.prereqs, held: heldNow }));
      setExpanded((s) => new Set(s).add(key));
      setJump({ key });
    };
    goToHash();
    window.addEventListener("hashchange", goToHash);
    return () => window.removeEventListener("hashchange", goToHash);
  }, [loaded]);

  useEffect(() => {
    if (!jump) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const key = scrollToFlag(document, `#${jump.key}`, reduce);
    if (!key) return;
    setHighlighted(key);
    const timer = setTimeout(() => setHighlighted(null), FLAG_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [jump]);

  const groups = useMemo(
    () =>
      state
        ? buildFlagView(state.flags, {
            q,
            state: stateFilter,
            recent,
            now,
            prereqs: state.prereqs,
            pinned,
            held,
          })
        : [],
    [state, q, stateFilter, recent, now, pinned, held],
  );
  const searching = q.trim() !== "";

  /** A new search or filter is a new question: what a link or a tap kept in view lets go. */
  function letGo() {
    setPinned(null);
    setHeld(new Map());
  }

  function toggleGroup(id: string, isOpen: boolean) {
    if (linkGroup === id) setLinkGroup(null);
    flagViewPrefs.setState({ open: { ...open, [id]: !isOpen } });
  }

  function toggleRow(key: FlagKey) {
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  async function toggle(f: FlagRow) {
    const enabled = !f.enabled;
    // Payment flags move real money: ask once before turning one on.
    if (enabled && f.key.startsWith("payments.") && !window.confirm(`打开 ${f.key}？`)) return;
    setBusy(f.key);
    setToast(null);
    setHeld((h) =>
      h.has(f.key) ? h : new Map(h).set(f.key, isShipped(f, state?.prereqs?.[f.key])),
    );
    try {
      const r = await fetch("/api/dev/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: f.key, enabled }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setState(data);
        const audience = (FLAGS[f.key] as FlagDef).audience;
        setToast({
          ok: true,
          id: Date.now(),
          text: fill(t.saved.value, {
            flag: f.key,
            state: enabled ? t.on.value : t.off.value,
            seconds: data.cacheSeconds ?? state?.cacheSeconds ?? "",
            audience:
              audience === "owner"
                ? t.ownerOnly.value
                : audience === "allowlist"
                  ? t.allowlist.value
                  : t.everyone.value,
          }),
        });
      } else
        setToast({
          ok: false,
          id: Date.now(),
          text: fill(t.failed.value, { flag: f.key, error: data.error ?? `HTTP ${r.status}` }),
        });
    } catch (e) {
      setToast({
        ok: false,
        id: Date.now(),
        text: fill(t.failed.value, { flag: f.key, error: String(e) }),
      });
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <p className="text-sm opacity-70">{msg ?? "…"}</p>;
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div className="space-y-4">
      <DevToast msg={toast} onClose={closeToast} />
      <p data-flags-cache-note className="text-xs opacity-70">
        {fill(t.cacheNote.value, { seconds: state.cacheSeconds })}
      </p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 rounded-lg border border-[oklch(0_0_0/0.15)] dark:border-[oklch(1_0_0/0.2)] px-3 py-2">
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
            className="shrink-0 opacity-60"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3.5 3.5" />
          </svg>
          <input
            type="search"
            value={q}
            aria-label="搜索开关"
            placeholder="搜索名称或说明"
            onChange={(e) => {
              setQ(e.target.value);
              letGo();
            }}
            className="min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <div role="group" aria-label="按状态筛选" className="flex gap-1.5">
            {STATE_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={stateFilter === value}
                className={pill(stateFilter === value)}
                onClick={() => {
                  flagViewPrefs.setState({ state: value });
                  letGo();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={recent}
            data-flags-recent={recent ? "on" : "off"}
            className={`${pill(false)} inline-flex items-center gap-1.5 pe-1`}
            onClick={() => {
              flagViewPrefs.setState({ recent: !recent });
              letGo();
            }}
          >
            {RECENT_DAYS} 天内改过
            <SealStamp on={recent} size="sm" />
          </button>
          <span data-testid="flags-count" className="ms-auto text-xs opacity-60">
            {shown} / {state.flags.length}
          </span>
        </div>
      </div>

      {groups.map((g) => {
        const isOpen = searching || linkGroup === g.id || isGroupOpen(open, g.id);
        return (
          <section key={g.id} id={groupDomId(g.id)} data-flag-group={g.id} className="scroll-mt-20">
            <h2>
              <button
                type="button"
                aria-expanded={isOpen}
                disabled={searching}
                onClick={() => toggleGroup(g.id, isOpen)}
                className="flex min-h-9 w-full items-center gap-1.5 text-start text-sm font-bold"
              >
                <Chevron open={isOpen} />
                {g.label}
                <span className="ms-auto text-xs font-normal opacity-60">
                  开 {g.on} / {g.total}
                </span>
              </button>
            </h2>
            {isOpen && g.id === SHIPPED_GROUP && (
              <p className="mb-1 text-xs opacity-60">
                已打开且对所有用户生效。这里只是换个位置看，开关照常可用。
              </p>
            )}
            {isOpen && (
              <div className="rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] divide-y divide-[oklch(0_0_0/0.08)] dark:divide-[oklch(1_0_0/0.08)]">
                {g.rows.map((f) => (
                  <FlagCard
                    key={f.key}
                    flag={f}
                    failed={state.prereqs?.[f.key]}
                    busy={busy !== null}
                    highlighted={highlighted === f.key}
                    expanded={expanded.has(f.key)}
                    onExpand={() => toggleRow(f.key)}
                    onToggle={() => void toggle(f)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {shown === 0 && <p className="text-sm opacity-70">没有符合的开关。</p>}
      {filtersActive({ q, state: stateFilter, recent }) && (
        <button
          type="button"
          className={pill(false)}
          onClick={() => {
            setQ("");
            flagViewPrefs.setState({ state: "all", recent: false });
            letGo();
          }}
        >
          清除筛选
        </button>
      )}

      <section className={card}>
        <h2 className="font-bold text-sm">改动记录</h2>
        {state.log.length === 0 ? (
          <p className="text-xs opacity-60">还没有改动。</p>
        ) : (
          <ul className="text-xs font-mono space-y-1">
            {state.log.map((e, i) => (
              <li key={i}>
                {jst(e.at)} · {e.key} → {e.enabled ? "开" : "关"} · {e.by}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
