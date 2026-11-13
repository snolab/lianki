"use client";

import { useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { accountLabel, fill, shortId, txt, workerMeta } from "./lines";

type Allowed = { userId: string; name: string | null; addedAt: number; lastUsedAt: number | null };
type Worker = {
  id: string;
  name: string;
  ownerUserId: string | null;
  capacity: number | null;
  createdAt: number;
  revokedAt: number | null;
};
type State = { flag: boolean; allowed: Allowed[]; workers: Worker[] };

const API = "/api/dev/stt-access";
const LINE = "border-[oklch(0.88_0_0)] dark:border-[oklch(0.35_0_0)]";
const BTN =
  "rounded-md px-3 py-1 text-sm border border-[oklch(0_0_0/0.25)] dark:border-[oklch(1_0_0/0.25)] disabled:opacity-50";

/** The allowlist (add by email, remove) and the registered speech servers (revoke). */
export default function SttAccessAdmin() {
  const c = useIntlayer("dev-stt-access");
  const { locale } = useLocale();
  const failed = txt(c.failed);
  const [state, setState] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  /** Accounts matching what is typed (name or email), for a one-tap add. */
  const [found, setFound] = useState<{ id: string; name: string | null; email: string }[]>([]);
  useEffect(() => {
    const q = email.trim();
    if (q.length < 2) return setFound([]);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${API}?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d: { users?: typeof found }) => setFound(d.users ?? []))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [email]);
  /** The row waiting for its confirming tap: "u:<userId>" or "w:<workerId>". */
  const [confirm, setConfirm] = useState<string | null>(null);

  const when = (ms: number) =>
    `${new Date(ms).toLocaleString(locale, { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" })} JST`;

  useEffect(() => {
    fetch(API, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<State>) : Promise.reject(r.status)))
      .then(setState)
      .catch(() => setErr(failed));
  }, [failed]);

  async function op(body: Record<string, string>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as State & { error?: string };
      if (r.ok) {
        setState(data);
        setConfirm(null);
        if (body.op === "add") {
          setEmail("");
          setFound([]);
        }
      } else setErr(txt(data.error === "no-such-user" ? c.noSuchUser : c.failed));
    } catch {
      setErr(txt(c.failed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm opacity-80">{c.intro}</p>
      {state && (
        <p className="text-sm">
          <span className={state.flag ? "text-seal font-medium" : ""}>
            {state.flag ? c.flagOn : c.flagOff}
          </span>{" "}
          <a className="underline" href="/dev/flags#stt.worker">
            {c.flagLink}
          </a>
        </p>
      )}
      {err && (
        <p role="alert" className="text-sm font-medium">
          ⚠ {err}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{c.people}</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void op({ op: "add", email: email.trim() });
          }}
        >
          <input
            type="search"
            aria-label={txt(c.email)}
            placeholder={txt(c.email)}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-sm bg-transparent ${LINE}`}
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className={`${BTN} bg-seal text-white border-transparent`}
          >
            {c.add}
          </button>
        </form>
        {found.length > 0 && (
          <ul data-testid="stt-access-found" className={`rounded-md border ${LINE}`}>
            {found.map((u) => {
              const on = state?.allowed.some((a) => a.userId === u.id);
              return (
                <li
                  key={u.id}
                  className={`px-2 py-1.5 border-b last:border-b-0 ${LINE} flex items-center gap-2`}
                >
                  <span className="min-w-0 flex-1 break-all text-sm">
                    {u.name ? `${u.name} · ` : ""}
                    <span className="opacity-70">{u.email}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy || on}
                    onClick={() => void op({ op: "add", userId: u.id })}
                    className={`${BTN} bg-seal text-white border-transparent`}
                  >
                    {c.add}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {state && state.allowed.length === 0 && <p className="text-sm opacity-70">{c.nobody}</p>}
        <ul>
          {state?.allowed.map((a) => (
            <li
              key={a.userId}
              className={`py-2 border-b ${LINE} flex flex-wrap items-center gap-2`}
            >
              <span className="min-w-0 flex-1 break-all text-sm">
                {accountLabel(a)}
                {a.name ? (
                  // The id only as a short tag (owner, 2026-11-14: the full id is too long); all of it on hover.
                  <code className="ml-2 text-xs opacity-70" title={a.userId}>
                    {shortId(a.userId)}
                  </code>
                ) : null}
                <span className="block text-xs opacity-70">
                  {fill(txt(c.addedAt), { time: when(a.addedAt) })}
                  {" · "}
                  {a.lastUsedAt
                    ? fill(txt(c.lastUsed), { time: when(a.lastUsedAt) })
                    : txt(c.neverUsed)}
                </span>
              </span>
              {confirm === `u:${a.userId}` ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{c.confirmRemove}</span>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${BTN} bg-seal text-white border-transparent`}
                    onClick={(e) => e.isTrusted && void op({ op: "remove", userId: a.userId })}
                  >
                    {c.remove}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className={BTN}
                  onClick={() => setConfirm(`u:${a.userId}`)}
                >
                  {c.remove}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{c.servers}</h2>
        {state && state.workers.length === 0 && <p className="text-sm opacity-70">{c.noServers}</p>}
        <ul>
          {state?.workers.map((w) => (
            <li key={w.id} className={`py-2 border-b ${LINE} flex flex-wrap items-center gap-2`}>
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{w.name}</span>{" "}
                <code className="text-xs opacity-70">{w.id}</code>
                <span className="block text-xs opacity-70">
                  {workerMeta(w, c, when(w.createdAt))}
                </span>
              </span>
              {!w.revokedAt && w.ownerUserId && (
                <button
                  type="button"
                  disabled={busy}
                  className={BTN}
                  onClick={(e) => e.isTrusted && void op({ op: "official-worker", id: w.id })}
                >
                  {c.makeOfficial}
                </button>
              )}
              {w.revokedAt ? (
                <span className="text-sm opacity-70">
                  {c.revoked} · {when(w.revokedAt)}
                </span>
              ) : confirm === `w:${w.id}` ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{c.confirmRevoke}</span>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${BTN} bg-seal text-white border-transparent`}
                    onClick={(e) => e.isTrusted && void op({ op: "revoke-worker", id: w.id })}
                  >
                    {c.revoke}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className={BTN}
                  onClick={() => setConfirm(`w:${w.id}`)}
                >
                  {c.revoke}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
