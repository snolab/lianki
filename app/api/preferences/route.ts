import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db";
import { authUser } from "@/app/signInEmail";

const Preferences = db.collection("preferences");

export interface UserPreferences {
  userId: string;
  mobileExcludeDomains: string[];
  updatedAt: Date;
}

export async function GET() {
  try {
    const user = await authUser();
    const prefs = await Preferences.findOne({ userId: user.id });

    // Return default preferences if none exist
    if (!prefs) {
      return NextResponse.json({
        mobileExcludeDomains: [],
      });
    }

    return NextResponse.json({
      mobileExcludeDomains: prefs.mobileExcludeDomains || [],
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
      mobileExcludeDomains: body.mobileExcludeDomains || [],
      updatedAt: new Date(),
    };

    await Preferences.updateOne({ userId: user.id }, { $set: preferences }, { upsert: true });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
