/**
 * The feature-flag registry: every flag the owner can turn on and off at
 * /dev/flags, with no deploy and no secret change. docs/feature-flags.md.
 *
 * Rules:
 * - Only keys listed here exist. The store refuses to write any other key, and
 *   ignores a stored row whose key is not here.
 * - Every flag is positive: ON provides a feature, never forbids one (owner
 *   rule, 2026-11-10). No "-off" or "disable" keys.
 * - A default is OFF (`default: false`) unless the flag guards something that
 *   is already live: then `default: true`, and a stored row overrides it. A
 *   new feature ships dark behind a default-off flag; when it has been on for
 *   good, delete the flag and its checks.
 * - A flag that cannot be read (D1 error, no D1) is OFF, whatever its default
 *   (`closedFlags`).
 *
 * Client-safe: no D1 here (the server side is lib/flags-store.ts).
 */

/**
 * Server-side prerequisite checks a flag may declare (lib/flag-prereqs.ts runs
 * them). Each one reads only whether a setting is present and in the right
 * format — never a secret's value — or whether a migration's table exists.
 */
export type PrereqCheck =
  | "stripe.live-key"
  | "komoju.live-key"
  | "workers-ai.credentials"
  | "ai-credits.migration"
  | "google.oauth-client"
  | "google.picker-key"
  | "auth-secret";

/**
 * Why a check failed: a key, its text on /dev/flags (owner-only and Chinese
 * only, like the rest of that page), and a context line — where it appears,
 * what it means — so it is never translated or reworded on its own
 * (docs/i18n.md).
 */
export const PREREQ_REASONS = {
  "stripe.no-live-key": {
    zh: "缺 Stripe sk_live_ 密钥（或 webhook 密钥）",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker has no Stripe secret key starting sk_live_, or no Stripe webhook secret, so live Stripe payments cannot be turned on. Keep sk_live_ as is.",
  },
  "komoju.no-live-key": {
    zh: "缺 KOMOJU sk_live_ 密钥（或 webhook 密钥）",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker has no KOMOJU secret key starting sk_live_, or no KOMOJU webhook secret, so live KOMOJU payments cannot be turned on. Keep sk_live_ as is.",
  },
  "workers-ai.no-credentials": {
    zh: "缺 Workers AI 设置（CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_AI_TOKEN）",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker lacks the Cloudflare account id or the Workers AI token, so the Learning Partner AI cannot call the model. Keep the setting names as is.",
  },
  "ai-credits.no-migration": {
    zh: "积分账本迁移（0041_ai_credits）还没在 D1 上执行",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the D1 database lacks the AI credits tables from migration 0041, so AI replies could not be charged. Keep 0041_ai_credits as is.",
  },
  "google.no-oauth-client": {
    zh: "缺 Google OAuth 客户端（AUTH_GOOGLE_ID 或 AUTH_GOOGLE_SECRET）",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker lacks the Google OAuth client id or secret, so users cannot connect a Google account. Keep the setting names as is.",
  },
  "google.no-picker-key": {
    zh: "缺 Google Picker 浏览器密钥（GOOGLE_PICKER_API_KEY）或项目编号",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker lacks a well-formed Google Picker API key or the project number, so users cannot pick Google Docs to import. Keep the setting name as is.",
  },
  "auth.no-secret": {
    zh: "缺 AUTH_SECRET（或少于 32 个字符），无法加密保存 Google 授权",
    context:
      "Reason under a greyed-out switch on the owner's /dev/flags page: the Worker's AUTH_SECRET is missing or shorter than 32 characters, so Google refresh tokens could not be sealed at rest. Keep AUTH_SECRET as is.",
  },
} as const satisfies Record<string, { zh: string; context: string }>;

export type PrereqReason = keyof typeof PREREQ_REASONS;

