import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/**
 * A box's /sign-in (app/(app)/sign-in/BoxSignIn.tsx, docs/box-oauth.md) when
 * the tab is already signed in through lianki.com: a page drawn on the box's
 * own server sent the user here because that server cannot see the sign-in.
 */
const dictionary = {
  key: "box-sign-in",
  content: {
    serverOnly: t({
      en: "You are signed in, but this page is drawn on this box's own server, which cannot see your sign-in yet.",
      zh: "你已登录，但这个页面由本 box 自己的服务器生成，它还看不到你的登录。",
      hi: "आप साइन इन हैं, पर यह पेज इस box के अपने सर्वर पर बनता है, जो अभी आपका साइन-इन नहीं देख सकता।",
      es: "Has iniciado sesión, pero esta página la genera el propio servidor de este box, que aún no ve tu sesión.",
      fr: "Vous êtes connecté, mais cette page est générée par le serveur de ce box, qui ne voit pas encore votre connexion.",
      ar: "أنت مسجّل الدخول، لكن هذه الصفحة يرسمها خادم هذا الـ box نفسه، وهو لا يرى تسجيل دخولك بعد.",
      bn: "আপনি সাইন ইন করা আছেন, কিন্তু এই পেজটি এই box-এর নিজের সার্ভারে তৈরি হয়, যা এখনো আপনার সাইন-ইন দেখতে পায় না।",
      pt: "Você está conectado, mas esta página é gerada pelo próprio servidor deste box, que ainda não vê seu login.",
      ru: "Вы вошли, но эту страницу строит собственный сервер этого box, а он пока не видит ваш вход.",
      ur: "آپ سائن اِن ہیں، لیکن یہ صفحہ اس box کے اپنے سرور پر بنتا ہے، جو ابھی آپ کا سائن اِن نہیں دیکھ سکتا۔",
      id: "Anda sudah masuk, tetapi halaman ini dibuat oleh server box ini sendiri, yang belum bisa melihat sesi Anda.",
      de: "Du bist angemeldet, aber diese Seite erzeugt der eigene Server dieser Box, und der sieht deine Anmeldung noch nicht.",
      ja: "サインイン済みですが、このページはこの box 自身のサーバーで描かれていて、まだサインインが見えません。",
      sw: "Umeingia, lakini ukurasa huu unachorwa na seva ya box hii yenyewe, ambayo bado haioni kuingia kwako.",
      mr: "तुम्ही साइन इन आहात, पण हे पान या box च्या स्वतःच्या सर्व्हरवर बनते, ज्याला अजून तुमचे साइन-इन दिसत नाही.",
      ko: "로그인되어 있지만, 이 페이지는 이 box 자체 서버가 그리며 아직 로그인을 볼 수 없습니다.",
    }),
    openOnLianki: t({
      en: "Open on lianki.com",
      zh: "在 lianki.com 打开",
      hi: "lianki.com पर खोलें",
      es: "Abrir en lianki.com",
      fr: "Ouvrir sur lianki.com",
      ar: "افتح على lianki.com",
      bn: "lianki.com-এ খুলুন",
      pt: "Abrir em lianki.com",
      ru: "Открыть на lianki.com",
      ur: "lianki.com پر کھولیں",
      id: "Buka di lianki.com",
      de: "Auf lianki.com öffnen",
      ja: "lianki.com で開く",
      sw: "Fungua kwenye lianki.com",
      mr: "lianki.com वर उघडा",
      ko: "lianki.com에서 열기",
    }),
    backHome: t({
      en: "Back to home",
      zh: "回到首页",
      hi: "होम पर वापस",
      es: "Volver al inicio",
      fr: "Retour à l'accueil",
      ar: "العودة إلى الرئيسية",
      bn: "হোমে ফিরুন",
      pt: "Voltar ao início",
      ru: "На главную",
      ur: "ہوم پر واپس",
      id: "Kembali ke beranda",
      de: "Zur Startseite",
      ja: "ホームに戻る",
      sw: "Rudi nyumbani",
      mr: "मुख्यपृष्ठावर परत",
      ko: "홈으로 돌아가기",
    }),
    callbackFailed: t({
      en: "Signing in didn't finish. Please try again.",
      zh: "登录没有完成，请再试一次。",
      hi: "साइन इन पूरा नहीं हुआ। कृपया फिर से कोशिश करें।",
      es: "No se completó el inicio de sesión. Inténtalo de nuevo.",
      fr: "La connexion n’a pas abouti. Veuillez réessayer.",
      ar: "لم يكتمل تسجيل الدخول. يُرجى المحاولة مرة أخرى.",
      bn: "সাইন ইন শেষ হয়নি। অনুগ্রহ করে আবার চেষ্টা করুন।",
      pt: "O login não foi concluído. Tente novamente.",
      ru: "Вход не завершился. Попробуйте ещё раз.",
      ur: "سائن اِن مکمل نہیں ہوا۔ براہِ کرم دوبارہ کوشش کریں۔",
      id: "Proses masuk tidak selesai. Silakan coba lagi.",
      de: "Die Anmeldung wurde nicht abgeschlossen. Bitte versuch es noch einmal.",
      ja: "ログインが完了しませんでした。もう一度お試しください。",
      sw: "Kuingia hakukukamilika. Tafadhali jaribu tena.",
      mr: "साइन इन पूर्ण झाले नाही. कृपया पुन्हा प्रयत्न करा.",
      ko: "로그인이 완료되지 않았습니다. 다시 시도해 주세요.",
    }),
    signInAgain: t({
      en: "Sign in again",
      zh: "重新登录",
      hi: "फिर से साइन इन करें",
      es: "Volver a iniciar sesión",
      fr: "Se reconnecter",
      ar: "تسجيل الدخول مرة أخرى",
      bn: "আবার সাইন ইন করুন",
      pt: "Entrar novamente",
      ru: "Войти снова",
      ur: "دوبارہ سائن اِن کریں",
      id: "Masuk lagi",
      de: "Erneut anmelden",
      ja: "もう一度ログイン",
      sw: "Ingia tena",
      mr: "पुन्हा साइन इन करा",
      ko: "다시 로그인",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  serverOnly:
    "Message on a developer's own copy of the app (a 'box', keep the word box untranslated) when a page sent the user to sign in although they already are: that page is built by the box's server, which has no sign-in. Calm, factual, one sentence.",
  openOnLianki:
    "Link button under that message: opens the same app on the main site lianki.com, where the page works signed in. Keep lianki.com as is.",
  backHome:
    "Second link button under that message: goes to the app's home page on this box, which does work signed in. Also shown under callbackFailed.",
  callbackFailed:
    "Message on a box's sign-in return page (after lianki.com sent the browser back) when finishing the sign-in failed, e.g. an expired code or no network. No technical detail. Calm, two short sentences.",
  signInAgain:
    "Link button under callbackFailed on a box's sign-in return page: starts signing in again. Imperative phrase.",
};

export default {
  ...dictionary,
  title: "A box's sign-in page when already signed in",
  description: describeKeys(
    "Shown only on a developer's box (its own copy of Lianki that signs in through lianki.com): when a server-drawn page asks for sign-in the box already has, and when finishing a sign-in on the return page failed.",
    context,
  ),
} satisfies DeclarationContent;
