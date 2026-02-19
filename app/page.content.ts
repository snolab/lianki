import { t, type DeclarationContent } from "intlayer";

const landingContent = {
  key: "landing-page",
  content: {
    appName: t({ en: "Lianki", zh: "炼記", ja: "煉記" }),

    nav: {
      blog: t({ en: "Blog", zh: "博客", ja: "ブログ" }),
      goToApp: t({ en: "Go to App", zh: "进入应用", ja: "アプリへ" }),
    },

    hero: {
      title: t({
        en: "Supercharge Your Learning with Spaced Repetition",
        zh: "用间隔重复提升你的学习效率",
        ja: "間隔反復で学習を加速する",
      }),
      description: t({
        en: "Lianki is a modern spaced repetition system designed for efficient flashcard review and long-term memorization.",
        zh: "炼記 是一款现代间隔重复系统，专为高效复习和长期记忆而设计。",
        ja: "煉記 は、効率的なフラッシュカードレビューと長期記憶のために設計された現代的な間隔反復システムです。",
      }),
      cta: t({ en: "Get Started for Free", zh: "免费开始", ja: "無料で始める" }),
    },

    features: {
      title: t({ en: "Key Features", zh: "主要功能", ja: "主な機能" }),
      fsrs: {
        title: t({ en: "FSRS Algorithm", zh: "FSRS 算法", ja: "FSRSアルゴリズム" }),
        description: t({
          en: "Utilizes the powerful FSRS algorithm for optimal review scheduling.",
          zh: "采用强大的 FSRS 算法，实现最优复习调度。",
          ja: "強力な FSRSアルゴリズムで最適なレビュースケジュールを実現します。",
        }),
      },
      browser: {
        title: t({ en: "Browser Integration", zh: "浏览器集成", ja: "ブラウザ統合" }),
        description: t({
          en: "Add flashcards from any webpage with our Tampermonkey userscript.",
          zh: "通过 Tampermonkey 用户脚本从任意网页添加闪卡。",
          ja: "Tampermonkeyユーザースクリプトで、どのウェブページからもフラッシュカードを追加できます。",
        }),
      },
      multiUser: {
        title: t({ en: "Multi-User Support", zh: "多用户支持", ja: "マルチユーザー対応" }),
        description: t({
          en: "Sign in with Email, GitHub, or Google and keep your learning progress private.",
          zh: "支持邮箱、GitHub 或 Google 登录，学习进度完全私密。",
          ja: "メール、GitHub、またはGoogleでサインインし、学習の進捗をプライベートに保ちます。",
        }),
      },
    },

    howItWorks: {
      title: t({ en: "How It Works", zh: "使用方法", ja: "使い方" }),
      step1: t({
        en: "in your browser (Tampermonkey or Violentmonkey required).",
        zh: "（需要 Tampermonkey 或 Violentmonkey）。",
        ja: "（TampermonkeyまたはViolentmonkeyが必要）。",
      }),
      step2: t({
        en: "Use keyboard shortcuts (e.g., Alt+F) to add a webpage as a flashcard.",
        zh: "使用键盘快捷键（如 Alt+F）将网页添加为闪卡。",
        ja: "キーボードショートカット（例：Alt+F）でウェブページをフラッシュカードとして追加します。",
      }),
      step3: t({
        en: "Review your due cards daily with our simple interface.",
        zh: "每天用简单的界面复习到期卡片。",
        ja: "シンプルなインターフェースで毎日期限カードを復習します。",
      }),
      step4: t({
        en: "The FSRS algorithm schedules the next review based on your performance.",
        zh: "FSRS 算法根据你的表现安排下次复习时间。",
        ja: "FSRSアルゴリズムがあなたのパフォーマンスに基づいて次のレビューをスケジュールします。",
      }),
      installLink: t({
        en: "Install the userscript",
        zh: "安装用户脚本",
        ja: "ユーザースクリプトをインストール",
      }),
    },

    footer: {
      brand: t({ en: "Lianki", zh: "炼記", ja: "煉記" }),
    },
  },
} satisfies DeclarationContent;

export default landingContent;
