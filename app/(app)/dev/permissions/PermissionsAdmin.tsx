"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import PermissionsHistory from "./PermissionsHistory";

type Permission = "admin" | "dev";
type Row = { email: string; permission: Permission; granted_by: string; granted_at: number };
type Pending =
  | { op: "grant"; email: string; permissions: Permission[] }
  | { op: "revoke"; email: string; permissions: [Permission] };

const PERMS: Permission[] = ["admin", "dev"];
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/**
 * List, grant and revoke the admin and dev permissions. Every change goes
 * through an in-app confirm dialog first; /api/dev/permissions checks
 * everything again on the server.
 */
export default function PermissionsAdmin({ self, seconds }: { self: string; seconds: number }) {
  const c = useIntlayer("dev-permissions");
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [want, setWant] = useState<Record<Permission, boolean>>({ admin: false, dev: true });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [version, setVersion] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);

  const name = (p: Permission) => (p === "admin" ? c.admin.value : c.dev.value);

  const apply = useCallback(
    async (r: Response) => {
      // No longer an admin (an own revocation took effect): this page is gone too.
      if (r.status === 404) return location.reload();
      const j = (await r.json().catch(() => ({}))) as { grants?: Row[]; error?: string };
      if (j.grants) setRows(j.grants);
      if (r.ok) return setErr("");
      const known: Record<string, string> = {
        "last-admin": c.errLastAdmin.value,
        "not-granted": c.errNotGranted.value,
        "bad-email": c.errBadEmail.value,
      };
      setErr(known[j.error ?? ""] ?? fill(c.errOther.value, { status: r.status }));
    },
    [c],
  );

  useEffect(() => {
    void fetch("/api/dev/permissions", { cache: "no-store" }).then(apply);
  }, [apply]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    if (!pending && d.open) d.close();
  }, [pending]);

  async function run(p: Pending) {
    setBusy(true);
    try {
      for (const permission of p.permissions)
        await apply(
          await fetch("/api/dev/permissions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: p.op, email: p.email, permission }),
          }),
        );
      if (p.op === "grant") setEmail("");
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }

  function askGrant() {
    const target = email.trim().toLowerCase();
    const permissions = PERMS.filter((p) => want[p]);
    if (target && permissions.length) setPending({ op: "grant", email: target, permissions });
  }

  const question = (p: Pending) =>
    p.op === "grant"
      ? fill(c.confirmGrant.value, {
          permission: p.permissions.map(name).join(" + "),
          email: p.email,
        })
      : fill(c.confirmRevoke.value, {
          permission: name(p.permissions[0]),
          email: p.email,
          seconds,
        });

  const emails = [...new Set(rows.map((r) => r.email))];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold">{c.holders}</h2>
        {emails.length === 0 && <p className="text-sm opacity-70">{c.none}</p>}
        <p className="text-sm opacity-70">
          {c.revokeDelay.value.replace("{seconds}", String(seconds))}
        </p>
        <ul className="divide-y divide-[oklch(0.88_0_0)] dark:divide-[oklch(0.35_0_0)]">
          {emails.map((e) => (
            <li key={e} className="py-2 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono break-all">{e}</span>
                {e === self && <span className="opacity-70">{c.you}</span>}
              </div>
              {rows
                .filter((r) => r.email === e)
                .map((r) => (
                  <div key={r.permission} className="flex flex-wrap items-center gap-2 pl-3">
                    <span className="font-medium">{name(r.permission)}</span>
                    <span className="opacity-70">
                      {fmt(r.granted_at)} · {r.granted_by}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPending({ op: "revoke", email: e, permissions: [r.permission] })
                      }
                      disabled={busy}
                      className="ml-auto min-h-9 px-2 text-[oklch(0.5_0.2_27)] dark:text-[oklch(0.75_0.15_27)] disabled:opacity-40"
                    >
                      {c.revoke}
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">{c.grantHeading}</h2>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={180}
          placeholder={c.emailPlaceholder.value}
          aria-label={c.emailPlaceholder.value}
          autoComplete="off"
          className="w-full min-w-0 border rounded px-2 py-1 bg-transparent"
        />
        {PERMS.map((p) => (
          <label key={p} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={want[p]}
              onChange={(e) => setWant((w) => ({ ...w, [p]: e.target.checked }))}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{name(p)}</span> —{" "}
              <span className="opacity-80">{p === "admin" ? c.adminHint : c.devHint}</span>
            </span>
          </label>
        ))}
        <button
          type="button"
          onClick={askGrant}
          disabled={busy || !email.trim() || !PERMS.some((p) => want[p])}
          className="min-h-9 rounded bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)] px-3 py-1 disabled:opacity-40"
        >
          {c.grant}
        </button>
      </section>

      {err && (
        <p
          role="alert"
          className="text-sm text-[oklch(0.5_0.2_27)] dark:text-[oklch(0.75_0.15_27)]"
        >
          {err}
        </p>
      )}

      <PermissionsHistory version={version} />

      <dialog
        ref={dialog}
        onClose={() => setPending(null)}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg p-4 bg-[oklch(0.99_0_0)] text-[oklch(0.2_0_0)] dark:bg-[oklch(0.22_0_0)] dark:text-[oklch(0.95_0_0)] backdrop:bg-[oklch(0_0_0/0.5)]"
      >
        {pending && (
          <div className="space-y-3">
            <p className="break-words">{question(pending)}</p>
            {pending.op === "revoke" && pending.email === self && (
              <p className="text-sm font-medium">{c.confirmSelf}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setPending(null)}
                className="min-h-9 px-3 rounded border"
              >
                {c.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = pending;
                  setPending(null);
                  void run(p);
                }}
                className="min-h-9 px-3 rounded bg-[oklch(0.2_0_0)] text-[oklch(0.98_0_0)] dark:bg-[oklch(0.95_0_0)] dark:text-[oklch(0.15_0_0)]"
              >
                {c.confirm}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
