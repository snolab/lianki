"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { startGoogleConnect } from "@/lib/connections/connect-client";
import {
  autoPickOnReturn,
  pickAndImport,
  withoutPickParams,
  type Imported,
  type PickPage,
} from "@/lib/connections/drive-pick";

/**
 * "Choose docs from Google Drive" (docs/connections.md, "Picking docs"), on
 * /connections and /read: opens Google's Picker straight away, several docs
 * at once, each imported as the user's own book. One imported: it opens.
 * Several: `onImported` (the page shows its list). Not connected: Google's
 * consent first, and back here the Picker opens by itself.
 */
export function DrivePick(p: {
  page: PickPage;
  onImported?: (books: Imported[]) => void;
  /** A smaller, dashed button that sits with /read's other import buttons. */
  compact?: boolean;
}) {
  const t = useIntlayer("drive-pick");
  const d = useIntlayer("read-gdoc-drive");
  const g = useIntlayer("read-gdoc");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ alert: boolean; text: string } | null>(null);
  const started = useRef(false);

  const errText = (code: string | undefined): string =>
    ({
      "not-configured": d.notConfigured.value,
      "rate-limited": t.rateLimited.value,
      "not-granted": d.notGranted.value,
      "too-large": g.errTooLarge.value,
      "too-much-text": g.errTooLarge.value,
      "no-text": g.errNoText.value,
      "not-found": g.errNotFound.value,
    })[code ?? ""] ?? d.connectFailed.value;

  async function run(first: string) {
    setBusy(true);
    setMsg({ alert: false, text: first });
    try {
      const { pickGoogleDocs } = await import("@/lib/connections/picker-client");
      const out = await pickAndImport(p.page, {
        fetch: (u, i) => fetch(u, i),
        pick: (setup) => pickGoogleDocs(setup, { multi: true }),
        connect: startGoogleConnect,
        onProgress: (n, total) =>
          setMsg({
            alert: false,
            text: t.importing.value.replace("{n}", String(n)).replace("{total}", String(total)),
          }),
      });
      if (out.kind === "leaving") return; // to Google; keep the button busy
      setBusy(false);
      if (out.kind === "cancelled") return setMsg(null);
      if (out.kind === "error") return setMsg({ alert: true, text: errText(out.code) });
      const { imported, failed } = out;
      if (imported.length === 1 && !failed.length) return router.push(`/read/${imported[0].id}`);
      if (imported.length) p.onImported?.(imported);
      const parts = [
        imported.length ? t.imported.value.replace("{n}", String(imported.length)) : "",
        failed.length === 1 && !imported.length
          ? errText(failed[0])
          : failed.length
            ? t.someFailed.value.replace("{n}", String(failed.length))
            : "",
      ].filter(Boolean);
      setMsg({ alert: failed.length > 0, text: parts.join(" ") });
    } catch {
      setBusy(false);
      setMsg({ alert: true, text: d.connectFailed.value });
    }
  }

  // Back from Google's consent screen, started by this button: open the
  // Picker without another tap, then drop the words from the URL.
  useEffect(() => {
    if (started.current) return;
    const s = window.location.search;
    if (!new URLSearchParams(s).has("pick")) return;
    started.current = true;
    const open = autoPickOnReturn(s);
    window.history.replaceState(null, "", window.location.pathname + withoutPickParams(s));
    // /connections shows its own result line; /read has none but this.
    const back = p.page === "/read" ? new URLSearchParams(s).get("google") : null;
    if (open) void run(t.connectedOpening.value);
    else if (back === "not-configured") setMsg({ alert: true, text: d.notConfigured.value });
    else if (back && back !== "denied") setMsg({ alert: true, text: d.connectFailed.value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const button = p.compact
    ? "w-full py-4 px-2 border-2 border-dashed border-[oklch(0.62_0.15_255)] dark:border-[oklch(0.68_0.13_255)] rounded-lg text-[oklch(0.5_0.17_255)] dark:text-[oklch(0.78_0.11_255)] hover:bg-[oklch(0.96_0.02_255)] dark:hover:bg-[oklch(0.3_0.04_255)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    : "w-full sm:w-auto px-4 py-2.5 rounded-lg text-sm font-medium bg-[oklch(0.55_0.18_255)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.18_255)] disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div
      className={p.compact ? "flex-1 flex flex-col gap-2" : "space-y-2"}
      data-testid={`drive-pick-${p.page.slice(1)}`}
    >
      <button
        type="button"
        data-testid="drive-pick"
        className={button}
        disabled={busy}
        onClick={() => void run(t.opening.value)}
      >
        {p.compact ? <>+ {t.pick}</> : t.pick}
      </button>
      {msg && (
        <p
          role={msg.alert ? "alert" : "status"}
          data-testid="drive-pick-msg"
          className={
            msg.alert
              ? "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
              : "text-sm text-[oklch(0.45_0.02_260)] dark:text-[oklch(0.78_0.02_260)]"
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** The three steps under the button: what to tap, what to tick, where it lands. */
export function DrivePickHowTo() {
  const t = useIntlayer("drive-pick");
  return (
    <div
      data-testid="drive-pick-howto"
      className="text-xs text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]"
    >
      <p className="font-medium mb-1">{t.howTitle}</p>
      <ol className="space-y-0.5">
        {[t.step1, t.step2, t.step3].map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden="true">{"①②③"[i]}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
