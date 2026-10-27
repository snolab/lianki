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
  // A catalog list id, or "group:<page>" for a group.
  source: z
    .string()
    .regex(/^(group:)?[a-z0-9-]{1,64}$/)
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

/** Reorder lists: `order` is list ids first to last. */
export async function PATCH(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const parsed = z
    .object({
      // Ids in display order; or {id, parentId} to also set the tree.
      order: z
        .array(
          z.union([
            z.string().max(64),
            z.object({ id: z.string().max(64), parentId: z.string().max(64).nullable() }),
          ]),
        )
        .max(200),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid order" }, { status: 400 });
  await repo.reorder(
    parsed.data.order.map((x) =>
      typeof x === "string" ? { id: x, parentId: undefined } : { id: x.id, parentId: x.parentId },
    ),
  );
  return NextResponse.json({ lists: await repo.lists() });
}
