import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * Settings → Language: the app's UI language, which follows the account
 * (app/components/LanguageSettings.tsx, lib/account-locale.ts,
 * docs/prefs-sync.md "UI language").
 */
const dictionary = {
  key: "language-settings",
  content: {
    heading: t({
      en: "Language",
      zh: "语言",
      hi: "भाषा",
      es: "Idioma",
      fr: "Langue",
      ar: "اللغة",
      bn: "ভাষা",
      pt: "Idioma",
      ru: "Язык",
      ur: "زبان",
      id: "Bahasa",
      de: "Sprache",
      ja: "言語",
      sw: "Lugha",
      mr: "भाषा",
      ko: "언어",
    }),
    help: t({
      en: "The language of Lianki's menus and buttons. It follows your account to every device you sign in on.",
      zh: "Lianki 菜单和按钮使用的语言。它跟随你的账号，在你登录的每台设备上都一样。",
      hi: "Lianki के मेनू और बटनों की भाषा। यह आपके खाते के साथ हर उस डिवाइस पर जाती है जिस पर आप साइन इन करते हैं।",
      es: "El idioma de los menús y botones de Lianki. Va con tu cuenta a cada dispositivo en el que inicies sesión.",
      fr: "La langue des menus et des boutons de Lianki. Elle suit votre compte sur chaque appareil où vous vous connectez.",
      ar: "لغة قوائم Lianki وأزراره. تنتقل مع حسابك إلى كل جهاز تسجّل الدخول عليه.",
      bn: "Lianki-এর মেনু ও বোতামের ভাষা। আপনি যে ডিভাইসেই সাইন ইন করুন, এটি আপনার অ্যাকাউন্টের সঙ্গে থাকে।",
      pt: "O idioma dos menus e botões do Lianki. Ele acompanha sua conta em todo dispositivo em que você entrar.",
      ru: "Язык меню и кнопок Lianki. Он следует за вашим аккаунтом на каждое устройство, где вы входите.",
      ur: "Lianki کے مینو اور بٹنوں کی زبان۔ یہ آپ کے اکاؤنٹ کے ساتھ ہر اس آلے پر جاتی ہے جس پر آپ سائن ان کریں۔",
      id: "Bahasa menu dan tombol Lianki. Bahasa ini mengikuti akun Anda di setiap perangkat tempat Anda masuk.",
      de: "Die Sprache der Menüs und Schaltflächen von Lianki. Sie folgt deinem Konto auf jedes Gerät, auf dem du dich anmeldest.",
      ja: "Lianki のメニューやボタンの言語です。アカウントに保存され、サインインするすべての端末で同じになります。",
      sw: "Lugha ya menyu na vitufe vya Lianki. Inafuata akaunti yako kwenye kila kifaa unachoingia.",
      mr: "Lianki च्या मेनू आणि बटणांची भाषा. तुम्ही ज्या डिव्हाइसवर साइन इन कराल तिथे ती तुमच्या खात्यासोबत येते.",
      ko: "Lianki 메뉴와 버튼의 언어입니다. 로그인하는 모든 기기에서 계정을 따라갑니다.",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  heading:
    "Section heading on the Settings page for the app's interface language (menus, buttons), not the language the user studies. Short noun, as settings menus name this group.",
  help: "Small help text under the language picker in Settings → Language: what the setting changes (the language of the app's menus and buttons) and that the choice is saved to the user's account, so every device they sign in on uses it. Two short factual sentences; keep Lianki as is.",
};

export default {
  ...dictionary,
  title: "Settings → Language — the app's interface language",
  description: describeKeys(
    "A section of the Settings page: the language of Lianki's own interface (menus, buttons, messages), picked from a list and saved to the account. Not the language the user is learning. Lianki is a name and stays as it is.",
    context,
  ),
} satisfies DeclarationContent;
