import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

const dictionary = {
  key: "profile-session",
  content: {
    heading: t({
      en: "This sign-in",
      zh: "本次登录",
      ja: "現在のログイン",
      ko: "현재 로그인",
      hi: "यह साइन-इन",
      es: "Este inicio de sesión",
      fr: "Cette connexion",
      ar: "تسجيل الدخول الحالي",
      bn: "এই সাইন-ইন",
      pt: "Este login",
      ru: "Текущий вход",
      ur: "یہ سائن اِن",
      id: "Login ini",
      de: "Diese Anmeldung",
      sw: "Uingiaji huu",
      mr: "हे साइन-इन",
    }),
    since: t({
      en: "Signed in since {date}",
      zh: "自 {date} 起已登录",
      ja: "{date} からログイン中",
      ko: "{date}부터 로그인됨",
      hi: "{date} से साइन इन है",
      es: "Sesión iniciada desde {date}",
      fr: "Connecté depuis le {date}",
      ar: "مسجَّل الدخول منذ {date}",
      bn: "{date} থেকে সাইন ইন করা আছে",
      pt: "Conectado desde {date}",
      ru: "Вход выполнен {date}",
      ur: "{date} سے سائن اِن ہے",
      id: "Masuk sejak {date}",
      de: "Angemeldet seit {date}",
      sw: "Umeingia tangu {date}",
      mr: "{date} पासून साइन इन आहे",
    }),
    expires: t({
      en: "This session expires {date}",
      zh: "本次登录将于 {date} 过期",
      ja: "このログインの有効期限は {date} です",
      ko: "이 로그인은 {date}에 만료됩니다",
      hi: "यह सत्र {date} को समाप्त होगा",
      es: "Esta sesión caduca el {date}",
      fr: "Cette session expire le {date}",
      ar: "تنتهي هذه الجلسة في {date}",
      bn: "এই সেশনের মেয়াদ শেষ হবে {date}",
      pt: "Esta sessão expira em {date}",
      ru: "Сеанс истекает {date}",
      ur: "یہ سیشن {date} کو ختم ہوگا",
      id: "Sesi ini berakhir pada {date}",
      de: "Diese Sitzung läuft am {date} ab",
      sw: "Kipindi hiki kitaisha {date}",
      mr: "हे सत्र {date} रोजी संपेल",
    }),
    hint: t({
      en: "Using Lianki keeps you signed in; signing out ends it on this device.",
      zh: "使用 Lianki 会让登录保持有效；在这台设备上退出登录即可结束它。",
      ja: "Lianki を使っているあいだはログインが続きます。このデバイスでログアウトすると終了します。",
      ko: "Lianki를 사용하면 로그인이 유지됩니다. 이 기기에서 로그아웃하면 끝납니다.",
      hi: "Lianki इस्तेमाल करते रहने से आप साइन इन रहते हैं; इस डिवाइस पर साइन आउट करने से यह खत्म हो जाता है।",
      es: "Usar Lianki mantiene tu sesión abierta; cerrar sesión la termina en este dispositivo.",
      fr: "Utiliser Lianki vous garde connecté ; vous déconnecter y met fin sur cet appareil.",
      ar: "استخدام Lianki يبقيك مسجَّل الدخول؛ وتسجيل الخروج ينهيه على هذا الجهاز.",
      bn: "Lianki ব্যবহার করলে আপনি সাইন ইন থাকেন; সাইন আউট করলে এই ডিভাইসে তা শেষ হয়।",
      pt: "Usar o Lianki mantém você conectado; sair encerra a sessão neste dispositivo.",
      ru: "Пока вы пользуетесь Lianki, вход сохраняется; выход из аккаунта завершает его на этом устройстве.",
      ur: "Lianki استعمال کرتے رہنے سے آپ سائن اِن رہتے ہیں؛ سائن آؤٹ کرنے سے یہ اس ڈیوائس پر ختم ہو جاتا ہے۔",
      id: "Memakai Lianki membuat Anda tetap masuk; keluar akan mengakhirinya di perangkat ini.",
      de: "Solange du Lianki nutzt, bleibst du angemeldet; Abmelden beendet es auf diesem Gerät.",
      sw: "Kutumia Lianki kunakuweka umeingia; kutoka kunakimaliza kwenye kifaa hiki.",
      mr: "Lianki वापरत राहिल्याने तुम्ही साइन इन राहता; साइन आउट केल्याने या डिव्हाइसवर ते संपते.",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  heading:
    "Heading of a small card on the profile page about the user's current sign-in (session) in this browser. Short noun phrase.",
  since:
    "Line in that card: when the user signed in on this browser. {date} is a date and time with its time zone, like '9 November 2026, 18:15 JST'; keep {date}. A short statement, not a question.",
  expires:
    "Line in that card: when this sign-in (session) will end unless it is renewed by using the app. {date} is a date and time with its time zone; keep {date}. One short sentence.",
  hint: "Small note under the two lines in that card: the expiry moves later while the app is used, and signing out ends the session on this device. Lianki is the app's name; keep it. One sentence.",
};

export default {
  ...dictionary,
  title: "/profile — this sign-in (session) card",
  description: describeKeys(
    "A small card on the profile page that tells a signed-in user when they signed in on this browser and when that sign-in expires. 'Session' means a sign-in in one browser, not a study session.",
    context,
  ),
} satisfies DeclarationContent;
