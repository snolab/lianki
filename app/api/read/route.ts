import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import {
  saveReadMaterial,
  listReadMaterials,
} from "@/app/[locale]/read/getReadMaterialsCollection";

// GET /api/read - List materials
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "10", 10);

  const { materials, total } = await listReadMaterials(session.user.id, page, pageSize);

  return NextResponse.json({
    materials: materials.map((m) => ({
      id: m._id.toString(),
      title: m.title,
      lines: m.lines,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

// POST /api/read - Create new material
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { title, content } = body;

  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const lines = content
    .split(/\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);

  const materialTitle = title || `Import ${new Date().toLocaleDateString()}`;

  const material = await saveReadMaterial(session.user.id, materialTitle, content, lines);

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    lines: material.lines,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  });
}
