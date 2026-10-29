"use client";
import { Turnstile } from "@marsidev/react-turnstile";
import { Icon } from "@/app/components/icons";
import type { TurnstileInstance } from "@marsidev/react-turnstile";
import { useEffect, useRef, useState, useTransition } from "react";
import { useIntlayer } from "next-intlayer";
import { authClient } from "@/lib/auth-client";
import { sendSignInCodeAction } from "./actions";
import {
  defaultPasskeyName,
  PASSKEY_SUGGESTION_DISMISSED_KEY,
  passkeyErrorKind,
} from "@/lib/passkey";

type Step = "email" | "password" | "code" | "suggest-passkey";

/** A full load, so every part of the app sees the new session. */
function goToApp() {
  window.location.href = "/home";
}

function suggestionDismissed(): boolean {
  try {
    return localStorage.getItem(PASSKEY_SUGGESTION_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Offer a passkey right after an email sign-in only where one can be made on
 * this device (a platform authenticator: Touch ID, Windows Hello, a phone's
 * screen lock) and the offer was not turned down here before.
 */
async function canSuggestPasskey(): Promise<boolean> {
  if (suggestionDismissed() || typeof PublicKeyCredential === "undefined") return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Sign in = sign up: an unknown email gets an account on first sign-in.
 *
 * Email comes first — Google and GitHub are unreachable from mainland China —
 * and goes straight to emailing a 6-digit code, typed on this same page. A
 * code (unlike a link) still works when the mail is read on another device or
 * inside an app's built-in browser. The password step exists only
 * when the server allows passwords (dev QA); production never asks for one,
 * since it could not work there.
 *
 * Passkeys: a "Sign in with a passkey" button, and — where the browser supports
 * conditional mediation — the same passkeys offered in the email field's
 * autofill. After an email sign-in, a one-time, dismissible offer to add one.
 */
export default function SignInClient({ passwordEnabled }: { passwordEnabled: boolean }) {
  const t = useIntlayer("sign-in-page");
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileState, setTurnstileState] = useState<"loading" | "ready" | "failed">("loading");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  // Set after mount: the server render cannot know whether WebAuthn exists.
  const [passkeySupported, setPasskeySupported] = useState(false);

  // Conditional UI: list this site's passkeys in the email field's autofill.
  // One request on page load (no polling); the browser then waits for the user
  // to pick one. Any failure or cancellation just leaves the form as it was —
  // the explicit button aborts this pending request when it starts its own.
  useEffect(() => {
    if (typeof PublicKeyCredential === "undefined") return;
    setPasskeySupported(true);
    let active = true;
    (async () => {
      const available = await PublicKeyCredential.isConditionalMediationAvailable?.().catch(
        () => false,
      );
      if (!available || !active) return;
      const result = await authClient.signIn.passkey({ autoFill: true });
      if (active && result?.data && !result.error) goToApp();
    })();
    return () => {
      active = false;
    };
  }, []);

  function signInWithPasskey() {
    setError("");
    startTransition(async () => {
      const result = await authClient.signIn.passkey();
      if (result?.data && !result.error) goToApp();
      else if (passkeyErrorKind(result?.error) !== "cancelled") setError(t.passkeyFailed.value);
    });
  }

  /** After an email/password sign-in: offer a passkey once, or go straight in. */
  async function afterEmailSignIn() {
    if (await canSuggestPasskey()) {
      setError("");
      setStep("suggest-passkey");
    } else goToApp();
  }

  function addPasskeyNow() {
    setError("");
    startTransition(async () => {
      const result = await authClient.passkey.addPasskey({
        name: defaultPasskeyName(navigator.userAgent),
      });
      if (result?.data && !result.error) return goToApp();
      const kind = passkeyErrorKind(result?.error);
      // Already has one here: nothing to add, so just carry on.
      if (kind === "duplicate") return goToApp();
      if (kind !== "cancelled") setError(t.passkeyAddFailed.value);
    });
  }

  function dismissPasskeySuggestion() {
    try {
      localStorage.setItem(PASSKEY_SUGGESTION_DISMISSED_KEY, "1");
    } catch {
      // private mode: it will simply be offered again next time
    }
    goToApp();
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
      const result = await authClient.signIn.email({ email, password, callbackURL: "/home" });
      if (result.error) {
        // Try sign-up if sign-in fails with "user not found" type error
        const msg = result.error.message ?? "";
        if (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("not found")) {
          const signUpResult = await authClient.signUp.email({
            email,
            password,
            name: "",
            callbackURL: "/home",
          });
          if (signUpResult.error) {
            setError(signUpResult.error.message || "Authentication failed");
          } else {
            await afterEmailSignIn();
          }
        } else {
          setError(msg || "Sign in failed");
        }
      } else {
        await afterEmailSignIn();
      }
    });
  }

  function sendCode() {
    if (!turnstileToken) return;
    setError("");
    startTransition(async () => {
      const result = await sendSignInCodeAction(email, turnstileToken);
      // A Turnstile token is single-use: get a fresh one for "send a new code".
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      if (result.success) {
        setCode("");
        setStep("code");
      } else setError(result.error === "captcha" ? t.captchaRetry.value : result.error);
    });
  }

  function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await authClient.signIn.emailOtp({ email, otp: code.trim() });
      if (result.error) setError(t.wrongCode.value);
      else await afterEmailSignIn();
    });
  }

  function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (passwordEnabled) setStep("password");
    else sendCode();
  }

  const turnstile = siteKey ? (
    <div className="space-y-1">
      <Turnstile
        ref={turnstileRef}
        siteKey={siteKey}
        onWidgetLoad={() => setTurnstileState("ready")}
        onSuccess={(token) => {
          setTurnstileToken(token);
          setTurnstileState("ready");
        }}
        onExpire={() => {
          turnstileRef.current?.reset();
          setTurnstileToken(null);
        }}
        onError={() => {
          setTurnstileToken(null);
          setTurnstileState("failed");
        }}
        options={{ theme: "auto" }}
      />
      {turnstileState === "loading" && <p className="text-xs text-gray-500">{t.captchaChecking}</p>}
      {turnstileState === "failed" && (
        <button
          type="button"
          className="text-xs text-red-500 hover:underline"
          onClick={() => {
            setTurnstileState("loading");
            turnstileRef.current?.reset();
          }}
        >
          {t.captchaFailed}
        </button>
      )}
    </div>
  ) : null;

  const blockedNote = t.blockedNote.value;

  if (step === "suggest-passkey") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 p-4">
        <PasskeyIcon className="w-10 h-10" />
        <div className="text-center space-y-2 max-w-sm">
          <h1 className="text-xl font-bold">{t.suggestHeading}</h1>
          <p className="text-sm text-gray-500">{t.suggestBody}</p>
        </div>
        <div className="w-full max-w-xs space-y-3">
          {error && (
            <p role="alert" className="text-red-500 text-sm">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={addPasskeyNow}
            disabled={isPending}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
          >
            {isPending ? t.addingPasskey : t.addPasskey}
          </button>
          <button
            type="button"
            onClick={dismissPasskeySuggestion}
            className="w-full px-4 py-2.5 text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          >
            {t.notNow}
          </button>
        </div>
      </div>
    );
  }

  if (step === "code") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 p-4">
        <Icon name="envelopeSimple" className="text-4xl text-gray-500" />
        <div className="text-center space-y-1">
          <p className="text-sm text-gray-500">{t.codeSentTo}</p>
          <p className="font-medium">{email}</p>
        </div>
        <form onSubmit={verifyCode} className="w-full max-w-xs space-y-3">
          <label htmlFor="otp" className="sr-only">
            {t.codeLabel}
          </label>
          <input
            id="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            placeholder={t.codeLabel.value}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-full text-center text-2xl tracking-[0.5em] border border-gray-300 dark:border-gray-600 px-3 py-2.5 rounded-lg dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && (
            <p role="alert" className="text-red-500 text-sm">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={isPending || code.length !== 6}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
          >
            {isPending ? t.verifying : t.verifyCode}
          </button>
        </form>
        <p className="text-sm text-gray-500 text-center max-w-sm">{t.codeCheckSpam}</p>
        <div className="flex gap-4 text-sm">
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setError("");
            }}
            className="text-blue-600 hover:underline"
          >
            {t.resendCode}
          </button>
          <button
            type="button"
            onClick={() => {
              setEmail("");
              setStep("email");
              setError("");
            }}
            className="text-blue-600 hover:underline"
          >
            {t.useDifferentEmail}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 p-4">
      <div className="text-center space-y-2 max-w-sm">
        <h1 className="text-2xl font-bold">{t.heading}</h1>
        <p className="text-sm text-gray-500">{t.subtitle}</p>
      </div>

      <div className="w-full max-w-sm space-y-3">
        {step === "email" ? (
          <>
            {/* Email first: it works everywhere. */}
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <div>
                <label htmlFor="email" className="sr-only">
                  {t.emailPlaceholder}
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  // "webauthn" lets the browser offer passkeys here (conditional UI).
                  autoComplete="username webauthn"
                  placeholder={t.emailPlaceholder.value}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 px-3 py-2.5 rounded-lg dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {!passwordEnabled && turnstile}
              {error && (
                <p role="alert" className="text-red-500 text-sm">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={isPending || (!passwordEnabled && !turnstileToken)}
                className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
              >
                {passwordEnabled ? "Continue" : isPending ? t.sending : t.sendCode}
              </button>
            </form>

            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-gray-700" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-[var(--background)] text-gray-400">{t.otherWays}</span>
              </div>
            </div>

            {passkeySupported && (
              <button
                type="button"
                onClick={signInWithPasskey}
                disabled={isPending}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                <PasskeyIcon className="w-[18px] h-[18px]" />
                <span>{t.signInWithPasskey}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/home" })}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <GoogleIcon />
              <span>{t.signInWithGoogle}</span>
            </button>

            <button
              type="button"
              onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/home" })}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <GitHubIcon />
              <span>{t.signInWithGithub}</span>
            </button>
            {blockedNote && <p className="text-xs text-gray-500 text-center">{blockedNote}</p>}

            <a
              href="/list"
              className="block text-center text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 pt-2"
            >
              {t.continueAsGuest}
            </a>
          </>
        ) : (
          <>
            {/* Password step: dev QA only (passwordEnabled). */}
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
          </>
        )}
      </div>
    </div>
  );
}

function PasskeyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-1a6 6 0 0 1 9.5-4.9" />
      <circle cx="17.5" cy="13.5" r="2.5" />
      <path d="M17.5 16v5l1.5-1.2M17.5 18.5h1.5" />
    </svg>
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
