import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { authUser } from "@/app/signInEmail";

const Preferences = db.collection("preferences");

export type FilterType = "domain" | "title" | "url";

export interface FilterPattern {
  id: string;
  type: FilterType;
  pattern: string;
  isRegex: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface UserPreferences {
  userId: string;
  mobileExcludeDomains?: string[]; // Legacy, deprecated
  mobileExcludePatterns?: FilterPattern[];
  updatedAt: Date;
}

export async function GET() {
  try {
    const user = await authUser();
    const prefs = await Preferences.findOne({ userId: user.id });

    // Return default preferences if none exist
    if (!prefs) {
      return NextResponse.json({
        mobileExcludePatterns: [],
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
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await authUser();
    const body = await req.json();

    const preferences: Partial<UserPreferences> = {
      userId: user.id,
      mobileExcludePatterns: body.mobileExcludePatterns || [],
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
