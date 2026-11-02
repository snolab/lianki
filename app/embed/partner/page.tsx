import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import type { ChatStrings } from "@lianki/debug-chat/wire";
import { PartnerFrame } from "./PartnerFrame";

/**
 * /embed/partner: the Learning Partner as a frame for the userscript on
 * other sites (docs/dev-debug-widget.md, "On every site", "The frame").
 * The only route that any site may frame (`frame-ancestors *`, next.config.mjs).
 * It shows nothing and connects to nothing until the userscript's shell hands
 * it a ticket over a MessagePort.
 */
export const metadata = { title: "Lianki", robots: { index: false } };

export default async function PartnerFramePage() {
  const locale = await appLocale();
  const strings = Object.fromEntries(
    Object.entries(getIntlayer("learning-partner", locale as never)).map(([k, v]) => [
      k,
      String(v),
    ]),
  ) as unknown as Partial<ChatStrings>;
  return <PartnerFrame strings={strings} />;
}
