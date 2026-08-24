"use client";
import { Turnstile } from "@marsidev/react-turnstile";
import type { TurnstileInstance } from "@marsidev/react-turnstile";
import { useRef, useState, useTransition } from "react";
import { useIntlayer } from "next-intlayer";
import { authClient } from "@/lib/auth-client";
import { sendMagicLinkAction } from "./actions";
import { useRouter } from "next/navigation";

type Step = "email" | "password" | "magic-sent";

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
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [showTurnstile, setShowTurnstile] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setStep("password");
    setShowTurnstile(true);
  }

  function handleBack() {
    setStep("email");
    setError("");
    setPassword("");
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await authClient.signIn.email({ email, password, callbackURL: "/list" });
      if (result.error) {
        // Try sign-up if sign-in fails with "user not found" type error
        const msg = result.error.message ?? "";
        if (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("not found")) {
          const signUpResult = await authClient.signUp.email({
            email,
            password,
            name: "",
            callbackURL: "/list",
          });
          if (signUpResult.error) {
            setError(signUpResult.error.message || "Authentication failed");
          } else {
            router.push("/list");
          }
        } else {
          setError(msg || "Sign in failed");
        }
      } else {
        router.push("/list");
      }
    });
  }

  async function handleMagicLink() {
    if (!turnstileToken) return;
    setError("");
    startTransition(async () => {
      const result = await sendMagicLinkAction(email, turnstileToken);
      if (result.success) {
        setStep("magic-sent");
      } else {
        setError(result.error);
        turnstileRef.current?.reset();
        setTurnstileToken(null);
      }
    });
  }

  if (step === "magic-sent") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-4">
        <div className="text-4xl">✉️</div>
        <p className="text-center text-lg">{checkEmail}</p>
        <p className="text-sm text-gray-500">{email}</p>
        <button
          type="button"
          onClick={() => setStep("email")}
          className="text-sm text-blue-600 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 p-4">
      <h1 className="text-2xl font-bold">{heading}</h1>

      <div className="w-full max-w-sm space-y-3">
        {step === "email" ? (
          <>
            {/* Social */}
            <button
              type="button"
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/list" })}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <GoogleIcon />
              <span>{signInWithGoogle}</span>
            </button>

            <button
              type="button"
              onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/list" })}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <GitHubIcon />
              <span>{signInWithGithub}</span>
            </button>

            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-gray-700" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-white dark:bg-gray-900 text-gray-400">
                  or continue with email
                </span>
              </div>
            </div>

            {/* Email step */}
            <form onSubmit={handleEmailContinue} className="space-y-3">
              <div>
                <label htmlFor="email" className="sr-only">
                  {emailPlaceholder}
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder={emailPlaceholder.value}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 px-3 py-2.5 rounded-lg dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Continue
              </button>
            </form>
          </>
        ) : (
          <>
            {/* Password step */}
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <button
                type="button"
                onClick={handleBack}
                className="hover:text-gray-800 dark:hover:text-gray-200"
              >
                ←
              </button>
              <span className="truncate">{email}</span>
            </div>

            <form onSubmit={handlePasswordSignIn} className="space-y-3">
              <div>
                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  autoFocus
                  className="w-full border border-gray-300 dark:border-gray-600 px-3 py-2.5 rounded-lg dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {error && (
                <p role="alert" className="text-red-500 text-sm">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={isPending}
                className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
              >
                {isPending ? "Signing in…" : "Sign in"}
              </button>
            </form>

            {/* Magic link fallback */}
            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-gray-700" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-white dark:bg-gray-900 text-gray-400">no password?</span>
              </div>
            </div>

            {showTurnstile && (
              <Turnstile
                ref={turnstileRef}
                siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!}
                onSuccess={(t) => setTurnstileToken(t)}
                onExpire={() => {
                  turnstileRef.current?.reset();
                  setTurnstileToken(null);
                }}
                onError={() => setTurnstileToken(null)}
                options={{ theme: "auto" }}
              />
            )}

            <button
              type="button"
              disabled={isPending || !turnstileToken}
              onClick={handleMagicLink}
              className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors text-sm"
            >
              {isPending ? sending : sendSignInLink}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.298 24 12c0-6.63-5.37-12-12-12" />
    </svg>
  );
}
