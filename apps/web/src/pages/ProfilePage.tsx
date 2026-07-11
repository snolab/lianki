import { useEffect, useState } from "react";
import { useSession } from "../lib/useSession";
import { authClient } from "../lib/auth";
import { api } from "../lib/api";

// Account overview: signed-in identity (email is the unique key), membership
// tier, and sign-out.
type Membership = { tier?: string; trialEndsAt?: string; active?: boolean };

export function ProfilePage() {
  const { user, loading } = useSession();
  const [membership, setMembership] = useState<Membership | null>(null);

  useEffect(() => {
    if (!user) return;
    api<Membership>("/api/membership/status")
      .then(setMembership)
      .catch(() => setMembership(null));
  }, [user]);

  if (loading) return <p>Loading…</p>;
  if (!user)
    return (
      <section>
        <h1>Profile</h1>
        <p>
          You're not signed in. <a href="/signin">Sign in</a>
        </p>
      </section>
    );

  return (
    <section>
      <h1>Profile</h1>
      <dl style={{ lineHeight: 1.8 }}>
        <dt style={{ color: "#888" }}>Email (your identity)</dt>
        <dd style={{ margin: "0 0 0.5rem" }}>{user.email}</dd>
        <dt style={{ color: "#888" }}>Membership</dt>
        <dd style={{ margin: "0 0 0.5rem" }}>
          {membership?.tier ?? "…"}
          {membership?.trialEndsAt ? ` (trial ends ${membership.trialEndsAt})` : ""}
        </dd>
      </dl>
      <button onClick={() => authClient.signOut().then(() => (window.location.href = "/"))}>
        Sign out
      </button>
    </section>
  );
}
