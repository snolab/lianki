import type { DevSwitch, DevSwitchLabels } from "@/app/components/DevSwitchItem";
import { devWholePage } from "@/lib/dev-whole-page";
import { isOwner } from "@/lib/owner";
import { devSwitchMode } from "@/lib/dev-server-switch";

/**
 * The account menu's dev-server switch, decided on the server: the owner's
 * session gets it (with its strings), anyone else's page carries nothing of
 * it — not hidden, absent. `labels` is called only for the owner.
 */
export function devSwitchFor(
  email: string | null | undefined,
  labels: () => DevSwitchLabels,
  env: Record<string, string | undefined> = process.env,
): DevSwitch | undefined {
  const mode = devSwitchMode({
    owner: isOwner(email, env.OWNER_EMAILS),
    devServer: devWholePage(env),
  });
  if (!mode) return undefined;
  return { mode, labels: labels() };
}
