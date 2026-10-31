/**
 * Text of the legal pages, in English and Japanese. Other locales read the
 * English text with a note (LEGAL_LABELS.fallbackNote).
 *
 * Inline links are written `[label](href)`; LegalDoc renders them.
 * Facts that change in one place (email, name, prices) come from lib/legal.ts
 * and lib/payments/passes.ts so the pages cannot drift from the app.
 */
import { PASSES } from "@/lib/payments/passes";
import { SELLER, SITE_URL, SUPPORT_EMAIL, OWNER_LEGAL_NAME, type LegalLocale } from "@/lib/legal";

export type Block = string | { list: string[] };
export interface Section {
  heading: string;
  blocks: Block[];
}
export interface LegalDocText {
  title: string;
  intro?: Block[];
  sections: Section[];
}
export interface TokushohoText {
  title: string;
  intro: string;
  rows: [label: string, value: Block[]][];
}

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;
const P1 = PASSES["pro-1m"];
const P12 = PASSES["pro-12m"];
const MAIL = `[${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL})`;

// ── Terms of Service ──────────────────────────────────────────────────────────

const termsEn: LegalDocText = {
  title: "Terms of Service",
  intro: [
    `These Terms govern your use of Lianki (${SITE_URL}), including the website, the userscript and the browser extension (together, "the Service"). The Service is operated by ${SELLER}, a sole proprietorship in Japan ("we", "us"). By creating an account or using the Service you agree to these Terms.`,
  ],
  sections: [
    {
      heading: "1. Accounts",
      blocks: [
        "You can sign in with Google, GitHub, an email code or link, or a passkey. Keep your sign-in methods secure; you are responsible for activity on your account.",
        "You must be at least 13 years old, or the minimum age for using online services without parental consent in your country if that is higher. If you are a minor, you need your parent or guardian's consent to buy anything.",
      ],
    },
    {
      heading: "2. The Service",
      blocks: [
        "Lianki is a spaced-repetition learning tool. Some features are free; others require Lianki Pro. New accounts may receive a free Pro trial; its length is shown on the [membership page](/membership).",
        "AI features (translation, example sentences, text-to-speech, speech recognition) produce machine-generated output that may be inaccurate. Check anything that matters.",
        "The userscript and the extension run on web pages you choose to visit. You are responsible for complying with the terms of those sites.",
      ],
    },
    {
      heading: "3. Pro passes",
      blocks: [
        `Pro is sold as prepaid passes: ${P1.name} (${yen(P1.amount)}, ${P1.days} days) and ${P12.name} (${yen(P12.amount)}, ${P12.days} days). Prices are in Japanese yen and include any applicable consumption tax.`,
        {
          list: [
            "A pass is a one-time payment. It does not renew automatically and you are never charged again unless you buy another pass.",
            "Pro starts as soon as payment is confirmed. Buying a pass while Pro is still running adds the days to your current end date.",
            "Passes are personal to your account and cannot be transferred or exchanged for cash.",
            "Payments are processed by our payment partners (for example Stripe, or Paddle acting as reseller and merchant of record where applicable). Where a partner is the merchant of record, its buyer terms also apply to that purchase.",
          ],
        },
        "Refunds are covered by the [Refund Policy](/legal/refund).",
      ],
    },
    {
      heading: "4. Sponsorships, gift codes and invites",
      blocks: [
        "Supporting Lianki through a sponsorship platform (GitHub Sponsors, Patreon or afdian) can grant Pro as described on the membership page. Payments there are governed by that platform's terms.",
        "Gift codes and invite rewards add Pro days. They have no cash value and cannot be sold.",
      ],
    },
    {
      heading: "5. Your content",
      blocks: [
        "You keep all rights to the cards, notes, words and materials you add. You grant us a licence to store, copy, process and display them only as needed to run the Service for you (for example, syncing between your devices and sending text to our AI provider when you use an AI feature).",
        "You are responsible for your content and must have the right to use it. Do not upload anything unlawful or that infringes others' rights.",
      ],
    },
    {
      heading: "6. Acceptable use",
      blocks: [
        {
          list: [
            "Do not use the Service for anything illegal, or to harass or harm others.",
            "Do not interfere with or overload the Service, probe it for vulnerabilities without permission, or bypass limits or access controls.",
            "Do not scrape the Service or resell access to it.",
          ],
        },
        "We may suspend or close accounts that break these rules. Where reasonable we will tell you first.",
      ],
    },
    {
      heading: "7. Changes and availability",
      blocks: [
        "We are continually improving Lianki and may add, change or remove features. We aim to keep the Service available but do not guarantee it will be uninterrupted or error-free.",
        "If we discontinue Pro altogether, we will refund the unused part of any pass still running, pro rata.",
      ],
    },
    {
      heading: "8. Ending your account",
      blocks: [
        `You can stop using Lianki at any time. You can export your data from the app, and you can ask us to delete your account by writing to ${MAIL}.`,
      ],
    },
    {
      heading: "9. Disclaimer and limitation of liability",
      blocks: [
        'The Service is provided "as is". To the extent permitted by law, we make no warranties beyond those stated in these Terms.',
        "To the extent permitted by law, our total liability to you for any claim relating to the Service is limited to the amount you paid us in the 12 months before the claim. This limit does not apply to damage caused by our intent or gross negligence, or where the law (including the Japanese Consumer Contract Act) does not allow it. Nothing in these Terms limits rights you have as a consumer under the law of your country.",
      ],
    },
    {
      heading: "10. Changes to these Terms",
      blocks: [
        "We may update these Terms. We will post the new version here with a new date and, for significant changes, tell you in the app or by email in advance. Continuing to use the Service after a change takes effect means you accept it.",
      ],
    },
    {
      heading: "11. Governing law",
      blocks: [
        "These Terms are governed by the laws of Japan. Any dispute will be heard by the district court having jurisdiction over our place of business as the court of first instance, without prejudice to any mandatory rights you have to bring proceedings where you live.",
        "The Japanese version of these Terms is equally authoritative; if the two differ, the Japanese version prevails for users in Japan.",
      ],
    },
    {
      heading: "12. Contact",
      blocks: [`${SELLER} — ${MAIL}, or the [contact form](/contacts).`],
    },
  ],
};

