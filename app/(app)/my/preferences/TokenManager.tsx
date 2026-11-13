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
import { RevokeConfirm } from "./RevokeConfirm";
import { AgentGuide, CopyGuideButton, useAgentGuide, useAgentGuidePointer } from "./AgentGuide";
import { agentGuideWithToken } from "@/lib/agent-guide";
import { INVITE_PREFILL, invitePrefill } from "@lianki/debug-chat/presence";

/**
 * Settings → API tokens (lib/api-tokens.ts, /api/token): like GitHub's
 * fine-grained personal access tokens. Each has a name (shown on every chat
 * line it posts), the permissions picked here, a required expiry, and when it
 * was last used; Revoke asks first (RevokeConfirm), then deletes it at once.
 * The account every token acts as is named at the top. The secret is shown
 * once, right after it is made, and never again. Every token also offers the
 * instructions for the user's own AI assistant (AgentGuide, lib/agent-guide.ts),
 * which contain no secret unless the user explicitly copies the combined
 * instructions-and-token message from the one-time box. Shown to every signed-in user.
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
/** `scopes`: what this account may pick (`eval` only for a site owner, lib/api-token-api.ts). */
type Listing = { account: string; tokens: Token[]; scopes?: { id: ScopeId }[] };

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
  const [secret, setSecret] = useState<{
    token: string;
    name: string;
    scopes: ScopeId[];
    expiresAt: string | null;
  } | null>(null);
  const guide = useAgentGuide();
  const pointer = useAgentGuidePointer();
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  /** The row asking "Revoke …?", the one being revoked, and the one Cancel returned focus to. */
  const [asking, setAsking] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/token", { cache: "no-store" });
    if (r.ok) setList((await r.json()) as Listing);
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  // The chat's Invite (PresenceStack.tsx): the form filled in for a chat-only
  // agent. Nothing is made until the user taps Create.
  useEffect(() => {
    const p = invitePrefill(location.search);
    if (!p) return;
    setName(p.name);
    setScopes([...p.scopes]);
    setExpiry({ days: p.days });
  }, []);

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
        scopes?: ScopeId[];
        expiresAt?: string;
        error?: string;
      };
      if (!r.ok || !j.token) {
        setError(j.error?.startsWith("expiry") ? s("errExpiry") : s("errFailed"));
        return;
      }
      setSecret({
        token: j.token,
        name: j.name ?? name.trim(),
        scopes: j.scopes ?? scopes,
        expiresAt: j.expiresAt ?? null,
      });
      setCopied(false);
      setShared(false);
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
    setRevoking(id);
    const r = await fetch("/api/token", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setRevoking(null);
    if (!r?.ok) return setError(s("errFailed"));
    setAsking(null);
    setList((l) => (l ? { ...l, tokens: l.tokens.filter((x) => x.id !== id) } : l));
  }

  const guideLabels = {
    summary: s("guideSummary"),
    copy: s("guideCopy"),
    copied: s("guideCopied"),
    noToken: s("guideNoToken"),
  };

  const revokeLabels = {
    revoke: s("revoke"),
    question: s("revokeConfirm"),
    cancel: s("revokeCancel"),
  };

  function copy() {
    if (!secret) return;
    navigator.clipboard.writeText(secret.token).then(() => setCopied(true));
  }

  async function copyWithGuide() {
    if (!secret) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(
        agentGuideWithToken({
          scopes: secret.scopes,
          lang: String(locale),
          token: secret.token,
          template: s("shareMessage"),
        }),
      );
      setShared(true);
    } catch {
      setError(s("errCopy"));
    }
  }

  const chatOnly =
    scopes.length === INVITE_PREFILL.scopes.length &&
    INVITE_PREFILL.scopes.every((scope) => scopes.includes(scope));

  const scopeName: Record<ScopeId, string> = {
    study: s("scopeStudy"),
    "chat:read": s("scopeChatRead"),
    "chat:write": s("scopeChatWrite"),
    "chat:ask": s("scopeChatAsk"),
    eval: s("scopeEval"),
  };

  return (
    <section id="api-tokens" className="my-8 space-y-4" data-testid="api-tokens">
      <div>
        <h2 className="text-xl font-semibold mb-2">{s("heading")}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{s("intro")}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{s("aiIntro")}</p>
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              data-testid="token-share-copy"
              onClick={copyWithGuide}
              className="text-sm font-medium bg-primary text-on-primary rounded px-3 py-1.5 hover:opacity-90"
            >
              {shared ? s("copied") : s("shareCopy")}
            </button>
            <button
              type="button"
              onClick={copy}
              className="text-sm font-medium text-primary hover:underline"
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
          <div className="space-y-1 pt-1">
            <CopyGuideButton
              text={pointer(secret)}
              copy={guideLabels.copy}
              copied={guideLabels.copied}
            />
            <p className="text-xs opacity-80">{guideLabels.noToken}</p>
          </div>
        </div>
      )}

      <ul className="divide-y divide-gray-200 dark:divide-gray-700 border-y border-gray-200 dark:border-gray-700">
        {list?.tokens.map((t) => (
          <li
            key={t.id}
            className="py-3 flex flex-wrap items-start justify-between gap-x-3 text-sm"
            data-testid="token-row"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
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
            <RevokeConfirm
              id={t.id}
              name={t.name}
              confirming={asking === t.id}
              busy={revoking === t.id}
              focusRevoke={refocus === t.id}
              labels={revokeLabels}
              onAsk={() => {
                setRefocus(null);
                setAsking(t.id);
              }}
              onConfirm={() => revoke(t.id)}
              onCancel={() => {
                setAsking(null);
                setRefocus(t.id);
              }}
            />
            {!t.expired && (
              <div className="basis-full min-w-0">
                <AgentGuide text={guide(t)} copyText={pointer(t)} labels={guideLabels} />
              </div>
            )}
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
        <button
          type="button"
          data-testid="token-chat-only"
          disabled={busy}
          aria-pressed={chatOnly}
          onClick={() => setScopes([...INVITE_PREFILL.scopes])}
          className={`min-h-10 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${chatOnly ? "bg-primary border-primary text-on-primary" : "border-current/30 text-primary"}`}
        >
          {s("chatOnly")}
        </button>
        <PermissionPicker
          value={scopes}
          onChange={setScopes}
          disabled={busy}
          offered={list?.scopes?.map((x) => x.id)}
        />
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
          className="bg-primary text-on-primary text-sm font-medium py-2 px-4 rounded hover:opacity-90 disabled:opacity-50"
        >
          {busy ? s("creating") : s("create")}
        </button>
      </div>
    </section>
  );
}
