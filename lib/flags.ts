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
   * - "owner": `dev` holders; each call site checks `isDev` itself.
   * - "allowlist": the flag's own list (a /dev page); the call site checks it.
   * - "insider": `isInsider` (the `insider` grant, or `admin`). Read it with
   *   flagOnFor (lib/flag-audience.ts), which applies the audience for you.
   *   Insiders first: ship with `audience: "insider"`, then delete the line to
   *   reach everyone (docs/feature-flags.md, "Insiders first").
   */
  audience?: FlagAudience;
}

export type FlagAudience = "owner" | "allowlist" | "insider";

/**
 * The audience badge on each /dev/flags row (owner-only and Chinese only, like
 * the rest of that page), with a context line so it is never translated or
 * reworded on its own (docs/i18n.md). A flag without `audience` has no badge.
 */
export const AUDIENCE_LABELS = {
  owner: {
    zh: "仅开发者",
    context:
      "Small badge beside a switch's name on the owner's /dev/flags page: once on, the switch reaches only accounts holding the dev permission, not every user.",
  },
  allowlist: {
    zh: "仅名单内",
    context:
      "Small badge beside a switch's name on the owner's /dev/flags page: once on, the switch reaches only the accounts on that switch's own allow list.",
  },
  insider: {
    zh: "仅内测用户",
    context:
      "Small badge beside a switch's name on the owner's /dev/flags page: once on, the switch reaches only insiders (accounts given the insider permission at /dev/permissions, plus admins) — a feature shipped to insiders first.",
  },
} as const satisfies Record<FlagAudience, { zh: string; context: string }>;

