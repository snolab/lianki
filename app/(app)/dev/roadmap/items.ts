/**
 * The owner's status board for /dev/roadmap. Edit freely — the page renders
 * whatever is here, in this order.
 */

export type RoadmapStatus = "doing" | "deciding" | "shipped" | "ideas";

export type RoadmapItem = {
  title: string;
  detail?: string;
  /** PR number in snolab/lianki. */
  pr?: number;
  link?: string;
};

export const STATUS_ORDER: RoadmapStatus[] = ["doing", "deciding", "shipped", "ideas"];

export const STATUS_LABEL: Record<RoadmapStatus, string> = {
  doing: "进行中",
  deciding: "等待决定",
  shipped: "已上线（最近）",
  ideas: "想法",
};

export const ROADMAP: Record<RoadmapStatus, RoadmapItem[]> = {
  doing: [
    {
      title: "更好的发音：德俄补 Piper",
      detail: "免费档已上线（#225）。德语、俄语还没有服务器语音，韩语仍是 MeloTTS。",
    },
  ],
  deciding: [
    {
      title: "会员档语音（ElevenLabs / Gemini）",
      detail:
        "例句、整段朗读、音色选择、慢速。需要：Worker secret ELEVENLABS_API_KEY；会员开通方式（手动开 pro 还是接 Stripe）。",
    },
    {
      title: "全站信息架构重新分组",
      detail:
        "首页 / 记 / 练 / 读 / 规划 / 页面卡片（高级）/ 实验室 / 博客与帮助 / 账户，URL 不变。",
    },
    {
      title: "是否静音两条吵的 Worker 日志警告",
      detail: "better-auth baseURL、kysely。",
    },
    { title: "WebRTC 实时调参直连" },
    {
      title: "竹简纯 HTML 原型真机验证后是否替换 JS 滑动",
      link: "https://lianki.com/proto/slip.html",
    },
    {
      title: "Slack bot 加 files:write 权限",
      detail: "需要 owner 在 api.slack.com 操作。",
    },
    {
      title: "滑动遥测分析",
      detail: "需要授权读生产 D1。",
    },
  ],
  shipped: [
    {
      pr: 225,
      title: "词表发音换开源语音",
      detail: "VOICEVOX No.7（日）+ Kokoro（英西法意葡中），62,617 条预生成进 R2。",
    },
    { pr: 224, title: "/dev/roadmap" },
    { pr: 223, title: "服务器 AI 语音默认" },
    { pr: 222, title: "首页 = 导航 + 引导，旧首页移到 /sites" },
    { pr: 221, title: "单词表为入口，页面卡片功能移入高级" },
    { pr: 220, title: "Worker 日志常开 + 登录邮件按域名记录" },
    { pr: 219, title: "实时倒计时、到期词插到屏幕下方" },
    { pr: 212, title: "竹简" },
    { pr: 211, title: "书法纸张主题" },
  ],
  ideas: [{ title: "AI 对话陪练" }],
};
