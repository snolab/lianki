import { randomBytes } from "crypto";
import { ObjectId } from "mongodb";
import { authEmail } from "@/app/signInEmail";
import { getApiTokensCollection, hashToken } from "@/lib/getApiTokensCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { ApiTokensD1Repo } from "@/lib/repos/d1Repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = await authEmail();

  if (dbBackend() === "d1") {
    const tokens = await new ApiTokensD1Repo(getD1()).listByEmail(email);
    // token_hash is the stable id for D1 (a SHA-256 hash — safe to expose)
    return Response.json(
      tokens.map((t) => ({ id: t.tokenHash, name: t.name, createdAt: t.createdAt })),
    );
  }

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
  const record = { tokenHash: hashToken(token), email, name, createdAt: new Date() };

  if (dbBackend() === "d1") {
    await new ApiTokensD1Repo(getD1()).insert(record);
  } else {
    await getApiTokensCollection().insertOne(record);
  }
  return Response.json({ token }); // plain token returned only once
}

export async function DELETE(req: Request) {
  const email = await authEmail();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });

  if (dbBackend() === "d1") {
    // id is the token_hash; deletion is scoped to the caller's email
    const repo = new ApiTokensD1Repo(getD1());
    const owner = await repo.emailByHash(id);
    if (owner !== email) return Response.json({ error: "not found" }, { status: 404 });
    await repo.delete(id);
    return Response.json({ ok: true });
  }

  if (!ObjectId.isValid(id)) return Response.json({ error: "invalid id" }, { status: 400 });
  await getApiTokensCollection().deleteOne({ _id: new ObjectId(id), email });
  return Response.json({ ok: true });
}
