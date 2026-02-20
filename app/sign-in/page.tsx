"use client";
import { Turnstile } from "@marsidev/react-turnstile";
import type { TurnstileInstance } from "@marsidev/react-turnstile";
import { useRef, useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { sendMagicLinkAction } from "./actions";

export default function SignInPage() {
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");
    startTransition(async () => {
      const result = await sendMagicLinkAction(email, token);
      if (result.success) {
        setSent(true);
      } else {
        setError(result.error);
        turnstileRef.current?.reset();
        setToken(null);
      }
    });
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6">
      <h1 className="text-2xl font-bold">Sign in to Lianki</h1>

      <button
        onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/list" })}
        className="px-6 py-2 bg-gray-900 text-white rounded hover:bg-gray-700"
      >
        Sign in with GitHub
      </button>

      <button
        onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/list" })}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        Sign in with Google
      </button>

      {sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <form onSubmit={handleEmail} className="flex flex-col gap-3 items-center">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border px-3 py-2 rounded"
          />
          <Turnstile
            ref={turnstileRef}
            siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!}
            onSuccess={(t) => setToken(t)}
            onExpire={() => {
              turnstileRef.current?.reset();
              setToken(null);
            }}
            onError={() => setToken(null)}
            options={{ theme: "auto" }}
          />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={isPending || !token}
            className="px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            {isPending ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}
