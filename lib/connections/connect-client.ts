"use client";

/**
 * Start connecting Google Drive (docs/connections.md): the server seals state
 * and the PKCE verifier into a cookie and answers Google's consent URL, which
 * we go to. `returnTo` is /connections, /read, or /read?gdoc=<id> (anything
 * else is replaced by /connections on the server).
 */
export async function startGoogleConnect(
  returnTo: string,
): Promise<"ok" | "not-configured" | "failed"> {
  try {
    const r = await fetch("/api/connections/google/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ return: returnTo }),
    });
    if (r.status === 503) return "not-configured";
    const j = (await r.json().catch(() => ({}))) as { url?: string };
    if (!r.ok || !j.url?.startsWith("https://accounts.google.com/")) return "failed";
    window.location.assign(j.url);
    return "ok";
  } catch {
    return "failed";
  }
}