const termsJa: LegalDocText = {
  title: "利用規約",
  intro: [
    `本規約は、Lianki（${SITE_URL}。ウェブサイト、ユーザースクリプトおよびブラウザ拡張機能を含み、以下「本サービス」といいます）の利用条件を定めるものです。本サービスは、日本の個人事業主である${SELLER}（以下「当方」といいます）が運営しています。アカウントを作成し、または本サービスを利用することにより、利用者は本規約に同意したものとみなされます。`,
  ],
  sections: [
    {
      heading: "第1条（アカウント）",
      blocks: [
        "Google、GitHub、メールのコードまたはリンク、パスキーでサインインできます。サインイン手段は利用者の責任で管理してください。アカウント上の行為は利用者の責任となります。",
        "本サービスは13歳以上（お住まいの国で保護者の同意なくオンラインサービスを利用できる年齢がそれより高い場合はその年齢以上）の方を対象とします。未成年の方が購入する場合は、親権者の同意を得てください。",
      ],
    },
    {
      heading: "第2条（本サービス）",
      blocks: [
        "Liankiは間隔反復による学習ツールです。一部の機能は無料で、その他の機能はLianki Proが必要です。新規アカウントには無料のPro体験期間が付与される場合があり、その期間は[メンバーシップページ](/membership)に表示します。",
        "AI機能（翻訳、例文生成、音声合成、音声認識）は機械による生成結果であり、誤りを含む場合があります。重要な内容はご自身でご確認ください。",
        "ユーザースクリプトおよび拡張機能は、利用者が訪問するウェブページ上で動作します。各サイトの利用条件の遵守は利用者の責任となります。",
      ],
    },
    {
      heading: "第3条（Proパス）",
      blocks: [
        `Proは前払い式のパスとして販売します。1か月パス（${P1.amount.toLocaleString("ja-JP")}円・${P1.days}日間）、12か月パス（${P12.amount.toLocaleString("ja-JP")}円・${P12.days}日間）。価格は日本円の税込表示です。`,
        {
          list: [
            "パスは1回限りのお支払いです。自動更新はなく、新たにパスを購入しない限り再度課金されることはありません。",
            "Pro期間は決済の完了と同時に開始します。Pro期間中に購入した場合は、現在の終了日に日数が加算されます。",
            "パスは購入したアカウントに帰属し、譲渡・換金はできません。",
            "決済は当方の決済パートナー（例：Stripe。該当する場合は再販事業者・販売者（merchant of record）としてのPaddle）が処理します。決済パートナーが販売者となる購入には、そのパートナーの購入者向け規約も適用されます。",
          ],
        },
        "返金については[返金ポリシー](/legal/refund)をご覧ください。",
      ],
    },
    {
      heading: "第4条（スポンサー、ギフトコード、招待）",
      blocks: [
        "スポンサープラットフォーム（GitHub Sponsors、Patreon、愛発電（afdian））を通じた支援により、メンバーシップページに記載のとおりProが付与される場合があります。当該プラットフォームでのお支払いには、各プラットフォームの規約が適用されます。",
        "ギフトコードおよび招待特典はPro日数を付与するもので、現金価値はなく、売買はできません。",
      ],
    },
    {
      heading: "第5条（利用者のコンテンツ）",
      blocks: [
        "利用者が登録したカード、メモ、単語、教材の権利は利用者に留保されます。利用者は当方に対し、本サービスを提供するために必要な範囲（端末間の同期、AI機能利用時のAI提供事業者へのテキスト送信など）に限り、これらを保存・複製・処理・表示する権利を許諾します。",
        "コンテンツについては利用者が責任を負い、利用する権利を有している必要があります。違法なもの、他者の権利を侵害するものを登録しないでください。",
      ],
    },
    {
      heading: "第6条（禁止事項）",
      blocks: [
        {
          list: [
            "法令に違反する行為、他者への嫌がらせや危害を加える行為",
            "本サービスの運営を妨害し、過度な負荷をかけ、許可なく脆弱性を調査し、または利用制限・アクセス制御を回避する行為",
            "本サービスのスクレイピング、利用権の転売",
          ],
        },
        "これらに違反したアカウントは、停止または削除する場合があります。合理的に可能な場合は事前にお知らせします。",
      ],
    },
    {
      heading: "第7条（変更および提供の中断）",
      blocks: [
        "当方は本サービスの機能を追加・変更・削除することがあります。安定した提供に努めますが、中断や不具合がないことを保証するものではありません。",
        "Proの提供を終了する場合、有効期間が残っているパスについては、未使用期間分を日割りで返金します。",
      ],
    },
    {
      heading: "第8条（退会）",
      blocks: [
        `利用者はいつでも本サービスの利用をやめることができます。データはアプリからエクスポートでき、アカウントの削除は${MAIL}までご依頼ください。`,
      ],
    },
    {
      heading: "第9条（免責および責任の制限）",
      blocks: [
        "本サービスは現状有姿で提供されます。法令で認められる範囲で、本規約に定めるもの以外の保証は行いません。",
        "法令で認められる範囲で、本サービスに関して当方が負う責任の総額は、請求の原因が生じた日の前12か月間に利用者が当方に支払った金額を上限とします。ただし、当方の故意または重大な過失による損害、その他消費者契約法等の法令によりこの制限が認められない場合には適用しません。本規約は、お住まいの国の法令により消費者に認められた権利を制限するものではありません。",
      ],
    },
    {
      heading: "第10条（規約の変更）",
      blocks: [
        "当方は本規約を変更することがあります。変更後の規約は日付を更新してこのページに掲載し、重要な変更は事前にアプリ内またはメールでお知らせします。変更の効力発生後に本サービスを利用した場合、変更に同意したものとみなします。",
      ],
    },
    {
      heading: "第11条（準拠法および管轄）",
      blocks: [
        "本規約は日本法に準拠します。本サービスに関する紛争は、当方の事業所の所在地を管轄する地方裁判所を第一審の管轄裁判所とします。ただし、法令により利用者に認められた居住地での訴訟提起の権利を妨げません。",
      ],
    },
    {
      heading: "第12条（お問い合わせ）",
      blocks: [`${SELLER} — ${MAIL}、または[お問い合わせフォーム](/contacts)。`],
    },
  ],
};

