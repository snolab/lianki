import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";

const Preferences = db.collection("preferences");

// FilterType/FilterPattern moved to lib/core/preferences.ts (Next-free) for reuse
// by the D1 repos / CF-native worker; re-exported here so existing imports keep
// working.
import type { FilterType, FilterPattern } from "@/lib/core/preferences";
import { asReviewOrder, DEFAULT_REVIEW_ORDER, type ReviewOrder } from "@lianki/core";
export type { FilterType, FilterPattern };

export interface UserPreferences {
  userId: string;
  reviewOrder?: ReviewOrder;
  mobileExcludeDomains?: string[]; // Legacy, deprecated
  mobileExcludePatterns?: FilterPattern[];
  updatedAt: Date;
}

export async function GET() {
  try {
    const user = await authUserOrNull();
    if (!user) return NextResponse.json({ error: "Login required" }, { status: 401 });

    if (dbBackend() === "d1") {
      const prefs = await new PreferencesD1Repo(getD1(), user.id).get();
      return NextResponse.json({
        mobileExcludePatterns: prefs?.mobileExcludePatterns ?? [],
        reviewOrder: prefs?.reviewOrder ?? DEFAULT_REVIEW_ORDER,
      });
    }

    const prefs = await Preferences.findOne({ userId: user.id });

    // Return default preferences if none exist
    if (!prefs) {
      return NextResponse.json({
        mobileExcludePatterns: [],
        reviewOrder: DEFAULT_REVIEW_ORDER,
      });
    }

    // Migrate legacy mobileExcludeDomains to new format
    let patterns = prefs.mobileExcludePatterns || [];
    if (
      prefs.mobileExcludeDomains &&
      prefs.mobileExcludeDomains.length > 0 &&
      patterns.length === 0
    ) {
      patterns = prefs.mobileExcludeDomains.map((domain: string) => ({
        id: crypto.randomUUID(),
        type: "domain" as FilterType,
        pattern: domain,
        isRegex: false,
        enabled: true,
        createdAt: new Date().toISOString(),
      }));
    }

    return NextResponse.json({
      mobileExcludePatterns: patterns,
      reviewOrder: asReviewOrder(prefs.reviewOrder),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await authUserOrNull();
    if (!user) return NextResponse.json({ error: "Login required" }, { status: 401 });
    const body = await req.json();
    const patterns: FilterPattern[] = body.mobileExcludePatterns || [];
    // Only apply an order when one was sent — the filter-patterns form posts
    // without it, and defaulting here would quietly reset a saved choice.
    const reviewOrder =
      body.reviewOrder === undefined ? undefined : asReviewOrder(body.reviewOrder);

    if (dbBackend() === "d1") {
      await new PreferencesD1Repo(getD1(), user.id).set(patterns, reviewOrder);
      return NextResponse.json({ success: true });
    }

    const preferences: Partial<UserPreferences> = {
      userId: user.id,
      mobileExcludePatterns: patterns,
      ...(reviewOrder !== undefined && { reviewOrder }),
      updatedAt: new Date(),
    };

    // Remove legacy field if present
    await Preferences.updateOne(
      { userId: user.id },
      {
        $set: preferences,
        $unset: { mobileExcludeDomains: "" },
      },
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
