import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { NewVersionNotice } from "./NewVersionNotice";
import type { PartnerStrings } from "./DebugEval";
import { DebugEvalLazy } from "./DebugEvalLazy";
import { LeaveGuard } from "./LeaveGuard";
import { NoCreditsNotice, type NoCreditsStrings } from "./NoCreditsNotice";
import type { BoxConfig } from "@/lib/box-oauth/client";

/**
 * What every page but the partner frame mounts: the service worker, the
 * version notice, the unsaved-changes guard (LeaveGuard), the not-enough-credits notice, and DebugEval (the owner's debug socket, pairing / Allow
 * UI, remote eval, hot islands). Never on /embed/partner.
 */
export function OwnerBoots({
  strings,
  leave,
  credits,
  open = false,
  dev = false,
  etaBar = false,
  chatFull = false,
  liHub = false,
  box = null,
}: {
  /** On a box (docs/box-oauth.md): its sign-in config, so the chat uses lianki.com's hub. */
  box?: BoxConfig | null;
  strings: PartnerStrings;
  leave: string;
  /** The not-enough-credits notice's words (credits-needed.content.ts); none: not shown. */
  credits?: NoCreditsStrings;
  /** The Learning Partner for every signed-in user (partner.ai-reply on; docs/partner-ai.md). */
  open?: boolean;
  /** The viewer holds `dev` (lib/permissions.ts): the chat's developer parts are allowed. */
  dev?: boolean;
  /** Flag chat.eta-bar: the owner's ETA bar in the chat (lib/eta-ping.ts). */
  etaBar?: boolean;
  /** The chat's full screen for every chat user (partner.fullscreen on); off, the owner only. */
  chatFull?: boolean;
  /** Flag `voice.li-hub`: Li's sound hub observes the owner's pages (docs/li-sound-hub.md). */
  liHub?: boolean;
}) {
  return (
    <>
      <ServiceWorkerRegistration />
      <LeaveGuard message={leave} />
      {credits ? <NoCreditsNotice strings={credits} /> : null}
      <NewVersionNotice />
      <DebugEvalLazy
        strings={strings}
        partnerOpen={open}
        dev={dev}
        fullScreen={chatFull}
        etaBar={etaBar}
        liHub={liHub}
        box={box}
      />
    </>
  );
}
