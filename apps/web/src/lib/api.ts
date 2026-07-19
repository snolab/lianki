// Minimal browser API client for the Lianki Worker API. Same-origin in prod
// (the Worker serves this SPA), proxied to VITE_API_ORIGIN in dev. Session
// cookies flow automatically; if a device/API token is stored it's sent as a
// Bearer header too (so a Google/email account is optional).
const TOKEN_KEY = "lk:token";

export const getToken = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem(TOKEN_KEY)) || "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Mint an anonymous device token (no sign-in) and store it — makes an account optional. */
export async function ensureDeviceToken(): Promise<string> {
  const existing = getToken();
  if (existing) return existing;
  const { token } = await api<{ token: string; email: string }>("/api/token/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Device" }),
  });
  setToken(token);
  return token;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { credentials: "include", ...init, headers });
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
