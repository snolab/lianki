"use client";
import { Turnstile } from "@marsidev/react-turnstile";
import type { TurnstileInstance } from "@marsidev/react-turnstile";
import { useRef, useState, useTransition } from "react";
import { useIntlayer } from "next-intlayer";
import { authClient } from "@/lib/auth-client";
import { sendMagicLinkAction } from "./actions";
import { useRouter } from "next/navigation";

export default function SignInClient() {
  const {
    heading,
    signInWithGithub,
    signInWithGoogle,
    checkEmail,
    emailPlaceholder,
    sending,
    sendSignInLink,
  } = useIntlayer("sign-in-page");
  const router = useRouter();
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
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

  async function handlePasswordAuth(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      if (isSignUp) {
        // Sign up with email and password
        const result = await authClient.signUp.email({
          email,
          password,
          name: name || undefined,
          callbackURL: "/list",
        });

        if (result.error) {
          setError(result.error.message || "Sign up failed");
        } else {
          router.push("/list");
        }
      } else {
        // Sign in with email and password
        const result = await authClient.signIn.email({
          email,
          password,
          callbackURL: "/list",
        });

        if (result.error) {
          setError(result.error.message || "Sign in failed");
        } else {
          router.push("/list");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
      <h1 className="text-2xl font-bold">{heading}</h1>

      <div className="w-full max-w-md space-y-6">
        {/* Social Auth */}
        <div className="space-y-3">
          <button
            onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/list" })}
            className="w-full px-6 py-2 bg-gray-900 text-white rounded hover:bg-gray-700"
          >
            {signInWithGithub}
          </button>

          <button
            onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/list" })}
            className="w-full px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            {signInWithGoogle}
          </button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white dark:bg-gray-900 text-gray-500">Or</span>
          </div>
        </div>

        {/* Email/Password Auth */}
        <div className="space-y-4">
          {/* Tab buttons */}
          <div className="flex gap-2 border-b border-gray-300">
            <button
              type="button"
              onClick={() => setIsSignUp(false)}
              className={`px-4 py-2 font-medium ${
                !isSignUp
                  ? "border-b-2 border-blue-600 text-blue-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setIsSignUp(true)}
              className={`px-4 py-2 font-medium ${
                isSignUp
                  ? "border-b-2 border-blue-600 text-blue-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Sign Up
            </button>
          </div>

          {/* Password Form */}
          <form onSubmit={handlePasswordAuth} className="space-y-3">
            {isSignUp && (
              <input
                type="text"
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border px-3 py-2 rounded dark:bg-gray-800 dark:border-gray-600"
              />
            )}
            <input
              type="email"
              required
              placeholder={emailPlaceholder}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border px-3 py-2 rounded dark:bg-gray-800 dark:border-gray-600"
            />
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              className="w-full border px-3 py-2 rounded dark:bg-gray-800 dark:border-gray-600"
            />
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              type="submit"
              className="w-full px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {isSignUp ? "Sign Up" : "Sign In"}
            </button>
          </form>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white dark:bg-gray-900 text-gray-500">Or use magic link</span>
          </div>
        </div>

        {/* Magic Link */}
        {sent ? (
          <p className="text-center">{checkEmail}</p>
        ) : (
          <form onSubmit={handleEmail} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder={emailPlaceholder}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border px-3 py-2 rounded dark:bg-gray-800 dark:border-gray-600"
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
            <button
              type="submit"
              disabled={isPending || !token}
              className="w-full px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
            >
              {isPending ? sending : sendSignInLink}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
