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
      title: "更好的发音",
      detail:
        "免费档：VOICEVOX（日语）+ Kokoro（英西法意葡中）本机预生成词表音频进 R2，Piper 补德俄，韩语保留 MeloTTS；第二步会员档接 ElevenLabs/Gemini（例句、整段朗读、音色选择、慢速）。",
    },
  ],
  deciding: [
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
    { pr: 223, title: "服务器 AI 语音默认" },
    { pr: 222, title: "首页 = 导航 + 引导，旧首页移到 /sites" },
    { pr: 221, title: "单词表为入口，页面卡片功能移入高级" },
    { pr: 220, title: "Worker 日志常开 + 登录邮件按域名记录" },
    { pr: 219, title: "实时倒计时、到期词插到屏幕下方" },
    { pr: 212, title: "竹简" },
    { pr: 211, title: "书法纸张主题" },
  ],
  ideas: [{ title: "会员服务（高级语音）" }, { title: "AI 对话陪练" }],
};
