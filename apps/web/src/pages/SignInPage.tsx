import { useState } from "react";
import { authClient } from "../lib/auth";

// Sign-in: magic-link (email) + social OAuth. All paths key off the email as the
// unique identity, so signing in with Google/GitHub or a magic link for the same
// address resolves to the same account.
export function SignInPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    const { error } = await authClient.signIn.magicLink({
      email: email.trim(),
      callbackURL: "/",
    });
    setBusy(false);
    setStatus(error ? `Failed: ${error.message}` : "Check your email for a sign-in link.");
  }

  function social(provider: "github" | "google") {
    return () => authClient.signIn.social({ provider, callbackURL: "/" });
  }

  return (
    <section style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
      <form
        onSubmit={magicLink}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Email me a link"}
        </button>
      </form>
      {status ? <p role="status">{status}</p> : null}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <button onClick={social("google")}>Continue with Google</button>
        <button onClick={social("github")}>Continue with GitHub</button>
      </div>
    </section>
  );
}
