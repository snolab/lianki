import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { NewVersionNotice } from "./NewVersionNotice";
import { DebugEval, type PartnerStrings } from "./DebugEval";

/**
 * What every page but the partner frame mounts: the service worker, the
 * version notice, and DebugEval (the owner's debug socket, pairing / Allow
 * UI, remote eval, hot islands). Never on /embed/partner.
 */
export function OwnerBoots({ strings }: { strings: PartnerStrings }) {
  return (
    <>
      <ServiceWorkerRegistration />
      <NewVersionNotice />
      <DebugEval strings={strings} />
    </>
  );
}
