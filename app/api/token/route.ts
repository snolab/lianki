import { randomBytes } from "crypto";
import { ObjectId } from "mongodb";
import { authEmail } from "@/app/signInEmail";
import { getApiTokensCollection, hashToken } from "@/lib/getApiTokensCollection";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = await authEmail();
  const col = getApiTokensCollection();
  const tokens = await col
    .find({ email }, { projection: { tokenHash: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return Response.json(
    tokens.map((t) => ({ id: t._id!.toString(), name: t.name, createdAt: t.createdAt })),
  );
}

export async function POST(req: Request) {
  const email = await authEmail();
  const { name = "API Token" } = await req.json().catch(() => ({}));
  const token = "lk_" + randomBytes(32).toString("hex");
  const col = getApiTokensCollection();
  await col.insertOne({ tokenHash: hashToken(token), email, name, createdAt: new Date() });
  return Response.json({ token }); // plain token returned only once
}

export async function DELETE(req: Request) {
  const email = await authEmail();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  if (!ObjectId.isValid(id)) return Response.json({ error: "invalid id" }, { status: 400 });
  const col = getApiTokensCollection();
  await col.deleteOne({ _id: new ObjectId(id), email });
  return Response.json({ ok: true });
}
