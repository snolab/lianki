import { useEffect, useState } from "react";

// Identity hook. Uses /api/me, which resolves BOTH a better-auth session cookie
// (Google/GitHub/magic-link) and a device/API token (Bearer) — so a user with
// only a device token still shows as signed in.
export type SessionUser = { id?: string; email: string; name?: string; device?: boolean };

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    import("./api").then(({ api }) =>
      api<{ user?: SessionUser }>("/api/me")
        .then((data) => {
          if (alive) setUser(data?.user ?? null);
        })
        .catch(() => alive && setUser(null))
        .finally(() => alive && setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, []);

  return { user, loading };
}
