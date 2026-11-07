"use client";
import { useCallback, useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { longDate, longDateTime } from "@/lib/dates";
import { MAX_NAME, type ScopeId } from "@/lib/api-tokens";
import {
  ExpiryPicker,
  PermissionPicker,
  expiryBody,
  textOf,
  type Expiry,
} from "@/app/components/TokenPickers";

/**
 * Settings → API tokens (lib/api-tokens.ts, /api/token): like GitHub's
 * fine-grained personal access tokens. Each has a name (an agent lane's name,
 * on every chat line it posts), the permissions picked here, a required
 * expiry, and when it was last used; Revoke deletes it at once. The account
 * every token acts as is named at the top. The secret is shown once, right
 * after it is made, and never again.
 */
type Token = {
  id: string;
  name: string;
  email: string;
  scopes: ScopeId[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
};
type Listing = { account: string; tokens: Token[] };

export default function TokenManager() {
  const c = useIntlayer("api-tokens") as unknown as Record<string, unknown>;
  const s = (k: string) => textOf(c[k]);
  const { locale } = useLocale();
  const [list, setList] = useState<Listing | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ScopeId[]>([]);
  const [expiry, setExpiry] = useState<Expiry>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/token", { cache: "no-store" });
    if (r.ok) setList((await r.json()) as Listing);
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function create() {
    const exp = expiryBody(expiry);
    if (!name.trim() || [...name.trim()].length > MAX_NAME) return setError(s("errName"));
    if (scopes.length === 0) return setError(s("errScopes"));
    if (!exp) return setError(s("errExpiry"));
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes, expiry: exp }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        token?: string;
        name?: string;
        error?: string;
      };
      if (!r.ok || !j.token) {
        setError(j.error?.startsWith("expiry") ? s("errExpiry") : s("errFailed"));
        return;
      }
      setSecret({ token: j.token, name: j.name ?? name.trim() });
      setCopied(false);
      setName("");
      setScopes([]);
      setExpiry(null);
      await load();
    } catch {
      setError(s("errFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    const r = await fetch("/api/token", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    if (!r?.ok) return setError(s("errFailed"));
    setList((l) => (l ? { ...l, tokens: l.tokens.filter((x) => x.id !== id) } : l));
  }

  function copy() {
    if (!secret) return;
    navigator.clipboard.writeText(secret.token).then(() => setCopied(true));
  }

  const scopeName: Record<ScopeId, string> = {
    study: s("scopeStudy"),
    "chat:read": s("scopeChatRead"),
    "chat:write": s("scopeChatWrite"),
    "chat:ask": s("scopeChatAsk"),
  };

  return (
    <section className="my-8 space-y-4" data-testid="api-tokens">
      <div>
        <h2 className="text-xl font-semibold mb-2">{s("heading")}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{s("intro")}</p>
        {list && (
          <p className="text-sm mt-2">
            {s("account")
              .split("{email}")
              .flatMap((part, i) =>
                i
                  ? [
                      <strong key={i} className="break-all">
                        {list.account}
                      </strong>,
                      part,
                    ]
                  : [part],
              )}
          </p>
        )}
      </div>

      {secret && (
        <div
          role="status"
          className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-md space-y-2"
        >
          <p className="text-sm font-medium">
            {secret.name}: {s("copyOnce")}
          </p>
          <code
            data-testid="new-token"
            className="block break-all text-xs bg-white dark:bg-gray-900 p-2 rounded select-all font-mono"
          >
            {secret.token}
          </code>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={copy}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              {copied ? s("copied") : s("copy")}
            </button>
            <button
              type="button"
              onClick={() => setSecret(null)}
              className="text-sm hover:underline"
            >
              {s("done")}
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-gray-200 dark:divide-gray-700 border-y border-gray-200 dark:border-gray-700">
        {list?.tokens.map((t) => (
          <li
            key={t.id}
            className="py-3 flex items-start justify-between gap-3 text-sm"
            data-testid="token-row"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="font-medium break-words">{t.name}</div>
              <div className="text-xs opacity-80">
                {t.scopes.map((x) => scopeName[x]).join(" · ")}
              </div>
              <div className="text-xs opacity-60">
                {s("createdOn").replace("{date}", longDate(t.createdAt, locale))}
                {" · "}
                {t.expiresAt === null ? (
                  s("noExpiry")
                ) : t.expired ? (
                  <span className="text-red-600 dark:text-red-400">
                    {s("expiredOn").replace("{date}", longDate(t.expiresAt, locale))}
                  </span>
                ) : (
                  s("expiresOn").replace("{date}", longDate(t.expiresAt, locale))
                )}
                {" · "}
                {t.lastUsedAt
                  ? s("lastUsed").replace("{date}", longDateTime(t.lastUsedAt, locale))
                  : s("neverUsed")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => revoke(t.id)}
              className="shrink-0 px-3 py-1.5 rounded border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 text-xs"
            >
              {s("revoke")}
            </button>
          </li>
        ))}
        {list && list.tokens.length === 0 && (
          <li className="py-3 text-sm opacity-60">{s("none")}</li>
        )}
      </ul>

      <div className="space-y-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <label className="block text-sm">
          <span className="font-medium">{s("nameLabel")}</span>
          <input
            type="text"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            data-testid="token-name"
            className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900"
          />
          <span className="block text-xs opacity-70 mt-1">{s("nameHint")}</span>
        </label>
        <PermissionPicker value={scopes} onChange={setScopes} disabled={busy} />
        <ExpiryPicker value={expiry} onChange={setExpiry} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={create}
          disabled={busy}
          data-testid="token-create"
          className="bg-blue-600 text-white text-sm py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? s("creating") : s("create")}
        </button>
      </div>
    </section>
  );
}
