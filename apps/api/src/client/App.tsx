import { useEffect, useState } from "react";

type Health = { ok: boolean; backend?: string; notes?: number | null; error?: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "3rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>Lianki — Cloudflare-native scaffold</h1>
      <p>
        Phase 1: Hono Worker + Vite/React SPA + Workers Static Assets, reading the production D1.
        The worker script stays tiny; this React bundle ships as static assets (not counted against
        the 3&nbsp;MiB worker limit) — which is how this fits the free plan.
      </p>
      <h2>
        <code>/api/health</code>
      </h2>
      <pre style={{ background: "#f4f4f5", padding: "1rem", borderRadius: 8, overflow: "auto" }}>
        {err ? `error: ${err}` : health ? JSON.stringify(health, null, 2) : "loading…"}
      </pre>
    </main>
  );
}
