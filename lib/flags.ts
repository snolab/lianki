/**
 * The feature-flag registry: every flag the owner can turn on and off at
 * /dev/flags, with no deploy and no secret change. docs/feature-flags.md.
 *
 * Rules:
 * - Only keys listed here exist. The store refuses to write any other key, and
 *   ignores a stored row whose key is not here.
 * - Every default is OFF (`default: false`), so a flag that cannot be read,
 *   a fresh database, and a new flag all mean "off". Ship a new feature dark
 *   behind a flag; when it has been on for good, delete the flag and its checks.
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
  /** Always off; a flag is a switch the owner turns ON. */
  default: false;
  /**
   * Checks that must all pass before the flag may be turned ON (the API
   * refuses otherwise; /dev/flags greys the switch). Turning OFF is always
   * allowed: a flag is also a kill switch.
   */
  requires?: readonly PrereqCheck[];
  /** Turning it on moves real money: the owner confirms by typing in Slack first. */
  money?: true;
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
  "words.voice-mode": {
    description:
      "/words 语音口令模式：设置里出现「语音口令」开关，打开后不用唤醒词，说「下一张、上一张、上下左右、重来/困难/良好/简单、显示答案、再读一遍、撤销、退出语音模式」来操作。关闭时只有站长本人能预览。",
    default: false,
  },
  "read.reader-v2": {
    description:
      "新阅读器 /read/[id]：整本书连续滚动（按原书段落显示），每个词按熟悉度标记；左右滑动一段给理解打分（同 /words，FSRS 记在每个句子上），朗读读完一段后等你滑动；同步阅读位置、阅读笔记和语境中见过的词。关闭时只有站长本人能用（数据接口和新界面都是，正式站也一样）。",
    default: false,
  },
  "stt.polish-off": {
    description:
      "关闭语音消息的自动润色：打开后，助手不能再改写你的语音消息，聊天里只留识别原文。关闭（默认）= 照旧：助手只按上下文（最近的消息、当前页面、屏幕上的词）改错字和标点，不改原意；原文一直保留，点 ✨ 可看。",
    default: false,
  },
  "partner.ai-reply": {
    description:
      "学习伙伴由 AI 回复（除你以外的所有用户）：打开后，普通登录用户在任意页面都能看到学习伙伴聊天框（不用调试模式），他们的消息由 Cloudflare Workers AI 上的 DeepSeek 模型在服务器端回复，只读他们自己的词表、到期卡片和学习计划。你的线程永远不经过模型，仍是你的 Claude 通道；通道先回复则 AI 不再回复。每人每日 token 上限和全站每日花费上限在 lib/partner-ai-config.ts。关闭（默认）= 照旧：只有调试模式的朋友能聊，由开发通道回复。",
    default: false,
    requires: ["workers-ai.credentials", "ai-credits.migration"],
  },
  "connections.google": {
    description:
      "Google 连接（/connections）：所有登录用户都能连接自己的 Google 账号（只授权 drive.file：只有在 Lianki 里用 Google 选择器打开的文件），在 /read 导入自己的非公开 Google 文档。和 Google 登录完全分开，断开不影响登录。需要先在 GCP 控制台完成设置（docs/connections.md）。关闭（默认）= 只有你本人能用。",
    default: false,
    requires: ["google.oauth-client", "google.picker-key", "auth-secret"],
  },
  "self-intro.import": {
    description:
      "自我介绍从「导入关于你的材料」开始：所有登录用户都能在 /self-intro 写一段关于自己的话、或放进文件（简历、个人资料、文章、PDF、Word、照片、手写笔记的照片，可多个），AI 一次识别成一条条事实，用户逐条保留/修改/删除；还缺的或不确定的，学习伙伴一次问一个问题（可打字或点选建议答案），回答也变成待确认的信息；确认后再填进自我介绍。文件只用来识别，不保存；只保存用户确认的内容。关闭（默认）= 只有你本人能看到导入这一步，其他人照旧手动填写。",
    default: false,
  },
  "books.catalogue": {
    description:
      "公版书库 /books：所有登录用户都能看到公版书目录（只收美国公版且所有作者/译者/编者去世 80 年以上的原文，每本标明来源和授权），点一下导入成自己的书，之后在 /read 里阅读。原文不进仓库，服务器按需从来源（Project Gutenberg）下载一次，缓存在 R2 里给所有人共用。关闭（默认）= 只有你本人能看到和导入。",
    default: false,
  },
  levels: {
    description:
      "学习等级（种子→莲 / 炼气→炼虚）：所有登录用户都能通过 /api/levels/me 读到自己的等级（未注册 / 免费 / 付费，付费后按累计有效学习天数升：100、365、1000 天）。界面上还没有任何地方显示等级。学习天数不论开关都在记录。关闭（默认）= 只有你本人能看到自己的等级（/dev/levels）。",
    default: false,
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;

/** A value for every flag; a key that is missing reads as off. */
export type FlagValues = Partial<Record<FlagKey, boolean>>;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: unknown): key is FlagKey {
  return typeof key === "string" && Object.hasOwn(FLAGS, key);
}

/** Every flag at its default (off). */
export function defaultFlags(): Record<FlagKey, boolean> {
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, FLAGS[k].default])) as Record<
    FlagKey,
    boolean
  >;
}

/** On only when the snapshot says exactly `true`; anything else is off. */
export function flagIn(flags: FlagValues | null | undefined, key: FlagKey): boolean {
  return flags?.[key] === true;
}
