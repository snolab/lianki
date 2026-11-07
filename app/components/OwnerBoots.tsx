import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { NewVersionNotice } from "./NewVersionNotice";
import { DebugEval, type PartnerStrings } from "./DebugEval";
import { LeaveGuard } from "./LeaveGuard";

/**
 * What every page but the partner frame mounts: the service worker, the
 * version notice, the unsaved-changes guard (LeaveGuard), and DebugEval (the owner's debug socket, pairing / Allow
 * UI, remote eval, hot islands). Never on /embed/partner.
 */
export function OwnerBoots({
  strings,
  leave,
  open = false,
  chatFull = false,
  liHub = false,
}: {
  strings: PartnerStrings;
  leave: string;
  /** The Learning Partner for every signed-in user (partner.ai-reply on; docs/partner-ai.md). */
  open?: boolean;
  /** The chat's full screen for every chat user (partner.fullscreen on); off, the owner only. */
  chatFull?: boolean;
  /** Flag `voice.li-hub`: Li's sound hub observes the owner's pages (docs/li-sound-hub.md). */
  liHub?: boolean;
}) {
  return (
    <>
      <ServiceWorkerRegistration />
      <LeaveGuard message={leave} />
      <NewVersionNotice />
      <DebugEval strings={strings} partnerOpen={open} fullScreen={chatFull} liHub={liHub} />
    </>
  );
}
