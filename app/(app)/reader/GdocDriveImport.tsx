"use client";

import { useState } from "react";
import { useIntlayer } from "next-intlayer";
import { gdocIdOf, gdocUrlOf } from "@/lib/gdoc/url";
import { startGoogleConnect } from "@/lib/connections/connect-client";
import { pickWithRetry } from "@/lib/connections/picker-setup";

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
      const { pickGoogleDoc } = await import("@/lib/connections/picker-client");
      // A fresh token request per try; the Picker is tried once more if the
      // first one failed (pickWithRetry: a bad setup or a Picker error).
      let got: { ids: string[] } | { other: "off" | "connect" | "failed" };
      try {
        got = await pickWithRetry<"off" | "connect" | "failed">(
          async () => {
            const r = await fetch("/api/connections/google/picker", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }).catch(() => null);
            if (!r) return { setup: null };
            if (r.status === 503) return { other: "off" as const };
            if (r.status === 409) return { other: "connect" as const };
            if (!r.ok) return { other: "failed" as const };
            return { setup: await r.json().catch(() => null) };
          },
          async (setup) => {
            const one = await pickGoogleDoc(setup, id);
            return one ? [one] : [];
          },
        );
      } catch {
        return setMsg({ alert: true, text: t.connectFailed.value });
      }
      if ("other" in got) {
        if (got.other === "off") return setMsg({ alert: true, text: t.notConfigured.value });
        if (got.other === "connect") return void (await connect()); // leaving for Google, or says why not
        return setMsg({ alert: true, text: t.connectFailed.value });
      }
      const picked = got.ids[0];
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
        className="lk-btn lk-btn-secondary"
      >
        {t.chooseInDrive}
      </button>
    </div>
  );
}
