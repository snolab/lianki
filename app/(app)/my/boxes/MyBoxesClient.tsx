"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import type { MyBox } from "@/lib/box-oauth/my-box";
import { RevokeConfirm } from "../preferences/RevokeConfirm";
import { longDate } from "@/lib/dates";
import { isBoxOrigin } from "@/lib/box-oauth/rules";

export default function MyBoxesClient() {
  const t = useIntlayer("my-boxes");
  const { locale } = useLocale();
  const [box, setBox] = useState<MyBox | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await fetch("/api/my/boxes", { cache: "no-store" });
      if (!r.ok) throw new Error("load-failed");
      setBox(((await r.json()) as { box: MyBox | null }).box);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function disconnect() {
    if (!box || busy) return;
    setBusy(true);
    setError(false);
    try {
      const r = await fetch("/api/my/boxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "revoke", clientId: box.clientId }),
      });
      if (!r.ok) throw new Error("revoke-failed");
      setBox(null);
      setConfirm(false);
      setDisconnected(true);
      heading.current?.focus();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="preferences-accessible mx-auto max-w-3xl px-4 py-8" data-testid="my-boxes">
      <a href="/my" className="text-sm text-primary underline">
        {t.back}
      </a>
      <h1 ref={heading} tabIndex={-1} className="mt-4 text-3xl font-semibold">
        {t.title}
      </h1>
      <p className="mt-2 text-gray-600 dark:text-gray-300">{t.intro}</p>
      <p role="status" aria-live="polite" className="mt-4">
        {loading ? t.loading : disconnected ? t.disconnected : ""}
      </p>
      {error && (
        <div role="alert" className="mt-4">
          <p>{t.error}</p>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy || loading}
            className="min-h-10 px-3 text-primary underline"
          >
            {t.retry}
          </button>
        </div>
      )}
      {!loading && !error && !box && <p className="mt-4">{t.empty}</p>}
      {box && (
        <section aria-label={t.title.value} className="mt-6 space-y-4">
          <dl className="space-y-3">
            <div>
              <dt className="text-sm opacity-70">{t.address}</dt>
              <dd className="break-all">
                {isBoxOrigin(box.origin) ? (
                  <a href={box.origin} className="text-primary underline">
                    {box.origin}
                  </a>
                ) : (
                  box.origin
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm opacity-70">{t.created}</dt>
              <dd>{longDate(new Date(box.createdAt).toISOString(), locale)}</dd>
            </div>
            <div>
              <dt className="text-sm opacity-70">{t.permissions}</dt>
              <dd className="break-words font-mono text-sm">{box.scopes.join(" · ")}</dd>
            </div>
          </dl>
          <RevokeConfirm
            id={box.clientId}
            name={box.origin}
            confirming={confirm}
            busy={busy}
            focusRevoke={refocus}
            labels={{
              revoke: t.disconnect.value,
              question: t.confirm.value,
              cancel: t.cancel.value,
            }}
            onAsk={() => {
              setConfirm(true);
              setRefocus(false);
            }}
            onCancel={() => {
              setConfirm(false);
              setRefocus(true);
            }}
            onConfirm={() => void disconnect()}
          />
        </section>
      )}
    </main>
  );
}
