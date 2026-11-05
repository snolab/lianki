import { dbBackend } from "@/lib/d1";
import { deleteAvatar, postAvatar } from "@/lib/profile/handlers";
import { profileDeps } from "@/lib/profile/deps";

/** Upload or remove your own avatar (lib/profile/handlers.ts). R2 and its table are D1-side only. */
const off = () => Response.json({ error: "Not found" }, { status: 404 });

export const POST = (req: Request) => (dbBackend() === "d1" ? postAvatar(req, profileDeps) : off());
export const DELETE = (req: Request) =>
  dbBackend() === "d1" ? deleteAvatar(req, profileDeps) : off();
