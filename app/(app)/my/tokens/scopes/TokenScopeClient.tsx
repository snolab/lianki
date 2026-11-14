"use client";

import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { EVAL_MAX_DAYS, MAX_NAME, type ScopeId } from "@/lib/api-tokens";
import { withoutSecrets } from "@/lib/agent-guide";
import { SCOPE_TEXT, textOf } from "@/app/components/TokenPickers";

type RequestView = {
  token: { id: string; name: string; scopes: ScopeId[]; expiresAt: string | null };
  needScope: ScopeId;
  granted: boolean;
  canApprove: boolean;
  error?: "dev-required" | "expiry-too-long";
};

export default function TokenScopeClient({
  id,
  scope,
}: {
  id: string | null;
  scope: ScopeId | null;
}) {
  const strings = useIntlayer("api-tokens") as unknown as Record<string, unknown>;
  return <TokenScopeApproval id={id} scope={scope} strings={strings} />;
}

/** The same explicit approval form, with dictionary nodes supplied by the host. */
export function TokenScopeApproval({
  id,
  scope,
  strings,
}: {
  id: string | null;
  scope: ScopeId | null;
  strings: Record<string, unknown>;
}) {
  const s = (key: string) => textOf(strings[key]);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "sign-in" | "invalid" | "approved" | "rejected"
  >(id && scope ? "loading" : "invalid");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const submitting = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    active.current = true;
    submitting.current = false;
    setRequest(null);
    setBusy(false);
    setFailed(false);
    setStatus(id && scope ? "loading" : "invalid");
    if (!id || !scope) return;
    const valid = () => active.current && generation.current === current;

    const controller = new AbortController();
    void fetch(
      `/api/token/scopes?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}`,
      {
        cache: "no-store",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!valid() || controller.signal.aborted) return;
        if (!response.ok) {
          setStatus(response.status === 401 ? "sign-in" : "invalid");
          return;
        }
        const body = (await response.json()) as RequestView;
        if (!valid() || controller.signal.aborted) return;
        if (
          body.token?.id !== id ||
          body.needScope !== scope ||
          typeof body.token.name !== "string" ||
          !Array.isArray(body.token.scopes) ||
          typeof body.granted !== "boolean" ||
          typeof body.canApprove !== "boolean" ||
          (body.error !== undefined &&
            body.error !== "dev-required" &&
            body.error !== "expiry-too-long")
        ) {
          setStatus("invalid");
          return;
        }
        setRequest(body);
        setStatus(body.granted && body.canApprove ? "approved" : "ready");
      })
      .catch(() => {
        if (valid() && !controller.signal.aborted) setStatus("invalid");
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [id, scope]);

  async function approve() {
    if (
      !id ||
      !scope ||
      status !== "ready" ||
      !request?.canApprove ||
      submitting.current ||
      request.token.id !== id ||
      request.needScope !== scope
    )
      return;
    const current = generation.current;
    const valid = () => active.current && generation.current === current;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/token/scopes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, scope }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        token?: { id?: string; scopes?: ScopeId[] };
      } | null;
      if (!valid()) return;
      if (
        !response.ok ||
        body?.ok !== true ||
        body.token?.id !== id ||
        !Array.isArray(body.token.scopes) ||
        !body.token.scopes.includes(scope)
      ) {
        setFailed(true);
        return;
      }
      setStatus("approved");
    } catch {
      if (valid()) setFailed(true);
    } finally {
      if (valid()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  const displayed = request?.token.id === id && request.needScope === scope ? request : null;
  const tokenName = displayed
    ? [...withoutSecrets(displayed.token.name)].slice(0, MAX_NAME).join("")
    : "";
  const permission = scope ? SCOPE_TEXT[scope] : null;
  const denial =
    displayed?.error === "dev-required"
      ? s("scopeRequestDevRequired")
      : displayed?.error === "expiry-too-long"
        ? s("scopeRequestExpiry").replaceAll("{days}", String(EVAL_MAX_DAYS))
        : s("scopeRequestUnavailable");
  return (
    <main
      className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center gap-5 p-5"
      data-testid="token-scope-request"
    >
      <h1 className="text-xl font-semibold">{s("scopeRequestTitle")}</h1>
      {status === "loading" && <p role="status">{s("scopeRequestLoading")}</p>}
      {status === "sign-in" && (
        <>
          <p>{s("scopeRequestSignInFirst")}</p>
          <a
            href="/sign-in"
            target="_blank"
            rel="noopener noreferrer"
            className="self-start rounded bg-primary px-4 py-2 text-on-primary"
          >
            {s("scopeRequestSignIn")}
          </a>
        </>
      )}
      {status === "invalid" && <p role="alert">{s("scopeRequestUnavailable")}</p>}
      {displayed && permission && (
        <section
          className="space-y-3 rounded-lg border border-current/20 p-4"
          aria-label={s("permissions")}
        >
          <p className="break-words">
            <strong data-testid="scope-request-token" className="break-all">
              {tokenName}
            </strong>
          </p>
          <p>{s("scopeRequestIntro")}</p>
          <div>
            <strong>{s(permission.label)}</strong>{" "}
            <code className="break-all text-sm opacity-70">{scope}</code>
            <p className="mt-1 text-sm opacity-80">{s(permission.hint)}</p>
          </div>
          <p className="text-sm opacity-70">{s("scopeRequestBounded")}</p>
        </section>
      )}
      {status === "ready" && (
        <>
          {!displayed?.canApprove && <p role="alert">{denial}</p>}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="scope-request-approve"
              disabled={busy || !displayed?.canApprove}
              aria-busy={busy}
              onClick={() => void approve()}
              className="min-h-11 rounded bg-primary px-4 py-2 text-on-primary disabled:opacity-50"
            >
              {s("scopeRequestApprove")}
            </button>
            <button
              type="button"
              data-testid="scope-request-reject"
              disabled={busy}
              onClick={() => {
                setFailed(false);
                setStatus("rejected");
              }}
              className="min-h-11 rounded border border-current/30 px-4 py-2 disabled:opacity-50"
            >
              {s("scopeRequestReject")}
            </button>
          </div>
        </>
      )}
      {failed && <p role="alert">{s("scopeRequestFailed")}</p>}
      {status === "approved" && (
        <p role="status" data-testid="scope-request-approved">
          {s("scopeRequestApproved")}
        </p>
      )}
      {status === "rejected" && <p role="status">{s("scopeRequestRejected")}</p>}
      <a href="/my/preferences#tokens" className="self-start text-sm text-primary underline">
        {s("scopeRequestBack")}
      </a>
    </main>
  );
}
