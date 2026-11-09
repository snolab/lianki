/**
 * The userscript's Li chat strings (docs/userscript-li-chat.md): the trust
 * prompt, the sites list and the pill's Li entry, in the app's 16 locales.
 *
 * One source for two readers: the userscript imports this plain table (it
 * cannot load intlayer), and app/components/pill-chat.content.ts declares the
 * same strings as the intlayer dictionary `pill-chat`, with the context lines
 * below as its description (docs/i18n.md). Edit here; translators read
 * PILL_CHAT_CONTEXT first.
 */

export const PILL_CHAT_LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
] as const;
export type PillChatLocale = (typeof PILL_CHAT_LOCALES)[number];

export type PillChatStrings = {
  liTitle: string;
  promptTitle: string;
  promptBody: string;
  promptWarn: string;
  allowOnce: string;
  allowAlways: string;
  neverHere: string;
  notNow: string;
  sitesTitle: string;
  sitesMenu: string;
  sitesEmpty: string;
  sitesAllowed: string;
  sitesNever: string;
  forget: string;
  close: string;
  blocked: string;
  openLianki: string;
};

export const PILL_CHAT_CONTEXT: Record<keyof PillChatStrings, string> = {
  liTitle:
    "Tooltip and screen-reader label of the small 'Li' button on the userscript's floating pill on any website: opens Li, the Learning Partner chat. Li is a product name: keep it as is.",
  promptTitle:
    "Heading of the one-time trust prompt shown on a website before Li chat opens there. {host} is that website's domain (e.g. example.com): keep the placeholder. A yes/no question to the user.",
  promptBody:
    "Body text of the trust prompt: explains that the chat window is served by lianki.com in its own isolated frame, that the website cannot read what the user types in it, and that Li does not see the page unless the user shares something. Li and lianki.com stay as is.",
  promptWarn:
    "Warning line under the trust prompt's body, in a highlighted box: Li (an AI) can be wrong, and the user should never paste passwords or private data from the current website into the chat. Li stays as is.",
  allowOnce:
    "Button in the trust prompt: allow Li chat on this website for this page visit only; it asks again next time. Imperative, short.",
  allowAlways:
    "Button in the trust prompt: always allow Li chat on this website (remembered until the user removes it in the sites list). Short phrase.",
  neverHere:
    "Button in the trust prompt: never allow Li chat on this website and hide the Li button here (can be undone in the sites list). Short phrase.",
  notNow:
    "Screen-reader label and tooltip of the × button that closes the trust prompt without deciding: counts as not allowing this time, asks again next time.",
  sitesTitle:
    "Heading of the dialog listing every website where the user allowed or blocked Li chat, each with a button to remove the decision. Li stays as is.",
  sitesMenu:
    "Menu item in the userscript manager's menu (Tampermonkey/Violentmonkey) that opens the list of websites allowed or blocked for Li chat. Ends with an ellipsis because it opens a dialog. Li stays as is.",
  sitesEmpty:
    "Shown in the sites list when the user has not allowed or blocked Li chat on any website yet. A full short sentence.",
  sitesAllowed:
    "Status label next to a website's domain in the sites list: Li chat is always allowed there. One word or short adjective.",
  sitesNever:
    "Status label next to a website's domain in the sites list: Li chat is blocked (never) there. One word or short adjective.",
  forget:
    "Button next to a website in the sites list: removes the stored allow/never decision, so the trust prompt asks again next time. Imperative verb, short.",
  close: "Button that closes the sites list dialog. Imperative verb, one word.",
  blocked:
    "Note shown on a website whose security policy blocks Li's private chat window (a frame from lianki.com): the chat cannot open there, use lianki.com instead. Full sentence; Li and lianki.com stay as is.",
  openLianki:
    "Link under the 'blocked' note that opens lianki.com in a new tab, where Li chat works. Imperative, short; lianki.com stays as is.",
};

