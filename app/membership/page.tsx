"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type MembershipTier = "free" | "trial" | "pro";

interface MembershipInfo {
  tier: MembershipTier;
  trialEndsAt?: string;
  proEndsAt?: string;
}

export default function MembershipPage() {
  const router = useRouter();
  const [membership, setMembership] = useState<MembershipInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchMembership();
  }, []);

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
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  if (!membership) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg text-red-500">Failed to load membership information</div>
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
            ← Back to Home
          </button>
        </div>

        <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-white">Membership</h1>

        {/* 90-day trial notice */}
        <div className="mb-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🎁</span>
            <div>
              <h3 className="font-semibold text-blue-900 dark:text-blue-200 mb-1">
                New User Benefit
              </h3>
              <p className="text-blue-800 dark:text-blue-300 text-sm">
                Every new user gets <strong>90 days of Pro access</strong> automatically! Enjoy all
                premium features including Polyglot language learning.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {/* Current Status */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 mb-8">
          <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">
            Current Status
          </h2>
          <div className="flex items-center gap-4 mb-4">
            <div className="text-5xl">
              {membership.tier === "pro" && "⭐"}
              {membership.tier === "trial" && "🎁"}
              {membership.tier === "free" && "👤"}
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white capitalize">
                {membership.tier}
              </div>
              {membership.tier === "trial" && membership.trialEndsAt && (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Trial expires on {new Date(membership.trialEndsAt).toLocaleDateString()}
                </div>
              )}
              {membership.tier === "pro" && membership.proEndsAt && (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  Active until {new Date(membership.proEndsAt).toLocaleDateString()}
                </div>
              )}
            </div>
          </div>

          {membership.tier === "free" && (
            <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              Your 90-day trial has expired. Upgrade to Pro to continue using premium features.
            </div>
          )}
        </div>

        {/* Features Comparison */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Free Tier */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border-2 border-gray-200 dark:border-gray-700">
            <h3 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">Free</h3>
            <ul className="space-y-3 text-gray-700 dark:text-gray-300">
              <li className="flex items-start">
                <span className="text-green-500 mr-2">✓</span>
                Basic spaced repetition
              </li>
              <li className="flex items-start">
                <span className="text-green-500 mr-2">✓</span>
                Unlimited cards
              </li>
              <li className="flex items-start">
                <span className="text-green-500 mr-2">✓</span>
                Video speed control
              </li>
              <li className="flex items-start">
                <span className="text-red-500 mr-2">✗</span>
                Polyglot feature
              </li>
            </ul>
          </div>

          {/* Pro Tier */}
          <div className="bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg shadow-lg p-6 border-2 border-blue-400 text-white">
            <h3 className="text-xl font-bold mb-4">Pro</h3>
            <ul className="space-y-3">
              <li className="flex items-start">
                <span className="mr-2">✓</span>
                All Free features
              </li>
              <li className="flex items-start">
                <span className="mr-2">✓</span>
                Polyglot language learning
              </li>
              <li className="flex items-start">
                <span className="mr-2">✓</span>
                AI-powered translations
              </li>
              <li className="flex items-start">
                <span className="mr-2">✓</span>
                Text-to-speech support
              </li>
            </ul>
            <div className="mt-6 text-center">
              <div className="text-sm opacity-75">Contact us for Pro access</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