export const FLAGS = {
  "partner.standard-flow": {
    description:
      "统一学习伙伴流程：所有账号（包括有开发权限的账号）由同一套学习伙伴流程回答、整理和补充交接信息。连续语音停顿后合成一轮，保留原话编号；助手仍可直接监听、主动回答或不答，无需等待学习伙伴。额度、积分和已有权限不变。关闭 = 保留原来的回复规则。",
    default: false,
    group: "ai",
  },
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
  // No `audience`: for everyone; ON is the shipped state.
  "app.auto-update": {
    description:
      "有新版本时自动更新（lib/auto-update.ts）：页面「干净」时（没有未发送的聊天草稿、没在录音或按住说话、没在朗读或播放、没有打开的对话框或改过的表单、没有正在保存的请求、没在 /words 或 /review 的进行中、没在录声纹）自己刷新：切到后台时、换到别的页面时、或者一段时间没有操作后；回来时停在原来的位置。右下角显示「有新版本，空闲时自动更新」；页面不干净时显示「有新版本，有未保存内容」，干净了再更新。用户可在「设置」里自己关掉。关闭 = 和以前一样，只显示「有新版本 · 刷新」按钮。",
    default: true,
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
  "stt.voiceprint-cloud": {
    description:
      "声纹存到你的账号：声纹面板里多出「保存到我的账号」「从账号恢复」，你按一下、过一次 Face ID / Touch ID，Mac 上的声纹特征（描述声音的数字，不是录音）就加密存进你的 Lianki 账号，只有你的账号能读，随时可删；换一台 Mac 也能恢复。删除声纹时 Mac 和账号里的一起删。只对有 dev 权限的账号开放。关闭 = 声纹只在 Mac 上，账号相关的按钮和接口都没有。",
    default: true,
    audience: "owner",
  },
  "voice.clone": {
    description:
      "用你自己的声音朗读：把一段你的声音样本（一段不超过 30 秒的录音和它的文字）加密存进你的 Lianki 账号，换一台 Mac 也能用你的声音合成语音。存入、替换、删除每次都要过一次 Face ID / Touch ID（不走十分钟免验证窗口）；只有你的账号能读，随时可删。只对有 dev 权限的账号开放。关闭（默认）= 账号里不存声音样本，/api/my/voice-clone-ref 不存在（404），已存的样本留着但读不到。",
    default: false,
    audience: "owner",
    group: "stt",
  },
  "voice.recordings": {
    description:
      "麦克风录音存到你的账号（/my/recordings，docs/recordings.md）：在 Lianki 里开着麦克风时，每一句话（主动和被动模式都算，发不发到聊天都算）的录音和它已有的文字（Mac 本机识别的；Mac 不在时是聊天用的云端结果）加密存进你的账号，第二天也能回听、按天下载到 Mac 上重新识别。会议里别人的声音也会被录下；只有你的账号能读。服务器从不替录音做识别。默认永久保留，不自动删除（/dev/config 的 recordings.retentionDays，0 = 永久），可以在页面上按句删除。只对有 dev 权限的账号开放。关闭 = 不再上传新的录音，/api/my/recordings 和 /my/recordings 都不存在（404）；已存的录音留着但读不到（设了保留天数时到期照样清理）。",
    default: true,
    audience: "owner",
    group: "stt",
  },
  // Recording: one of the exceptions to "new flags ship on" (docs/meetings.md, "The gate").
  "meetings.record": {
    description:
      "会议录制（/my/meetings，docs/meetings.md）：在电脑上的 Chrome / Edge 里点「开始」，选一个标签页或屏幕共享，录下画面、你的麦克风和被共享标签页的声音，每 30 秒一段加密上传到你的账号，在 /my/meetings 回放、下载、删除。只在你亲手点「开始」后才录；录制时每个 Lianki 页面底部有「正在录制」条，聊天麦克风暂停。只对有 dev 权限的账号开放。关闭（默认）= /my/meetings 和 /api/my/meetings 都不存在（404），正在录的会议在下一段上传时停下；已存的会议留着但读不到，保留期照样生效。",
    default: false,
    audience: "owner",
    group: "stt",
  },
  "stt.polish": {
    description:
      "语音消息的自动润色：打开（默认）时，助手可以按上下文（最近的消息和助手的回复、当前页面、屏幕上的词、选中的文字）改你语音消息里的错字、标点、被截断的词和漏掉的小词（的、了、在、里这类），不改原意，最近 15 条语音都能改；原文一直保留，点 ✨ 可看。关闭 = 助手不能再改你的语音消息，聊天里只留识别原文。",
    default: true,
    audience: "owner",
  },
  "voice.auto-polish": {
    description:
      "语音自动润色：你用麦克风说的每一句话识别完以后，不用等助手，系统自己（标记为 auto）立刻用便宜的快模型按上下文改错字、去口头禅、补标点，原意和你的说法不变；短短几秒内接着说的几句如果明显是一句话的碎片，会合并成一条。只改你自己说的话，打字的、别人的、已经润色过的都不动；原文一直保留，点 ✨ 可看，助手之后还能再润色。按字数从你的积分扣（和别人一样，没有管理员免费）；等多久、最短几个字在 /dev/config 的 voice.autoPolish* 里。总开关 stt.polish 关了它也不润色。关闭 = 只有助手主动润色时才改。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "voice.fold-others": {
    description:
      "非本人声纹内容折叠：打开（默认）时，声纹识别判定不是你本人的语音消息（识别为另一个声音）在 Li 聊天和 /my/recordings 录音回顾文章中默认折叠成一行小字，点击可展开或再次折叠；折叠状态仅在当前标签页会话（sessionStorage）中记忆。关闭 = 别人的声音在聊天与回顾中直接展开显示，不默认折叠。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "voice.speaker-avatars": {
    description:
      "每个声音一个头像：打开（默认）时，Li 聊天里不是你本人的语音行，按 Mac 声纹服务器给的声音分组（今天听到的第一个陌生声音 A、第二个 B……，家人声纹则是「家人的声音」）各用自己的头像：字母或小房子，颜色各不相同（不用你的印章红）。分组只在 Mac 内存里，每天本地午夜和重启后从 A 重新开始。调色板和最低相似度在 /dev/config 的 voice.clusterHues、voice.clusterMinScore。关闭 = 照旧，所有别人的声音共用一个「另一个声音」头像。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "voice.echo-dedupe": {
    description:
      "回声去重：两台手机同时开着麦克风时，同一句话被另一台设备再识别一次（超过两麦合并的几秒、或者识别得稍有不同），或者 Li 朗读的助手回复、你润色后的读回被另一台手机听到又转成文字，都会被当成回声：不显示、不朗读、不转给助手，原文留在 hub 里可以撤销（edited.by 为 auto，原因 echo）。时间窗和相似度在 /dev/config 的 voice.echo* 里。关闭 = 照旧，每条都当作你说的新话。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  // docs/echo-suppression.md, layer (b) and the collapsed rows (owner "go", 2026-11-20).
  "voice.echo-reports": {
    description:
      "朗读回声（跨设备）：打开（默认，只对你）后，你的每台设备朗读时（Li 读回复、读回你润色后的话、/words 读单词、阅读器朗读）都告诉 hub「正在读哪句、从几点到几点」；另一台设备的麦克风同一时间听到、内容又落在这几句里，就当作朗读回声：不转给助手、Li 不回、不润色、不朗读、不进聊天记录，只在聊天里折叠成一行「朗读声被录回」，点开能看全文，点「这是我说的」就照常发出。读过的句子只在 hub 内存里留 2 分钟（/dev/config 的 voice.echoPlayKeepMs）。相似度和时间余量在 voice.echoPlaySimilarity、voice.echoSlackMs。关闭 = 和以前完全一样：只按助手回复到达的时间判断，回声直接隐藏。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  // docs/echo-suppression.md, "The play window" (2026-11-26 00:30–00:55 JST incident).
  "voice.echo-window": {
    description:
      "朗读时间窗：打开（默认，只对你）后，你的任何一台设备正在朗读（Li 读消息、/words 读单词和例句、阅读器）或刚读完的几秒内，麦克风识别出来的话只要和刚读出来的句子对得上一部分（门槛 voice.echoWindowMatchMin，比平时的 voice.echoPlaySimilarity 低，识别走样的回声也能认出来），就当朗读回声：不转给助手、Li 不回、不润色、不进聊天记录，只折叠成一行「朗读声被录回」，点「这是我说的」照常发出。只看时间从不折叠：朗读时你或别人说的别的话照常发出；没有文字的声音（播放的语音文件）什么也折叠不了。另外，识别噪声短语（voice.echoHallucinations，如「明镜需要您的支持」）在最近读过东西时也折叠。Mac 声纹明确签名说「是你」的那句照常发出。收尾时长和比例在 /dev/config 的 voice.echoWindowTailMs、voice.echoWindowShare。关闭 = 只按平时的内容门槛比对，识别噪声短语也不再折叠。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  // docs/echo-suppression.md, layer (c), M4 (owner approved 2026-11-21).
  "stt.self-voice": {
    description:
      "认出我们自己的朗读声：打开（默认，只对你）后，你的页面让 Mac 的声纹服务器同时拿每句话去比 Lianki 自己的朗读声音（MeloTTS、Aura、谷歌 / Azure 声音，只用生成的语音做的 self.campp.json 声纹，从不包括你的克隆声音）；明显更像我们的朗读声、不像你的那句，就标成「我们自己的声音」：和朗读回声一样只折叠显示，不转给助手、Li 不回、不进聊天记录，点「这是我说的」照常发出。Mac 上没有这份声纹时什么都不变。界线在 /dev/config 的 stt.selfAccept、stt.selfMargin、stt.selfMeMargin。关闭 = 照旧，Mac 不做这个判断。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "stt.merge": {
    description:
      "连续语音合并：打开后，你接着说的话如果明显是上一句的延续，会并入你刚发的那条语音消息，而不是多出一个气泡；助手收到的是完整的一句，等你说完后再按上下文润色一次整段。只并你自己刚发的语音、中间没有任何人说话、没有问答卡片；语音口令不会被合并。合并后的消息有 ✨ 和撤销按钮，撤销可拆回原来的几条。关闭（默认）= 照旧：每段语音各发一条。",
    default: false,
    audience: "owner",
  },
  // Owner, 2026-11-15 03:17 JST: "用 Whisper 整段重听 … 作为第二步 polish".
  "stt.whisper-recheck": {
    description:
      "Whisper 整段重听：你断断续续说的几句合并成一条以后，说完（停顿下来）时，你 Mac 上的 Whisper（Large V3 Turbo）把这一整段的录音重新听一遍，这条消息换成它听出来的文字；之后的自动润色和助手润色都在这段文字上改。三级：流式识别（SenseVoice）→ Whisper 整段重听 → 润色。原来流式识别的文字留在消息详情里。录音只在 Mac 的内存里，不存文件、不上传；太短（/dev/config 的 stt.recheckMinSec）或太长（stt.recheckMaxSec）的一段不重听，Mac 没回答（stt.recheckTimeoutMs）就照旧。需要 stt.merge 开着、用的是 Mac 的本地识别。关闭 = 照旧：合并后直接润色流式识别的文字。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  // Owner, 2026-11-14 02:15 JST: the mic open on two devices doubled every sentence.
  "stt.two-mic-merge": {
    description:
      "两个麦克风合成一条：你在两台设备（比如 Windows 和 Mac）上同时开着麦克风时，同一句话两边各识别一次。打开（默认）时，另一台设备几秒内（/dev/config 的 chat.twoMicWindowMs，默认 4 秒）发来几乎一样的语音消息，就当成同一句，只留一条：声纹认出是你的那条优先，其次声纹分数高的，再其次更完整的那条文字；声纹说是别人的话不会和你的合并，打字的消息从不合并。关闭 = 照旧：每台设备各发一条。",
    default: true,
    audience: "owner",
  },
  // Lianki's speech servers for other accounts (docs/local-stt.md, "Lianki's speech
  // servers for everyone"): owner decision 2026-11-11 00:3x JST, shipped dark.
  "stt.worker": {
    description:
      "Lianki 语音服务器对其他账号开放（第一阶段）：名单里的账号（/dev/stt-access 添加/移除）在麦克风里用 Lianki 的语音服务器（SenseVoice）流式识别：先走 WebRTC 直连（STUN，TURN 备用），再走 WSS 隧道，最后才是 Workers AI 云端。暂时免费，每句话按云服务价格记进成本账（/dev/costs，speech.stt.local）。每人同时 1 个会话、每分钟最多 6 张票、每天 30 分钟、一句最长 40 秒、一次会话最长 15 分钟，机器容量 3 路留 1 路给你（都在 /dev/config 改）。用户看到的只有「Lianki 的语音服务器」。关闭（默认）= 相关接口一律 404，你自己的麦克风照旧不变。",
    default: false,
    audience: "allowlist",
  },
  "chat.lane-events": {
    description:
      "全员入群：聊天里每个 agent（API token）一条线，记下它是「实时监听」还是「只读」、有没有被禁言。线入群、开始实时监听、转为只读、下线、被禁言时，聊天里出现一行系统消息（静音，不朗读），头像栏显示每个 agent 的状态；被禁言的线发言会被拒绝（403）。关闭 = 不记状态、不发系统消息、不禁言，聊天和以前一样。",
    default: true,
    audience: "owner",
    // With the other agent switches (the groups stay few, flag-view.ts).
    group: "ai",
  },
  "chat.eta-bar": {
    description:
      "学习伙伴聊天里的任务进度条：助手给每个任务报的预计时间（progress.ts --eta）在聊天输入框上方汇总成一条进度条（总进度按预计时长加权、总剩余时间、下一个到期），点一下打开状态树，每个任务有自己的进度条和剩余时间。预计时间一到，自动在你的线程里发一条「ETA reached for …: report to the owner」给助手（静音，不朗读；不是你说的话，永远不算批准）。没有页面开着也会发（服务器定时）。只给你本人。关闭（默认）= 不显示进度条，也不发到期消息。",
    default: false,
    audience: "owner",
  },
  // Owner, 2026-11-14 23:2x JST: "消息里能带计算器/按钮等组件" — data only, no script.
  "chat.message-widgets": {
    description:
      "消息里的小组件（packages/debug-chat/src/message-widget.ts）：你的助手（配对的或你自己的通道令牌）在你自己的线程里发 ```lianki-widget 代码块（JSON），聊天里就显示成按钮、计算器、滑块或表格。全是页面自己的组件，消息里的任何代码都不会运行；点一下只是把内容填进你的回复框，发不发由你。朋友和家人的线程、你自己打的字不显示组件。关闭 = 这些代码块照原样显示为代码。",
    default: true,
    // With the other agent switches (the groups stay few, flag-view.ts).
    group: "ai",
    audience: "owner",
  },
  "chat.play-audio": {
    description:
      "助手在你手机上播放音频（docs/li-sound-hub.md「Playing audio from an agent」）：助手用 say --play <https 地址 | file:我的文件> 发一条带 ▶ 的消息，可以是音频文件，也可以是直播流（HLS / Icecast）。只在手机页面、页面在前台、已经点过一下（声音已解锁）、麦克风没开时自动播放；否则 ▶ 等你点，并说明原因。Mac 上永远不自动播放。Li 说话时它暂停，等 Li 说完再继续；不改任何音量。服务器从不去抓那个地址。通道令牌要有「chat:play」权限，每条都记进安全日志（谁、哪个网站、什么时候），限速和禁止的网站在 /dev/config（chat.play.*）。关闭（默认）= 不显示 ▶，带音频的消息被拒绝。",
    default: false,
    group: "stt",
    audience: "owner",
  },
  // No `audience`: on, any account whose token holds mic:polish (or its session) may call it.
  "mic.polish-api": {
    description:
      "麦克风润色接口（docs/mic-polish-api.md）：打开后 POST /api/mic/polish 可用——otoji.org/mic 的用户脚本通过 otoji 的服务器，用带「mic:polish」权限的 Lianki API 令牌（或在 lianki.com 上登录的会话），把一段语音识别文字交给我们的 Workers AI 润色（改错字、标点，不加内容）。每次先从调用者自己的积分预扣、按实际用量结算、失败全退（管理员也一样扣）；每个账号每个 UTC 日最多 mic.polishDailyMax 次，每个令牌每分钟最多 mic.polishPerMinute 次，大小上限在 /dev/config 的 mic.polish*。关闭（默认）= 接口不存在（404），otoji 端只能用原文。",
    default: false,
    requires: ["workers-ai.credentials", "ai-credits.migration"],
    group: "ai",
  },
  "chat.line-replay": {
    description:
      "聊天里回放你说的话的原始录音（docs/recordings.md「Replay from the chat」）：右键或长按你自己的一条语音消息，消息详情里出现「播放原始录音」，播放这句话在 /my/recordings 里存的那段录音（用你自己的登录读取，只读你自己的录音）。和 /my/recordings 同一道门：还要 voice.recordings 打开、账号有 dev 权限；找不到录音就什么都不显示。通过 Li 的播放器播放：麦克风开着时不播，Li 说话时暂停。关闭 = 消息详情里不显示这一项，也不去查录音。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "partner.ai-reply": {
    description:
      "学习伙伴由 AI 回复（除你以外的所有用户）：打开后，普通登录用户在任意页面都能看到学习伙伴聊天框（不用调试模式），他们的消息由 Cloudflare Workers AI 上的 DeepSeek 模型在服务器端回复，只读他们自己的词表、到期卡片和学习计划。你的线程仍是你的 Claude 通道（只有 partner.owner-thread 打开时，没有通道回复的消息才由 Li 回复）；通道先回复则 AI 不再回复。每人每日 token 上限和全站每日花费上限在 lib/partner-ai-config.ts。关闭（默认）= 照旧：只有调试模式的朋友能聊，由开发通道回复。",
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
  "words.import-ai": {
    description:
      "导入：AI 把已保存的文件变成单词：/words「导入」面板第三项「任意文件」里，每个已保存的文件旁多一个「用 AI 变成单词」按钮。服务器读出这个文件的文字（文本、PDF、Word、网页、字幕 .srt、Excel、照片），交给 DeepSeek（Cloudflare Workers AI）整理成和 CSV 模板一样的表（单词 / 释义 / 例句），然后走 CSV 导入同一条路：先看生成的 CSV（可下载、可修改）和预览，确认后才添加。用户自己的额度付费：先按这个文件最多可能花的扣住，做完按实际结算、多的退回；额度不够就说不够，不缩小；超过扣住的额度就停，不多扣。只有额度够最小一次扣住的人才看得到按钮。打开 = 所有登录用户（额度够的）；关闭（默认）= 只有有 dev 权限的人（额度够的，管理员免费）。",
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
  // No `audience`: /library, the catalogue, for everyone; ON is the shipped state.
  // Replaced `books.catalogue` (2026-11-10), on for everyone since 2026-11-05;
  // its stored row is ignored now (a key not listed here).
  "library.catalogue": {
    description:
      "书库 /library：所有人都能看到书目（每本只在首次出版国、你所在的国家和美国都属于公有领域时列出，标明来源和授权），登录后点一下「加入我的阅读」，书就进了 /books「我的书」和 /reader。原文不进仓库，服务器按需从来源下载一次，缓存在 R2 里给所有人共用。关闭 = /library 是 404，没有入口；有 dev 权限的人仍能看到。",
    default: true,
    group: "read",
  },
  // No `audience`: /books, the user's own shelf, for everyone; ON is the shipped state.
  "books.mine": {
    description:
      "我的书 /books：每个登录用户的书架，放从书库 /library 加入的书和自己导入的书（EPUB 或纯文本，存在「我的文件」的「书」文件夹里，只有本人能看到；服务器解析章节、书名、作者、封面和语言，不用 AI、不扣额度）。旧的 /books/<语言>/<书名> 链接：书在书架上就留在 /books，不在就 308 转到 /library。关闭 = /books 不再是书架，旧链接一律转到 /library，侧栏没有「我的书」；有 dev 权限的人仍能看到。",
    default: true,
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
  "mcp.oauth": {
    description:
      "MCP 用 OAuth 登录（docs/mcp-oauth.md）：ChatGPT、Claude.ai 等应用连接 https://lianki.com/mcp 时自行注册，用户在 lianki.com 登录并在同意页上看到应用名和权限后批准；应用拿到的是短期 lk_ 令牌（可续期），和用户自己建的 API 令牌走同一个检查。用户可在 偏好设置 → API 令牌 → 已连接的应用 里断开。打开后：所有账号都能连接。关闭（默认）：元数据、注册、授权、换令牌一律 404，已发出的 OAuth 令牌全部失效（行还在，重新打开即恢复）。",
    default: false,
    group: "mcp",
  },
  "mcp.events": {
    description:
      "MCP 事件（docs/chat-wake.md）：连上 https://lianki.com/mcp 的 ChatGPT 会话可以订阅「被 @ 名字」事件——你在这个令牌所在的聊天里写一行带 @令牌名（不分大小写）的话，Lianki 就向 ChatGPT 的回呼地址发一条签名通知，只带这一行的 id、文字和作者，不带历史。代理自己的行永远不会触发。打开后：只有你本人（有 dev 权限的账号）的令牌能订阅。关闭（默认）：不再宣告事件能力，订阅被拒绝，任何通知都不发（已有订阅留着，重新打开即恢复；令牌被撤销时订阅自动删除）。",
    default: false,
    group: "mcp",
    audience: "owner",
  },
  "chat.wake.pull": {
    description:
      "拉取式唤醒（docs/chat-wake.md）：任何代理（Gemini 定时任务、本机 Claude Code / Codex、以后的客户端）用自己的令牌查「谁 @ 了我」——MCP 工具 lianki_chat_mentions_since 和 events/poll，只返回这个令牌自己线程里 @ 它名字的那几行（id、文字、作者），不带历史，需要 chat:read。要先打开 mcp.events（被 @ 的记录由它记下）。只对有 dev 权限的账号开放。关闭 = 工具和 events/poll 都答「未开启」，events/list 不再列出 poll；记录照记，过期后在有人写聊天或代理来查时顺带分批删（网站完全没人用时不删）。",
    default: true,
    group: "mcp",
    audience: "owner",
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
  "voice.talk-over": {
    description:
      "朗读时插话（不关麦克风）：在你本人的页面上（需要 dev 权限），回声消除关着（lk:voice-aec = 0）时，Li 朗读回复的时候麦克风不再暂停（不会变成金色的「暂停收音」圈），一直在听。你一开口，Li 就停下来听你说，说完照原来的规则接着读（你的话发出去后，或安静 1.5 秒后）。Li 自己的声音不会被当成你的话：识别出来的一句话，如果时间上和 Li 正在读的那一句重叠、内容也基本就是那一句，就当回声丢掉；同样的词在别的时间说就是你的。/words 读单词时照旧暂停收音；回声消除开着时一切照旧。关闭（默认）= 照旧：回声消除关着时，Li 朗读期间麦克风暂停收音。",
    default: false,
    group: "stt",
    audience: "owner",
  },
  "voice.sync-speak": {
    description:
      "多台设备同时朗读：你有两台或更多设备同时连着、都在读 Li 的话时，同一句话尽量在同一时刻开始读（相差约 0.2 秒以内）。先收到的设备等几百毫秒（/dev/config 的 voice.syncLeadMs，默认 300），等慢的设备也收到；最多等 voice.syncMaxWaitMs（默认 1.5 秒），已经晚了的设备马上读。只有一台设备时从不等待。润色后的回读也一样。打开（默认，只对你）；关闭 = 照旧，每台设备收到就读。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "voice.audio-sync": {
    description:
      "多端毫秒级语音同步（WebRTC + Web Audio + 声学延迟检测）：打开后，同账号在线设备之间通过 WebRTC DataChannel 做 NTP 时钟对齐，并用 AudioBufferSourceNode 统一定时起播，配合麦克风声学相关性自动补偿不同设备（如 Windows 外放与 Mac 蓝牙/预览代理）的硬件延迟差，让多台设备听起来像同一个声音。关闭（默认）= 仅用原有的 voice.sync-speak 粗同步。",
    default: false,
    group: "stt",
    audience: "owner",
  },
  "voice.polish-readback": {
    description:
      "润色后用你自己的声音读一遍：在你本人的页面上（需要 dev 权限），你用麦克风说的一句话被 Li 润色以后（聊天里那句话变成润色后的文字、带小星星），Li 用你 Mac 上的克隆声音（你自己的声音）把润色后的文字读一遍给你听，每句只读一次。和 Li 的其它朗读排在同一个队列里：朗读开关关着就不读，你插话时照样暂停。只读你自己说的话，不读打字的、别人的或摘要；同一句再润色也不再读。克隆声音服务器没开或超时（/dev/config 的 voice.cloneTimeoutMs，默认 20 秒）就安静跳过，不换别的声音读。每台设备可以在 lk:agent-clone-tts 里改服务器地址，填 off 就这台设备不读。打开（默认，只对你）；关闭 = 照旧，润色后不读。",
    default: true,
    group: "stt",
    audience: "owner",
  },
  "voice.cloud-voices": {
    description:
      "Li 用谷歌 / Azure 的声音朗读（docs/li-sound-hub.md，「Provider voices」）：打开后，在你本人的页面上（需要 dev 权限），一句话可以用 google:<声音> 或 azure:<声音> 来读（say --voice google:cmn-TW-Wavenet-A），按语言自动选声音的表在 /dev/config 的 voice.langVoices（默认 zh-TW → 谷歌台湾国语，nan → Azure 闽南语）。声音在服务器上生成，手机用云端 <audio> 播放，没有系统语音的手机也能听。按字数从你的积分扣（和别人一样，没有管理员免费）。没有谷歌 / Azure 密钥时什么都不变，照常用原来的声音。关闭（默认）= 完全不用这些声音。",
    default: false,
    group: "stt",
    audience: "owner",
  },
  "ext.pill-chat": {
    description:
      "从用户脚本药丸打开 Li 聊天（docs/userscript-li-chat.md，第一步）：在任意网站上，用户脚本的浮动药丸多一个「Li」按钮。每个网站第一次点时先问「允许在这个网站使用 Li 聊天吗？」（仅这一次 / 在此网站总是允许 / 永不），关掉弹窗 = 不允许；允许之前不向 lianki.com 发任何聊天请求。允许后在 lianki.com 的独立窗口（跨域 iframe）里打开 Li，网站读不到你输入的内容，也拿不到登录凭证。已允许/已拒绝的网站可以在脚本管理器菜单「Li 聊天：网站…」里移除。你本人用你的伙伴票据（进你自己的线程）；其他用户还要再打开 ext.pill-chat-users 才有。关闭（默认）= 谁都看不到 Li 按钮，已打开的网站下次点也不会再打开。",
    default: false,
    audience: "owner",
    group: "ai",
  },
  "ext.pill-chat-users": {
    description:
      "药丸 Li 聊天开放给所有登录用户（docs/userscript-li-chat.md，M5）：要和 ext.pill-chat 一起打开才生效。打开后，每个登录用户在任意网站点药丸的 Li，都只进入他自己的 Li 线程（按账号签发的 60 秒一次性票据，只能聊天：不能运行代码、不能配对、看不到你的线程）。未登录的人看不到 Li 按钮。请在安全检查（M4）通过之后再打开。关闭（默认）= 只有你本人能用。",
    default: false,
    group: "ai",
  },
  "ext.pill-chat-per-origin": {
    description:
      "药丸 Li 聊天按网站分线程（docs/userscript-li-chat.md，「Per-site threads」）：打开后，在每个网站（按来源 origin：协议 + 域名 + 端口，不含路径和参数）点药丸的 Li，都进入这个账号下这个网站自己的线程，网站之间的聊天互不相混，Li 回答时也只看这个网站线程里的话。线程编号是加密的散列，看不出是哪个网站。lianki.com 的「聊天 → 各网站」（/chat/sites）列出你的网站线程（网站名、最后一句、时间），点开就能接着聊；网站页面上从来不显示这个列表。票据只能进入签发时绑定的那个网站的线程：换一个网站、换一个账号都会被拒绝。用户脚本要 2.24.39 以上。关闭（默认）= 照旧：所有网站都进同一个线程。",
    default: false,
    group: "ai",
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
  "words.shatter": {
    description:
      "单词列表里倒计时结束、已经不能再滑的卡片（显示「↓ 回来了」的那张）盖上一层碎玻璃裂纹：印泥红的裂缝带一点金色反光，画在文字下面，字照样清楚。倒计时在屏幕上结束的那一刻裂开一次（约 0.6 秒），之后静止；每张卡的裂纹固定不变（按卡片算），减少动画时直接显示静止的裂纹。还有时间的卡片不变。打开（默认）= 有 dev 权限的账号（现在是你本人）能看到；关闭 = 谁都看不到。",
    default: true,
    audience: "owner",
  },
  "membership.email-invite": {
    description:
      "邮件邀请好友：所有 Pro 用户（和管理员）在 /membership 的邀请卡片里多一个「用邮件邀请」框，填一个朋友的邮箱，Lianki 用发件人的账户语言发一封邀请信，里面是他自己的邀请链接（奖励规则不变）。防滥用：每人每天最多 5 封、同一个地址一个月内只收一封（不管谁邀请）、一次只能填一个地址、已有账户的地址不发（发件人看到的结果一样）、信里有退订和举报链接（一键退订），被举报 2 次的发件人不能再发。收件人地址只存哈希，发件人只看到自己发过的打码地址。关闭（默认）= 只有你本人（管理员）能用。",
    default: false,
    requires: ["auth-secret"],
  },
  // No `audience`: every account; ON is the shipped state. Grants credits,
  // never charges, so default-on (docs/payments.md, "Login-streak bonus").
  "credits.login-streak": {
    description:
      "连续学习奖励：每天服务器记到一次真实学习（复习了卡片、阅读打分）就送当天的积分，连续天数越多送得越多（7 天一轮，金额在 /dev/config 的 credits.loginStreak.*）；漏一天只扣几天，不清零。每个自然日（按账号时区）只送一次，重试不会重复。钱包卡片上有一行「连续 N 天 · +X」，流水里显示为「连续学习 · 第 N 天」。关闭 = 不再送（已送的积分不动），钱包上没有这一行。",
    default: true,
    group: "credits",
  },
  // No `audience`: every account; ON is the shipped state (owner 2026-11-15:
  // "按默认生效上线"). Grants credits, never charges (docs/payments.md, "Sign-up bonus").
  "credits.signup-bonus": {
    description:
      "注册礼：新注册的账号送 1 美元积分（金额在 /dev/config 的 credits.signupBonusUsd），但只有每个 UTC 日（UTC 零点换日）的前 10 个新账号能拿到（名额在 credits.signupBonusDaily）；超出的人什么也拿不到，也不报错。功能上线前就有的老账号，下次登录或打开钱包时补发一次，不占名额。每个账号只送一次，重试不会重复；钱包流水里显示为「注册礼」。关闭 = 新账号和老账号都不再送（已送的积分不动）。",
    default: true,
    group: "credits",
  },
  // Owner, 2026-11-15 05:2x JST: an agent publishes a one-file app; each capability is a per-app grant.
  "mini-apps": {
    description:
      "小应用（/m/<名字>，docs/mini-apps.md）：你的助手可以发布一个单文件 HTML 小应用，它在独立的沙盒里运行（不和 lianki.com 同源，不能读你的登录状态），通过 lianki.* 接口使用存储、设置和聊天；每一种能力第一次用时都会弹出卡片问你：仅这一次 / 这个应用一直允许 / 拒绝，之后可以在 /my/preferences 撤销。第一阶段只有有 dev 权限的账号能发布。关闭 = /m/ 和 /api/my/mini-apps 都不存在（404），已发布的应用留着但打不开。",
    default: true,
    audience: "owner",
  },
  // Owner, 2026-11-15 13:4x JST: Li speaks in his own thread too. Only his
  // thread: on, it changes nothing for anyone else (/dev/flags groups it under ai).
  // Owner, 2026-11-25: "can u ensure the history stable? because if it changes any byte, we cost again on cache miss".
  "partner.stable-prompt": {
    description:
      "Li 的提示词按缓存友好的顺序排：固定的规则在最前，之前的聊天按第一次发出时的样子只往后追加（润色后的改动作为一条更正追加在后面，不回头改），这次才有的内容（在场的人、学习数据、当前页面、要润色的句子）放在最后。这样每次调用前面的字节都一样，模型缓存能命中，花费更少；你自己的线程里 Li 回复时也顺便润色你刚说的、还没润色过的话（和回复同一次调用，不重复扣费）。关闭 = 旧的顺序，每次都重新拼。",
    default: true,
    group: "ai",
  },
  "partner.owner-thread": {
    description:
      "Li 也在你自己的线程里说话：「学习伙伴由 AI 回复」也打开时，你没有点名任何一条线（codex、agy…）的消息，如果几秒内（/dev/config 的 partner.ownerReplyDelayMs，默认 8 秒）没有开发通道回复，就由 Li（DeepSeek 模型）回复并朗读；通道先回复则 Li 不说话。声纹判断为别人的声音的消息不回复。和别人一样扣你自己的积分，没有免费。关闭 = 照旧：你的线程只由开发通道回复。",
    default: true,
    group: "ai",
    audience: "owner",
  },
  // Owner, 2026-11-15 15:0x JST: "每超过一美元，就在我这里发一个新的通知" — the
  // whole site's and his own account's AI/TTS/STT spend (lib/payments/spend-alert.ts).
  "partner.spend-alert": {
    description:
      "AI 花费提醒：全站和你自己账号的 AI（学习伙伴、朗读、语音识别）花费（按服务商成本算，cost ledger 和已结算的付费调用）每多一个整数步长（/dev/config 的 partner.spendAlertStepUsd，默认 1 美元），就在你的线程里发一条消息并朗读，比如「AI 全站花费已达 $3（今日 $0.42，本月 $3.00）」「我的 AI 花费已达 $1（…）」；文字在 /dev/config 的 partner.spendAlertSiteText / partner.spendAlertMineText。同一个金额只提醒一次。累计从上线这一刻算起。关闭 = 不发；关闭期间经过的金额不补发。",
    default: true,
    group: "ai",
    audience: "owner",
  },
  "stt.webgpu": {
    description:
      "Windows / 桌面端 WebGPU 本地语音识别：仅在 webgpu:local 路由上音频不离开设备；按需在后台下载并缓存客户端模型，与服务器路由竞速（未就绪、拒绝下载或不支持时自动静默回退到服务器/云端路由，此时音频会按常规方式发送）。",
    default: false,
    group: "stt",
    audience: "owner",
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