export const PILL_CHAT_STRINGS: Record<PillChatLocale, PillChatStrings> = {
  en: {
    liTitle: "Chat with Li",
    promptTitle: "Allow Li chat on {host}?",
    promptBody:
      "Li runs in its own window from lianki.com. This site cannot read what you type there. Li does not see this page unless you share something.",
    promptWarn: "Li can make mistakes. Do not paste passwords or private data from this page.",
    allowOnce: "Allow once",
    allowAlways: "Always on this site",
    neverHere: "Never on this site",
    notNow: "Not now",
    sitesTitle: "Li chat: sites",
    sitesMenu: "Li chat: sites…",
    sitesEmpty: "No sites yet.",
    sitesAllowed: "Allowed",
    sitesNever: "Never",
    forget: "Forget",
    close: "Close",
    blocked: "This site blocks Li's private window, so Li cannot open here.",
    openLianki: "Chat on lianki.com",
  },
  zh: {
    liTitle: "和 Li 聊天",
    promptTitle: "允许在 {host} 上使用 Li 聊天吗？",
    promptBody:
      "Li 在来自 lianki.com 的独立窗口里运行。这个网站读不到你在里面输入的内容。除非你主动分享，Li 也看不到这个页面。",
    promptWarn: "Li 可能会出错。不要把这个页面上的密码或私人信息粘贴进来。",
    allowOnce: "仅这一次",
    allowAlways: "在此网站总是允许",
    neverHere: "在此网站永不允许",
    notNow: "暂不",
    sitesTitle: "Li 聊天：网站",
    sitesMenu: "Li 聊天：网站…",
    sitesEmpty: "还没有任何网站。",
    sitesAllowed: "已允许",
    sitesNever: "永不",
    forget: "移除",
    close: "关闭",
    blocked: "这个网站阻止了 Li 的独立窗口，Li 无法在这里打开。",
    openLianki: "去 lianki.com 聊天",
  },
  hi: {
    liTitle: "Li से चैट करें",
    promptTitle: "{host} पर Li चैट की अनुमति दें?",
    promptBody:
      "Li, lianki.com की अपनी अलग विंडो में चलता है। यह साइट वहाँ आपके द्वारा लिखी गई बातें नहीं पढ़ सकती। जब तक आप कुछ साझा न करें, Li यह पेज नहीं देखता।",
    promptWarn: "Li से गलतियाँ हो सकती हैं। इस पेज से पासवर्ड या निजी जानकारी यहाँ पेस्ट न करें।",
    allowOnce: "एक बार अनुमति दें",
    allowAlways: "इस साइट पर हमेशा",
    neverHere: "इस साइट पर कभी नहीं",
    notNow: "अभी नहीं",
    sitesTitle: "Li चैट: साइटें",
    sitesMenu: "Li चैट: साइटें…",
    sitesEmpty: "अभी कोई साइट नहीं।",
    sitesAllowed: "अनुमति है",
    sitesNever: "कभी नहीं",
    forget: "हटाएँ",
    close: "बंद करें",
    blocked: "यह साइट Li की निजी विंडो को रोकती है, इसलिए Li यहाँ नहीं खुल सकता।",
    openLianki: "lianki.com पर चैट करें",
  },
  es: {
    liTitle: "Chatear con Li",
    promptTitle: "¿Permitir el chat de Li en {host}?",
    promptBody:
      "Li funciona en su propia ventana de lianki.com. Este sitio no puede leer lo que escribes ahí. Li no ve esta página a menos que compartas algo.",
    promptWarn: "Li puede equivocarse. No pegues contraseñas ni datos privados de esta página.",
    allowOnce: "Permitir una vez",
    allowAlways: "Siempre en este sitio",
    neverHere: "Nunca en este sitio",
    notNow: "Ahora no",
    sitesTitle: "Chat de Li: sitios",
    sitesMenu: "Chat de Li: sitios…",
    sitesEmpty: "Todavía no hay sitios.",
    sitesAllowed: "Permitido",
    sitesNever: "Nunca",
    forget: "Olvidar",
    close: "Cerrar",
    blocked: "Este sitio bloquea la ventana privada de Li, así que Li no puede abrirse aquí.",
    openLianki: "Chatear en lianki.com",
  },
  fr: {
    liTitle: "Discuter avec Li",
    promptTitle: "Autoriser le chat Li sur {host} ?",
    promptBody:
      "Li fonctionne dans sa propre fenêtre servie par lianki.com. Ce site ne peut pas lire ce que vous y tapez. Li ne voit pas cette page, sauf si vous partagez quelque chose.",
    promptWarn:
      "Li peut se tromper. Ne collez pas de mots de passe ni de données privées de cette page.",
    allowOnce: "Autoriser une fois",
    allowAlways: "Toujours sur ce site",
    neverHere: "Jamais sur ce site",
    notNow: "Pas maintenant",
    sitesTitle: "Chat Li : sites",
    sitesMenu: "Chat Li : sites…",
    sitesEmpty: "Aucun site pour l’instant.",
    sitesAllowed: "Autorisé",
    sitesNever: "Jamais",
    forget: "Oublier",
    close: "Fermer",
    blocked: "Ce site bloque la fenêtre privée de Li : Li ne peut pas s’ouvrir ici.",
    openLianki: "Discuter sur lianki.com",
  },
  ar: {
    liTitle: "الدردشة مع Li",
    promptTitle: "هل تسمح بدردشة Li على {host}؟",
    promptBody:
      "يعمل Li في نافذته الخاصة من lianki.com. لا يستطيع هذا الموقع قراءة ما تكتبه هناك. ولا يرى Li هذه الصفحة إلا إذا شاركت شيئًا منها.",
    promptWarn: "قد يخطئ Li. لا تلصق كلمات مرور أو بيانات خاصة من هذه الصفحة.",
    allowOnce: "السماح مرة واحدة",
    allowAlways: "دائمًا على هذا الموقع",
    neverHere: "أبدًا على هذا الموقع",
    notNow: "ليس الآن",
    sitesTitle: "دردشة Li: المواقع",
    sitesMenu: "دردشة Li: المواقع…",
    sitesEmpty: "لا توجد مواقع بعد.",
    sitesAllowed: "مسموح",
    sitesNever: "أبدًا",
    forget: "إزالة",
    close: "إغلاق",
    blocked: "يحظر هذا الموقع نافذة Li الخاصة، لذا لا يمكن فتح Li هنا.",
    openLianki: "الدردشة على lianki.com",
  },
  bn: {
    liTitle: "Li-এর সঙ্গে চ্যাট করুন",
    promptTitle: "{host}-এ Li চ্যাটের অনুমতি দেবেন?",
    promptBody:
      "Li চলে lianki.com-এর নিজস্ব আলাদা উইন্ডোতে। আপনি সেখানে যা লেখেন, এই সাইট তা পড়তে পারে না। আপনি কিছু শেয়ার না করলে Li এই পেজ দেখে না।",
    promptWarn: "Li ভুল করতে পারে। এই পেজ থেকে পাসওয়ার্ড বা ব্যক্তিগত তথ্য এখানে পেস্ট করবেন না।",
    allowOnce: "একবার অনুমতি দিন",
    allowAlways: "এই সাইটে সবসময়",
    neverHere: "এই সাইটে কখনো না",
    notNow: "এখন না",
    sitesTitle: "Li চ্যাট: সাইট",
    sitesMenu: "Li চ্যাট: সাইট…",
    sitesEmpty: "এখনো কোনো সাইট নেই।",
    sitesAllowed: "অনুমতি আছে",
    sitesNever: "কখনো না",
    forget: "সরান",
    close: "বন্ধ করুন",
    blocked: "এই সাইট Li-এর ব্যক্তিগত উইন্ডো আটকে দেয়, তাই Li এখানে খোলা যায় না।",
    openLianki: "lianki.com-এ চ্যাট করুন",
  },
  pt: {
    liTitle: "Conversar com Li",
    promptTitle: "Permitir o chat do Li em {host}?",
    promptBody:
      "O Li funciona em sua própria janela do lianki.com. Este site não consegue ler o que você digita lá. O Li não vê esta página, a menos que você compartilhe algo.",
    promptWarn: "O Li pode errar. Não cole senhas nem dados privados desta página.",
    allowOnce: "Permitir uma vez",
    allowAlways: "Sempre neste site",
    neverHere: "Nunca neste site",
    notNow: "Agora não",
    sitesTitle: "Chat do Li: sites",
    sitesMenu: "Chat do Li: sites…",
    sitesEmpty: "Nenhum site ainda.",
    sitesAllowed: "Permitido",
    sitesNever: "Nunca",
    forget: "Esquecer",
    close: "Fechar",
    blocked: "Este site bloqueia a janela privada do Li, então o Li não pode abrir aqui.",
    openLianki: "Conversar no lianki.com",
  },
  ru: {
    liTitle: "Чат с Li",
    promptTitle: "Разрешить чат Li на {host}?",
    promptBody:
      "Li работает в собственном окне с lianki.com. Этот сайт не может прочитать то, что вы там вводите. Li не видит эту страницу, если вы сами чем-то не поделитесь.",
    promptWarn: "Li может ошибаться. Не вставляйте пароли и личные данные с этой страницы.",
    allowOnce: "Разрешить один раз",
    allowAlways: "Всегда на этом сайте",
    neverHere: "Никогда на этом сайте",
    notNow: "Не сейчас",
    sitesTitle: "Чат Li: сайты",
    sitesMenu: "Чат Li: сайты…",
    sitesEmpty: "Пока нет сайтов.",
    sitesAllowed: "Разрешено",
    sitesNever: "Никогда",
    forget: "Забыть",
    close: "Закрыть",
    blocked: "Этот сайт блокирует отдельное окно Li, поэтому Li здесь не откроется.",
    openLianki: "Общаться на lianki.com",
  },
  ur: {
    liTitle: "Li سے چیٹ کریں",
    promptTitle: "کیا {host} پر Li چیٹ کی اجازت دیں؟",
    promptBody:
      "Li، lianki.com کی اپنی الگ ونڈو میں چلتا ہے۔ یہ سائٹ وہ نہیں پڑھ سکتی جو آپ وہاں لکھتے ہیں۔ جب تک آپ کچھ شیئر نہ کریں، Li یہ صفحہ نہیں دیکھتا۔",
    promptWarn: "Li غلطی کر سکتا ہے۔ اس صفحے سے پاس ورڈ یا نجی معلومات یہاں پیسٹ نہ کریں۔",
    allowOnce: "ایک بار اجازت دیں",
    allowAlways: "اس سائٹ پر ہمیشہ",
    neverHere: "اس سائٹ پر کبھی نہیں",
    notNow: "ابھی نہیں",
    sitesTitle: "Li چیٹ: سائٹس",
    sitesMenu: "Li چیٹ: سائٹس…",
    sitesEmpty: "ابھی کوئی سائٹ نہیں۔",
    sitesAllowed: "اجازت ہے",
    sitesNever: "کبھی نہیں",
    forget: "ہٹائیں",
    close: "بند کریں",
    blocked: "یہ سائٹ Li کی نجی ونڈو کو روکتی ہے، اس لیے Li یہاں نہیں کھل سکتا۔",
    openLianki: "lianki.com پر چیٹ کریں",
  },
  id: {
    liTitle: "Ngobrol dengan Li",
    promptTitle: "Izinkan obrolan Li di {host}?",
    promptBody:
      "Li berjalan di jendelanya sendiri dari lianki.com. Situs ini tidak bisa membaca apa yang Anda ketik di sana. Li tidak melihat halaman ini kecuali Anda membagikan sesuatu.",
    promptWarn: "Li bisa keliru. Jangan tempel kata sandi atau data pribadi dari halaman ini.",
    allowOnce: "Izinkan sekali",
    allowAlways: "Selalu di situs ini",
    neverHere: "Jangan pernah di situs ini",
    notNow: "Nanti saja",
    sitesTitle: "Obrolan Li: situs",
    sitesMenu: "Obrolan Li: situs…",
    sitesEmpty: "Belum ada situs.",
    sitesAllowed: "Diizinkan",
    sitesNever: "Tidak pernah",
    forget: "Lupakan",
    close: "Tutup",
    blocked: "Situs ini memblokir jendela pribadi Li, jadi Li tidak bisa dibuka di sini.",
    openLianki: "Ngobrol di lianki.com",
  },
  de: {
    liTitle: "Mit Li chatten",
    promptTitle: "Li-Chat auf {host} erlauben?",
    promptBody:
      "Li läuft in einem eigenen Fenster von lianki.com. Diese Website kann nicht lesen, was du dort tippst. Li sieht diese Seite nicht, außer du teilst etwas.",
    promptWarn:
      "Li kann Fehler machen. Füge keine Passwörter oder privaten Daten von dieser Seite ein.",
    allowOnce: "Einmal erlauben",
    allowAlways: "Immer auf dieser Website",
    neverHere: "Nie auf dieser Website",
    notNow: "Jetzt nicht",
    sitesTitle: "Li-Chat: Websites",
    sitesMenu: "Li-Chat: Websites…",
    sitesEmpty: "Noch keine Websites.",
    sitesAllowed: "Erlaubt",
    sitesNever: "Nie",
    forget: "Vergessen",
    close: "Schließen",
    blocked: "Diese Website blockiert das private Fenster von Li, daher kann Li hier nicht öffnen.",
    openLianki: "Auf lianki.com chatten",
  },
  ja: {
    liTitle: "Li とチャット",
    promptTitle: "{host} で Li チャットを許可しますか？",
    promptBody:
      "Li は lianki.com の専用ウィンドウで動きます。このサイトは、そこで入力した内容を読めません。共有しない限り、Li もこのページを見ません。",
    promptWarn:
      "Li は間違えることがあります。このページのパスワードや個人情報は貼り付けないでください。",
    allowOnce: "今回だけ許可",
    allowAlways: "このサイトで常に許可",
    neverHere: "このサイトでは許可しない",
    notNow: "今はしない",
    sitesTitle: "Li チャット：サイト",
    sitesMenu: "Li チャット：サイト…",
    sitesEmpty: "まだサイトはありません。",
    sitesAllowed: "許可",
    sitesNever: "許可しない",
    forget: "削除",
    close: "閉じる",
    blocked: "このサイトは Li の専用ウィンドウをブロックしているため、ここでは Li を開けません。",
    openLianki: "lianki.com でチャット",
  },
  sw: {
    liTitle: "Ongea na Li",
    promptTitle: "Ruhusu gumzo la Li kwenye {host}?",
    promptBody:
      "Li inaendeshwa kwenye dirisha lake kutoka lianki.com. Tovuti hii haiwezi kusoma unachoandika humo. Li haioni ukurasa huu isipokuwa ukishiriki kitu.",
    promptWarn: "Li inaweza kukosea. Usibandike nenosiri au data binafsi kutoka ukurasa huu.",
    allowOnce: "Ruhusu mara moja",
    allowAlways: "Daima kwenye tovuti hii",
    neverHere: "Kamwe kwenye tovuti hii",
    notNow: "Si sasa",
    sitesTitle: "Gumzo la Li: tovuti",
    sitesMenu: "Gumzo la Li: tovuti…",
    sitesEmpty: "Bado hakuna tovuti.",
    sitesAllowed: "Imeruhusiwa",
    sitesNever: "Kamwe",
    forget: "Sahau",
    close: "Funga",
    blocked: "Tovuti hii inazuia dirisha binafsi la Li, kwa hiyo Li haiwezi kufunguka hapa.",
    openLianki: "Ongea kwenye lianki.com",
  },
  mr: {
    liTitle: "Li शी गप्पा मारा",
    promptTitle: "{host} वर Li चॅटला परवानगी द्यायची?",
    promptBody:
      "Li हे lianki.com च्या स्वतःच्या वेगळ्या विंडोमध्ये चालते. तुम्ही तिथे काय टाइप करता ते ही साइट वाचू शकत नाही. तुम्ही काही शेअर केल्याशिवाय Li हे पेज पाहत नाही.",
    promptWarn: "Li कडून चुका होऊ शकतात. या पेजवरील पासवर्ड किंवा खासगी माहिती इथे पेस्ट करू नका.",
    allowOnce: "एकदाच परवानगी द्या",
    allowAlways: "या साइटवर नेहमी",
    neverHere: "या साइटवर कधीही नाही",
    notNow: "आता नाही",
    sitesTitle: "Li चॅट: साइट्स",
    sitesMenu: "Li चॅट: साइट्स…",
    sitesEmpty: "अजून कोणतीही साइट नाही.",
    sitesAllowed: "परवानगी आहे",
    sitesNever: "कधीही नाही",
    forget: "काढा",
    close: "बंद करा",
    blocked: "ही साइट Li ची खासगी विंडो अडवते, त्यामुळे Li इथे उघडू शकत नाही.",
    openLianki: "lianki.com वर चॅट करा",
  },
  ko: {
    liTitle: "Li와 채팅",
    promptTitle: "{host}에서 Li 채팅을 허용할까요?",
    promptBody:
      "Li는 lianki.com의 별도 창에서 실행됩니다. 이 사이트는 그 안에 입력한 내용을 읽을 수 없습니다. 직접 공유하지 않는 한 Li도 이 페이지를 보지 않습니다.",
    promptWarn: "Li는 실수할 수 있습니다. 이 페이지의 비밀번호나 개인 정보를 붙여 넣지 마세요.",
    allowOnce: "이번만 허용",
    allowAlways: "이 사이트에서 항상 허용",
    neverHere: "이 사이트에서 허용 안 함",
    notNow: "나중에",
    sitesTitle: "Li 채팅: 사이트",
    sitesMenu: "Li 채팅: 사이트…",
    sitesEmpty: "아직 사이트가 없습니다.",
    sitesAllowed: "허용됨",
    sitesNever: "허용 안 함",
    forget: "삭제",
    close: "닫기",
    blocked: "이 사이트는 Li의 별도 창을 차단하므로 여기서는 Li를 열 수 없습니다.",
    openLianki: "lianki.com에서 채팅",
  },
};

/** The browser's language (not the site's), one of the 16; English otherwise. */
export function pillChatLang(lang: string | null | undefined = globalThis.navigator?.language) {
  const base = String(lang ?? "")
    .toLowerCase()
    .split(/[-_]/)[0] as PillChatLocale;
  return (PILL_CHAT_LOCALES as readonly string[]).includes(base) ? base : "en";
}

export const pillChatStrings = (lang?: string | null): PillChatStrings =>
  PILL_CHAT_STRINGS[pillChatLang(lang)];
