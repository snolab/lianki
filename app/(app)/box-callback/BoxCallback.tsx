"use client";

import { useEffect, useRef, useState } from "react";
import { finishBoxSignIn, type BoxConfig } from "@/lib/box-oauth/client";

/** Trades the one-time code once, removes it from the URL, and goes to the app. */
export default function BoxCallback({ config }: { config: BoxConfig }) {
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const search = new URLSearchParams(location.search);
    history.replaceState(null, "", location.pathname);
    finishBoxSignIn(config, search)
      .then((e) => (e ? setError(e) : location.replace("/home")))
      .catch(() => setError("network"));
  }, [config]);
  if (error) return <code className="m-8 block">{error}</code>;
  return <span className="loading loading-spinner m-8" aria-busy="true" />;
}
