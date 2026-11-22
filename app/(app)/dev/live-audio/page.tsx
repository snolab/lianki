import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { appLocale } from "@/lib/app-locale.server";
import { cfg } from "@/lib/config-store";
import { devPageMetadata, devPageText } from "../dev-page-title";
import LiveAudioPanel from "./LiveAudioPanel";
export const dynamic = "force-dynamic";
export const generateMetadata = devPageMetadata("liveAudio", { referrer: "no-referrer" });
export default async function LiveAudioPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  const locale = await appLocale();
  const heading = await devPageText("liveAudio");
  const text = getIntlayer("live-audio" as never, locale as never) as unknown as Record<
    string,
    unknown
  >;
  const labels = Object.fromEntries(
    Object.entries(text).map(([key, value]) => [key, String(value)]),
  );
  const [toneHz, peak, gain, maxGain, uiRefreshMs] = await Promise.all([
    cfg("voice.liveToneHz"),
    cfg("voice.liveTonePeakPct"),
    cfg("voice.liveGainPct"),
    cfg("voice.liveMaxGainPct"),
    cfg("voice.liveUiRefreshMs"),
  ]);
  return (
    <main lang={heading.lang} className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-3xl">{heading.text}</h1>
      <LiveAudioPanel
        labels={labels}
        settings={{
          toneHz,
          peak: peak / 100,
          gain: Math.min(gain, maxGain) / 100,
          maxGain: maxGain / 100,
          uiRefreshMs,
        }}
      />
    </main>
  );
}
