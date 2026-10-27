import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { wordsRepo } from "../repo";

export async function GET() {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  return NextResponse.json({ lists: await repo.lists() });
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  lang: z.string().trim().min(2).max(16),
  source: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .nullable()
    .optional(),
  params: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid list" }, { status: 400 });
  const id = await repo.createList(parsed.data);
  return NextResponse.json({ list: await repo.getList(id) });
}
