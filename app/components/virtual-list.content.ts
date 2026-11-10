import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * <VirtualList> (app/components/VirtualList.tsx): the one list every page uses
 * (reading materials, page cards, chat history, files…). It has no pages: more
 * rows load by themselves as the reader scrolls toward the end. These are the
 * small status lines under the last row.
 */
const dictionary = {
  key: "virtual-list",
  content: {
    loading: t({
      en: "Loading…",
      zh: "加载中…",
      hi: "लोड हो रहा है…",
      es: "Cargando…",
      fr: "Chargement…",
      ar: "جارٍ التحميل…",
      bn: "লোড হচ্ছে…",
      pt: "Carregando…",
      ru: "Загрузка…",
      ur: "لوڈ ہو رہا ہے…",
      id: "Memuat…",
      de: "Wird geladen…",
      ja: "読み込み中…",
      sw: "Inapakia…",
      mr: "लोड होत आहे…",
      ko: "불러오는 중…",
    }),
    loadingMore: t({
      en: "Loading more…",
      zh: "正在加载更多…",
      hi: "और लोड हो रहे हैं…",
      es: "Cargando más…",
      fr: "Chargement de la suite…",
      ar: "جارٍ تحميل المزيد…",
      bn: "আরও লোড হচ্ছে…",
      pt: "Carregando mais…",
      ru: "Загружаем ещё…",
      ur: "مزید لوڈ ہو رہا ہے…",
      id: "Memuat lebih banyak…",
      de: "Weitere werden geladen…",
      ja: "続きを読み込み中…",
      sw: "Inapakia zaidi…",
      mr: "आणखी लोड होत आहे…",
      ko: "더 불러오는 중…",
    }),
    loadFailed: t({
      en: "Couldn't load the rest of the list.",
      zh: "列表剩下的部分没能加载出来。",
      hi: "सूची का बाकी हिस्सा लोड नहीं हो सका।",
      es: "No se pudo cargar el resto de la lista.",
      fr: "Impossible de charger la suite de la liste.",
      ar: "تعذّر تحميل بقية القائمة.",
      bn: "তালিকার বাকি অংশ লোড করা যায়নি।",
      pt: "Não foi possível carregar o resto da lista.",
      ru: "Не удалось загрузить остаток списка.",
      ur: "فہرست کا باقی حصہ لوڈ نہیں ہو سکا۔",
      id: "Sisa daftar tidak bisa dimuat.",
      de: "Der Rest der Liste konnte nicht geladen werden.",
      ja: "リストの続きを読み込めませんでした。",
      sw: "Sehemu iliyobaki ya orodha haikuweza kupakiwa.",
      mr: "यादीचा उरलेला भाग लोड होऊ शकला नाही.",
      ko: "목록의 나머지를 불러오지 못했습니다.",
    }),
    retry: t({
      en: "Try again",
      zh: "重试",
      hi: "फिर से कोशिश करें",
      es: "Reintentar",
      fr: "Réessayer",
      ar: "أعد المحاولة",
      bn: "আবার চেষ্টা করুন",
      pt: "Tentar de novo",
      ru: "Повторить",
      ur: "دوبارہ کوشش کریں",
      id: "Coba lagi",
      de: "Erneut versuchen",
      ja: "再試行",
      sw: "Jaribu tena",
      mr: "पुन्हा प्रयत्न करा",
      ko: "다시 시도",
    }),
    end: t({
      en: "That's the whole list.",
      zh: "已经是全部了。",
      hi: "पूरी सूची यही है।",
      es: "Esa es toda la lista.",
      fr: "C'est toute la liste.",
      ar: "هذه هي القائمة كاملة.",
      bn: "পুরো তালিকা এটুকুই।",
      pt: "Essa é a lista inteira.",
      ru: "Это весь список.",
      ur: "پوری فہرست یہی ہے۔",
      id: "Itu seluruh daftarnya.",
      de: "Das ist die ganze Liste.",
      ja: "リストはこれで全部です。",
      sw: "Hiyo ndiyo orodha nzima.",
      mr: "संपूर्ण यादी इतकीच आहे.",
      ko: "목록은 여기까지입니다.",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  loading:
    "Status line in place of a list while its first rows are still coming from the server; short, ends with an ellipsis.",
  loadingMore:
    "Status line under the last row of a list while the next rows load on their own as the reader scrolls down; there are no pages or buttons, so never say 'next page'.",
  loadFailed:
    "Notice under the last row of a list when the next rows could not be fetched (network or server trouble); a full sentence, shown beside a Try again button.",
  retry:
    "Button next to the failure notice under a list: fetches the missing rows again. An imperative verb phrase, not 'Cancel' or 'Reload page'.",
  end: "Quiet line under the very last row of a list, telling the reader nothing more will load; a calm statement, not an error or a warning.",
};

export default {
  ...dictionary,
  title: "Lists — loading and end lines under any list",
  description: describeKeys(
    "Status lines of the shared list component used on every page with a list of rows. Lists never have pages: rows load continuously as you scroll, so no string may speak of pages.",
    context,
  ),
} satisfies DeclarationContent;