// ── Privacy Policy ────────────────────────────────────────────────────────────

const privacyEn: LegalDocText = {
  title: "Privacy Policy",
  intro: [
    `This policy explains what personal data Lianki collects, why, and who processes it. The operator responsible for your data is ${SELLER}, a sole proprietorship in Japan. We handle personal information in accordance with Japan's Act on the Protection of Personal Information (APPI) and, for users in the EU/EEA and UK, the GDPR.`,
  ],
  sections: [
    {
      heading: "1. What we collect",
      blocks: [
        {
          list: [
            "Account data: your name, email address and profile picture from the sign-in method you choose (Google, GitHub, or email), the provider's account ID, and passkey public keys if you add a passkey.",
            "Session data: the IP address and browser user agent recorded with each sign-in session, used to keep you signed in and to detect abuse.",
            "Learning data: the cards you add (including the URLs of pages you save), your notes, review history and scheduling data, words, reading materials, roadmap goals and preferences.",
            "Purchase data: which pass you bought, the amount, the date and the payment provider's reference. Card details are entered on the payment provider's page; we never receive or store your card number.",
            "Sponsorship data: if you sponsor through GitHub Sponsors, your GitHub account ID and login, the tier, the amount and the dates GitHub sends us.",
            "Messages: what you send through the contact form (name, email, optional phone number, message) or the in-app feedback chat.",
            "Technical data: request logs and performance metrics (page path, status, timing) used to keep the Service running.",
          ],
        },
      ],
    },
    {
      heading: "2. How we use it",
      blocks: [
        "To provide the Service: signing you in, syncing your cards across devices, scheduling reviews, running the AI features you use, granting Pro after a purchase or sponsorship, answering your messages, keeping the Service secure, fixing problems, and meeting legal obligations such as keeping tax records.",
        "We do not sell your personal data, do not show advertising, do not use third-party analytics or advertising trackers, and do not use your content to train AI models.",
        "Legal bases (GDPR): performance of our contract with you; our legitimate interests in security and improving the Service; legal obligations; and your consent where we ask for it.",
      ],
    },
    {
      heading: "3. Who processes it",
      blocks: [
        "We use these service providers. Each receives only the data needed for its job:",
        {
          list: [
            "Cloudflare, Inc. (USA): hosting, the database (Cloudflare D1) and file storage (R2) that hold your account and learning data, request metrics, bot protection on sign-in (Turnstile), and Workers AI, which processes the text you send to translation, example-sentence and text-to-speech features and voice input you record for speech recognition.",
            "Resend (USA): delivering sign-in emails to your address.",
            "Google LLC and GitHub, Inc. (USA): sign-in, only if you choose them. GitHub also, if you sponsor us there.",
            "Payment partners: Stripe, and other card payment processors we may use for checkout, including Paddle acting as reseller and merchant of record where applicable. They process your payment details under their own privacy policies.",
            "Sponsorship platforms (GitHub Sponsors, Patreon, afdian), if you support us through them.",
            "Slack Technologies (USA): contact-form and feedback-chat messages are delivered to our Slack workspace so we can reply.",
            "A MongoDB database kept as a frozen backup of data created before Lianki moved to Cloudflare in October 2026. It is not written to.",
          ],
        },
        "These providers may process data outside Japan, mainly in the United States. Where required, we rely on appropriate safeguards such as the providers' data processing terms and standard contractual clauses.",
      ],
    },
    {
      heading: "4. Cookies and storage on your device",
      blocks: [
        "We use only cookies needed for the Service: a sign-in session cookie, a language cookie (`lang`) and, after you open an invite link, an invite cookie (`lk_invite`, 30 days). Cloudflare may set cookies needed for security. There are no advertising or analytics cookies.",
        "The app and the userscript also keep a copy of your cards and settings in your browser (IndexedDB, local storage and the userscript manager's storage) so they work offline. Clearing your browser data removes it.",
      ],
    },
    {
      heading: "5. How long we keep it",
      blocks: [
        "We keep your account and learning data while your account exists. When you ask us to delete your account, we delete it from the live database within 30 days. Records of purchases are kept for as long as Japanese tax law requires (up to 7 years). Request logs and metrics are kept for a limited period and then deleted automatically.",
      ],
    },
    {
      heading: "6. Your rights",
      blocks: [
        `You can export your cards from the app at any time. You may also ask us to disclose, correct, delete or stop using your personal data, or to tell you how it has been shared, by writing to ${MAIL}. Users in the EU/EEA and UK also have the right to data portability, to object, and to complain to their data protection authority.`,
      ],
    },
    {
      heading: "7. Security",
      blocks: [
        "Data is encrypted in transit (HTTPS). Access to production data is limited to the operator. No system is perfectly secure; if a breach affects your data, we will notify you and the authorities as the law requires.",
      ],
    },
    {
      heading: "8. Children",
      blocks: [
        "Lianki is not directed at children under 13, and we do not knowingly collect their data. If you believe a child has given us data, contact us and we will delete it.",
      ],
    },
    {
      heading: "9. Changes",
      blocks: [
        "We will post any update here with a new date, and tell you in the app or by email about significant changes.",
      ],
    },
    {
      heading: "10. Contact",
      blocks: [`${SELLER} — ${MAIL}`],
    },
  ],
};

