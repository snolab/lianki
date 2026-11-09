/**
 * The shared server side of the custom-frontend routes (docs/custom-frontend.md):
 * the viewer, the flag, D1. Next-only (the session); the rules and the store
 * are lib/live-view/custom.ts.
 */
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import type { CustomDb } from "./custom";

export type Viewer = { userId: string; email: string; owner: boolean; flagOn: boolean };

/**
 * The signed-in viewer who may use custom frontends at all: the flag on, or
 * the owner. null for a guest, off D1, or with the flag off for anyone else.
 */
export async function customViewer(): Promise<Viewer | null> {
  if (dbBackend() !== "d1") return null;
  const user = await authUserOrNull();
  if (!user?.id || !user.email) return null;
  const owner = isDev(user.email);
  const flagOn = flagIn(await readFlags(), "my-box");
  if (!flagOn && !owner) return null;
  return { userId: user.id, email: user.email, owner, flagOn };
}

export const customDb = () => getD1() as unknown as CustomDb;
