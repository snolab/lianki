import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import {
  getReadMaterialById,
  getReadMaterialContent,
  deleteReadMaterial,
} from "@/app/[locale]/read/getReadMaterialsCollection";

// GET /api/read/[id] - Get material by ID
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const material = await getReadMaterialById(session.user.id, id);

  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  const content = await getReadMaterialContent(material);

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    content,
    lines: material.lines,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  });
}

// DELETE /api/read/[id] - Delete material
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await deleteReadMaterial(session.user.id, id);

  if (!deleted) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
