import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * The read-aloud player of the /read reader (read/[id]/ReaderV2.tsx,
 * lib/read/player.ts): play, pause, the auto-advance switch, the error
 * message, and the way back to the line being read.
 */
const dictionary = {
  key: "read-player",
  content: {
    play: t({
      en: "Play",
      zh: "播放",
      ja: "再生",
      ko: "재생",
      hi: "चलाएँ",
      es: "Reproducir",
      fr: "Lecture",
      ar: "تشغيل",
      bn: "চালান",
      pt: "Reproduzir",
      ru: "Воспроизвести",
      ur: "چلائیں",
      id: "Putar",
      de: "Abspielen",
      sw: "Cheza",
      mr: "प्ले करा",
    }),
    pause: t({
      en: "Pause",
      zh: "暂停",
      ja: "一時停止",
      ko: "일시정지",
      hi: "रोकें",
      es: "Pausa",
      fr: "Pause",
      ar: "إيقاف مؤقت",
      bn: "বিরতি",
      pt: "Pausar",
      ru: "Пауза",
      ur: "روکیں",
      id: "Jeda",
      de: "Pause",
      sw: "Sitisha",
      mr: "थांबवा",
    }),
    autoAdvance: t({
      en: "Read on without waiting",
      zh: "自动读下去，不等我",
      ja: "待たずに続けて読む",
      ko: "기다리지 않고 계속 읽기",
      hi: "रुके बिना आगे पढ़ते रहें",
      es: "Seguir leyendo sin esperar",
      fr: "Continuer sans attendre",
      ar: "تابع القراءة دون انتظار",
      bn: "অপেক্ষা না করে পড়ে চলুন",
      pt: "Continuar lendo sem esperar",
      ru: "Читать дальше, не дожидаясь",
      ur: "انتظار کیے بغیر پڑھتے رہیں",
      id: "Lanjut membaca tanpa menunggu",
      de: "Ohne Warten weiterlesen",
      sw: "Endelea kusoma bila kusubiri",
      mr: "न थांबता पुढे वाचत राहा",
    }),
    failed: t({
      en: "This line could not be read aloud, so playback stopped.",
      zh: "这一句没能读出来，已停止播放。",
      ja: "この行を読み上げられなかったため、再生を止めました。",
      ko: "이 줄을 읽어 줄 수 없어 재생을 멈췄습니다.",
      hi: "यह पंक्ति पढ़ी नहीं जा सकी, इसलिए प्लेबैक रुक गया।",
      es: "No se pudo leer esta línea en voz alta; la reproducción se detuvo.",
      fr: "Impossible de lire cette ligne à voix haute ; la lecture s’est arrêtée.",
      ar: "تعذّرت قراءة هذا السطر بصوت عالٍ، لذا توقّف التشغيل.",
      bn: "এই লাইনটি জোরে পড়া যায়নি, তাই চালানো থেমে গেছে।",
      pt: "Não foi possível ler esta linha em voz alta; a reprodução parou.",
      ru: "Не удалось прочитать строку вслух, воспроизведение остановлено.",
      ur: "یہ سطر بلند آواز سے نہیں پڑھی جا سکی، اس لیے چلانا رک گیا۔",
      id: "Baris ini tidak bisa dibacakan, jadi pemutaran berhenti.",
      de: "Diese Zeile konnte nicht vorgelesen werden, die Wiedergabe wurde angehalten.",
      sw: "Mstari huu haukuweza kusomwa kwa sauti, kwa hiyo uchezaji umesimama.",
      mr: "ही ओळ मोठ्याने वाचता आली नाही, म्हणून प्ले थांबले.",
    }),
    backToLine: t({
      en: "Back to the current line",
      zh: "回到当前这一句",
      ja: "現在の行に戻る",
      ko: "현재 줄로 돌아가기",
      hi: "मौजूदा पंक्ति पर वापस जाएँ",
      es: "Volver a la línea actual",
      fr: "Revenir à la ligne en cours",
      ar: "العودة إلى السطر الحالي",
      bn: "বর্তমান লাইনে ফিরে যান",
      pt: "Voltar à linha atual",
      ru: "К текущей строке",
      ur: "موجودہ سطر پر واپس جائیں",
      id: "Kembali ke baris saat ini",
      de: "Zurück zur aktuellen Zeile",
      sw: "Rudi kwenye mstari wa sasa",
      mr: "सध्याच्या ओळीवर परत जा",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  play: "Main button of the /read reader's controls: starts reading the current line of the text aloud. Imperative verb, one word if possible.",
  pause:
    "The same main button while a line is being read aloud: stops the reading (pressing Play later reads that line again). Imperative verb, one word if possible.",
  autoAdvance:
    "On/off switch in the /read reader's controls. Off (default): after reading a paragraph aloud the player waits until the learner grades it with a swipe. On: it reads every line one after another without waiting.",
  failed:
    "Error under the current line when the voice could not read it aloud (no voice for the language, network or server failure); the player stops instead of skipping ahead. A full sentence; the technical reason is shown after it.",
  backToLine:
    "Small button over the list of lines in the /read reader, shown after the learner scrolled away while it reads aloud: scrolls back to the line being read and follows it again.",
};

export default {
  ...dictionary,
  title: "/read — read-aloud player controls and status",
  description: describeKeys(
    "The read-aloud player of the /read reader for imported texts and books: it reads one line aloud, then waits for the learner (or reads on when auto-advance is on).",
    context,
  ),
} satisfies DeclarationContent;