const privacyJa: LegalDocText = {
  title: "プライバシーポリシー",
  intro: [
    `本ポリシーは、Liankiが取得する個人情報、その利用目的、および取扱いを委託する事業者について説明するものです。個人情報の取扱いの責任者は、日本の個人事業主である${SELLER}です。当方は、個人情報の保護に関する法律（個人情報保護法）、およびEU・EEA・英国の利用者についてはGDPRに従って個人情報を取り扱います。`,
  ],
  sections: [
    {
      heading: "1. 取得する情報",
      blocks: [
        {
          list: [
            "アカウント情報：選択したサインイン方法（Google、GitHub、メール）から得られる氏名・メールアドレス・プロフィール画像、各サービスのアカウントID、パスキーを登録した場合はその公開鍵",
            "セッション情報：サインインのたびに記録されるIPアドレスおよびブラウザのユーザーエージェント（サインイン状態の維持と不正利用の検知に使用）",
            "学習データ：登録したカード（保存したページのURLを含む）、メモ、復習履歴とスケジュール、単語、読み物、ロードマップの目標、各種設定",
            "購入情報：購入したパス、金額、日時、決済事業者の取引番号。カード情報は決済事業者のページで入力され、当方がカード番号を受け取ったり保存したりすることはありません。",
            "スポンサー情報：GitHub Sponsorsで支援した場合に、GitHubから送られるGitHubアカウントIDとログイン名、ティア、金額、日付",
            "お問い合わせ内容：お問い合わせフォーム（氏名、メールアドレス、任意の電話番号、本文）やアプリ内フィードバックチャットで送信された内容",
            "技術情報：本サービスの運用のためのリクエストログおよび性能指標（ページのパス、ステータス、処理時間）",
          ],
        },
      ],
    },
    {
      heading: "2. 利用目的",
      blocks: [
        "本サービスの提供（サインイン、端末間のカード同期、復習スケジュールの作成、利用者が使用するAI機能の実行、購入・スポンサーに伴うProの付与、お問い合わせへの回答）、セキュリティの確保、不具合の修正、および税務記録の保存などの法令上の義務の履行のために利用します。",
        "当方は、個人情報を販売せず、広告を表示せず、第三者のアクセス解析や広告トラッカーを使用せず、利用者のコンテンツをAIモデルの学習に使用しません。",
        "GDPR上の法的根拠：利用者との契約の履行、セキュリティ確保およびサービス改善という正当な利益、法的義務、ならびに同意をお願いした場合のその同意です。",
      ],
    },
    {
      heading: "3. 取扱いの委託先・提供先",
      blocks: [
        "当方は次の事業者を利用しています。各事業者には、その業務に必要な情報のみが渡ります。",
        {
          list: [
            "Cloudflare, Inc.（米国）：ホスティング、アカウント情報と学習データを保存するデータベース（Cloudflare D1）とファイルストレージ（R2）、リクエスト指標、サインイン時のボット対策（Turnstile）、およびWorkers AI（翻訳・例文生成・音声合成に送信したテキスト、音声認識のために録音した音声を処理します）",
            "Resend（米国）：サインイン用メールの配信",
            "Google LLC・GitHub, Inc.（米国）：利用者が選択した場合のサインイン。GitHubはGitHub Sponsorsで支援した場合にも利用",
            "決済パートナー：Stripe、およびチェックアウトに利用する場合があるその他のカード決済事業者（該当する場合は再販事業者・販売者としてのPaddleを含む）。お支払い情報は各社のプライバシーポリシーに従って処理されます。",
            "スポンサープラットフォーム（GitHub Sponsors、Patreon、愛発電（afdian））：これらを通じて支援した場合",
            "Slack Technologies（米国）：お問い合わせフォームおよびフィードバックチャットのメッセージは、返信のため当方のSlackワークスペースに届きます。",
            "MongoDBデータベース：2026年10月にCloudflareへ移行する前に作成されたデータの凍結されたバックアップとして保持しており、書き込みは行いません。",
          ],
        },
        "これらの事業者は、主に米国など日本国外で情報を処理することがあります。外国にある第三者への提供にあたっては、各事業者のデータ処理条件や標準契約条項など、法令が求める適切な措置に依拠します。",
      ],
    },
    {
      heading: "4. Cookieと端末内の保存",
      blocks: [
        "使用するCookieは本サービスに必要なものに限られます：サインインのセッションCookie、言語設定のCookie（`lang`）、招待リンクを開いた場合の招待Cookie（`lk_invite`、30日間）。Cloudflareがセキュリティのために必要なCookieを設定する場合があります。広告やアクセス解析のCookieは使用しません。",
        "アプリとユーザースクリプトは、オフラインでも使えるよう、カードと設定のコピーをブラウザ内（IndexedDB、ローカルストレージ、ユーザースクリプトマネージャーのストレージ）に保存します。ブラウザのデータを消去すると削除されます。",
      ],
    },
    {
      heading: "5. 保存期間",
      blocks: [
        "アカウント情報と学習データは、アカウントが存在する間保存します。アカウント削除のご依頼を受けた場合、30日以内に稼働中のデータベースから削除します。購入記録は日本の税法上必要な期間（最長7年）保存します。リクエストログと指標は一定期間の経過後に自動的に削除されます。",
      ],
    },
    {
      heading: "6. 利用者の権利",
      blocks: [
        `カードはいつでもアプリからエクスポートできます。保有個人データの開示、訂正、削除、利用停止、第三者提供記録の開示は、${MAIL}までご請求ください。EU・EEA・英国の利用者は、データポータビリティ、異議申立て、監督機関への苦情申立ての権利も有します。`,
      ],
    },
    {
      heading: "7. 安全管理",
      blocks: [
        "通信はHTTPSで暗号化しています。本番データへのアクセスは運営者に限定しています。万一、利用者の情報に影響する漏えい等が発生した場合は、法令に従い利用者および当局に報告します。",
      ],
    },
    {
      heading: "8. 子どもの情報",
      blocks: [
        "本サービスは13歳未満の方を対象としておらず、その情報を意図的に取得することはありません。13歳未満の方の情報が提供されたと思われる場合はご連絡ください。削除いたします。",
      ],
    },
    {
      heading: "9. 改定",
      blocks: [
        "本ポリシーを改定した場合は、日付を更新してこのページに掲載し、重要な変更はアプリ内またはメールでお知らせします。",
      ],
    },
    {
      heading: "10. お問い合わせ窓口",
      blocks: [`${SELLER} — ${MAIL}`],
    },
  ],
};

