import { t, type Dictionary } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
const dictionary = {
  key: "my-mcp",
  content: {
    title: t({
      en: "MCP connections",
      zh: "MCP 连接",
      hi: "MCP कनेक्शन",
      es: "Conexiones MCP",
      fr: "Connexions MCP",
      ar: "اتصالات MCP",
      bn: "MCP সংযোগ",
      pt: "Conexões MCP",
      ru: "Подключения MCP",
      ur: "MCP کنکشن",
      id: "Koneksi MCP",
      de: "MCP-Verbindungen",
      ja: "MCP 接続",
      sw: "Miunganisho ya MCP",
      mr: "MCP कनेक्शन",
      ko: "MCP 연결",
    }),
    intro: t({
      en: "Connect your AI apps to your own cards and chat. Create a token below with only the permissions you need and an expiry, then copy its MCP connection URL.",
      zh: "将 AI 应用连接到你自己的卡片和聊天。在下方创建 token，只勾选所需权限并设置有效期，然后复制 MCP 连接地址。",
      hi: "अपने AI ऐप को अपने कार्ड और चैट से जोड़ें। नीचे आवश्यक अनुमतियों और समाप्ति के साथ टोकन बनाएं, फिर उसका MCP कनेक्शन URL कॉपी करें।",
      es: "Conecta tus apps de IA a tus tarjetas y chat. Crea un token abajo solo con los permisos necesarios y una fecha de caducidad; después copia su URL MCP.",
      fr: "Connectez vos apps IA à vos cartes et discussions. Créez ci-dessous un jeton avec uniquement les permissions nécessaires et une expiration, puis copiez son URL MCP.",
      ar: "اربط تطبيقات الذكاء الاصطناعي ببطاقاتك ودردشتك. أنشئ رمزًا أدناه بالصلاحيات المطلوبة فقط وتاريخ انتهاء، ثم انسخ رابط اتصال MCP.",
      bn: "নিজের কার্ড ও চ্যাটে AI অ্যাপ সংযুক্ত করুন। নিচে শুধু প্রয়োজনীয় অনুমতি ও মেয়াদসহ টোকেন তৈরি করে তার MCP সংযোগ URL কপি করুন।",
      pt: "Conecte apps de IA aos seus cartões e chat. Crie abaixo um token apenas com as permissões necessárias e uma validade, depois copie a URL MCP.",
      ru: "Подключите приложения ИИ к своим карточкам и чату. Создайте ниже токен только с нужными правами и сроком действия, затем скопируйте его URL MCP.",
      ur: "اپنے AI ایپس کو اپنے کارڈز اور چیٹ سے جوڑیں۔ نیچے صرف ضروری اجازتوں اور میعاد کے ساتھ ٹوکن بنائیں، پھر اس کا MCP کنکشن URL کاپی کریں۔",
      id: "Hubungkan aplikasi AI ke kartu dan chat Anda. Buat token di bawah dengan izin yang diperlukan dan masa berlaku, lalu salin URL koneksi MCP.",
      de: "Verbinden Sie KI-Apps mit Ihren Karten und Chats. Erstellen Sie unten ein Token mit den benötigten Berechtigungen und Ablaufdatum und kopieren Sie seine MCP-URL.",
      ja: "AI アプリを自分のカードやチャットに接続します。必要な権限と有効期限を選んで下でトークンを作成し、MCP 接続 URL をコピーしてください。",
      sw: "Unganisha programu za AI kwenye kadi na gumzo lako. Unda tokeni hapa chini yenye ruhusa unazohitaji na muda wa kuisha, kisha nakili URL yake ya MCP.",
      mr: "तुमची AI अॅप्स तुमच्या कार्ड्स आणि चॅटशी जोडा. खाली फक्त आवश्यक परवानग्या व कालमर्यादा देऊन टोकन तयार करा, नंतर MCP कनेक्शन URL कॉपी करा.",
      ko: "AI 앱을 내 카드와 채팅에 연결하세요. 아래에서 필요한 권한과 만료일을 선택해 토큰을 만든 뒤 MCP 연결 URL을 복사하세요.",
    }),
    guide: t({
      en: "Connection guide",
      zh: "连接教程",
      hi: "कनेक्शन गाइड",
      es: "Guía de conexión",
      fr: "Guide de connexion",
      ar: "دليل الاتصال",
      bn: "সংযোগ নির্দেশিকা",
      pt: "Guia de conexão",
      ru: "Инструкция подключения",
      ur: "کنکشن گائیڈ",
      id: "Panduan koneksi",
      de: "Verbindungsanleitung",
      ja: "接続ガイド",
      sw: "Mwongozo wa kuunganisha",
      mr: "कनेक्शन मार्गदर्शक",
      ko: "연결 안내",
    }),
  },
};
const context: Record<keyof typeof dictionary.content, string> = {
  title:
    "Heading and My data navigation card title for /my/mcp, the signed-in user’s own AI app connections. Keep MCP unchanged. A plural noun.",
  intro:
    "Intro and My data card description for /my/mcp. Explain the existing scoped API-token connection flow: create a token with minimal permissions and expiry, then copy its MCP URL. Do not promise OAuth or automatic account access.",
  guide: "Link from the MCP account page to the public connection tutorial. A short noun phrase.",
};
export default {
  ...dictionary,
  description: describeKeys("The user’s own MCP connection manager, /my/mcp.", context),
} satisfies Dictionary;
