"use client";
import { useCallback, useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { longDate, longDateTime } from "@/lib/dates";
import type { ScopeId } from "@/lib/api-tokens";
import { textOf } from "@/app/components/TokenPickers";
import { SCOPE_TEXT } from "@/app/components/token-scope-text";
import { RevokeConfirm } from "./RevokeConfirm";

/**
 * Settings → API tokens → Connected apps (docs/mcp-oauth.md): the apps, such as
 * ChatGPT, that the account connected by OAuth sign-in. Disconnect asks first
 * (RevokeConfirm), then ends the app's access at once. Hidden while the flag
 * mcp.oauth is off and nothing is connected; with it off, apps already
 * connected are still listed so they can be disconnected.
 */
type App = {
  id: string;
  name: string;
  host: string;
  scopes: ScopeId[];
  connectedAt: string;
  lastUsedAt: string | null;
};

export default function ConnectedApps() {
  const c = useIntlayer("connected-apps") as unknown as Record<string, unknown>;
  const tok = useIntlayer("api-tokens") as unknown as Record<string, unknown>;
  const s = (k: string) => textOf(c[k]);
  const { locale } = useLocale();
  const [list, setList] = useState<{ enabled: boolean; apps: App[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/my/connected-apps", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setList(await r.json());
    } catch (e) {
      console.warn("[connected-apps] load failed", e);
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function disconnect(id: string) {
    setBusy(id);
    setFailed(false);
    try {
      const r = await fetch("/api/my/connected-apps", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok && r.status !== 404) throw new Error(`status ${r.status}`);
      setAsking(null);
      await load();
    } catch (e) {
      console.warn("[connected-apps] disconnect failed", e);
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  if (!list && !failed) return null;
  if (list && !list.enabled && list.apps.length === 0) return null;
  return (
    <div className="space-y-2 pt-4" data-testid="connected-apps">
      <h3 className="text-lg font-semibold">{s("appsHeading")}</h3>
      <p className="text-sm opacity-70">{s("appsHint")}</p>
      {failed && (
        <p role="alert" className="text-sm">
          {s("appsFailed")}
        </p>
      )}
      <ul className="divide-y divide-current/15 border-y border-current/15">
        {list?.apps.map((a) => (
          <li
            key={a.id}
            className="py-3 flex flex-wrap items-start justify-between gap-x-3 text-sm"
            data-testid="connected-app-row"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium break-words">{a.name}</div>
              <div className="text-xs opacity-80">{s("appsSite").replace("{host}", a.host)}</div>
              <div className="text-xs opacity-80">
                {a.scopes.map((x) => textOf(tok[SCOPE_TEXT[x].label])).join(" · ")}
              </div>
              <div className="text-xs opacity-60">
                {s("appsConnectedOn").replace("{date}", longDate(a.connectedAt, locale))}
                {" · "}
                {a.lastUsedAt
                  ? s("appsLastUsed").replace("{date}", longDateTime(a.lastUsedAt, locale))
                  : s("appsNeverUsed")}
              </div>
            </div>
            <RevokeConfirm
              id={a.id}
              name={a.name}
              confirming={asking === a.id}
              busy={busy === a.id}
              focusRevoke={refocus === a.id}
              labels={{
                revoke: s("appsDisconnect"),
                question: s("appsDisconnectConfirm"),
                cancel: s("appsKeep"),
              }}
              onAsk={() => {
                setRefocus(null);
                setAsking(a.id);
              }}
              onConfirm={() => void disconnect(a.id)}
              onCancel={() => {
                setAsking(null);
                setRefocus(a.id);
              }}
            />
          </li>
        ))}
        {list && list.apps.length === 0 && (
          <li className="py-3 text-sm opacity-60">{s("appsNone")}</li>
        )}
      </ul>
    </div>
  );
}
