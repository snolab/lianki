import { cookies } from "next/headers";
import { getIntlayer } from "intlayer";
import type { DevSwitchLabels } from "@/app/components/DevSwitchItem";
import type { LiveViewLabels } from "@/app/components/LiveView";
import type { PreviewMenu } from "@/app/components/PreviewMenuItem";
import { devSwitchFor } from "@/lib/dev-server-switch.server";
import { LIVE_VIEW_COOKIE, liveViewFor } from "@/lib/live-view/shell.server";

/**
 * The preview row for a page outside the app shell (the landing page and the
 * blog, which render Header): the same server decisions the app layout makes,
 * so the same `dev` grant gates it. Anyone else gets both empty: no strings, no
 * pointer, no D1 read.
 */
export async function previewMenuFor(
  email: string | null | undefined,
  locale: string,
  /** next/headers' cookies(); a test passes its own jar. */
  jar: () => Promise<{ get(name: string): { value: string } | undefined }> = cookies,
): Promise<PreviewMenu> {
  const [devSwitch, liveView] = [
    devSwitchFor(email, () => getIntlayer("dev-switch", locale) as unknown as DevSwitchLabels),
    await liveViewFor(
      email,
      (await jar()).get(LIVE_VIEW_COOKIE)?.value,
      () => getIntlayer("live-view", locale) as unknown as LiveViewLabels,
    ),
  ];
  return { devSwitch, liveView };
}
