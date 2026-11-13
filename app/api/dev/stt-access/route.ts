import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagOn } from "@/lib/flags-store";
import { isAdmin } from "@/lib/permissions";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import {
  allowSttUser,
  disallowSttUser,
  listSttAccess,
  listSttWorkers,
  makeSttWorkerOfficial,
  revokeSttWorker,
  searchUsers,
  type SttDb,
} from "@/lib/stt-worker/store";

/**
 * Admin only: who may use Lianki's speech servers, and the speech servers
 * allowed to register (lib/stt-worker/store.ts; docs/local-stt.md, "Lianki's
 * speech servers for everyone"). 404 for anyone else.
 * - GET → { flag, allowed: [...], workers: [...] } (a worker's key is never sent);
 *   GET ?q=… → { users: [{id, name, email}] }, accounts whose name or email has it;
 * - POST (same-origin JSON) `{ op: "add", email }` | `{ op: "remove", userId }`
 *   | `{ op: "revoke-worker", id }` | `{ op: "official-worker", id }`. Audited.
 * Adding a worker is the CLI's (scripts/local-stt/stt-worker-add.ts), never this page.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });
const db = () => getD1() as unknown as SttDb;

async function admin() {
  const user = await authUserOrNull();
  return isAdmin(user?.email) && user?.id ? user : null;
}

async function state() {
  const workers = (await listSttWorkers(db())).map(({ pubkey: _key, ...w }) => w);
  return {
    flag: await flagOn("stt.worker"),
    allowed: await listSttAccess(db()),
    workers,
  };
}

export const GET = async (req: Request) => {
  if (!(await admin()) || dbBackend() !== "d1") return notFound();
  const q = new URL(req.url).searchParams.get("q");
  if (q !== null)
    return NextResponse.json({ users: await searchUsers(db(), q) }, { headers: NO_STORE });
  return NextResponse.json(await state(), { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const by = await admin();
  if (!by || dbBackend() !== "d1") return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "same-origin-json-only" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });
  if (b.op === "add") {
    // By the picked account's id (the search), or a typed email.
    const who =
      typeof b.userId === "string" && b.userId && b.userId.length <= 100
        ? b.userId
        : typeof b.email === "string" && b.email.includes("@") && b.email.length <= 200
          ? b.email
          : null;
    if (!who) return bad("email-required");
    if (!(await allowSttUser(db(), who, by.id))) return bad("no-such-user");
  } else if (b.op === "remove") {
    if (typeof b.userId !== "string" || !b.userId) return bad("user-id-required");
    await disallowSttUser(db(), b.userId, by.id);
  } else if (b.op === "official-worker") {
    if (typeof b.id !== "string" || !b.id) return bad("id-required");
    await makeSttWorkerOfficial(db(), b.id, by.id);
  } else if (b.op === "revoke-worker") {
    if (typeof b.id !== "string" || !b.id) return bad("id-required");
    await revokeSttWorker(db(), b.id, by.id);
  } else return bad("bad-op");
  return NextResponse.json(await state(), { headers: NO_STORE });
};
