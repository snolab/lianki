import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * /read, the Google Docs import's private path (docs/connections.md): a doc
 * that is not shared by link is opened through the user's Google Drive
 * connection, after they choose it in Google's file picker.
 */
const dictionary = {
  key: "read-gdoc-drive",
  content: {
    notShared: t({
      en: "This doc is not shared by link. Choose it in Google Drive to import it from your account.",
      zh: "这个文档没有开启链接共享。在 Google 云端硬盘中选择它，即可从你的账号导入。",
      hi: "यह दस्तावेज़ लिंक से साझा नहीं है। अपने खाते से आयात करने के लिए इसे Google ड्राइव में चुनें।",
      es: "Este documento no está compartido por enlace. Elígelo en Google Drive para importarlo desde tu cuenta.",
      fr: "Ce document n'est pas partagé par lien. Choisissez-le dans Google Drive pour l'importer depuis votre compte.",
      ar: "هذا المستند غير مشارك عبر رابط. اختره في Google Drive لاستيراده من حسابك.",
      bn: "এই ডকটি লিংকের মাধ্যমে শেয়ার করা নেই। আপনার অ্যাকাউন্ট থেকে আমদানি করতে Google ড্রাইভে এটি বেছে নিন।",
      pt: "Este documento não está compartilhado por link. Escolha-o no Google Drive para importá-lo da sua conta.",
      ru: "Этот документ не открыт по ссылке. Выберите его в Google Диске, чтобы импортировать из своего аккаунта.",
      ur: "یہ دستاویز لنک کے ذریعے شیئر نہیں ہے۔ اپنے اکاؤنٹ سے امپورٹ کرنے کے لیے اسے Google ڈرائیو میں منتخب کریں۔",
      id: "Dokumen ini tidak dibagikan lewat tautan. Pilih di Google Drive untuk mengimpornya dari akun Anda.",
      de: "Dieses Dokument ist nicht per Link freigegeben. Wähle es in Google Drive aus, um es aus deinem Konto zu importieren.",
      ja: "このドキュメントはリンクで共有されていません。Google ドライブで選ぶと、あなたのアカウントから取り込めます。",
      sw: "Hati hii haijashirikiwa kwa kiungo. Ichague kwenye Google Drive ili uilete kutoka akaunti yako.",
      mr: "हा दस्तऐवज लिंकने शेअर केलेला नाही. तुमच्या खात्यातून आयात करण्यासाठी तो Google ड्राइव्हमध्ये निवडा.",
      ko: "이 문서는 링크로 공유되어 있지 않습니다. 내 계정에서 가져오려면 Google 드라이브에서 선택하세요.",
    }),
    chooseInDrive: t({
      en: "Choose in Google Drive",
      zh: "在 Google 云端硬盘中选择",
      hi: "Google ड्राइव में चुनें",
      es: "Elegir en Google Drive",
      fr: "Choisir dans Google Drive",
      ar: "اختر في Google Drive",
      bn: "Google ড্রাইভে বেছে নিন",
      pt: "Escolher no Google Drive",
      ru: "Выбрать в Google Диске",
      ur: "Google ڈرائیو میں منتخب کریں",
      id: "Pilih di Google Drive",
      de: "In Google Drive auswählen",
      ja: "Google ドライブで選ぶ",
      sw: "Chagua kwenye Google Drive",
      mr: "Google ड्राइव्हमध्ये निवडा",
      ko: "Google 드라이브에서 선택",
    }),
    connectedPick: t({
      en: "Google Drive is connected. Choose the doc to import it.",
      zh: "Google 云端硬盘已连接。选择这个文档即可导入。",
      hi: "Google ड्राइव कनेक्ट हो गया। आयात करने के लिए दस्तावेज़ चुनें।",
      es: "Google Drive está conectado. Elige el documento para importarlo.",
      fr: "Google Drive est connecté. Choisissez le document pour l'importer.",
      ar: "تم الاتصال بـ Google Drive. اختر المستند لاستيراده.",
      bn: "Google ড্রাইভ সংযুক্ত হয়েছে। আমদানি করতে ডকটি বেছে নিন।",
      pt: "O Google Drive está conectado. Escolha o documento para importá-lo.",
      ru: "Google Диск подключён. Выберите документ, чтобы импортировать его.",
      ur: "Google ڈرائیو منسلک ہو گئی۔ امپورٹ کرنے کے لیے دستاویز منتخب کریں۔",
      id: "Google Drive sudah terhubung. Pilih dokumennya untuk mengimpor.",
      de: "Google Drive ist verbunden. Wähle das Dokument aus, um es zu importieren.",
      ja: "Google ドライブと連携しました。ドキュメントを選ぶと取り込めます。",
      sw: "Google Drive imeunganishwa. Chagua hati ili uilete.",
      mr: "Google ड्राइव्ह जोडले गेले. आयात करण्यासाठी दस्तऐवज निवडा.",
      ko: "Google 드라이브가 연결되었습니다. 가져올 문서를 선택하세요.",
    }),
    notGranted: t({
      en: "Lianki can't open that doc yet. Choose it in Google Drive.",
      zh: "Lianki 还不能打开这个文档。请在 Google 云端硬盘中选择它。",
      hi: "Lianki अभी वह दस्तावेज़ नहीं खोल सकता। उसे Google ड्राइव में चुनें।",
      es: "Lianki aún no puede abrir ese documento. Elígelo en Google Drive.",
      fr: "Lianki ne peut pas encore ouvrir ce document. Choisissez-le dans Google Drive.",
      ar: "لا يستطيع Lianki فتح هذا المستند بعد. اختره في Google Drive.",
      bn: "Lianki এখনো ওই ডকটি খুলতে পারে না। Google ড্রাইভে এটি বেছে নিন।",
      pt: "O Lianki ainda não pode abrir esse documento. Escolha-o no Google Drive.",
      ru: "Lianki пока не может открыть этот документ. Выберите его в Google Диске.",
      ur: "Lianki ابھی وہ دستاویز نہیں کھول سکتا۔ اسے Google ڈرائیو میں منتخب کریں۔",
      id: "Lianki belum bisa membuka dokumen itu. Pilih di Google Drive.",
      de: "Lianki kann dieses Dokument noch nicht öffnen. Wähle es in Google Drive aus.",
      ja: "Lianki はまだそのドキュメントを開けません。Google ドライブで選んでください。",
      sw: "Lianki bado haiwezi kufungua hati hiyo. Ichague kwenye Google Drive.",
      mr: "Lianki अजून तो दस्तऐवज उघडू शकत नाही. तो Google ड्राइव्हमध्ये निवडा.",
      ko: "Lianki가 아직 그 문서를 열 수 없습니다. Google 드라이브에서 선택하세요.",
    }),
    notConfigured: t({
      en: "Private Google Docs can't be imported yet: the site's Google setup is not finished.",
      zh: "暂时还不能导入非公开的 Google 文档：网站的 Google 设置尚未完成。",
      hi: "निजी Google Docs अभी आयात नहीं किए जा सकते: साइट का Google सेटअप पूरा नहीं हुआ है।",
      es: "Aún no se pueden importar documentos de Google privados: la configuración de Google del sitio no está terminada.",
      fr: "Les Google Docs privés ne peuvent pas encore être importés : la configuration Google du site n'est pas terminée.",
      ar: "لا يمكن استيراد مستندات Google الخاصة بعد: لم يكتمل إعداد Google للموقع.",
      bn: "ব্যক্তিগত Google ডক এখনো আমদানি করা যাবে না: সাইটের Google সেটআপ শেষ হয়নি।",
      pt: "Ainda não é possível importar Google Docs privados: a configuração do Google no site não foi concluída.",
      ru: "Личные Google Документы пока нельзя импортировать: настройка Google на сайте не завершена.",
      ur: "نجی Google Docs ابھی امپورٹ نہیں ہو سکتیں: سائٹ کا Google سیٹ اپ مکمل نہیں ہوا۔",
      id: "Google Dokumen pribadi belum bisa diimpor: pengaturan Google di situs belum selesai.",
      de: "Private Google Docs lassen sich noch nicht importieren: Die Google-Einrichtung der Website ist nicht abgeschlossen.",
      ja: "非公開の Google ドキュメントはまだ取り込めません：サイト側の Google 設定が完了していません。",
      sw: "Google Docs za faragha bado haziwezi kuletwa: mipangilio ya Google ya tovuti haijakamilika.",
      mr: "खाजगी Google Docs अजून आयात करता येत नाहीत: साइटचे Google सेटअप पूर्ण झालेले नाही.",
      ko: "비공개 Google 문서는 아직 가져올 수 없습니다: 사이트의 Google 설정이 끝나지 않았습니다.",
    }),
    connectFailed: t({
      en: "Couldn't reach Google Drive. Try again.",
      zh: "无法连接 Google 云端硬盘，请重试。",
      hi: "Google ड्राइव तक नहीं पहुँच सके। फिर से कोशिश करें।",
      es: "No se pudo acceder a Google Drive. Inténtalo de nuevo.",
      fr: "Impossible d'accéder à Google Drive. Réessayez.",
      ar: "تعذّر الوصول إلى Google Drive. حاول مرة أخرى.",
      bn: "Google ড্রাইভে পৌঁছানো যায়নি। আবার চেষ্টা করুন।",
      pt: "Não foi possível acessar o Google Drive. Tente de novo.",
      ru: "Не удалось связаться с Google Диском. Попробуйте ещё раз.",
      ur: "Google ڈرائیو تک رسائی نہیں ہو سکی۔ دوبارہ کوشش کریں۔",
      id: "Tidak dapat menjangkau Google Drive. Coba lagi.",
      de: "Google Drive war nicht erreichbar. Versuch es noch einmal.",
      ja: "Google ドライブに接続できませんでした。もう一度お試しください。",
      sw: "Imeshindwa kufikia Google Drive. Jaribu tena.",
      mr: "Google ड्राइव्हपर्यंत पोहोचता आले नाही. पुन्हा प्रयत्न करा.",
      ko: "Google 드라이브에 연결할 수 없습니다. 다시 시도하세요.",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  notShared:
    "Message under the Google Doc link field on /read when the pasted doc is not shared by link, and the user can import it through their own Google Drive instead (the 'Choose in Google Drive' button follows).",
  chooseInDrive:
    "Button under the Google Doc link field on /read: opens Google's file picker on the pasted doc (connecting Google Drive first if needed) so Lianki may import it. Imperative verb phrase; keep 'Google Drive' as Google's product name in this language.",
  connectedPick:
    "Message on /read after the user came back from connecting Google Drive: they now press 'Choose in Google Drive' to pick the doc and import it.",
  notGranted:
    "Error under the Google Doc link field on /read: Google Drive did not let Lianki open the doc because the user has not chosen it in the picker yet (or chose another one).",
  notConfigured:
    "Error under the Google Doc link field on /read when the site operator has not finished setting up Google: private docs cannot be imported yet. Not the user's fault.",
  connectFailed:
    "Error under the Google Doc link field on /read when talking to Google Drive or loading its file picker failed for a technical reason; the user can try again.",
};

export default {
  ...dictionary,
  title: "/read — importing a private Google Doc through Google Drive",
  description: describeKeys(
    "Messages and the button of the /read Google Docs import for docs that are not shared by link: the user chooses the doc in Google's file picker and Lianki imports it from their Google Drive. Keep product names (Lianki, Google Drive, Google Docs) as is.",
    context,
  ),
} satisfies DeclarationContent;
