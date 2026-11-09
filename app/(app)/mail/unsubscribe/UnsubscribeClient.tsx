"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";

type State = "idle" | "busy" | "off" | "on-again" | "invalid" | "error";

const BTN =
  "min-h-11 rounded-full px-5 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const SEAL = `${BTN} bg-[oklch(0.53_0.207_22.3)] text-[oklch(0.99_0.005_85)] hover:bg-[oklch(0.46_0.18_22)]`;
const QUIET = `${BTN} bg-[oklch(0.5_0.02_70/0.15)] hover:bg-[oklch(0.5_0.02_70/0.25)]`;

export function UnsubscribeClient() {
  const c = useIntlayer("mail-unsubscribe");
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    const read = () => {
      const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
      setToken(t);
      setState(t ? "idle" : "invalid");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function act(action: "unsubscribe" | "undo") {
    if (!token) return;
    setState("busy");
    try {
      const res = await fetch("/api/mail/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      if (res.ok) setState(action === "undo" ? "on-again" : "off");
      else setState(res.status === 400 ? "invalid" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-10" data-qa="mail-unsubscribe">
      <h1 className="text-2xl font-semibold">{c.title}</h1>
      {state === "invalid" ? (
        <p role="alert" data-qa="unsub-invalid">
          <span aria-hidden="true">⚠︎ </span>
          {c.invalid}
        </p>
      ) : state === "off" ? (
        <>
          <p role="status" data-qa="unsub-done">
            {c.done}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={QUIET}
              onClick={() => act("undo")}
              data-qa="unsub-undo"
            >
              {c.undo}
            </button>
            <a href="/my/preferences#mail" className={`${QUIET} inline-flex items-center`}>
              {c.preferences}
            </a>
          </div>
        </>
      ) : state === "on-again" ? (
        <p role="status" data-qa="unsub-undone">
          {c.undone}
        </p>
      ) : (
        <>
          <p>{c.body}</p>
          <button
            type="button"
            className={SEAL}
            disabled={state === "busy" || !token}
            onClick={() => act("unsubscribe")}
            data-qa="unsub-confirm"
          >
            {c.confirm}
          </button>
          {state === "error" && (
            <p role="alert">
              <span aria-hidden="true">⚠︎ </span>
              {c.error}
            </p>
          )}
        </>
      )}
    </main>
  );
}