export interface FlagDef {
  /** Shown on /dev/flags: what turning it on does (the owner's language). */
  description: string;
  /**
   * Its state while no row is stored. Off for a new feature; on only for a
   * flag that keeps something already live switchable (`stt.polish`).
   */
  default: boolean;
  /**
   * Checks that must all pass before the flag may be turned ON (the API
   * refuses otherwise; /dev/flags greys the switch). Turning OFF is always
   * allowed: a flag is also a kill switch.
   */
  requires?: readonly PrereqCheck[];
  /** Turning it on moves real money: the owner confirms by typing in Slack first. */
  money?: true;
  /**
   * The section on /dev/flags, when the key's prefix does not read well or would
   * stand alone. Default: the prefix, the text before the first dot.
   */
  group?: string;
  /**
   * Who it reaches once ON, when that is not every user. /dev/flags only counts
   * a flag as shipped (on for everyone) without this. Default: every user.
   */
  audience?: "owner" | "allowlist";
}

export const FLAGS = {
  "payments.stripe.live": {
    description:
      "Stripe 正式收款：需要 sk_live_ 密钥并打开此开关。关闭 = 紧急停止：30 秒内不再开始新的付款；已经在付款中的会照常入账。",
    default: false,
    requires: ["stripe.live-key"],
    money: true,
  },
  "payments.komoju.live": {
    description:
      "KOMOJU 正式收款：需要 sk_live_ 密钥并打开此开关。关闭 = 紧急停止：30 秒内不再开始新的付款；已经在付款中的（含便利店付款）会照常入账。",
    default: false,
    requires: ["komoju.live-key"],
    money: true,
  },
  // No `audience`: the page and its rail / home links for everyone; ON is the shipped state.
  "today.goal": {
    description:
      "今日目标（/today）：全屏的一页，只有一个数字「还剩 N 张卡片」和一条进度条，加一个「开始」按钮去 /words。数字来自单词列表的真实计数（现在到期的复习卡，和 /words、首页的「到期」一样）；进度条是今天已复习的卡片占（已复习 + 还剩）的比例。亮色金底红字，暗色红底金字。侧栏和首页都有入口。关闭 = 没有这个页面（404），也没有入口。",
    default: true,
  },
  // No `audience`: a walkthrough for everyone on /words; ON is the shipped state.
  "words.onboarding": {
    description:
      "/words 首次引导：第一次打开单词列表时播放一段约五个场景的 SVG 动画（点卡片看答案、按感觉评分、处理过的卡片变淡可撤销、之后卡片在下面再出现、双指上下捏改变卡片高度），可跳过；看完或跳过后缩进标题旁的圆圈「?」按钮，点它重播。是否看过跟随账号同步。关闭 = 不自动播放，也没有「?」按钮。",
    default: true,
  },
  "words.voice-mode": {
    description:
      "/words 语音口令模式：设置里出现「语音口令」开关，打开后不用唤醒词，说「下一张、上一张、上下左右、重来/困难/良好/简单、显示答案、再读一遍、撤销、退出语音模式」来操作。关闭时只有站长本人能预览。",
    default: false,
    group: "stt",
  },
  "stt.voiceprint-filter": {
    description:
      "只听我的声音：你本机语音识别（Mac 上的 SenseVoice）只转写和你声纹匹配的话；明显不是你声音的一句话不转写、不发送，也不走云端。需要先在这台设备录声纹（聊天菜单 → 声纹）；没有声纹、或模型出问题时，一切照旧。只作用于你自己的本地语音路线，从不用于其他用户，也不是安全门：语音依然不能批准任何敏感操作。关闭（默认）= 照旧，只统计「本来会被过滤」的句数。",
    default: false,
    audience: "owner",
  },
  "stt.polish": {
    description:
      "语音消息的自动润色：打开（默认）时，助手可以按上下文（最近的消息和助手的回复、当前页面、屏幕上的词、选中的文字）改你语音消息里的错字、标点、被截断的词和漏掉的小词（的、了、在、里这类），不改原意，最近 5 条语音都能改；原文一直保留，点 ✨ 可看。关闭 = 助手不能再改你的语音消息，聊天里只留识别原文。",
    default: true,
    audience: "owner",
  },
  "stt.merge": {
    description:
      "连续语音合并：打开后，你接着说的话如果明显是上一句的延续，会并入你刚发的那条语音消息，而不是多出一个气泡；助手收到的是完整的一句，等你说完后再按上下文润色一次整段。只并你自己刚发的语音、中间没有任何人说话、没有问答卡片；语音口令不会被合并。合并后的消息有 ✨ 和撤销按钮，撤销可拆回原来的几条。关闭（默认）= 照旧：每段语音各发一条。",
    default: false,
    audience: "owner",
  },
  "chat.eta-bar": {
    description:
      "学习伙伴聊天里的任务进度条：助手给每个任务报的预计时间（progress.ts --eta）在聊天输入框上方汇总成一条进度条（总进度按预计时长加权、总剩余时间、下一个到期），点一下打开状态树，每个任务有自己的进度条和剩余时间。预计时间一到，自动在你的线程里发一条「ETA reached for …: report to the owner」给助手（静音，不朗读；不是你说的话，永远不算批准）。没有页面开着也会发（服务器定时）。只给你本人。关闭（默认）= 不显示进度条，也不发到期消息。",
    default: false,
    audience: "owner",
  },
  "partner.ai-reply": {
    description:
      "学习伙伴由 AI 回复（除你以外的所有用户）：打开后，普通登录用户在任意页面都能看到学习伙伴聊天框（不用调试模式），他们的消息由 Cloudflare Workers AI 上的 DeepSeek 模型在服务器端回复，只读他们自己的词表、到期卡片和学习计划。你的线程永远不经过模型，仍是你的 Claude 通道；通道先回复则 AI 不再回复。每人每日 token 上限和全站每日花费上限在 lib/partner-ai-config.ts。关闭（默认）= 照旧：只有调试模式的朋友能聊，由开发通道回复。",
    default: false,
    requires: ["workers-ai.credentials", "ai-credits.migration"],
    group: "ai",
  },
  // No `audience`: on, it reaches everyone who has the Learning Partner chat.
  "partner.fullscreen": {
    description:
      "学习伙伴全屏：所有能看到学习伙伴聊天框的用户，在打开的聊天框右上角都有一个全屏按钮，点一下聊天铺满整个应用（iPhone 主屏幕应用和电脑都一样），右上角的按钮、Esc 或返回键回到原来的小聊天框。同一个对话、草稿、滚动位置和麦克风，切换时都不变；是否全屏只记在这台设备上。关闭（默认）= 只有你本人能用。",
    default: false,
  },
  "connections.google": {
    description:
      "Google 连接（/connections）：所有登录用户都能连接自己的 Google 账号（只授权 drive.file：只有在 Lianki 里用 Google 选择器打开的文件），在 /reader 导入自己的非公开 Google 文档。和 Google 登录完全分开，断开不影响登录。需要先在 GCP 控制台完成设置（docs/connections.md）。关闭（默认）= 只有你本人能用。",
    default: false,
    requires: ["google.oauth-client", "google.picker-key", "auth-secret"],
    group: "read",
  },
  "self-intro.import": {
    description:
      "自我介绍从「导入关于你的材料」开始：所有登录用户都能在 /self-intro 写一段关于自己的话、或放进文件（简历、个人资料、文章、PDF、Word、照片、手写笔记的照片，可多个），AI 一次识别成一条条事实，用户逐条保留/修改/删除；还缺的或不确定的，学习伙伴一次问一个问题（可打字或点选建议答案），回答也变成待确认的信息；确认后再填进自我介绍。文件只用来识别，不保存；只保存用户确认的内容。关闭（默认）= 只有你本人能看到导入这一步，其他人照旧手动填写。",
    default: false,
    group: "ai",
  },
  "import.any": {
    description:
      "导入词表（所有登录用户，免费，不扣额度）：在 /import 和 /words 顶上的「导入」按钮里，选预制词组，或放进/粘贴 .txt / .csv / .tsv / Excel 词表（一行一个词，或带「单词/释义/例句」等列名的表格，有模板可下载），先看预览（新词几个、已经有几个、跳过几个），确认后变成 /words 里的一个新词表；已经有的词不重复添加。原文不保存，只记下导入结果。关闭时只有你本人（isDev）能用。",
    default: false,
    group: "words",
  },
  "read.gdoc-stream": {
    description:
      "Google 文档实时同步：所有用户都能在 Google 文档页面上用用户脚本打开“同步到 Lianki”，这个文档之后每次改动都会更新到自己的 /reader，打开 /reader/<id>?streamingFrom=google-docs 的阅读页会实时更新并重新标记词。只同步用户自己打开开关的文档，且要保持文档标签页开着。关闭（默认）= 只有你本人能用。",
    default: false,
  },
  "read.live-polish": {
    description:
      "实时文档的 AI 润色：所有用户都能把正在同步的 Google 文档内容润色成演讲文稿（去口头禅、重复和说错的开头），每攒够几句完整的句子润色一次，只处理新内容。用 DeepSeek V4.1 Flash，约 $0.03/小时文稿（估算），费用由 Cloudflare 账号承担，不扣用户额度，所以打开前要想好成本。原文保留，不写回文档。关闭（默认）= 只有你本人能用。",
    default: false,
  },
  "read.youtube-songs": {
    description:
      "YouTube 歌词例句（docs/youtube-song-examples.md）：所有登录用户都能在 /reader 点「YouTube 歌曲」，贴一个 YouTube 链接和带时间的歌词（LRC、SRT 或 VTT），每句歌词变成 /reader 里的一段，旁边的 ▶ 在弹窗里用 YouTube 官方播放器（youtube-nocookie）只播这一句（t0→t1）。从歌词做的单词卡会带上那一句：在 /words 和阅读器的单词复习里，例句前也有 ▶，点了就唱那一句。不下载、不保存任何音视频，只存视频 id；歌词只存在用户自己的账号里，不共享。关闭（默认）= 只有你本人能用，其他人 /reader/youtube 是 404，也看不到 ▶。",
    default: false,
  },
  "books.catalogue": {
    description:
      "公版书库 /books：所有登录用户都能看到公版书目录（只收美国公版且所有作者/译者/编者去世 80 年以上的原文，每本标明来源和授权），点一下导入成自己的书，之后在 /reader 里阅读。原文不进仓库，服务器按需从来源（Project Gutenberg）下载一次，缓存在 R2 里给所有人共用。关闭（默认）= 只有你本人能看到和导入。",
    default: false,
    group: "read",
  },
  "my-box": {
    description:
      "my-box，用自己机器上的前端（docs/custom-frontend.md；原名 live.custom-frontend）：白名单里的用户（在 /dev/live-frontends 添加/移除）可以登记自己的 Cloudflare 快速隧道（https://<名字>.trycloudflare.com，最长 8 小时，每人同时最多 3 个；现在只接受这种隧道，登记要在浏览器控制台调用 /api/live-previews，还没有界面），然后在 lianki.com/<页面>?live=<id> 看到自己开发服务器上的前端页面。页面里的请求走 /api 和 /auth，永远是正式版，用的是他在 lianki.com 上自己的账号和权限；他的开发服务器收不到任何 cookie 或登录信息，服务器端渲染时都是未登录状态。只有登记的本人能看到（别人打开同一链接只看到正式版），页面有严格的 CSP（只能连 lianki.com 和他的隧道）。关闭（默认）= 只有你本人能登记和使用。",
    default: false,
    group: "box",
    audience: "allowlist",
  },
  "box.oauth": {
    description:
      "开发盒通过 lianki.com 登录（docs/box-oauth.md）：my-<hash> 盒子用 OAuth（PKCE）登录，只能用绑定的那一个账号（在 /dev/box-clients 绑定/撤销），用短期令牌访问允许的 API 路由，只能碰这个账号自己的数据。关闭时：相关路由一律 404，盒子无法登录。",
    default: false,
    audience: "allowlist",
  },
  levels: {
    description:
      "学习等级（种子→莲 / 炼气→炼虚）：所有用户都能看到自己的等级（未注册 / 免费 / 付费，付费后按累计有效学习天数升：100、365、1000 天）——登录后导航栏头像旁有一个小徽章，/my/profile 上有等级卡片（徽章、等级名、学习天数、离下一级还差几天；未注册的访客在 /my/profile 也能看到自己的等级和注册提示）。学习天数不论开关都在记录。关闭（默认）= 只有你本人能看到。",
    default: false,
  },
  "read.vibe": {
    description:
      "/vibe 对话日记（docs/vibe.md）：和外国朋友对话时互相学语言。声音只在你的 Mac 上转成文字（不存、不上传），文字存进你账号里的一篇私有文档（/reader 可读，一直留着直到你删除；想自动删可在偏好设置里填天数）。/vibe 列出所有对话，/vibe/new 点一下「开始」就开始，没有表单，/vibe/<id> 是一段对话的记录。打开后：只有你本人能开始。关闭（默认）= 任何人都不能开始，包括你本人（没有 owner 例外），服务器也拒绝写入；已有的文档仍可阅读和删除。",
    default: false,
    audience: "owner",
  },
  "voice.li-hub": {
    description:
      "声音都经过 Li（第 0 步，只观察，docs/li-sound-hub.md）：打开后，在你本人的页面上（调试模式），Li 记录谁在用麦克风（聊天麦克风、对话日记的录音）、谁在出声（Li 的朗读、/words 读词、阅读器朗读、页面上的 <audio> 和浏览器语音），写进 Worker 日志：每次变化一条 audio-owner，两个录音同时开着或两个声音同时在放时一条 audio-conflict。不改变任何声音或麦克风的行为。关闭（默认）= 完全不运行，和以前一模一样。",
    default: false,
    group: "stt",
    audience: "owner",
  },
  "ext.pill-chat": {
    description:
      "从用户脚本药丸打开 Li 聊天（docs/userscript-li-chat.md，第一步）：在任意网站上，用户脚本的浮动药丸多一个「Li」按钮。每个网站第一次点时先问「允许在这个网站使用 Li 聊天吗？」（仅这一次 / 在此网站总是允许 / 永不），关掉弹窗 = 不允许；允许之前不向 lianki.com 发任何聊天请求。允许后在 lianki.com 的独立窗口（跨域 iframe）里打开 Li，网站读不到你输入的内容，也拿不到登录凭证。已允许/已拒绝的网站可以在脚本管理器菜单「Li 聊天：网站…」里移除。现在复用你的伙伴票据，所以打开后也只有你本人能用。关闭（默认）= 谁都看不到 Li 按钮，已打开的网站下次点也不会再打开。",
    default: false,
    audience: "owner",
  },
  "byok.sync": {
    description:
      "「自己的 AI」里的「同步 API key 到账号」（托管模式）草稿：所有登录用户都能看到这一行（显示「即将推出」和提醒：打开后 Lianki 服务器会保存你的 key（加密）；关闭会删除服务器上的副本）。现在只是界面，点不了，服务器上没有任何保存 key 的代码。提供方 / 地址 / 模型的同步不受这个开关影响，已经可以用。关闭（默认）= 只有你本人能看到这一行。",
    default: false,
    group: "ai",
  },
  "pwa.app-badge": {
    description:
      "应用图标角标数字（docs/app-badge.md）：装到主屏幕/程序坞的 Lianki 图标上显示一个数字 = 没回答的 Li 提问卡 + 今天到期的卡片（页面卡片和单词）。在「设置 → 通知」里选数什么：关闭 / 只数提问 / 只数到期卡片 / 两个都数（默认）。打开 App、切回来、回答提问、复习完都会更新；在 /review、/words 上时不数到期卡片。浏览器不支持就什么都不做（iPhone 需要 iOS 16.4+、从主屏幕打开并允许通知）。现在打开后只有你本人能用（以后再加名单）。关闭（默认）= 谁都没有角标，设置里也没有这一行。",
    default: false,
    audience: "owner",
  },
  // No `audience`: on (the default), every /words list review has it.
  "words.pinch-card-height": {
    description:
      "单词列表复习里双指上下捏合改卡片高度：两指在列表上竖着捏拢 = 卡片变矮、一屏更多词；张开 = 卡片变高、每张显示更多（例句、意思）。最矮只剩单词，最高把屏幕上的卡片内容全部显示出来；松手后停在整行上。高度跟着账号同步到所有设备。页面不会被缩放，单指滑动照旧。打开（默认）= 所有人都能捏；关闭 = 捏合不改高度，已选的高度也不再生效（恢复默认高度）。",
    default: true,
  },
  "membership.email-invite": {
    description:
      "邮件邀请好友：所有 Pro 用户（和管理员）在 /membership 的邀请卡片里多一个「用邮件邀请」框，填一个朋友的邮箱，Lianki 用发件人的账户语言发一封邀请信，里面是他自己的邀请链接（奖励规则不变）。防滥用：每人每天最多 5 封、同一个地址一个月内只收一封（不管谁邀请）、一次只能填一个地址、已有账户的地址不发（发件人看到的结果一样）、信里有退订和举报链接（一键退订），被举报 2 次的发件人不能再发。收件人地址只存哈希，发件人只看到自己发过的打码地址。关闭（默认）= 只有你本人（管理员）能用。",
    default: false,
    requires: ["auth-secret"],
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;

/** A value for every flag; a key that is missing reads as off. */
export type FlagValues = Partial<Record<FlagKey, boolean>>;

/**
 * Renamed flags: the new key and the key its state was stored under. A stored
 * row under the new key wins, whatever its value; without one, the old key's
 * row is the state. So a rename changes no switch and writes nothing, and the
 * first change at /dev/flags moves the flag to its new key.
 * docs/feature-flags.md, "Renaming a flag".
 */
export const FLAG_OLD_KEYS = {
  "my-box": "live.custom-frontend",
} as const satisfies Partial<Record<FlagKey, string>>;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: unknown): key is FlagKey {
  return typeof key === "string" && Object.hasOwn(FLAGS, key);
}

/** Every flag at its registry default (what a key with no stored row reads as). */
export function defaultFlags(): Record<FlagKey, boolean> {
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, FLAGS[k].default as boolean])) as Record<
    FlagKey,
    boolean
  >;
}

/** Every flag off: what an unreadable store reads as, whatever the defaults (fail closed). */
export function closedFlags(): Record<FlagKey, boolean> {
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, false])) as Record<FlagKey, boolean>;
}

/** The stored row that decides `key`: its own, or else its old key's (FLAG_OLD_KEYS). */
export function storedFlagRow<R>(rows: ReadonlyMap<string, R>, key: FlagKey): R | undefined {
  const old = (FLAG_OLD_KEYS as Partial<Record<FlagKey, string>>)[key];
  return rows.get(key) ?? (old === undefined ? undefined : rows.get(old));
}

/** On only when the snapshot says exactly `true`; anything else is off. */
export function flagIn(flags: FlagValues | null | undefined, key: FlagKey): boolean {
  return flags?.[key] === true;
}
