"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SealSwitch } from "@/app/components/SealSwitch";
import {
  canonicalExactSiteOrigin,
  type SitePermissionManagementAction,
} from "@/lib/site-permission-wire";
import { publicSitePermissionResult } from "@/lib/site-permission-result";
import type { SitePermissionGrant } from "@/lib/site-permission-authority";
export type SitePermissionLabels = Record<
  | "title"
  | "body"
  | "origin"
  | "originHint"
  | "add"
  | "pageRead"
  | "deny"
  | "error"
  | "loading"
  | "empty"
  | "site"
  | "advancedLink"
  | "retry",
  string
>;
export default function SitePermissions({ labels: t }: { labels: SitePermissionLabels }) {
  const [grants, setGrants] = useState<SitePermissionGrant[]>([]),
    [origin, setOrigin] = useState(""),
    [busy, setBusy] = useState(true),
    [failed, setFailed] = useState(false);
  const mounted = useRef(false),
    request = useRef<AbortController | null>(null),
    running = useRef(false);
  const run = async (action: SitePermissionManagementAction) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/chat/site-permissions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
        signal: controller.signal,
      });
      const result = response.ok ? publicSitePermissionResult(await response.json()) : null;
      if (!mounted.current || controller.signal.aborted) return;
      if (!result?.ok) {
        setFailed(true);
        return;
      }
      if (result.kind === "list") setGrants(result.grants);
      else if (result.kind === "grant")
        setGrants((current) =>
          [...current.filter((g) => g.origin !== result.grant.origin), result.grant].sort((a, b) =>
            a.origin.localeCompare(b.origin),
          ),
        );
      else setFailed(true);
    } catch {
      if (mounted.current && request.current === controller) setFailed(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    const selected = canonicalExactSiteOrigin(
      new URL(window.location.href).searchParams.get("origin"),
    );
    if (selected) setOrigin(selected);
    void run({ op: "list" });
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      running.current = false;
    };
  }, []);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const site = canonicalExactSiteOrigin(origin);
    if (!site || busy) return;
    void run({ op: "set", origin: site, scope: "page.read", enabled: false });
  };
  return (
    <section
      className="mb-6 space-y-4 rounded-xl border border-current/15 p-4"
      aria-labelledby="site-permissions-title"
      data-site-permissions
    >
      <h2 id="site-permissions-title" className="font-semibold">
        {t.title}
      </h2>
      <p className="text-sm opacity-75">{t.body}</p>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">
          {t.origin}
          <input
            name="siteOrigin"
            type="url"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="site-origin-hint"
            className="mt-1 w-full rounded-lg border border-current/25 bg-transparent px-3 py-2"
            placeholder="https://example.com"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !canonicalExactSiteOrigin(origin)}
          className="rounded-lg bg-primary px-3 py-2 text-on-primary disabled:opacity-50"
        >
          {t.add}
        </button>
      </form>
      <p id="site-origin-hint" className="text-xs opacity-70">
        {t.originHint}
      </p>
      <div role="status" aria-live="polite">
        {busy ? t.loading : failed ? "⚠ " + t.error : ""}
      </div>
      {failed && (
        <button
          type="button"
          disabled={busy}
          className="rounded-lg border border-current/30 px-3 py-2"
          onClick={() => void run({ op: "list" })}
        >
          {t.retry}
        </button>
      )}
      {!busy && !failed && !grants.length && <p className="text-sm opacity-70">{t.empty}</p>}
      <ul className="divide-y divide-current/10">
        {grants.map((g) => (
          <li key={g.origin} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm font-medium">{g.origin}</p>
              <p className="text-xs opacity-70">{t.pageRead}</p>
            </div>
            <SealSwitch
              checked={g.enabled}
              disabled={busy}
              aria-label={t.pageRead + " — " + g.origin}
              onClick={() =>
                run({ op: "set", origin: g.origin, scope: "page.read", enabled: !g.enabled })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
