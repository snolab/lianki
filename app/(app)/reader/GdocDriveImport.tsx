"use client";

import { useState } from "react";
import { useIntlayer } from "next-intlayer";
import { gdocIdOf, gdocUrlOf } from "@/lib/gdoc/url";
import { startGoogleConnect } from "@/lib/connections/connect-client";

/**
 * A private Google Doc on /read (docs/connections.md): "Choose in Google
 * Drive" fetches a short-lived drive.file token, opens Google's Picker on the
 * pasted doc, and imports the picked one through Drive
 * (POST /api/read/gdoc {via: "drive"}). Not connected yet (or the grant
 * ended): it goes to Google's consent screen first and comes back to
 * /read?gdoc=<id>, where this shows again with the doc filled in.
 */
export function GdocDriveImport(p: {
  url: string;
  /** The `google` word /connections' callback put in the URL, if we just came back. */
  returned: string | null;
  /** The import's own error text for a code (too large, no text, …). */
  errorText: (code: string | undefined) => string;
  onImported: (id: string) => void;
}) {
  const t = useIntlayer("read-gdoc-drive");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ alert: boolean; text: string }>(() =>
    p.returned === "connected"
      ? { alert: false, text: t.connectedPick.value }
      : p.returned === "not-configured"
        ? { alert: true, text: t.notConfigured.value }
        : p.returned
          ? { alert: true, text: t.connectFailed.value }
          : { alert: false, text: t.notShared.value },
  );

  const id = gdocIdOf(p.url);

  async function connect() {
    const r = await startGoogleConnect(id ? `/reader?gdoc=${id}` : "/reader");
    if (r !== "ok")
      setMsg({
        alert: true,
        text: r === "not-configured" ? t.notConfigured.value : t.connectFailed.value,
      });
    return r;
  }

  async function choose() {
    setBusy(true);
    try {
      const r = await fetch("/api/connections/google/picker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.status === 503) return setMsg({ alert: true, text: t.notConfigured.value });
      if (r.status === 409) {
        if ((await connect()) === "ok") return; // leaving for Google
        return;
      }
      if (!r.ok) return setMsg({ alert: true, text: t.connectFailed.value });
      const setup = (await r.json()) as { accessToken: string; apiKey: string; appId: string };
      const { pickGoogleDoc } = await import("@/lib/connections/picker-client");
      let picked: string | null;
      try {
        picked = await pickGoogleDoc(setup, id);
      } catch {
        return setMsg({ alert: true, text: t.connectFailed.value });
      }
      if (!picked) return;
      const res = await fetch("/api/read/gdoc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: gdocUrlOf(picked), via: "drive" }),
      });
      const j = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (res.ok && j?.id) return p.onImported(j.id);
      if (res.status === 409) {
        await connect();
        return;
      }
      setMsg({
        alert: true,
        text:
          j?.error === "not-granted"
            ? t.notGranted.value
            : j?.error === "not-configured"
              ? t.notConfigured.value
              : p.errorText(j?.error),
      });
    } catch {
      setMsg({ alert: true, text: t.connectFailed.value });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="read-gdoc-drive">
      <p
        role={msg.alert ? "alert" : "status"}
        className={
          msg.alert
            ? "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
            : "text-sm text-[oklch(0.45_0.02_260)] dark:text-[oklch(0.78_0.02_260)]"
        }
      >
        {msg.text}
      </p>
      <button
        type="button"
        onClick={choose}
        disabled={busy || !id}
        className="px-4 py-2 rounded-lg text-sm font-medium bg-[oklch(0.55_0.198_22.3)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.198_22.3)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t.chooseInDrive}
      </button>
    </div>
  );
}
