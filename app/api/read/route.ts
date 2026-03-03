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

  const DEFAULT_PAGE = 1;
  const DEFAULT_PAGE_SIZE = 10;
  const MAX_PAGE_SIZE = 100;

  const rawPage = searchParams.get("page");
  let page = parseInt(rawPage ?? "", 10);
  if (!Number.isFinite(page) || page < 1) {
    page = DEFAULT_PAGE;
  }

  const rawPageSize = searchParams.get("pageSize");
  let pageSize = parseInt(rawPageSize ?? "", 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) {
    pageSize = DEFAULT_PAGE_SIZE;
  } else if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { title, content } = body as { title?: unknown; content?: unknown };

  if (typeof content !== "string" || content.length === 0) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  if (typeof title !== "undefined" && typeof title !== "string") {
    return NextResponse.json({ error: "Title must be a string" }, { status: 400 });
  }

  const lines = content
    .split(/\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);

  const materialTitle =
    typeof title === "string" && title.length > 0
      ? title
      : `Import ${new Date().toLocaleDateString()}`;

  const material = await saveReadMaterial(session.user.id, materialTitle, content, lines);

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    lines: material.lines,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  });
}
