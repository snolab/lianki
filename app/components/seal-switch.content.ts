import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The two words stamped inside every on/off switch (SealSwitch.tsx): on is a
 * filled seal-red box seal with `on` in it, off the same box, grey and dashed,
 * with `off` in it (owner, 2026-11-11 01:11 JST: 开 / open, 关闭 / closed).
 */
const dictionary = {
  key: "seal-switch",
  content: {
    on: t({
      en: "Open",
      zh: "开",
      hi: "खुला",
      es: "Abierto",
      fr: "Ouvert",
      ar: "مفتوح",
      bn: "খোলা",
      pt: "Aberto",
      ru: "Открыто",
      ur: "کھلا",
      id: "Buka",
      de: "Offen",
      ja: "開",
      sw: "Wazi",
      mr: "उघडे",
      ko: "열림",
    }),
    off: t({
      en: "Closed",
      zh: "关闭",
      hi: "बंद",
      es: "Cerrado",
      fr: "Fermé",
      ar: "مغلق",
      bn: "বন্ধ",
      pt: "Fechado",
      ru: "Закрыто",
      ur: "بند",
      id: "Tutup",
      de: "Zu",
      ja: "閉",
      sw: "Imefungwa",
      mr: "बंद",
      ko: "닫힘",
    }),
  },
};

const ABOUT =
  "Every on/off switch in the app is drawn as a small rectangular seal stamp with one word inside it, like the open / closed sign on a shop door. The word names the state the setting is in now, never the action of changing it.";

const context: Record<keyof typeof dictionary.content, string> = {
  on: `${ABOUT} The word inside the switch while it is ON: the feature or setting is active (filled seal-red stamp, white text). A short state word (noun or adjective as a shop sign writes 'Open'), not a verb, not an instruction; one or two short words at most, it must fit a small stamp.`,
  off: `${ABOUT} The word inside the switch while it is OFF: the feature or setting is inactive (grey dashed box, grey text). A short state word (as a shop sign writes 'Closed'), not a verb such as 'turn off'; one short word if the language allows, it must fit the same small stamp as the ON word.`,
};

export default {
  ...dictionary,
  title: "The words inside every on/off switch (seal stamp)",
  description: describeKeys(
    "The state words stamped inside the app's on/off switches, shared by every switch on every page.",
    context,
  ),
} satisfies DeclarationContent;
