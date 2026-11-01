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
      title: "改名「学习伙伴」（Learning Partner）",
      detail: "用户界面里不再出现 “debug”。分支 feat/study-buddy-naming，未开 PR。",
    },
    {
      title: "统一聊天栏（预览）",
      detail:
        "[最小化 | 连接 | 输入框 | 麦克风] 合进一个玻璃容器。分支 feat/chat-unified-bar，预览中。",
    },
    {
      title: "热插拔 islands 基础",
      detail: "可替换的智能组件 + 共享状态 + action bus。分支 feat/hot-slots，未上线。",
    },
    {
      title: "嵌入模式",
      detail: "在 iframe 里或带 ?embed=1 时只显示内容、背景透明。分支 feat/embed-mode，未开 PR。",
    },
    {
      title: "聊天头像",
      detail: "聊天记录里用圆形头像代替名字。",
      pr: 298,
    },
    {
      title: "/words iOS 玻璃修正",
      detail: "在工具栏下打开、卡片后显露、页面不滚动。",
      pr: 299,
    },
    {
      title: "更好的发音：德俄补 Piper",
      detail: "免费档已上线（#225）。德语、俄语还没有服务器语音，韩语仍是 MeloTTS。",
    },
  ],
  deciding: [
    {
      title: "会员档语音（ElevenLabs / Gemini）",
      detail:
        "等 owner 决定。例句、整段朗读、音色选择、慢速。需要：Worker secret ELEVENLABS_API_KEY；会员开通已有 Stripe 预付 Pro（#254），还要定哪些语音算会员档。",
    },
    {
      title: "竹简：原生滑动 vs JS 滑动",
      detail:
        "等 owner 决定。原生滑动已作为 A/B 上线（#265，设置 → 实验），/dev/swipe-ab 对比。纯 HTML 原型仍在。",
      link: "https://lianki.com/proto/slip.html",
    },
    {
      title: "Slack bot 加 files:write 权限",
      detail: "等 owner 决定。需要 owner 在 api.slack.com 操作；截图才能以 bot 身份上传。",
    },
    {
      title: "滑动遥测分析",
      detail: "等 owner 决定。需要授权读生产 D1；遥测已带 ab=js|native 标签。",
    },
    {
      title: "/words 拆成 islands",
      detail: "words.list + words.toolbar，约 1.5–2 agent hours。依赖热插拔 islands 基础。",
    },
    {
      title: "预览方式：iframe 覆盖层 vs islands",
      detail: "预览改动用 iframe 叠在页面上，还是热换 island。",
    },
    {
      title: "liagent：npm / trusted publishing",
      detail:
        "liagent 已搬到 snolab/liagent，通过 agent-yes 以子路径 agent-yes/liagent 发布（PR 等 owner 合并）。是否单独上 npm、用 trusted publishing。",
      link: "https://github.com/snolab/liagent",
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
  ],
  shipped: [
    {
      pr: 297,
      title: "iOS 语音质量：优先自然语音",
      detail: "跳过机器味的 Eloquence 和搞怪语音。",
    },
    {
      pr: 296,
      title: "shot.ts：一条命令截设备屏",
      detail: "走在线 eval 授权，结果分块回传，支持连拍。",
    },
    { pr: 295, title: "麦克风开着也算聚焦：聊天框变不透明" },
    {
      pr: 293,
      title: "/words 玻璃覆盖层、平板玻璃导航、过度滚动里的休眠卡托盘",
      detail: "另见 #294：淡出的 ‘↓ 回来’ 竹简保持不透明。",
    },
    {
      pr: 291,
      title: "/words 音频预取、单词→释义→例句朗读",
      detail: "按输入方式给提示；80% 过度滚动；滑动吸附更强。",
    },
    {
      pr: 290,
      title: "设计原则文档",
      detail: "内容占满屏幕，导航 / 帮助 / 聊天以玻璃浮在上面。",
    },
    {
      pr: 292,
      title: "语音插话（barge-in）",
      detail: "AEC 麦克风常开、朗读时压低音量（ducking）、文本回声过滤、speech/cloud 输出模式。",
    },
    {
      pr: 289,
      title: "免手动语音：开麦即朗读回复",
      detail: "句子队列可续读、无回声、发送打勾。",
    },
    {
      pr: 287,
      title: "语音自动标点、agent 离线状态",
      detail: "输入框自滚、日志贴边。另见 #288：心跳不算听众，pages-idle / pages-back 在线状态。",
    },
    {
      pr: 285,
      title: "聊天胶囊、麦克风 + VAD + 实时文字、语音自动发送",
      detail:
        "组件移到 packages/debug-chat。另见 #283：Whisper large-v3-turbo 语音识别（多语言）。",
    },
    {
      pr: 286,
      title: "授权可续 8 小时，不再反复弹窗",
      detail: "另见 #281 #282：按页授权、切 app 不丢、5 分钟宽限；可热加载的聊天组件。",
    },
    {
      pr: 275,
      title: "朋友与 agent 在自己的线程聊天",
      detail: "预览需要本人同意。",
    },
    {
      pr: 266,
      title: "owner ⇄ agent 聊天，回复朗读",
      detail:
        "#267–#278：可拖动、游戏式单行日志、无底色、点击穿透、无标题栏、16px 输入防 iOS 缩放；#271 隐藏调试开关。",
    },
    {
      pr: 253,
      title: "调试页远程 eval，在设备上批准",
    },
    {
      pr: 265,
      title: "/words 滑动吸附、评分条、原生滑动 A/B",
      detail: "另见 #260 #262 #263：Android 更顺、Again/Easy 要用力推、iOS 连点不选中文字。",
    },
    {
      pr: 284,
      title: "iOS QA 一轮修正",
      detail: "标签、安全区、个人菜单、抽屉无障碍、html lang、点击区域、/home 到期数。",
    },
    {
      pr: 254,
      title: "Stripe 预付 Pro 通行证",
      detail: "卡 / 支付宝 / 微信支付。另见 #255 /dev/membership、#257 邀请链接和礼品码。",
    },
    { pr: 261, title: "/dev/users：账户、会员、活跃度、数据量" },
    {
      pr: 251,
      title: "/words/import：导入 Anki .apkg",
      detail: "再次导入即同步。另见 #248：按语言共享 Anki 牌组。",
    },
    { pr: 240, title: "通行密钥（passkey）登录" },
    { pr: 239, title: "Worker 冷启动：better-auth 懒加载" },
    {
      pr: 236,
      title: "lianki-monitor：请求指标与 Slack 告警",
      detail: "#237：只做事件驱动，不定时探测。",
    },
    {
      pr: 233,
      title: "竹简聚焦 = 绳子松开，双击打开操作",
      detail: "另见 #234 #235：绳子跨缝连贯、手机上到期时间避开右绳。",
    },
    {
      pr: 245,
      title: "水墨图标、当前页盖印章",
      detail: "另见 #244 #246 #249：桌面列宽按需、顶栏 ‘Lianki.com’、页面卡片改名 ‘Lianki 卡片’。",
    },
    { pr: 256, title: "换卡时单词音频淡出" },
    { pr: 228, title: "浏览器只用对应语言的声音读单词" },
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
  ideas: [
    {
      title: "AI 对话陪练",
      detail: "学习伙伴聊天 + 语音已有雏形。",
    },
    { title: "全站热插拔 islands" },
    { title: "按设备授权", detail: "授权绑定到设备，而不只是页面 / 标签。" },
    { title: "预览用 iframe 覆盖层" },
    { title: "共享状态的契约键", detail: "islands 之间共享状态的 key 有固定 schema。" },
    { title: "agent 连拍截图", detail: "shot.ts --burst 用于动画 / 手势回归。" },
    { title: "语音回声率仪表盘", detail: "按模式统计 voice-utt 里被当作回声丢弃的比例。" },
  ],
};
