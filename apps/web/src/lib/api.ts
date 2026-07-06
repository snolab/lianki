// Minimal browser API client for the Lianki Worker API. Same-origin in prod
// (the Worker serves this SPA), proxied to VITE_API_ORIGIN in dev. Session
// cookies flow automatically; a token can be layered on later.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = { error: res.statusText };
    }
    throw Object.assign(new Error(`API ${res.status}`), { status: res.status, detail });
  }
  return (await res.json()) as T;
}
