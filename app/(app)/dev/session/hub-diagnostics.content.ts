import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
const dictionary = {
  key: "hub-diagnostics",
  content: {
    title: t({
      en: "Chat hub activity",
      zh: "聊天 Hub 活跃状态",
      ja: "チャット Hub の稼働状況",
      ko: "채팅 Hub 활동",
      hi: "चैट हब गतिविधि",
      es: "Actividad del hub de chat",
      fr: "Activité du hub de discussion",
      ar: "نشاط مركز الدردشة",
      bn: "চ্যাট হাবের কার্যকলাপ",
      pt: "Atividade do hub de chat",
      ru: "Активность чат-хаба",
      ur: "چیٹ ہب کی سرگرمی",
      id: "Aktivitas hub obrolan",
      de: "Aktivität des Chat-Hubs",
      sw: "Shughuli za kitovu cha gumzo",
      mr: "चॅट हब क्रियाकलाप",
    }),
    note: t({
      en: "Snapshot for this wake cycle. Reading it wakes the hub; it does not measure continuous active time. No automatic polling.",
      zh: "本次唤醒周期的快照。读取会唤醒 Hub，不能据此判断持续活跃时长；不会自动轮询。",
      ja: "今回の起動中のスナップショットです。取得時に Hub を起こすため、連続稼働時間は測れません。自動ポーリングは行いません。",
      ko: "이번 깨어남 주기의 스냅샷입니다. 조회하면 Hub가 깨어나므로 연속 활동 시간을 측정하지 않습니다. 자동 조회는 없습니다.",
      hi: "यह वर्तमान जागरण चक्र का स्नैपशॉट है। इसे पढ़ने से हब जागता है; इससे लगातार सक्रिय समय नहीं मापा जाता। स्वचालित पोलिंग नहीं होती।",
      es: "Instantánea del ciclo actual. Consultarla despierta el hub; no mide el tiempo activo continuo. Sin consultas automáticas.",
      fr: "Instantané du cycle actuel. La lecture réveille le hub ; elle ne mesure pas son activité continue. Aucune interrogation automatique.",
      ar: "لقطة لدورة الاستيقاظ الحالية. قراءتها توقظ المركز ولا تقيس مدة نشاطه المتواصل. لا يوجد استقصاء تلقائي.",
      bn: "বর্তমান জাগরণ চক্রের স্ন্যাপশট। এটি পড়লে হাব জেগে ওঠে; একটানা সক্রিয় সময় মাপা হয় না। স্বয়ংক্রিয় পোলিং নেই।",
      pt: "Retrato do ciclo atual. A consulta desperta o hub; não mede o tempo ativo contínuo. Sem consultas automáticas.",
      ru: "Снимок текущего цикла пробуждения. Запрос будит хаб и не измеряет непрерывную активность. Автоматических опросов нет.",
      ur: "موجودہ بیداری دور کا اسنیپ شاٹ۔ اسے پڑھنے سے ہب جاگتا ہے؛ مسلسل فعال وقت نہیں ناپا جاتا۔ خودکار پولنگ نہیں ہوتی۔",
      id: "Cuplikan siklus bangun saat ini. Membacanya membangunkan hub; ini bukan ukuran waktu aktif berkelanjutan. Tanpa polling otomatis.",
      de: "Momentaufnahme des aktuellen Wachzyklus. Das Abrufen weckt den Hub; es misst keine durchgehende Aktivitätsdauer. Keine automatischen Abfragen.",
      sw: "Picha ya mzunguko wa sasa wa kuamka. Kuisoma huamsha kitovu; haipimi muda wa shughuli endelevu. Hakuna ukaguzi wa kiotomatiki.",
      mr: "सध्याच्या जागृत चक्राचा स्नॅपशॉट. तो वाचल्याने हब जागे होते; सलग सक्रिय वेळ मोजला जात नाही. स्वयंचलित पोलिंग नाही.",
    }),
    unavailable: t({
      en: "Hub diagnostics unavailable here.",
      zh: "此处暂时无法读取 Hub 诊断。",
      ja: "ここでは Hub の診断を取得できません。",
      ko: "여기서는 Hub 진단을 사용할 수 없습니다.",
      hi: "यहाँ हब निदान उपलब्ध नहीं है।",
      es: "Diagnóstico del hub no disponible aquí.",
      fr: "Diagnostic du hub indisponible ici.",
      ar: "تشخيص المركز غير متاح هنا.",
      bn: "এখানে হাবের নির্ণয় উপলব্ধ নেই।",
      pt: "Diagnóstico do hub indisponível aqui.",
      ru: "Диагностика хаба здесь недоступна.",
      ur: "یہاں ہب کی تشخیص دستیاب نہیں۔",
      id: "Diagnostik hub tidak tersedia di sini.",
      de: "Hub-Diagnose hier nicht verfügbar.",
      sw: "Uchunguzi wa kitovu haupatikani hapa.",
      mr: "येथे हब निदान उपलब्ध नाही.",
    }),
  },
};
const context = {
  title:
    "Heading of the developer-only chat Durable Object diagnostics on /dev/session; hub means the server coordinating chat connections.",
  note: "Explanation below developer diagnostics: values are in-memory for one wake cycle, inspecting wakes the Durable Object, and this panel never polls or proves billed duration.",
  unavailable:
    "Developer diagnostics fallback when the private PUSH binding is absent or the bounded diagnostic request failed; not shown in ordinary account UI.",
};
export default {
  ...dictionary,
  title: "/dev/session hub diagnostics",
  description: describeKeys("Developer-only chat hub health snapshot.", context),
} satisfies DeclarationContent;
