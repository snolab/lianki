import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/** /privacy: notes on how Lianki handles data (docs/partner-ai.md, "Privacy"). */
const dictionary = {
  key: "privacy-page",
  content: {
    title: t({
      en: "Privacy",
      zh: "隐私",
      hi: "गोपनीयता",
      es: "Privacidad",
      fr: "Confidentialité",
      ar: "الخصوصية",
      bn: "গোপনীয়তা",
      pt: "Privacidade",
      ru: "Конфиденциальность",
      ur: "رازداری",
      id: "Privasi",
      de: "Datenschutz",
      ja: "プライバシー",
      sw: "Faragha",
      mr: "गोपनीयता",
      ko: "개인정보",
    }),
    intro: t({
      en: "Notes on how Lianki handles your data. A full privacy policy is being written.",
      zh: "关于 Lianki 如何处理你的数据的说明。完整的隐私政策正在撰写中。",
      hi: "Lianki आपके डेटा को कैसे संभालता है, इसके बारे में नोट्स। पूरी गोपनीयता नीति अभी लिखी जा रही है।",
      es: "Notas sobre cómo Lianki trata tus datos. Estamos redactando una política de privacidad completa.",
      fr: "Notes sur la façon dont Lianki traite vos données. Une politique de confidentialité complète est en cours de rédaction.",
      ar: "ملاحظات حول كيفية تعامل Lianki مع بياناتك. سياسة خصوصية كاملة قيد الكتابة.",
      bn: "Lianki আপনার ডেটা কীভাবে ব্যবহার করে, সে বিষয়ে কিছু নোট। পূর্ণ গোপনীয়তা নীতি লেখা হচ্ছে।",
      pt: "Notas sobre como o Lianki trata seus dados. Uma política de privacidade completa está sendo escrita.",
      ru: "Заметки о том, как Lianki обращается с вашими данными. Полная политика конфиденциальности пишется.",
      ur: "Lianki آپ کے ڈیٹا کو کیسے سنبھالتا ہے، اس بارے میں نوٹس۔ مکمل رازداری پالیسی لکھی جا رہی ہے۔",
      id: "Catatan tentang cara Lianki menangani data Anda. Kebijakan privasi lengkap sedang ditulis.",
      de: "Hinweise dazu, wie Lianki mit deinen Daten umgeht. Eine vollständige Datenschutzerklärung wird gerade geschrieben.",
      ja: "Lianki があなたのデータをどう扱うかについての説明です。完全なプライバシーポリシーは作成中です。",
      sw: "Maelezo kuhusu jinsi Lianki inavyoshughulikia data yako. Sera kamili ya faragha inaandikwa.",
      mr: "Lianki तुमचा डेटा कसा हाताळते याबद्दल टिपा. संपूर्ण गोपनीयता धोरण लिहिले जात आहे.",
      ko: "Lianki가 데이터를 어떻게 다루는지에 대한 안내입니다. 전체 개인정보 처리방침은 작성 중입니다.",
    }),
    aiHeading: t({
      en: "Learning Partner AI replies",
      zh: "学习伙伴的 AI 回复",
      hi: "लर्निंग पार्टनर के AI जवाब",
      es: "Respuestas de IA del Learning Partner",
      fr: "Réponses IA du Learning Partner",
      ar: "ردود الذكاء الاصطناعي من Learning Partner",
      bn: "Learning Partner-এর AI উত্তর",
      pt: "Respostas de IA do Learning Partner",
      ru: "Ответы ИИ Learning Partner",
      ur: "Learning Partner کے AI جوابات",
      id: "Balasan AI Learning Partner",
      de: "KI-Antworten des Learning Partners",
      ja: "Learning Partner の AI 返信",
      sw: "Majibu ya AI ya Learning Partner",
      mr: "Learning Partner ची AI उत्तरे",
      ko: "Learning Partner의 AI 답장",
    }),
    aiBody: t({
      en: "Replies in the Learning Partner chat are written by an AI model (DeepSeek) hosted on Cloudflare Workers AI. To write a reply, the model receives your message, the recent messages of your chat, a short summary of your own study data (word lists, cards due, study plan) and the page context you send with a message. Cloudflare Workers AI does not use this content to train models. Lianki's logs keep only token counts and timings, not the text. The developer may read the chat. Each reply is paid from your credits.",
      zh: "学习伙伴聊天中的回复由运行在 Cloudflare Workers AI 上的 AI 模型（DeepSeek）生成。为了写出回复，模型会收到你的消息、聊天中最近的消息、你自己学习数据的简短摘要（单词表、待复习卡片、学习计划），以及你随消息发送的页面内容。Cloudflare Workers AI 不会用这些内容训练模型。Lianki 的日志只记录 token 数量和耗时，不记录文字。开发者可能会阅读聊天内容。每条回复都从你的积分中扣除。",
      hi: "लर्निंग पार्टनर चैट के जवाब Cloudflare Workers AI पर चलने वाला एक AI मॉडल (DeepSeek) लिखता है। जवाब लिखने के लिए मॉडल को आपका संदेश, चैट के हाल के संदेश, आपके अपने अध्ययन डेटा का छोटा सारांश (शब्द सूचियाँ, बाकी कार्ड, अध्ययन योजना) और संदेश के साथ भेजा गया पेज का संदर्भ मिलता है। Cloudflare Workers AI इस सामग्री से मॉडल प्रशिक्षित नहीं करता। Lianki के लॉग में केवल टोकन की संख्या और समय रहते हैं, पाठ नहीं। डेवलपर चैट पढ़ सकता है। हर जवाब आपके क्रेडिट से चुकाया जाता है।",
      es: "Las respuestas del chat del Learning Partner las escribe un modelo de IA (DeepSeek) alojado en Cloudflare Workers AI. Para escribir una respuesta, el modelo recibe tu mensaje, los mensajes recientes del chat, un breve resumen de tus propios datos de estudio (listas de palabras, tarjetas pendientes, plan de estudio) y el contexto de la página que envías con un mensaje. Cloudflare Workers AI no usa este contenido para entrenar modelos. Los registros de Lianki solo guardan recuentos de tokens y tiempos, no el texto. El desarrollador puede leer el chat. Cada respuesta se paga con tus créditos.",
      fr: "Les réponses du chat du Learning Partner sont rédigées par un modèle d’IA (DeepSeek) hébergé sur Cloudflare Workers AI. Pour rédiger une réponse, le modèle reçoit votre message, les messages récents du chat, un court résumé de vos propres données d’étude (listes de mots, cartes à réviser, plan d’étude) et le contexte de page que vous envoyez avec un message. Cloudflare Workers AI n’utilise pas ce contenu pour entraîner des modèles. Les journaux de Lianki ne gardent que le nombre de tokens et les durées, pas le texte. Le développeur peut lire le chat. Chaque réponse est payée avec vos crédits.",
      ar: "يكتب الردود في محادثة Learning Partner نموذج ذكاء اصطناعي (DeepSeek) مستضاف على Cloudflare Workers AI. لكتابة الرد، يتلقى النموذج رسالتك والرسائل الأخيرة في المحادثة وملخصًا قصيرًا لبيانات دراستك الخاصة (قوائم الكلمات، البطاقات المستحقة، خطة الدراسة) وسياق الصفحة الذي ترسله مع الرسالة. لا تستخدم Cloudflare Workers AI هذا المحتوى لتدريب النماذج. تحتفظ سجلات Lianki بعدد الرموز والأوقات فقط، لا بالنص. قد يقرأ المطوّر المحادثة. يُدفع كل رد من رصيدك.",
      bn: "Learning Partner চ্যাটের উত্তর লেখে Cloudflare Workers AI-তে চলা একটি AI মডেল (DeepSeek)। উত্তর লিখতে মডেলটি পায় আপনার বার্তা, চ্যাটের সাম্প্রতিক বার্তা, আপনার নিজের পড়াশোনার ডেটার ছোট সারাংশ (শব্দ তালিকা, বাকি কার্ড, পড়ার পরিকল্পনা) এবং বার্তার সঙ্গে পাঠানো পেজের প্রসঙ্গ। Cloudflare Workers AI এই কনটেন্ট দিয়ে মডেল প্রশিক্ষণ দেয় না। Lianki-র লগে শুধু টোকেনের সংখ্যা ও সময় থাকে, লেখা নয়। ডেভেলপার চ্যাট পড়তে পারেন। প্রতিটি উত্তরের খরচ আপনার ক্রেডিট থেকে যায়।",
      pt: "As respostas do chat do Learning Partner são escritas por um modelo de IA (DeepSeek) hospedado no Cloudflare Workers AI. Para escrever uma resposta, o modelo recebe sua mensagem, as mensagens recentes do chat, um breve resumo dos seus próprios dados de estudo (listas de palavras, cartões pendentes, plano de estudo) e o contexto da página que você envia com uma mensagem. O Cloudflare Workers AI não usa esse conteúdo para treinar modelos. Os registros do Lianki guardam apenas contagens de tokens e tempos, não o texto. O desenvolvedor pode ler o chat. Cada resposta é paga com seus créditos.",
      ru: "Ответы в чате Learning Partner пишет модель ИИ (DeepSeek), размещённая в Cloudflare Workers AI. Чтобы написать ответ, модель получает ваше сообщение, последние сообщения чата, краткую сводку ваших собственных учебных данных (списки слов, карточки к повторению, учебный план) и контекст страницы, который вы отправляете с сообщением. Cloudflare Workers AI не использует этот контент для обучения моделей. Журналы Lianki хранят только число токенов и время, но не текст. Разработчик может читать чат. Каждый ответ оплачивается вашими кредитами.",
      ur: "Learning Partner چیٹ کے جوابات Cloudflare Workers AI پر چلنے والا ایک AI ماڈل (DeepSeek) لکھتا ہے۔ جواب لکھنے کے لیے ماڈل کو آپ کا پیغام، چیٹ کے حالیہ پیغامات، آپ کے اپنے مطالعے کے ڈیٹا کا مختصر خلاصہ (الفاظ کی فہرستیں، باقی کارڈز، مطالعے کا منصوبہ) اور پیغام کے ساتھ بھیجا گیا صفحے کا سیاق ملتا ہے۔ Cloudflare Workers AI اس مواد سے ماڈلز کی تربیت نہیں کرتا۔ Lianki کے لاگز میں صرف ٹوکن کی تعداد اور وقت محفوظ ہوتے ہیں، متن نہیں۔ ڈیولپر چیٹ پڑھ سکتا ہے۔ ہر جواب کی ادائیگی آپ کے کریڈٹس سے ہوتی ہے۔",
      id: "Balasan di obrolan Learning Partner ditulis oleh model AI (DeepSeek) yang berjalan di Cloudflare Workers AI. Untuk menulis balasan, model menerima pesan Anda, pesan-pesan terbaru di obrolan, ringkasan singkat data belajar Anda sendiri (daftar kata, kartu jatuh tempo, rencana belajar) dan konteks halaman yang Anda kirim bersama pesan. Cloudflare Workers AI tidak memakai konten ini untuk melatih model. Log Lianki hanya menyimpan jumlah token dan waktu, bukan teksnya. Pengembang dapat membaca obrolan. Setiap balasan dibayar dari kredit Anda.",
      de: "Die Antworten im Learning-Partner-Chat schreibt ein KI-Modell (DeepSeek), das auf Cloudflare Workers AI läuft. Für eine Antwort erhält das Modell deine Nachricht, die letzten Nachrichten des Chats, eine kurze Zusammenfassung deiner eigenen Lerndaten (Wortlisten, fällige Karten, Lernplan) und den Seitenkontext, den du mit einer Nachricht sendest. Cloudflare Workers AI nutzt diese Inhalte nicht zum Trainieren von Modellen. Lianki protokolliert nur Token-Anzahlen und Zeiten, nicht den Text. Der Entwickler kann den Chat lesen. Jede Antwort wird mit deinen Credits bezahlt.",
      ja: "Learning Partner チャットの返信は、Cloudflare Workers AI 上で動く AI モデル（DeepSeek）が書いています。返信を書くために、モデルはあなたのメッセージ、チャットの最近のメッセージ、あなた自身の学習データの短い要約（単語リスト、復習待ちのカード、学習プラン）、メッセージと一緒に送ったページの内容を受け取ります。Cloudflare Workers AI はこの内容をモデルの学習に使いません。Lianki のログに残るのはトークン数と所要時間だけで、本文は残りません。開発者がチャットを読むことがあります。返信ごとにクレジットから支払われます。",
      sw: "Majibu katika gumzo la Learning Partner yanaandikwa na modeli ya AI (DeepSeek) inayoendeshwa kwenye Cloudflare Workers AI. Ili kuandika jibu, modeli inapokea ujumbe wako, jumbe za karibuni za gumzo, muhtasari mfupi wa data yako mwenyewe ya masomo (orodha za maneno, kadi zinazosubiri, mpango wa masomo) na muktadha wa ukurasa unaoutuma pamoja na ujumbe. Cloudflare Workers AI haitumii maudhui haya kufunza modeli. Kumbukumbu za Lianki huhifadhi idadi ya tokeni na muda tu, si maandishi. Msanidi programu anaweza kusoma gumzo. Kila jibu hulipwa kutoka kwa krediti zako.",
      mr: "Learning Partner चॅटमधील उत्तरे Cloudflare Workers AI वर चालणारे AI मॉडेल (DeepSeek) लिहिते. उत्तर लिहिण्यासाठी मॉडेलला तुमचा संदेश, चॅटमधील अलीकडील संदेश, तुमच्या स्वतःच्या अभ्यास डेटाचा छोटा सारांश (शब्द याद्या, बाकी कार्ड्स, अभ्यास योजना) आणि संदेशासोबत पाठवलेला पानाचा संदर्भ मिळतो. Cloudflare Workers AI या मजकुराचा वापर मॉडेल प्रशिक्षणासाठी करत नाही. Lianki च्या लॉगमध्ये फक्त टोकन संख्या आणि वेळ राहतात, मजकूर नाही. डेव्हलपर चॅट वाचू शकतो. प्रत्येक उत्तर तुमच्या क्रेडिट्समधून दिले जाते.",
      ko: "Learning Partner 채팅의 답장은 Cloudflare Workers AI에서 실행되는 AI 모델(DeepSeek)이 작성합니다. 답장을 쓰기 위해 모델은 내 메시지, 채팅의 최근 메시지, 내 학습 데이터의 짧은 요약(단어 목록, 복습할 카드, 학습 계획), 메시지와 함께 보낸 페이지 내용을 받습니다. Cloudflare Workers AI는 이 내용을 모델 학습에 사용하지 않습니다. Lianki의 로그에는 토큰 수와 소요 시간만 남고 본문은 남지 않습니다. 개발자가 채팅을 읽을 수 있습니다. 답장마다 크레딧에서 비용이 차감됩니다.",
    }),
  },
};

const context: Record<keyof typeof dictionary.content, string> = {
  title: "Heading and browser-tab title of the /privacy page. One word: privacy.",
  intro:
    "Paragraph under the /privacy heading: this page collects notes on how Lianki handles the user's data, and a complete privacy policy is still being written. Plain, factual, two sentences. Lianki is a product name.",
  aiHeading:
    "Section heading on /privacy about the Learning Partner chat (the chat assistant on every page) whose replies are written by an AI. Keep 'Learning Partner' as the product's English name. Short noun phrase.",
  aiBody:
    "Section body on /privacy: factual disclosure of what the AI model behind the Learning Partner chat receives and where it runs. Keep 'DeepSeek', 'Cloudflare Workers AI', 'Learning Partner' and 'Lianki' exactly. 'Credits' is the prepaid wallet balance on the Membership page (积分 in Chinese). Plain, precise sentences; do not add or drop any item from the list of what is sent.",
};

export default {
  ...dictionary,
  title: "/privacy — notes on how Lianki handles data",
  description: describeKeys(
    "The /privacy page: notes on how Lianki handles user data, starting with the Learning Partner chat's AI replies. Factual legal-style disclosure; precise, no marketing.",
    context,
  ),
} satisfies DeclarationContent;