// ── Refund Policy ─────────────────────────────────────────────────────────────

const refundEn: LegalDocText = {
  title: "Refund Policy",
  intro: [
    "Lianki Pro passes are digital services that start immediately. We still want every purchase to feel fair, so this is our policy:",
  ],
  sections: [
    {
      heading: "1. Pro passes: 14-day refund",
      blocks: [
        "If you ask within 14 days of purchase and have not substantively used Pro during that time, we refund the pass in full. When the refund is made, the pass's days are removed from your account.",
        "After 14 days, or once Pro has been substantively used, passes are not refundable, except where the law requires a refund or as set out below.",
      ],
    },
    {
      heading: "2. Always refunded",
      blocks: [
        {
          list: [
            "Duplicate or mistaken charges, and payments that did not give you Pro because of a fault on our side.",
            "If we discontinue Pro altogether: the unused part of any pass still running, pro rata.",
          ],
        },
      ],
    },
    {
      heading: "3. Purchases through a reseller",
      blocks: [
        "Where a purchase is made through Paddle or another payment partner acting as reseller and merchant of record, that partner's refund terms also apply, and the refund may be issued by the partner. You can contact either the partner or us.",
      ],
    },
    {
      heading: "4. Sponsorships, gift codes and trials",
      blocks: [
        {
          list: [
            "Sponsorships through GitHub Sponsors, Patreon or afdian are paid to and handled by that platform; refunds follow its policy. You can cancel a recurring sponsorship there at any time; Pro already granted runs to the end of its period.",
            "Gift codes, invite rewards and free trials cost nothing and have no cash value, so there is nothing to refund.",
          ],
        },
      ],
    },
    {
      heading: "5. Statutory rights",
      blocks: [
        "Pro is supplied as soon as payment is confirmed. If you are a consumer in the EU/EEA or UK, by buying a pass you ask for Pro to start immediately and acknowledge that the statutory 14-day right of withdrawal ends once it has started; this voluntary policy still gives you the 14-day refund above. Nothing here limits rights you have under the law of your country.",
        "For purchases in Japan: as an online sale (通信販売), a pass is not subject to cooling-off; returns and refunds are governed by this policy, as stated in our [Specified Commercial Transactions Act disclosure](/legal/tokushoho).",
      ],
    },
    {
      heading: "6. How to ask",
      blocks: [
        `Write to ${MAIL} from the email address on your Lianki account, or include it, with the date of purchase and the receipt if you have it. We reply within a few business days. Approved refunds go back to the original payment method; the time they take to appear depends on your payment provider.`,
      ],
    },
  ],
};

