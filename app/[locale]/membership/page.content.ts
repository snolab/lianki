import { t, type DeclarationContent } from "intlayer";

const membershipContent = {
  key: "membership-page",
  content: {
    backToHome: t({
      en: "← Back to Home",
      zh: "← 返回主页",
      ja: "← ホームに戻る",
      ko: "← 홈으로 돌아가기",
    }),
    title: t({
      en: "Membership",
      zh: "会员",
      ja: "メンバーシップ",
      ko: "멤버십",
    }),
    newUserBenefit: {
      title: t({
        en: "New User Benefit",
        zh: "新用户福利",
        ja: "新規ユーザー特典",
        ko: "신규 사용자 혜택",
      }),
      description: t({
        en: "Every new user gets 90 days of Pro access automatically! Enjoy all premium features including Polyglot language learning.",
        zh: "每位新用户自动获得 90 天的 Pro 访问权限！享受包括 Polyglot 语言学习在内的所有高级功能。",
        ja: "すべての新規ユーザーは自動的に90日間のProアクセスを取得します！Polyglot言語学習を含むすべてのプレミアム機能をお楽しみください。",
        ko: "모든 신규 사용자는 자동으로 90일간 Pro 액세스를 받습니다! Polyglot 언어 학습을 포함한 모든 프리미엄 기능을 즐기세요.",
      }),
    },
    currentStatus: {
      title: t({
        en: "Current Status",
        zh: "当前状态",
        ja: "現在のステータス",
        ko: "현재 상태",
      }),
      free: t({
        en: "Free",
        zh: "免费",
        ja: "無料",
        ko: "무료",
      }),
      trial: t({
        en: "Trial",
        zh: "试用",
        ja: "トライアル",
        ko: "체험판",
      }),
      pro: t({
        en: "Pro",
        zh: "专业版",
        ja: "Pro",
        ko: "프로",
      }),
      trialExpires: t({
        en: "Trial expires on",
        zh: "试用到期日",
        ja: "トライアル期限",
        ko: "체험판 만료일",
      }),
      activeUntil: t({
        en: "Active until",
        zh: "有效期至",
        ja: "有効期限",
        ko: "유효 기간",
      }),
      trialExpired: t({
        en: "Your 90-day trial has expired. Upgrade to Pro to continue using premium features.",
        zh: "您的 90 天试用期已过期。升级到 Pro 以继续使用高级功能。",
        ja: "90日間のトライアルが終了しました。プレミアム機能を引き続き使用するにはProにアップグレードしてください。",
        ko: "90일 체험판이 만료되었습니다. 프리미엄 기능을 계속 사용하려면 Pro로 업그레이드하세요.",
      }),
    },
    features: {
      title: t({
        en: "Features Comparison",
        zh: "功能对比",
        ja: "機能比較",
        ko: "기능 비교",
      }),
      free: {
        basicSpacedRepetition: t({
          en: "Basic spaced repetition",
          zh: "基础间隔重复",
          ja: "基本的な間隔反復",
          ko: "기본 간격 반복",
        }),
        unlimitedCards: t({
          en: "Unlimited cards",
          zh: "无限卡片",
          ja: "無制限カード",
          ko: "무제한 카드",
        }),
        videoSpeedControl: t({
          en: "Video speed control",
          zh: "视频速度控制",
          ja: "ビデオ速度コントロール",
          ko: "비디오 속도 제어",
        }),
        noPolyglot: t({
          en: "Polyglot feature",
          zh: "Polyglot 功能",
          ja: "Polyglot機能",
          ko: "Polyglot 기능",
        }),
      },
      pro: {
        allFreeFeatures: t({
          en: "All Free features",
          zh: "所有免费功能",
          ja: "すべての無料機能",
          ko: "모든 무료 기능",
        }),
        polyglotLearning: t({
          en: "Polyglot language learning",
          zh: "Polyglot 语言学习",
          ja: "Polyglot言語学習",
          ko: "Polyglot 언어 학습",
        }),
        aiTranslations: t({
          en: "AI-powered translations",
          zh: "AI 驱动的翻译",
          ja: "AI搭載翻訳",
          ko: "AI 기반 번역",
        }),
        textToSpeech: t({
          en: "Text-to-speech support",
          zh: "文本转语音支持",
          ja: "テキスト読み上げサポート",
          ko: "텍스트 음성 변환 지원",
        }),
        contactUs: t({
          en: "Contact us for Pro access",
          zh: "联系我们获取 Pro 访问权限",
          ja: "Proアクセスについてはお問い合わせください",
          ko: "Pro 액세스는 문의하세요",
        }),
      },
    },
    loading: t({
      en: "Loading...",
      zh: "加载中...",
      ja: "読み込み中...",
      ko: "로딩 중...",
    }),
    error: {
      failedToLoad: t({
        en: "Failed to load membership information",
        zh: "无法加载会员信息",
        ja: "メンバーシップ情報の読み込みに失敗しました",
        ko: "멤버십 정보를 불러오지 못했습니다",
      }),
    },
  },
} satisfies DeclarationContent;

export default membershipContent;
