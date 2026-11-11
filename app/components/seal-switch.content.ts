import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The two words stamped side by side inside every on/off switch
 * (SealSwitch.tsx), both always visible: [ on | off ]. The side naming the
 * current state is filled seal red, the other grey and dashed (owner,
 * 2026-11-11 18:50 JST: a switch shows all its states; 开 / 关).
 */
const dictionary = {
  key: "seal-switch",
  content: {
    on: t({
      en: "On",
      zh: "开",
      hi: "चालू",
      es: "Sí",
      fr: "Oui",
      ar: "تشغيل",
      bn: "চালু",
      pt: "Sim",
      ru: "Вкл",
      ur: "آن",
      id: "Nyala",
      de: "An",
      ja: "開",
      sw: "Washa",
      mr: "चालू",
      ko: "켬",
    }),
    off: t({
      en: "Off",
      zh: "关",
      hi: "बंद",
      es: "No",
      fr: "Non",
      ar: "إيقاف",
      bn: "বন্ধ",
      pt: "Não",
      ru: "Выкл",
      ur: "آف",
      id: "Mati",
      de: "Aus",
      ja: "閉",
      sw: "Zima",
      mr: "बंद",
      ko: "끔",
    }),
  },
};

const ABOUT =
  "Every on/off switch in the app is a small rectangular seal stamp split in two halves, with both words always shown side by side: the ON word first, the OFF word after it (in reading order). The half naming the current state is filled seal red, the other is a grey dashed outline. The words name the two states, never the action of changing them, and both must fit one small stamp together.";

const context: Record<keyof typeof dictionary.content, string> = {
  on: `${ABOUT} This is the word on the ON half: the feature or setting is active. Use the shortest word this language's own on/off switches show for 'on' (English 'On', Chinese 开), ideally one short word of up to five letters.`,
  off: `${ABOUT} This is the word on the OFF half: the feature or setting is inactive. Use the shortest word this language's own on/off switches show for 'off' (English 'Off', Chinese 关), the pair to the ON word, ideally one short word of up to five letters.`,
};

export default {
  ...dictionary,
  title: "The words inside every on/off switch (seal stamp)",
  description: describeKeys(
    "The state words stamped inside the app's on/off switches, shared by every switch on every page.",
    context,
  ),
} satisfies DeclarationContent;