const refundJa: LegalDocText = {
  title: "返金ポリシー",
  intro: [
    "Lianki Proのパスは、購入後すぐに提供が始まるデジタルサービスです。すべての購入が公正なものとなるよう、次のとおり返金を取り扱います。",
  ],
  sections: [
    {
      heading: "1. Proパス：14日間の返金",
      blocks: [
        "購入から14日以内にご依頼いただき、その間Proを実質的に利用していない場合は、全額を返金します。返金時には、そのパスの日数をアカウントから差し引きます。",
        "購入から14日を過ぎた場合、またはProを実質的に利用した場合は、法令により返金が求められる場合および以下に定める場合を除き、返金できません。",
      ],
    },
    {
      heading: "2. 必ず返金する場合",
      blocks: [
        {
          list: [
            "二重課金や誤課金、当方の不具合によりProが付与されなかったお支払い",
            "Proの提供を終了する場合：有効期間が残っているパスの未使用期間分（日割り）",
          ],
        },
      ],
    },
    {
      heading: "3. 再販事業者を通じた購入",
      blocks: [
        "Paddleなど、再販事業者・販売者（merchant of record）として行動する決済パートナーを通じた購入には、そのパートナーの返金条件も適用され、返金はパートナーから行われる場合があります。お問い合わせはパートナーまたは当方のどちらにもしていただけます。",
      ],
    },
    {
      heading: "4. スポンサー、ギフトコード、体験期間",
      blocks: [
        {
          list: [
            "GitHub Sponsors、Patreon、愛発電（afdian）によるスポンサーのお支払いは各プラットフォームが受領・管理しており、返金は各プラットフォームの規定に従います。継続的なスポンサーはいつでも各プラットフォームで解約でき、付与済みのProはその期間の終了まで有効です。",
            "ギフトコード、招待特典、無料体験期間は無償で現金価値がないため、返金の対象となるものはありません。",
          ],
        },
      ],
    },
    {
      heading: "5. 法令上の権利",
      blocks: [
        "Proは決済の完了と同時に提供されます。本サービスは通信販売であり、クーリング・オフの対象ではありません。返品・返金は本ポリシーに従います（[特定商取引法に基づく表記](/legal/tokushoho)参照）。本ポリシーは、お住まいの国の法令により認められた権利を制限するものではありません。",
      ],
    },
    {
      heading: "6. ご依頼方法",
      blocks: [
        `Liankiアカウントのメールアドレスから（またはそのアドレスを記載のうえ）、購入日と、お持ちであれば領収書を添えて${MAIL}までご連絡ください。数営業日以内にご返信します。承認された返金は元のお支払い方法に戻され、反映までの期間は決済事業者により異なります。`,
      ],
    },
  ],
};

