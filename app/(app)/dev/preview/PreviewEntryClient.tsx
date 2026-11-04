"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { switchToDevServer } from "@/lib/dev-server-switch";

/** Runs the profile menu's switch once (handoff in a form body, never a URL) and lands on `to`. */
export default function PreviewEntryClient({ to }: { to: string }) {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const go = useCallback(() => {
    setFailed(false);
    switchToDevServer({ pathname: to, search: "" })
      .then((ok) => !ok && setFailed(true))
      .catch(() => setFailed(true));
  }, [to]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    go();
  }, [go]);
  return (
    <>
      <h1 className="text-xl font-semibold">{failed ? "没能进入预览版" : "正在进入预览版…"}</h1>
      <p className="text-sm opacity-60 break-all">{to}</p>
      {failed && (
        <button
          type="button"
          onClick={go}
          className="rounded-full px-5 py-2 bg-[oklch(0.55_0.18_255)] text-[oklch(0.99_0_0)] font-semibold"
        >
          再试一次
        </button>
      )}
    </>
  );
}
