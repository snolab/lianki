import { useEffect, useState } from "react";

// Minimal better-auth session hook. Hits the framework-agnostic better-auth
// endpoint the Worker mounts at /api/auth/*. Returns the signed-in user (or null)
// and a loading flag. A fuller port would use better-auth's React client.
export type SessionUser = { id: string; email: string; name?: string };

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/get-session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: SessionUser } | null) => {
        if (alive) setUser(data?.user ?? null);
      })
      .catch(() => alive && setUser(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return { user, loading };
}
