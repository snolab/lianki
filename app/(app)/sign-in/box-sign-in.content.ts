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
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  serverOnly:
    "Message on a developer's own copy of the app (a 'box', keep the word box untranslated) when a page sent the user to sign in although they already are: that page is built by the box's server, which has no sign-in. Calm, factual, one sentence.",
  openOnLianki:
    "Link button under that message: opens the same app on the main site lianki.com, where the page works signed in. Keep lianki.com as is.",
  backHome:
    "Second link button under that message: goes to the app's home page on this box, which does work signed in.",
};

export default {
  ...dictionary,
  title: "A box's sign-in page when already signed in",
  description: describeKeys(
    "Shown only on a developer's box (its own copy of Lianki that signs in through lianki.com) when a server-drawn page asks for sign-in the box already has.",
    context,
  ),
} satisfies DeclarationContent;
