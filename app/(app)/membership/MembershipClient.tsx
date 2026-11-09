"use client";

import { useEffect, useRef, useState } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { PASSES, type PassId } from "@/lib/payments/passes";
import { GITHUB_SPONSORS_URL } from "@/lib/payments/sponsors";
import { InviteCard } from "./InviteCard";
import { WalletCard } from "./WalletCard";
import { longDate } from "@/lib/dates";
import { PlanChop, PlanDefs, PlanMark, PlanStroke, PlanSurface, usePlanSkin } from "./PlanCards";

const yen = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "JPY" }).format(n);

type MembershipTier = "free" | "trial" | "pro";

interface MembershipInfo {
  tier: MembershipTier;
  trialEndsAt?: string;
  proEndsAt?: string;
}

export default function MembershipClient() {
  const router = useRouter();
  const {
    backToHome,
    title,
    newUserBenefit,
    currentStatus,
    features,
    loading: loadingText,
    error: errorText,
  } = useIntlayer("membership-page");
  const [membership, setMembership] = useState<MembershipInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [passesOnSale, setPassesOnSale] = useState(false);
  const [buying, setBuying] = useState<PassId | null>(null);
  const [justPaid, setJustPaid] = useState(false);
  // Bumped when something outside the wallet (a gift code) may have changed it.
  const [walletKey, setWalletKey] = useState(0);
  // Card-testing protection: checkout needs a Turnstile token (checkout-guard.ts).
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // The plan cards' material: marble; ?card=paper|wood previews the others.
  const skin = usePlanSkin();

  useEffect(() => {
    fetchMembership();
    setJustPaid(new URLSearchParams(window.location.search).has("paid"));
    fetch("/api/payments/checkout")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => setPassesOnSale(Boolean(d.enabled)))
      .catch(() => {});
  }, []);

  async function buy(passId: PassId) {
    setBuying(passId);
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passId, turnstileToken }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (res.status === 429) return fail(features.buy.tooMany.value);
      if (res.status === 403 && data.error === "captcha") return fail(features.buy.captcha.value);
      if (!res.ok || !data.url) throw new Error(`checkout ${res.status}`);
      window.location.assign(data.url);
    } catch (e) {
      console.error("Error starting checkout:", e);
      fail(features.buy.failed.value);
    }
  }

  function fail(message: string) {
    setError(message);
    setBuying(null);
    // A Turnstile token is single-use: get a fresh one for the next try.
    turnstileRef.current?.reset();
    setTurnstileToken(null);
  }

  async function fetchMembership() {
    try {
      const res = await fetch("/api/membership/status");
      if (!res.ok) {
        if (res.status === 401) {
          router.push("/sign-in");
          return;
        }
        throw new Error("Failed to fetch membership");
      }
      const data = await res.json();
      setMembership(data);
    } catch (error) {
      console.error("Error fetching membership:", error);
      setError("Failed to load membership information");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">{loadingText.value}</div>
      </div>
    );
  }

  if (!membership) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg text-red-500">{errorText.failedToLoad.value}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <button
            onClick={() => router.push("/list")}
            className="text-blue-500 hover:text-blue-600"
          >
            {backToHome.value}
          </button>
        </div>

        <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-white">{title.value}</h1>

        {/* 90-day trial notice */}
        <div className="mb-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <Icon name="gift" className="text-2xl text-blue-600 dark:text-blue-300" />
            <div>
              <h3 className="font-semibold text-blue-900 dark:text-blue-200 mb-1">
                {newUserBenefit.title.value}
              </h3>
              <p className="text-blue-800 dark:text-blue-300 text-sm">
                {newUserBenefit.description.value}
              </p>
            </div>
          </div>
        </div>

        {justPaid && (
          <div className="mb-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 text-green-800 dark:text-green-200">
            {features.buy.paid.value}
          </div>
        )}

        {error && (
          <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {/* Current Status */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">
            {currentStatus.title.value}
          </h2>
          <div className="flex items-center gap-4 mb-4">
            <div className="text-5xl">
              {membership.tier === "pro" && <Icon name="star" />}
              {membership.tier === "trial" && <Icon name="gift" />}
              {membership.tier === "free" && <Icon name="user" />}
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {membership.tier === "pro" && currentStatus.pro.value}
                {membership.tier === "trial" && currentStatus.trial.value}
                {membership.tier === "free" && currentStatus.free.value}
              </div>
              {membership.tier === "trial" && membership.trialEndsAt && (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {currentStatus.trialExpires.value} {longDate(membership.trialEndsAt)}
                </div>
              )}
              {membership.tier === "pro" && membership.proEndsAt && (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {currentStatus.activeUntil.value} {longDate(membership.proEndsAt)}
                </div>
              )}
            </div>
          </div>

          {membership.tier === "free" && (
            <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              {currentStatus.trialExpired.value}
            </div>
          )}
        </div>

        <WalletCard refreshKey={walletKey} onProChanged={fetchMembership} />

        {/* Features Comparison */}
        <div className="lk-plans" data-skin={skin}>
          <PlanDefs />
          {/* Free Tier */}
          <div className="lk-plan lk-plan--free">
            <PlanSurface />
            <h3 className="lk-plan-title">{currentStatus.free.value}</h3>
            <PlanStroke />
            <ul className="lk-plan-list">
              <li className="flex items-start">
                <PlanMark />
                {features.free.basicSpacedRepetition.value}
              </li>
              <li className="flex items-start">
                <PlanMark />
                {features.free.unlimitedCards.value}
              </li>
              <li className="flex items-start">
                <PlanMark />
                {features.free.videoSpeedControl.value}
              </li>
              <li className="flex items-start">
                <PlanMark no />
                {features.free.noPolyglot.value}
              </li>
            </ul>
          </div>

          {/* Pro Tier */}
          <div className="lk-plan lk-plan--pro">
            <PlanSurface />
            <PlanChop />
            <h3 className="lk-plan-title">{currentStatus.pro.value}</h3>
            <PlanStroke />
            <ul className="lk-plan-list">
              <li className="flex items-start">
                <PlanMark />
                {features.pro.allFreeFeatures.value}
              </li>
              <li className="flex items-start">
                <PlanMark />
                {features.pro.polyglotLearning.value}
              </li>
              <li className="flex items-start">
                <PlanMark />
                {features.pro.aiTranslations.value}
              </li>
              <li className="flex items-start">
                <PlanMark />
                {features.pro.textToSpeech.value}
              </li>
            </ul>
            {passesOnSale ? (
              <div className="mt-6 space-y-2">
                {(["pro-1m", "pro-12m"] as const).map((id) => (
                  <button
                    key={id}
                    onClick={() => buy(id)}
                    disabled={buying !== null || (Boolean(siteKey) && !turnstileToken)}
                    className="lk-plan-btn w-full"
                  >
                    {id === "pro-1m"
                      ? features.buy.oneMonth.value
                      : features.buy.twelveMonths.value}{" "}
                    · {yen(PASSES[id].amount)}
                  </button>
                ))}
                {siteKey && (
                  <div className="flex justify-center">
                    <Turnstile
                      ref={turnstileRef}
                      siteKey={siteKey}
                      onSuccess={setTurnstileToken}
                      onExpire={() => {
                        turnstileRef.current?.reset();
                        setTurnstileToken(null);
                      }}
                      onError={() => setTurnstileToken(null)}
                      options={{ theme: "auto", size: "flexible", appearance: "interaction-only" }}
                    />
                  </div>
                )}
                <p className="text-xs text-center opacity-90">{features.buy.methods.value}</p>
              </div>
            ) : (
              <div className="mt-6 text-center">
                <a href="/contacts" className="lk-plan-btn inline-block">
                  {features.pro.contactUs.value}
                </a>
              </div>
            )}
            <div className="mt-4 text-center">
              <a
                href={GITHUB_SPONSORS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="lk-plan-btn2 inline-flex items-center gap-2"
              >
                <Icon name="star" />
                {features.sponsor.link.value}
              </a>
              <p className="text-xs mt-2 opacity-90">{features.sponsor.note.value}</p>
            </div>
          </div>
        </div>

        <InviteCard
          onProChanged={() => {
            fetchMembership();
            setWalletKey((k) => k + 1);
          }}
        />
      </div>
    </div>
  );
}
