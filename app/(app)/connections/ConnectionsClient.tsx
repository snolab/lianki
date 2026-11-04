"use client";

import { useEffect, useState } from "react";
import { DRIVE_FILE_SCOPE } from "@/lib/connections/scopes";
import { startGoogleConnect } from "@/lib/connections/connect-client";

export type ConnectionsLabels = {
  title: string;
  intro: string;
  googleName: string;
  googleWhat: string;
  connectedAs: string;
  connected: string;
  notConnected: string;
  needsReconnect: string;
  granted: string;
  scopeDriveFile: string;
  scopeEmail: string;
  connect: string;
  reconnect: string;
  disconnect: string;
  confirmDisconnect: string;
  notConfigured: string;
  resultConnected: string;
  resultDenied: string;
  failed: string;
  signIn: string;
};

type Conn = { email: string | null; scopes: string[]; status: "ok" | "reconnect" };

const btn =
  "px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const primary = `${btn} bg-[oklch(0.55_0.18_255)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.18_255)]`;
const quiet = `${btn} border border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)] hover:bg-[oklch(0.96_0.005_260)] dark:hover:bg-[oklch(0.3_0.02_260)]`;
const bad = "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]";

export default function ConnectionsClient(p: {
  labels: ConnectionsLabels;
  configured: boolean;
  initial: Conn | null;
  result: string | null;
}) {
  const L = p.labels;
  const [conn, setConn] = useState<Conn | null>(p.initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(() =>
    p.result === "connected"
      ? { ok: true, text: L.resultConnected }
      : p.result === "denied"
        ? { ok: false, text: L.resultDenied }
        : p.result === "not-configured"
          ? { ok: false, text: L.notConfigured }
          : p.result
            ? { ok: false, text: L.failed }
            : null,
  );

  // The result word came in the URL; drop it so a reload does not repeat it.
  useEffect(() => {
    if (p.result) window.history.replaceState(null, "", "/connections");
  }, [p.result]);

  async function connect() {
    setBusy(true);
    setMsg(null);
    const r = await startGoogleConnect("/connections");
    if (r !== "ok") {
      setMsg({ ok: false, text: r === "not-configured" ? L.notConfigured : L.failed });
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(L.confirmDisconnect)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/connections/google/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error(String(r.status));
      setConn(null);
    } catch {
      setMsg({ ok: false, text: L.failed });
    } finally {
      setBusy(false);
    }
  }

  const hasDrive = !!conn?.scopes.includes(DRIVE_FILE_SCOPE);
  const scopes = (conn?.scopes ?? [])
    .map((s) =>
      s === DRIVE_FILE_SCOPE ? L.scopeDriveFile : s.endsWith("email") ? L.scopeEmail : null,
    )
    .filter((s): s is string => !!s);
  const status = !conn
    ? L.notConnected
    : conn.status !== "ok" || !hasDrive
      ? L.needsReconnect
      : conn.email
        ? L.connectedAs.replace("{email}", conn.email)
        : L.connected;

  return (
    <>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm mb-4" : `${bad} mb-4`}>
          {msg.text}
        </p>
      )}
      <section
        aria-labelledby="conn-google"
        data-testid="connection-google"
        className="rounded-lg border border-[oklch(0.9_0.01_260)] dark:border-[oklch(0.35_0.02_260)] p-4 space-y-3"
      >
        <h2 id="conn-google" className="text-lg font-semibold">
          {L.googleName}
        </h2>
        <p className="text-sm text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]">
          {L.googleWhat}
        </p>
        <p className="text-sm font-medium" data-testid="connection-google-status">
          {status}
        </p>
        {conn && scopes.length > 0 && (
          <p className="text-xs text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]">
            {L.granted} {scopes.join(", ")}
          </p>
        )}
        {!p.configured ? (
          <p className={bad}>{L.notConfigured}</p>
        ) : (
          <div className="flex gap-2">
            {(!conn || conn.status !== "ok" || !hasDrive) && (
              <button className={primary} disabled={busy} onClick={connect}>
                {conn ? L.reconnect : L.connect}
              </button>
            )}
            {conn && (
              <button className={quiet} disabled={busy} onClick={disconnect}>
                {L.disconnect}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
