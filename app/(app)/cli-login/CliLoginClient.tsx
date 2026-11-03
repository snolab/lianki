"use client";

import { useState } from "react";

export type CliLoginLabels = {
  title: string;
  intro: string;
  details: string;
  warning: string;
  approve: string;
  deny: string;
  signInFirst: string;
  signIn: string;
  invalid: string;
  failed: string;
};

/** `details` with its {name}/{email}/{address} placeholders filled in bold. */
function Details({ text, fill }: { text: string; fill: Record<string, string> }) {
  const parts = text.split(/(\{name\}|\{email\}|\{address\})/);
  return (
    <p className="text-sm">
      {parts.map((p, i) => {
        const k = /^\{(\w+)\}$/.exec(p)?.[1];
        return k && k in fill ? (
          <strong key={i} className="font-mono break-all">
            {fill[k]}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </p>
  );
}

/**
 * Approve or deny the CLI's request (lib/cli-login.ts). Approve asks the
 * server for the one-time code and goes to the loopback URL it returns; Deny
 * tells the CLI, so it stops waiting. `redirectUri` was checked on the server
 * (only http://127.0.0.1:<port>/cb or http://[::1]:<port>/cb).
 */
export default function CliLoginClient(p: {
  labels: CliLoginLabels;
  requestId: string;
  state: string;
  redirectUri: string;
  name: string;
  email: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function approve() {
    setBusy(true);
    setFailed(false);
    try {
      const r = await fetch("/api/cli-login/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: p.requestId, state: p.state }),
      });
      const j = (await r.json().catch(() => ({}))) as { redirect?: string };
      if (!r.ok || !j.redirect) throw new Error(String(r.status));
      window.location.assign(j.redirect);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  function deny() {
    const u = new URL(p.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("state", p.state);
    window.location.assign(u.toString());
  }

  return (
    <>
      <p className="text-sm">{p.labels.intro}</p>
      <Details
        text={p.labels.details}
        fill={{ name: p.name, email: p.email, address: p.redirectUri }}
      />
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{p.labels.warning}</p>
      {failed && (
        <p role="alert" className="text-red-500 text-sm">
          {p.labels.failed}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={approve}
          disabled={busy}
          className="px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
        >
          {p.labels.approve}
        </button>
        <button
          type="button"
          onClick={deny}
          disabled={busy}
          className="px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
        >
          {p.labels.deny}
        </button>
      </div>
    </>
  );
}