// ── 特定商取引法に基づく表記 ───────────────────────────────────────────────────

const ON_REQUEST_JA = "請求があった場合には遅滞なく開示いたします。";
const ON_REQUEST_EN = "Disclosed without delay upon request.";

const tokushohoJa: TokushohoText = {
  title: "特定商取引法に基づく表記",
  intro: "特定商取引に関する法律第11条に基づき、以下のとおり表示します。",
  rows: [
    ["販売事業者", [`${SELLER}（屋号）`]],
    ["運営統括責任者", [OWNER_LEGAL_NAME]],
    ["所在地", [ON_REQUEST_JA]],
    ["電話番号", [ON_REQUEST_JA, `お問い合わせは下記メールアドレスまでお願いします。`]],
    ["メールアドレス", [MAIL]],
    ["URL", [`[${SITE_URL}](${SITE_URL})`]],
    [
      "販売価格",
      [
        {
          list: [
            `Lianki Pro 1か月パス（${P1.days}日間）：${P1.amount.toLocaleString("ja-JP")}円（税込）`,
            `Lianki Pro 12か月パス（${P12.days}日間）：${P12.amount.toLocaleString("ja-JP")}円（税込）`,
          ],
        },
        "スポンサー（GitHub Sponsors、Patreon、愛発電）の金額は各プラットフォームのページに表示します。",
      ],
    ],
    ["商品代金以外の必要料金", ["インターネット接続料金、通信料金はお客様のご負担となります。"]],
    [
      "お支払い方法",
      [
        "クレジットカード、Alipay、WeChat Payなど、決済画面に表示される方法。決済は当方の決済パートナー（例：Stripe。該当する場合は再販事業者としてのPaddle）が処理します。",
      ],
    ],
    ["お支払い時期", ["ご注文時に決済されます（各決済方法の規定によります）。"]],
    [
      "商品の引渡時期（役務の提供時期）",
      ["決済完了後、直ちにお客様のアカウントにPro期間が付与されます。"],
    ],
    [
      "契約期間・自動更新",
      [
        "パスは前払い式の買い切りで、自動更新はありません。購入したパスの日数分、Proをご利用いただけます。",
      ],
    ],
    [
      "返品・キャンセル",
      [
        "デジタルサービスの性質上、決済完了後のキャンセルはお受けしていません。ただし、購入から14日以内でProを実質的に利用していない場合は全額を返金します。詳しくは[返金ポリシー](/legal/refund)をご覧ください。",
      ],
    ],
    [
      "動作環境",
      [
        "最新版のGoogle Chrome、Microsoft Edge、Safari、Firefox（パソコン、iOS、Android）。JavaScriptとCookieを有効にしてください。ユーザースクリプトの利用には、Tampermonkey、Violentmonkey等のユーザースクリプトマネージャーが必要です。",
      ],
    ],
  ],
};

