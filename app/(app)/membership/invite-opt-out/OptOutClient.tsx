"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";

type State = "idle" | "busy" | "unsubscribed" | "reported" | "invalid" | "error";

export function OptOutClient() {
  const s = useIntlayer("email-invite");
  const [token, setToken] = useState<string | null>(null);
  const [focusReport, setFocusReport] = useState(false);
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(window.location.hash.slice(1));
      const t = p.get("t");
      setToken(t);
      setFocusReport(p.get("report") === "1");
      setState(t ? "idle" : "invalid");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function act(action: "unsubscribe" | "report") {
    if (!token) return;
    setState("busy");
    try {
      const res = await fetch("/api/invite/email/opt-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      if (res.ok) setState(action === "report" ? "reported" : "unsubscribed");
      else setState(res.status === 400 ? "invalid" : "error");
    } catch {
      setState("error");
    }
  }

  const done = state === "unsubscribed" || state === "reported";
  const btn =
    "min-h-11 rounded-lg px-4 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.55_0.14_250)] disabled:opacity-50";

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-10" data-qa="invite-opt-out">
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">{s.optTitle.value}</h1>
      {done ? (
        <p role="status" data-qa="opt-out-done" className="text-[var(--foreground)]">
          {state === "reported" ? s.optDoneReport.value : s.optDoneUnsub.value}
        </p>
      ) : state === "invalid" ? (
        <p
          role="alert"
          data-qa="opt-out-invalid"
          className="text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]"
        >
          {s.optInvalid.value}
        </p>
      ) : (
        <>
          <p className="text-[var(--foreground)]">{s.optBody.value}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={state === "busy" || !token}
              onClick={() => act("unsubscribe")}
              data-qa="opt-out-unsubscribe"
              className={`${btn} bg-[oklch(0.45_0.18_260)] text-[oklch(1_0_0)] hover:bg-[oklch(0.4_0.18_260)]`}
            >
              {s.optUnsub.value}
            </button>
            <button
              type="button"
              disabled={state === "busy" || !token}
              onClick={() => act("report")}
              autoFocus={focusReport}
              data-qa="opt-out-report"
              className={`${btn} border border-[oklch(0.5_0.19_27)] text-[oklch(0.5_0.19_27)] dark:border-[oklch(0.75_0.15_27)] dark:text-[oklch(0.75_0.15_27)]`}
            >
              {s.optReport.value}
            </button>
          </div>
          <p className="text-sm text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]">
            {s.optReportHint.value}
          </p>
          {state === "error" && (
            <p role="alert" className="text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]">
              {s.optError.value}
            </p>
          )}
        </>
      )}
    </main>
  );
}
