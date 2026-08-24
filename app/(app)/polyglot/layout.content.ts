import { t, type DeclarationContent } from "intlayer";

const polyglotLayoutContent = {
  key: "polyglot-layout",
  content: {
    accessDenied: {
      title: t({
        en: "Pro Membership Required",
        zh: "需要 Pro 会员",
        ja: "Proメンバーシップが必要です",
        ko: "Pro 멤버십이 필요합니다",
      }),
      description: t({
        en: "The Polyglot feature is available for Pro members. New users get 90 days free trial automatically.",
        zh: "Polyglot 功能适用于 Pro 会员。新用户自动获得 90 天免费试用。",
        ja: "Polyglot機能はProメンバー向けです。新規ユーザーは自動的に90日間の無料トライアルを取得します。",
        ko: "Polyglot 기능은 Pro 회원만 사용할 수 있습니다. 신규 사용자는 자동으로 90일 무료 체험을 받습니다.",
      }),
      upgradeToPro: t({
        en: "Upgrade to Pro",
        zh: "升级到 Pro",
        ja: "Proにアップグレード",
        ko: "Pro로 업그레이드",
      }),
      backToHome: t({
        en: "Back to Home",
        zh: "返回主页",
        ja: "ホームに戻る",
        ko: "홈으로 돌아가기",
      }),
    },
    banner: {
      trialExpires: t({
        en: "Trial expires on",
        zh: "试用到期日",
        ja: "トライアル期限",
        ko: "체험판 만료일",
      }),
      upgradeToPro: t({
        en: "Upgrade to Pro",
        zh: "升级到 Pro",
        ja: "Proにアップグレード",
        ko: "Pro로 업그레이드",
      }),
      proMemberUntil: t({
        en: "Pro member until",
        zh: "Pro 会员有效期至",
        ja: "Proメンバー期限",
        ko: "Pro 회원 유효 기간",
      }),
    },
  },
} satisfies DeclarationContent;

export default polyglotLayoutContent;