const tokushohoEn: TokushohoText = {
  title: "Disclosure under the Specified Commercial Transactions Act",
  intro:
    "The following is disclosed under Article 11 of Japan's Act on Specified Commercial Transactions (特定商取引法). The Japanese version is authoritative.",
  rows: [
    ["Seller", [`${SELLER} (trade name of a sole proprietor)`]],
    ["Person responsible", [OWNER_LEGAL_NAME]],
    ["Address", [ON_REQUEST_EN]],
    ["Phone", [ON_REQUEST_EN, "Please contact us by email."]],
    ["Email", [MAIL]],
    ["URL", [`[${SITE_URL}](${SITE_URL})`]],
    [
      "Price",
      [
        {
          list: [
            `${P1.name} (${P1.days} days): ${yen(P1.amount)} (tax included)`,
            `${P12.name} (${P12.days} days): ${yen(P12.amount)} (tax included)`,
          ],
        },
        "Sponsorship amounts (GitHub Sponsors, Patreon, afdian) are shown on each platform.",
      ],
    ],
    ["Additional fees", ["Internet connection and data charges are borne by the customer."]],
    [
      "Payment methods",
      [
        "Credit card, Alipay, WeChat Pay and other methods shown at checkout, processed by our payment partners (for example Stripe, or Paddle as reseller where applicable).",
      ],
    ],
    ["Payment timing", ["Charged when you order, subject to the payment method's rules."]],
    ["Delivery", ["Pro is added to your account immediately after payment is confirmed."]],
    [
      "Term and renewal",
      ["Passes are prepaid, one-time purchases and do not renew automatically."],
    ],
    [
      "Cancellation and refunds",
      [
        "Because the service is digital, orders cannot be cancelled after payment. A full refund is available within 14 days of purchase if Pro has not been substantively used. See the [Refund Policy](/legal/refund).",
      ],
    ],
    [
      "System requirements",
      [
        "Current versions of Google Chrome, Microsoft Edge, Safari or Firefox (desktop, iOS, Android) with JavaScript and cookies enabled. The userscript needs a userscript manager such as Tampermonkey or Violentmonkey.",
      ],
    ],
  ],
};

export const LEGAL_TEXT: {
  terms: Record<LegalLocale, LegalDocText>;
  privacy: Record<LegalLocale, LegalDocText>;
  refund: Record<LegalLocale, LegalDocText>;
  tokushoho: Record<LegalLocale, TokushohoText>;
} = {
  terms: { en: termsEn, ja: termsJa },
  privacy: { en: privacyEn, ja: privacyJa },
  refund: { en: refundEn, ja: refundJa },
  tokushoho: { en: tokushohoEn, ja: tokushohoJa },
};
