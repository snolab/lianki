import { NextRequest, NextResponse } from "next/server";
import { commitFile } from "@/lib/github-commit";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { slug, locale, content } = await request.json();

    if (!slug || !locale || !content) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Map locale to directory (zh -> cn)
    const dir = locale === "zh" ? "cn" : locale;
    const filePath = `blog/${dir}/${slug}.md`;

    console.log(`[commit-api] Attempting commit: ${filePath}`);

    await commitFile(filePath, content, `auto: translate ${slug} to ${locale}`);

    console.log(`[commit-api] ✓ Success: ${filePath}`);

    return NextResponse.json({ success: true, filePath });
  } catch (error) {
    console.error("[commit-api] ✗ Error:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
