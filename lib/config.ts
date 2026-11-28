import { MCP_MONITOR_DEFAULTS } from "./mcp-metrics";
import { MONITOR_BUDGET_DEFAULTS } from "./monitor-budget";
import { HUB_RPC_LIMITS } from "./hub-rpc-config";
import {
  CAP_WINDOW_HOURS,
  CAP_WINDOW_MAX,
  PARTNER_TURN_DELAY_MS,
  PARTNER_TURN_DELAY_MAX,
  PARTNER_TURN_WAIT_MS,
  PARTNER_TURN_WAIT_MAX,
  OWNER_AGENT_NAMES,
  OWNER_DEV_WORDS,
  OWNER_LANGUAGE_INTENTS,
  OWNER_STUDY_WORDS,
  PARTNER_SYSTEM_PROMPT,
  PARTNER_SYSTEM_PROMPT_MAX,
  OWNER_LANE_ACTIVE_MAX,
  OWNER_LANE_ACTIVE_MS,
  OWNER_LI_NAMES,
  OWNER_QUIET_MAX,
  OWNER_QUIET_MS,
  OWNER_REPLY_DELAY_MAX,
  OWNER_REPLY_DELAY_MS,
  OWNER_SPOKEN_NEEDS_NAME,
  OWNER_STOP_PHRASES,
  ROLL_CALL_REPLY_DEFAULT,
  SITE_DAILY_USD,
  SITE_WINDOW_USD_MAX,
  USER_DAILY_TOKENS,
  USER_WINDOW_TOKENS_MAX,
} from "./partner-ai-config";
import {
  SPEND_MINE_TEXT,
  SPEND_SITE_TEXT,
  SPEND_STEP_MAX,
  SPEND_STEP_MIN,
  SPEND_STEP_USD,
} from "./payments/spend-alert-config";
/**
 * The config registry: every user-meaningful number, text and icon whose live
 * value comes from the config store (lib/config-store.ts, D1 `config_values`)
 * and can be changed at /dev/config with no deploy. docs/config-store.md.
 *
 * Owner principle (2026-11-10): code holds only the DEFAULT; the live value
 * comes from the DB (hot-editable) or env.
 *
 * Rules:
 * - Only keys listed here exist. The store refuses to write any other key, and
 *   ignores a stored row whose key is not here.
 * - A stored value that fails its key's schema (or min/max) reads as the
 *   default; so does every key when the store cannot be read (fail to
 *   defaults — unlike flags, which fail closed).
 * - Read order: code default → global value (the store) → the user's own value
 *   (only for a key with `userPref: true`, and only if it validates too).
 * - `audience: "public"` keys reach the browser (the app layout hands them to
 *   lib/config-client.ts); `"server"` keys never leave the server.
 * - `money: true` keys move real money: /dev/config asks before saving one, and
 *   the API refuses without `confirmMoney`.
 *
 * Client-safe: no D1 here.
 */
import { z } from "zod";
import { DEFAULT_LOCAL_TTS_FALLBACKS } from "@lianki/debug-chat/local-tts-fallback";
import { DEFAULT_LEXICON, LEX_LANG, LEX_LIMITS, type LexEntry } from "@lianki/debug-chat/lexicon";
import {
  isProviderVoice,
  lineVoiceOf,
  parseLaneDef,
  LOCAL_ENGINES,
  isVoiceId,
  type ChatLaneDef,
} from "@lianki/debug-chat/voices";
import { LANES_CONFIG_DEFAULTS, type LaneAgentDef, laneAgentSchema } from "./lanes-config";
import {
  PHONETIC_MAX_NEAR_DEFAULT,
  PHONETIC_MAX_NEAR_MAX,
  PHONETIC_OWN_SYLLABLES_DEFAULT,
  PHONETIC_OWN_SYLLABLES_MAX,
} from "@lianki/debug-chat/lane-phonetic";
import { TWO_MIC_WINDOW_MAX, TWO_MIC_WINDOW_MS } from "@lianki/debug-chat/two-mic";
import { ETA_BAR_CYCLE, ETA_TICKER_KEEP, ETA_TICKER_SEC } from "@lianki/debug-chat/eta-ticker";
import { MERGE_REOPEN_DEFAULT_SEC, MERGE_REOPEN_MAX_SEC } from "@lianki/debug-chat/voice-tune";
import { STT_REPEAT } from "@lianki/debug-chat/stt-repeat";
import { SNAP_DEFAULTS } from "@lianki/debug-chat/snap-targets";
import {
  DEFAULT_PERSON_VOICES,
  PERSON_VOICES_MAX,
  isPersonVoiceId,
} from "@lianki/debug-chat/person-voice";
import { VAD_MAX, VAD_MIN, VAD_THRESHOLDS } from "@lianki/debug-chat/adaptive";
import { GUARD_MIN_SPEECH_MS, STT_GUARD } from "@lianki/debug-chat/stt-guard";
import { SHORT_ANSWER, SHORT_ANSWER_RANGE } from "@lianki/debug-chat/short-answer";
import { DEFAULT_PRESET_ROWS, presetListSchema, type ByokPresetRow } from "./byok/preset-data";
import { DEFAULT_MIME_PREFS, parseMimePrefs } from "./meetings/core";
import { ECHO_HALLUCINATIONS, ECHO_WINDOW_MATCH_MIN } from "./echo-reports";
import {
  MEETING_TRANSCRIPTION_DEFAULTS,
  meetingTranscriptionSchema,
} from "./meeting-transcription/settings";

export type ConfigAudience = "server" | "public";

export interface ConfigDef<V = unknown, A extends ConfigAudience = ConfigAudience> {
  /** The value while no valid row is stored. */
  default: V;
  /** What a stored or submitted value must parse as. */
  schema: z.ZodType<V>;
  /** Shown on /dev/config: what the value changes (the owner's language). */
  description: string;
  /** The section on /dev/config. */
  group: string;
  /** Shown beside the value: "ms", "wpm", "chars"… */
  unit?: string;
  /** Bounds for a number (also in `schema`; here for the editor). */
  min?: number;
  max?: number;
  /** Changing it moves real money: confirm first. */
  money?: true;
  /** Whether the value is sent to the browser. */
  audience: A;
  /** A user's own value may override the global one (lib/config-store.ts `cfg`). */
  userPref?: true;
}

/** A whole number between `min` and `max`, inclusive. */
function int<A extends ConfigAudience>(
  d: Omit<ConfigDef<number, A>, "schema" | "min" | "max"> & { min: number; max: number },
): ConfigDef<number, A> {
  return { ...d, schema: z.number().int().min(d.min).max(d.max) };
}

/** One token of stt.ownerRoutes: a named route or a socket URL (local-stt.ts localSttFrom takes the same). */
const OWNER_ROUTE_TOKEN =
  /^(?:rtc:lianki|wss:session|wss:\/\/[^\s,/]+(?:\/\S*)?|ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?)$/;

export const CONFIG = {
  "words.nativeAudioTimeoutMs": int({
    default: 15000,
    min: 3000,
    max: 60000,
    unit: "ms",
    group: "words",
    audience: "public",
    description: "单词原音载入、定位或播放停滞时等待多久再回退到合成音（毫秒）。",
  }),
  "review.nextPreview": {
    default: true as boolean,
    schema: z.boolean(),
    group: "review",
    audience: "public",
    description:
      "复习网页卡片时，仅预载下一张网页的受限预览；关闭后不请求预览检查或加载预览网页。省流量模式下也不预载。",
  },
  "review.previewHeadTimeoutMs": int({
    default: 5000,
    min: 500,
    max: 15000,
    unit: "ms",
    group: "review",
    audience: "server",
    description: "下一张网页预览的请求头和公开地址检查总等待时间；超时只显示标题链接。",
  }),
  "review.previewChecksPerMinute": int({
    default: 30,
    min: 1,
    max: 120,
    group: "review",
    audience: "server",
    description: "每个账号每分钟最多检查多少张下一页预览；超出后照常复习，只显示标题链接。",
  }),
  "review.titleFitChars": int({
    default: 40,
    min: 10,
    max: 400,
    unit: "chars",
    group: "review",
    audience: "public",
    description:
      "/review 当前卡片标题超过多少宽度（英文字母算 1，中日韩字算 2）开始缩小字号；标题越长字越小，始终完整显示。",
  }),
  "review.titleMinScalePct": int({
    default: 75,
    min: 40,
    max: 100,
    unit: "%",
    group: "review",
    audience: "public",
    description: "/review 当前卡片长标题最多缩到原字号的百分之几；再长就换行显示，不省略、不截断。",
  }),
  "words.speak.skipForeignParens": {
    default: true as boolean,
    schema: z.boolean(),
    group: "words",
    audience: "public",
    description:
      "读单词卡（单词、例句）时，括号 ( ) 或 （ ） 里主要是另一种文字的内容不念，比如英文例句后面括号里的中文翻译；屏幕上照常显示。同种文字的括号（如 (informal)）照念。关掉则整句照原样念。",
  },
  "words.nativeAudioStartMs": int({
    default: 1000,
    min: 200,
    max: 15000,
    unit: "ms",
    group: "words",
    audience: "public",
    description:
      "单词原音最多等多久开始发声（毫秒）；到时还没响就先用合成音读，原音包继续在后台下载，下次再用。",
  }),
  "words.partTimeoutMs": int({
    default: 30000,
    min: 5000,
    max: 120000,
    unit: "ms",
    group: "words",
    audience: "public",
    description:
      "/words 朗读时一段（单词、例句、释义）多久没报告结束就跳过它（毫秒），免得一段卡住后面全都不读。",
  }),
  "words.undoMs": int({
    default: 8000,
    min: 2000,
    max: 30000,
    unit: "ms",
    group: "words",
    audience: "public",
    description:
      "/words 删除单词列表后「撤销」提示停留多久（毫秒）；新加或重排的行高亮也持续这么久。过了这段时间才真正删除。",
  }),
  "files.undoMs": int({
    default: 5000,
    min: 2000,
    max: 30000,
    unit: "ms",
    group: "files",
    audience: "public",
    description:
      "我的文件（/my/files、自我介绍导入）删除文件后可以撤销的时间（毫秒）；过了这段时间才发给服务器删除。",
  }),
  "read.startWpm": int({
    default: 120,
    min: 30,
    max: 600,
    unit: "wpm",
    group: "read",
    audience: "public",
    description:
      "阅读器在还没测出用户自己的阅读速度前，假设的起始速度（每分钟词数），决定本地书一张卡片放多少字。",
  }),
  "lists.batchSize": int({
    default: 30,
    min: 5,
    max: 100,
    unit: "rows",
    group: "lists",
    audience: "public",
    description:
      "所有列表（阅读材料、链卡、聊天记录……）滚动到底时一次向服务器多要几行。不是分页：用户看不到这个数，只影响每次加载的量。",
  }),
  // Settings → 「自己的 AI」 (docs/byok.md): the providers offered, as data.
  // The relay's allowlist is NOT here (lib/byok/preset-data.ts RELAY_ALLOW, code only).
  "byok.presets": {
    default: DEFAULT_PRESET_ROWS,
    schema: presetListSchema as z.ZodType<ByokPresetRow[]>,
    group: "byok",
    audience: "public",
    description:
      '设置 →「自己的 AI」里推荐的 AI 供应商（分段选择器按这个顺序显示，最后总有「自定义」）。JSON 数组，每条 {id 小写短名, name 供应商名, protocol "openai"/"anthropic", baseUrl, model 起始模型, browser 浏览器能否直接调用（CORS）, keyless?, opaqueAuthErrors?, policyUrl?, pricingUrl? 价格页, keyUrl? 申请 key 的页, models? [{id, tier: "cheap"/"balanced"/"strong"}] 2–4 个推荐模型, note? {en, zh, …} 一句话介绍（内置供应商的介绍在词典里，这里写了就以这里为准）}。不写价格（价格会变，只链到价格页）。加在这里的供应商只能浏览器直连，不能经 Lianki 转发（转发白名单只在代码里）。',
  },
  "study.humanReactionMs": int({
    default: 1000,
    min: 200,
    max: 5000,
    unit: "ms",
    group: "study",
    audience: "server",
    description:
      "一次复习算作「学习天数」至少要在屏幕上停留多久（毫秒，人类反应时间 1–3 秒的下限）。更快的连点不算。",
  }),
  "contact.fieldMax": int({
    default: 2000,
    min: 100,
    // Four fields at 3 UTF-8 bytes a character stay under CONTACT_BODY_MAX (32 KiB).
    max: 2600,
    unit: "chars",
    group: "contact",
    audience: "server",
    description: "联系表单每一栏（姓名、邮箱、电话、留言）最多多少个字符，超过就拒收。",
  }),
  // The card-height pinch on /words (lib/words/row-pinch.ts, PinchFeel; lib/words/use-row-pinch.ts).
  "words.pinchGainPct": int({
    default: 40,
    min: 5,
    max: 150,
    unit: "%",
    group: "words",
    audience: "public",
    description:
      "/words 双指捏合调卡片高度的灵敏度（百分比）：两指距离变成两倍时，卡片高度变成 2^(值/100) 倍。40 = 约 1.32 倍；100 = 跟手指一样快（最初的版本，太灵敏）。越小越不灵敏。",
  }),
  "words.pinchDeadZonePct": int({
    default: 6,
    min: 0,
    max: 50,
    unit: "%",
    group: "words",
    audience: "public",
    description:
      "/words 捏合的死区（百分比）：两指距离变化不到这么多时卡片高度不动，手指轻微抖动不会让列表跟着晃。",
  }),
  "words.pinchSmoothMs": int({
    default: 70,
    min: 0,
    max: 400,
    unit: "ms",
    group: "words",
    audience: "public",
    description:
      "/words 捏合时卡片高度跟随手指的缓动时间常数（毫秒）：越大越平滑、跟得越慢；0 = 不缓动，直接跟手指。",
  }),
  // Read by the progress hub (lianki-push) over DebugSessions.config; docs/state-tree.md, "Waiting on the owner".
  "chat.ownerWaitRemindDays": {
    default: "1,3,7" as string,
    schema: z
      .string()
      .regex(/^\s*\d{1,2}(\s*,\s*\d{1,2})*\s*$/, "days, comma-separated: 1,3,7")
      .refine((s) => s.split(",").every((d) => Number(d) >= 1 && Number(d) <= 30), "1–30 days"),
    unit: "days",
    group: "chat",
    audience: "server",
    description:
      "等你处理的事（状态 waiting-owner 或写了 needs）到时间后先提醒你一次，之后隔多少天再提醒：逗号分隔的天数，用完后一直按最后一个间隔（默认 1,3,7 = 一天、三天、七天，之后每周）。",
  },
  // The chat's last lines kept on the device for an instant first paint
  // (lib/chat-cache.ts; docs/cold-start.md, "The chat at once"). Read by the root layout.
  // OAuth sign-in for the remote MCP server (docs/mcp-oauth.md, lib/mcp-oauth/*).
  "mcp.oauthAccessMin": int({
    default: 60,
    min: 5,
    max: 1440,
    unit: "min",
    group: "mcp",
    audience: "server",
    description:
      "ChatGPT 等应用通过 OAuth 拿到的访问令牌多久失效（分钟）；到期后应用用续期令牌换新的，断开连接则立即失效。",
  }),
  "mcp.oauthRefreshDays": int({
    default: 30,
    min: 1,
    max: 365,
    unit: "days",
    group: "mcp",
    audience: "server",
    description:
      "OAuth 续期令牌多久不用就失效（天）；每次续期都会换新并重新计时。过期后要在应用里重新连接。",
  }),
  "mcp.oauthCodeSeconds": int({
    default: 60,
    min: 10,
    max: 600,
    unit: "s",
    group: "mcp",
    audience: "server",
    description: "用户在同意页点「允许」后，应用必须在几秒内用授权码换令牌；授权码只能用一次。",
  }),
  "mcp.oauthRegisterPerHour": int({
    default: 20,
    min: 1,
    max: 1000,
    unit: "per hour",
    group: "mcp",
    audience: "server",
    description: "同一 IP 每小时最多注册几个 OAuth 应用（动态注册不需要登录，用这个防刷）。",
  }),
  "mcp.oauthTokenPerMin": int({
    default: 60,
    min: 5,
    max: 6000,
    unit: "per min",
    group: "mcp",
    audience: "server",
    description: "同一 IP 每分钟最多请求几次 OAuth 换令牌/续期/撤销。",
  }),
  // MCP Events (docs/chat-wake.md): a ChatGPT session woken by @its-name in its token's thread.
  "mcp.eventsSubscribePerHour": int({
    default: 30,
    min: 1,
    max: 1000,
    unit: "per hour",
    group: "mcp",
    audience: "server",
    description:
      "同一个令牌每小时最多订阅/续订几次 MCP 事件（ChatGPT 被 @ 名字唤醒；每次订阅都要先回呼验证对方地址）。",
  }),
  // The callback allowlist is the control against SSRF (docs/chat-wake.md,
  // "Callback addresses"): only hosts listed here are ever POSTed to.
  "mcp.eventsCallbackHosts": {
    default: ["connectors.api.openai.com"] as string[],
    schema: z
      .array(
        z
          .string()
          .regex(
            /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
            "a lower-case host name, or .suffix for its subdomains",
          ),
      )
      .max(20),
    group: "mcp",
    audience: "server",
    description:
      "MCP 事件只往这些主机发回呼（验证和每次通知都检查）：JSON 数组。写 host 只匹配这个主机本身；以点开头（.example.com）匹配它的所有子域名，不含它本身。空数组 = 一个都不发。默认是 ChatGPT 实际用的回呼主机 connectors.api.openai.com（OpenAI 文档没写明，是观察到的）；ChatGPT 订阅被拒、原因 host_not_allowed 时，在这里加上它用的主机。",
  },
  "mcp.eventsMaxPerToken": int({
    default: 3,
    min: 1,
    max: 20,
    unit: "subscriptions",
    group: "mcp",
    audience: "server",
    description: "同一个令牌最多同时有几个 MCP 事件订阅（不同的回呼地址各算一个）。",
  }),
  "mcp.eventsPerMinute": int({
    default: 10,
    min: 1,
    max: 600,
    unit: "per min",
    group: "mcp",
    audience: "server",
    description: "同一个订阅每分钟最多被唤醒几次（每次 @ 名字一次；超出的这一分钟内不再发送）。",
  }),
  "mcp.eventsTtlMin": int({
    default: 1440,
    min: 5,
    max: 43200,
    unit: "min",
    group: "mcp",
    audience: "server",
    description: "ChatGPT 没指定时，MCP 事件订阅多久后到期（分钟）；到期前它会自动续订。",
  }),
  "mcp.eventsMaxTtlMin": int({
    default: 10080,
    min: 5,
    max: 43200,
    unit: "min",
    group: "mcp",
    audience: "server",
    description: "MCP 事件订阅最长能有多久（分钟）；要求更久或永不过期时，按这个值给。",
  }),
  "mcp.eventsTimeoutMs": int({
    default: 6000,
    min: 1000,
    max: 10000,
    unit: "ms",
    group: "mcp",
    audience: "server",
    description: "向 ChatGPT 回呼地址发一次事件或验证请求，最多等多久（毫秒）。",
  }),
  "mcp.eventsRetries": int({
    default: 2,
    min: 0,
    max: 3,
    unit: "retries",
    group: "mcp",
    audience: "server",
    description: "一次事件发送失败（超时、5xx、429）后最多重试几次，间隔按倍数增长。",
  }),
  "mcp.eventsRetryBaseMs": int({
    default: 1000,
    min: 100,
    max: 5000,
    unit: "ms",
    group: "mcp",
    audience: "server",
    description: "事件重试的第一次间隔（毫秒），之后每次翻倍。",
  }),
  "mcp.eventsVerifyCacheMin": int({
    default: 60,
    min: 0,
    max: 1440,
    unit: "min",
    group: "mcp",
    audience: "server",
    description: "同一个令牌、同一个回呼地址验证成功后，多久内续订不再重新验证（分钟）。",
  }),
  "mcp.eventsRotationOverlapMin": int({
    default: 60,
    min: 0,
    max: 1440,
    unit: "min",
    group: "mcp",
    audience: "server",
    description: "ChatGPT 更换签名密钥后，旧密钥和新密钥一起签名多久（分钟）。",
  }),
  // Chat wake (docs/chat-wake.md): every @mention of a token kept in D1 chat_mention,
  // fanned out to its wake adapters (push: ChatGPT webhook; pull: tool + events/poll).
  "chat.wakeRetentionDays": int({
    default: 7,
    min: 1,
    max: 90,
    unit: "days",
    group: "chat",
    audience: "server",
    description:
      "被 @ 的记录（chat_mention，唤醒代理用）超过几天后可以删除。不是定时删：只在有动静时顺带分批删（有人在聊天里写话、代理来查「谁 @ 了我」时），平时通常在下一次动静后几分钟内删掉；整个网站都没人用时不会删，所以没有保证的删除时间。撤销令牌时它的记录立即删除。只存那一行的文字，不存历史。",
  }),
  "chat.wakeMaxPerToken": int({
    default: 500,
    min: 10,
    max: 10000,
    unit: "mentions",
    group: "chat",
    audience: "server",
    description: "同一个令牌最多保留几条被 @ 的记录；超出时删最旧的（代理翻页时会被告知有缺口）。",
  }),
  "chat.wakePurgeBatch": int({
    default: 100,
    min: 1,
    max: 1000,
    unit: "rows",
    group: "chat",
    audience: "server",
    description:
      "每写一条被 @ 的记录，顺带最多删掉几条已过保留期的旧记录（任何令牌的，包括从不来查的令牌；不用定时任务）。",
  }),
  "chat.wakePerMinute": int({
    default: 10,
    min: 1,
    max: 600,
    unit: "per min",
    group: "chat",
    audience: "server",
    description: "同一个令牌每分钟最多记下几次被 @（超出的这一分钟内不记、不唤醒拉取式代理）。",
  }),
  "chat.wakeMaxTokens": int({
    default: 50,
    min: 1,
    max: 500,
    unit: "tokens",
    group: "chat",
    audience: "server",
    description:
      "一行带 @ 的话最多对照这个线程里几个令牌的名字（防止一个账号令牌太多时拖慢聊天）。",
  }),
  "chat.wakePullTtlMin": int({
    default: 1440,
    min: 5,
    max: 43200,
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "代理不带游标来查「谁 @ 了我」时（例如 Gemini 定时任务），往回看多久（分钟）；也是 events/poll 的 maxAgeMs 上限。",
  }),
  "chat.wakePullLimit": int({
    default: 20,
    min: 1,
    max: 100,
    unit: "mentions",
    group: "chat",
    audience: "server",
    description: "代理查「谁 @ 了我」时一次最多返回几条（它可以按游标继续翻）。",
  }),
  "chat.wakePullPerMinute": int({
    default: 30,
    min: 1,
    max: 600,
    unit: "per min",
    group: "chat",
    audience: "server",
    description: "同一个令牌每分钟最多查几次「谁 @ 了我」（工具和 events/poll 合计）。",
  }),
  "chat.wakeNextPollMs": int({
    default: 60000,
    min: 1000,
    max: 3600000,
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "events/poll 建议代理隔多久再来查一次（毫秒，nextPollMs）。",
  }),
  "chat.cacheLines": int({
    default: 40,
    min: 0,
    max: 200,
    unit: "lines",
    group: "chat",
    audience: "server",
    description:
      "打开页面时聊天立刻显示的最近几条（存在这台设备上，只给当前登录的账号看，退出登录就清掉；之后用服务器上的记录替换）。0 = 不在设备上保存，聊天等连上后才出现。",
  }),
  // Read by the progress hub too; docs/state-tree.md, "Receipts".
  "chat.etaAckMin": int({
    default: 5,
    min: 1,
    max: 60,
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "任务到点后自动提醒负责的线（带回执码）；这条提醒送到后几分钟内没有回执（progress.ts ack 或对这个节点的任何汇报），就先通知协调线（main）。",
  }),
  "chat.etaOwnerMin": int({
    default: 5,
    min: 1,
    max: 60,
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "通知协调线之后再过几分钟，还没有原因和新时间，就告诉你「<名字> 超时，未说明原因」。",
  }),
  "chat.etaCoordinator": {
    default: "main" as string,
    schema: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "a lane name: main, codex…"),
    group: "chat",
    audience: "server",
    description: "到点提醒没有回执时，先通知哪条线（协调线的名字，默认 main）。",
  },
  // The state tree's lines in the chat (lib/eta-reply.ts; docs/state-tree.md, "Replies").
  // Each description is also the context a translator reads with the text.
  "chat.stateTreeSender": {
    default: "状态树提醒" as string,
    schema: z.string().trim().min(1).max(40),
    group: "chat",
    audience: "server",
    description:
      "状态树自动提醒（到点、卡住、未回执）在聊天里显示的发送者名字，配一个小树头像；让人一眼看出这是状态树发的，不是被 @ 的那条线（如 codex）说的话。短名词，不加句号。",
  },
  "chat.etaReplyAck": {
    default: "{agent}：收到「{task}」，处理中" as string,
    schema: z.string().trim().min(1).max(120),
    group: "chat",
    audience: "server",
    description:
      "被提醒的 agent 用回执码确认、或在节点上汇报后，状态树替它在聊天里回的一句（没有新的 ETA 时）。{agent} 换成 agent 的名字（如 coco (codex)），{task} 换成任务名，原样保留。一句短话。",
  },
  "chat.etaReplyDoing": {
    default: "{agent}：收到「{task}」，处理中（ETA {min} 分钟）" as string,
    schema: z.string().trim().min(1).max(120),
    group: "chat",
    audience: "server",
    description:
      "同上，但 agent 的汇报带了新的 ETA：{min} 换成从现在起还要的分钟数。{agent}、{task}、{min} 原样保留。一句短话。",
  },
  "chat.etaReplyDone": {
    default: "{agent}：「{task}」已处理" as string,
    schema: z.string().trim().min(1).max(120),
    group: "chat",
    audience: "server",
    description:
      "同上，但 agent 把这个节点报了完成：告诉大家这条提醒已经处理好了。{agent}、{task} 原样保留。一句短话。",
  },
  "chat.nudgeBackoffMin": {
    default: "10,20,40,80,160,240" as string,
    schema: z
      .string()
      .regex(/^\s*\d{1,4}(\s*,\s*\d{1,4})*\s*$/, "minutes, comma-separated: 10,20,40")
      .refine(
        (s) => s.split(",").every((m) => Number(m) >= 1 && Number(m) <= 1440),
        "1–1440 minutes",
      ),
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "「超时，未说明原因」之后、以及「卡住了，等你／等某条线」的提醒，每隔多少分钟再说一次：逗号分隔，用完后一直按最后一个间隔（默认 10,20,40,80,160,240 = 翻倍，最长每 4 小时一次），直到给出原因和新时间、完成或不再卡住。",
  },
  "chat.verifyEtaMin": int({
    default: 30,
    min: 5,
    max: 1440,
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "任务标成「完成但未验证」时，自动建一个「verify: <名字>」子任务交给同一条线，给它多少分钟的预计时间。",
  }),
  // Two mics, one line (flag stt.two-mic-merge; docs/dev-debug-widget.md,
  // "Two mics, one line"): read by the debug hub over DebugSessions.config.
  "chat.twoMicWindowMs": int({
    default: TWO_MIC_WINDOW_MS,
    min: 0,
    max: TWO_MIC_WINDOW_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "两个麦克风同时开着（比如 Windows 和 Mac）时，同一句话会各发一条：另一台设备在这么多毫秒内发来几乎一样的语音消息，就当成同一句，只留一条（留声纹分数更高、或更完整的那条文字）。默认 4000 = 4 秒；0 = 不合并。开关在 /dev/flags 的 stt.two-mic-merge。",
  }),
  // Li's read-aloud pronunciation table (packages/debug-chat/src/lexicon.ts;
  // docs/li-sound-hub.md, "Pronunciation table"): handed to the chat by the root layout.
  "voice.lexicon": {
    default: DEFAULT_LEXICON as LexEntry[],
    schema: z
      .array(
        z
          .object({
            term: z.string().min(1).max(LEX_LIMITS.term),
            say: z.string().min(1).max(LEX_LIMITS.say),
            lang: z.string().regex(LEX_LANG, "a language: zh, ja, zh-TW…").optional(),
            ignoreCase: z.boolean().optional(),
            ph: z.string().min(1).max(LEX_LIMITS.ph).optional(),
            alphabet: z.enum(["ipa", "x-sampa"]).optional(),
          })
          .strict(),
      )
      .max(LEX_LIMITS.entries) as z.ZodType<LexEntry[]>,
    group: "voice",
    audience: "public",
    description:
      'Li 朗读时的读音表（JSON 数组）：每条 {term 写法, say 读法, lang 可选语言如 zh / ja / zh-TW, ignoreCase 可选不分大小写, ph 可选音标}。只改读出来的声音，屏幕上的文字不变。整词匹配、默认区分大小写；同一个词有几条时，语言最具体的那条生效（zh-TW 胜过 zh，zh 胜过不写语言）。例：{"term":"WebRTC","say":"Web R T C"}。',
  },
  // Provider voices (lib/cloud-voices.ts; docs/li-sound-hub.md, "Provider voices"):
  // which language is read in which Google / Azure voice, as data. Flag voice.cloud-voices.
  "voice.localFallbacks": {
    default: DEFAULT_LOCAL_TTS_FALLBACKS,
    schema: z.record(
      z.string().regex(LEX_LANG),
      z.record(
        z.string().refine(isVoiceId, "a lane voice"),
        z.string().refine((name) => LOCAL_ENGINES.includes(name), "an existing local voice"),
      ),
    ),
    group: "voice",
    audience: "public",
    description:
      "开发账号的本地语音接管表：语言 → 车道声音 → 本地声音。已配置且未关闭本地服务时，用它替代已停用的 MeloTTS；没有配置的语言维持原路线，不把中文交给英语声音。需要设备能连接现有本地语音服务，空对象可关闭。",
  },
  "voice.langVoices": {
    default: {
      "zh-TW": "google:cmn-TW-Wavenet-A",
      nan: "azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN",
    } as Record<string, string>,
    schema: z
      .record(
        z.string().regex(LEX_LANG, "a language: zh, zh-TW, nan…"),
        z
          .string()
          .refine(
            (id) => isProviderVoice(lineVoiceOf(id)),
            "google:<voice> or azure:<voice>[/<locale>]",
          ),
      )
      .refine((m) => Object.keys(m).length <= 50, "at most 50 languages") as z.ZodType<
      Record<string, string>
    >,
    group: "voice",
    audience: "public",
    description:
      'Li 朗读时哪种语言用哪个谷歌 / Azure 声音（JSON 对象：语言 → 声音），只在开关 voice.cloud-voices 打开时生效。语言先找完整的（zh-TW），再找主语言（zh）。台语和台湾国语从文字认不出来，所以只有标了语言的句子会用到 zh-TW / nan；想让所有中文都用台湾腔，就加 "zh"。声音写法：google:cmn-TW-Wavenet-A、azure:zh-TW-HsiaoChenNeural、azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN（斜线后是它改用的口音）。按字数扣积分；没有密钥时照常用原来的声音。',
  },
  // The polish read-back in his cloned voice (packages/debug-chat/src/polish-readback.ts),
  // flag voice.polish-readback: a clip from the Mac's clone server not back by then is skipped.
  // An undecided voice line well under his print shows another voice's avatar
  // (packages/debug-chat/src/avatar-rules.ts, owner 2026-11-15 23:49 JST).
  "voice.otherAvatarBelow": {
    // Same as OTHER_AVATAR_BELOW in avatar-rules.ts (not imported: it pulls the lane tables into config).
    default: 0.45,
    schema: z.number().min(0).max(1),
    min: 0,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "声纹判定不了（未定）的语音行，如果和你的声纹相似度低于这个值，就用「另一个声音」的头像显示，而不是你的头像（淡色加问号）。你自己的话通常在 0.76–0.85，家人等其他人在 0.30–0.42。0 = 关闭，未定的行一律用你的头像。",
  },
  // The picture and name of another voice in his thread (avatar-rules.ts setOtherAvatar).
  "voice.otherAvatar": {
    default: "",
    schema: z.union([
      z.literal(""),
      z
        .string()
        .max(500)
        .regex(/^(https:\/\/|\/)/, "an https:// or /path picture link"),
    ]),
    group: "voice",
    audience: "public",
    description:
      "你线程里「另一个声音」的行用的头像图片链接（https:// 或站内 /路径），比如家人自己账号的头像。空 = 用自动生成的圆形图案。只影响显示。",
  },
  "voice.otherAvatarName": {
    default: "",
    schema: z.string().max(40),
    group: "voice",
    audience: "public",
    description: "「另一个声音」的行显示的名字（比如家人的名字）。空 = 「另一个声音」。",
  },
  // One avatar per voice in the room (packages/debug-chat/src/cluster-avatar.ts, flag voice.speaker-avatars).
  "voice.clusterHues": {
    // Same as CLUSTER_HUES in cluster-avatar.ts (not imported: config stays free of the chat package).
    default: [70, 110, 150, 185, 220, 255, 290, 325],
    schema: z.array(z.number().min(0).max(360)).min(1).max(24),
    group: "voice",
    audience: "public",
    description:
      "每个声音的头像颜色（oklch 色相 0–360，按顺序：A 用第一个，B 用第二个……）。印章红附近（约 5–45）的色相会被跳过，那是你的颜色。只影响显示。",
  },
  "voice.clusterMinScore": {
    // Same as CLUSTER_MIN_SCORE in cluster-avatar.ts.
    default: 0,
    schema: z.number().min(0).max(1),
    min: 0,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "一行语音和它所属声音分组的相似度（clusterScore）低于这个值时，不画这个分组的头像，改用共用的「另一个声音」头像。0 = 有分组就画。",
  },
  "voice.cloneTimeoutMs": int({
    default: 20_000,
    min: 2_000,
    max: 120_000,
    unit: "ms",
    group: "voice",
    audience: "public",
    description:
      "润色后用你的克隆声音读一遍（开关 voice.polish-readback）：每一句等 Mac 上的克隆声音服务器最多多久（毫秒）。一句通常要 5–10 秒生成；超过这个时间就安静跳过这一句，不换别的声音读。",
  }),
  // Other people's polished lines read back (packages/debug-chat/person-voice.ts, flag
  // voice.polish-readback): each recognized voice gets one of these, by its avatar id.
  "voice.personVoices": {
    default: [...DEFAULT_PERSON_VOICES] as string[],
    schema: z
      .array(
        z
          .string()
          .refine(
            isPersonVoiceId,
            "local:<name>, google:<voice> or azure:<voice>, not a voice an agent lane uses",
          ),
      )
      .max(PERSON_VOICES_MAX),
    group: "voice",
    audience: "public",
    description:
      "润色后读一遍别人说的话（开关 voice.polish-readback）：认出是另一个人（和他的头像同一个编号 A、B、s1……）时，从这些声音里固定给他一个，同一个人总是同一个声音。不克隆任何人的声音，也不用 agent 通道的声音（填了会被拒绝）。写法：local:bella（Mac 上的 Kokoro）、google:<声音>、azure:<声音>。空 = 别人的话不读。",
  },
  // Whisper re-reads a whole continuous-speech run (packages/debug-chat/src/whisper-recheck.ts;
  // flag stt.whisper-recheck; docs/dev-debug-widget.md, "Whisper re-listens to the whole run").
  "voice.pttMaxCaptureMs": int({
    default: 60_000,
    min: 1_000,
    max: 600_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "按住说话一次保留的音频上限（毫秒）。达到上限明确停止本次录音并保留已识别文字，不静默截断后当作完整录音发送；限制浏览器内存占用。",
  }),
  // The owner's default speech routes when his page stored none (packages/debug-chat/src/local-stt.ts
  // ownerDefaultRoutes; docs/local-stt.md, "On by default for the owner"). Empty = the build's
  // default: rtc:lianki, then NEXT_PUBLIC_LIANKI_OWNER_LOCAL_STT (his tailnet URL, never in the tree).
  "stt.ownerRoutes": {
    default: "",
    schema: z
      .string()
      .max(500)
      .refine(
        (v) =>
          v
            .split(/[\s,]+/)
            .filter(Boolean)
            .every((u) => OWNER_ROUTE_TOKEN.test(u)),
        "routes: rtc:lianki, wss:session, wss://… (ws:// only on localhost), separated by spaces",
      ),
    group: "voice",
    audience: "public",
    description:
      "你自己的手机/电脑在没有单独设置时用哪些语音识别路线（按顺序赛跑，先连上的用；都连不上就用云端）。空 = 默认：先 rtc:lianki（WebRTC 连到你的 Mac，不需要 Tailscale），再 tailnet 地址。可写 rtc:lianki、wss:session 或 wss:// 地址，空格分开。",
  },
  // The repetition guard (packages/debug-chat/src/stt-repeat.ts): a final that is a
  // decoding loop is cut or dropped, in the mic and again in the hub.
  "stt.repeatMaxRuns": int({
    default: STT_REPEAT.maxRuns,
    min: 2,
    max: 1000,
    unit: "times",
    group: "voice",
    audience: "public",
    description:
      "复读幻觉过滤：识别结果里同一个短片段（1–8 个字，或一个词）连续出现这么多次就算复读（比如「ウィッターウィッター…」）。3 次（「好好好」）是正常说话，默认 6。",
  }),
  "stt.repeatMaxShare": {
    default: STT_REPEAT.maxShare as number,
    schema: z.number().min(0).max(1),
    min: 0,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "复读幻觉过滤：复读部分占整句文字的比例达到这么多才处理（0–1，默认 0.6）。长句里偶尔重复几次不动它。处理方式：只留复读开始前的部分加一遍复读内容。",
  },
  "stt.repeatMinKeepChars": int({
    default: STT_REPEAT.minKeepChars,
    min: 0,
    max: 1000,
    unit: "chars",
    group: "voice",
    audience: "public",
    description:
      "复读幻觉过滤：剪掉复读后剩下的字少于这么多，就整句丢掉，不发到聊天里（详情里记为「复读」）。默认 4。",
  }),
  // Silero's start thresholds and the silence guard's minimum speech (adaptive.ts
  // NORMAL / WHISPER, stt-guard.ts STT_GUARD; owner 2026-11-15: café background
  // noise became his lines). A negative not below its positive is clamped to
  // positive − 0.05 in the mic (vadThresholdsOf).
  "stt.vadPositive": {
    default: VAD_THRESHOLDS.normal.positive as number,
    schema: z.number().min(VAD_MIN).max(VAD_MAX),
    min: VAD_MIN,
    max: VAD_MAX,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "语音开始的门槛（正常说话）：Silero 判断一帧是说话的概率达到这么多才算开口（0–1，默认 0.5，和 Silero 自己的默认一样）。调高：背景声音（咖啡店、人声、音乐）更不容易被当成你在说话、转成文字；太高时小声或离得远的话会漏掉。下一句开始前生效。",
  },
  "stt.vadNegative": {
    default: VAD_THRESHOLDS.normal.negative as number,
    schema: z.number().min(VAD_MIN).max(VAD_MAX),
    min: VAD_MIN,
    max: VAD_MAX,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "语音结束的门槛（正常说话）：概率掉到这么多以下才算停了（0–1，默认 0.35）。必须比 stt.vadPositive 低，否则自动压到它减 0.05。调高：话尾的背景声音更快截断；太高时句子中间的轻声会被切开。",
  },
  "stt.vadWhisperPositive": {
    default: VAD_THRESHOLDS.whisper.positive as number,
    schema: z.number().min(VAD_MIN).max(VAD_MAX),
    min: VAD_MIN,
    max: VAD_MAX,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "语音开始的门槛（安静房间里自动进入的耳语模式）：概率达到这么多才算开口（0–1，默认 0.35）。调高：耳语模式下背景声音更难被转成文字；太高时耳语会漏掉。",
  },
  "stt.vadWhisperNegative": {
    default: VAD_THRESHOLDS.whisper.negative as number,
    schema: z.number().min(VAD_MIN).max(VAD_MAX),
    min: VAD_MIN,
    max: VAD_MAX,
    unit: "0–1",
    group: "voice",
    audience: "public",
    description:
      "语音结束的门槛（耳语模式）：概率掉到这么多以下才算停了（0–1，默认 0.25）。必须比 stt.vadWhisperPositive 低，否则自动压到它减 0.05。",
  },
  "stt.guardMinSpeechMs": int({
    default: STT_GUARD.minSpeechMs,
    min: GUARD_MIN_SPEECH_MS.min,
    max: GUARD_MIN_SPEECH_MS.max,
    unit: "ms",
    group: "voice",
    audience: "public",
    description:
      "静音过滤：一句话里 Silero 认为是说话的部分（每帧 32 毫秒）加起来不到这么多毫秒，识别出的文字就丢掉，不发到聊天里（详情里记为「no-speech-frames」）。默认 160（5 帧）；原来是 32。调高：背景噪声里一闪而过的声音更不容易变成文字；太高时很短的一个词（「好」「嗯」）也会被丢。",
  }),
  // Short spoken answers (short-answer.ts; docs/voice-mode.md, "Short answers").
  "stt.shortAnswerMaxChars": int({
    default: SHORT_ANSWER.maxChars,
    ...SHORT_ANSWER_RANGE.maxChars,
    unit: "chars",
    group: "voice",
    audience: "public",
    description:
      "短回答：助手刚问了你一句（最后一条是助手的问句，或还没回答的选项卡）时，你说的一句话不超过这么多个字（「要」「好」「嗯」「不要」），就算太短、语音很少也照样发出去，不被噪声过滤丢掉。没有问题在等你回答时照旧过滤。默认 2；0 = 关闭（只剩 stt.shortAnswerWords 里的词）。",
  }),
  "stt.shortAnswerMaxWordChars": int({
    default: SHORT_ANSWER.maxWordChars,
    ...SHORT_ANSWER_RANGE.maxWordChars,
    unit: "chars",
    group: "voice",
    audience: "public",
    description:
      "短回答：有问题在等你回答时，只有一个词、不超过这么多个字母的一句话（「yes」「nope」「okay」）也算短回答，照样发出去。默认 8；0 = 只看 stt.shortAnswerMaxChars。",
  }),
  "stt.shortAnswerMinSpeechMs": int({
    default: SHORT_ANSWER.minSpeechMs,
    ...SHORT_ANSWER_RANGE.minSpeechMs,
    unit: "ms",
    group: "voice",
    audience: "public",
    description:
      "短回答最少要有多少毫秒的说话声（Silero 判为说话的帧，每帧 32 毫秒）。比语音检测的最短长度还短的一句话，有这么多就照样去识别，识别出来是短回答（见上两条和 stt.shortAnswerWords）才发出去，否则照旧丢掉（详情里记为「short-speech」）。默认 64（2 帧）。调高：更少的短噪声被送去识别；太高时一个字的回答又会丢。",
  }),
  "stt.shortAnswerWords": {
    default: [...SHORT_ANSWER.words] as string[],
    schema: z.array(z.string().min(1).max(40)).max(200),
    group: "voice",
    audience: "public",
    description:
      "永远算回答的词：你说的一句话（去掉前面叫的名字，如「小克 苹果」里的「小克」，不分大小写和标点）正好是其中一个，就算很短、没有问题在等你回答，也照样发出去。默认是助手给的选项代号（苹果 香蕉 橘子 葡萄 批准 驳回 搁置）和两个字以上的是/否（不要、好的、可以、yes、no、はい…）；单个字（要、好、是、嗯）噪声也常变成它们，所以只在有问题等你回答时才放行。任何语言都直接加在这里。JSON 字符串数组。",
  },
  // A posted voice line takes the speech that follows (voice-merge.ts reopenVerdict;
  // docs/dev-debug-widget.md, "Continuous speech amends the last line", "Reopened").
  "stt.mergeReopenSec": int({
    default: MERGE_REOPEN_DEFAULT_SEC,
    min: 0,
    max: MERGE_REOPEN_MAX_SEC,
    unit: "s",
    group: "voice",
    audience: "server",
    description:
      "连续语音续写已发出的消息（开关 stt.merge）：你的一条语音消息发出去以后（哪怕已经停顿、已经润色过），这么多秒内你又开口说话，就接到这条消息后面，而不是新起一条；之后整段重新 Whisper 重听、重新润色一次，撤销（↩）还能拆回每一句。中间有任何别的消息（你打字的、助手的、别的 lane 的）就不再接。默认 20 秒；0 = 关闭，只按原来的规则合并。",
  }),
  "stt.recheckMinSec": {
    default: 1.5 as number,
    schema: z.number().min(0).max(60),
    min: 0,
    max: 60,
    unit: "s",
    group: "voice",
    audience: "server",
    description:
      "Whisper 整段重听（开关 stt.whisper-recheck）：合并后的一段话从开口到说完短于这么多秒就不重听（太短，重听没多大用）。",
  },
  "stt.recheckMaxSec": int({
    default: 60,
    min: 5,
    max: 600,
    unit: "s",
    group: "voice",
    audience: "server",
    description:
      "Whisper 整段重听：一段话从开口到说完长于这么多秒就不重听。Mac 的语音服务器每个连接在内存里最多留这么多秒的录音（启动参数 --recheck-max-sec 或环境变量 LIANKI_STT_RECHECK_MAX_SEC，默认 60）；这里调大时那边也要一起调大，否则长的一段 Mac 会回答听不全，照旧用流式识别的文字。",
  }),
  "stt.recheckTimeoutMs": int({
    default: 8000,
    min: 1000,
    max: 60_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "Whisper 整段重听：一段话说完以后最多等 Mac 多久（毫秒）。这段时间里润色也在等；超时就不等了，照旧润色流式识别的文字。",
  }),
  // Synchronized read-aloud across his devices (packages/debug-chat/src/sync-speak.ts;
  // docs/li-sound-hub.md, "Synchronized read-aloud"; flag voice.sync-speak).
  "voice.liveToneHz": int({
    default: 440,
    min: 80,
    max: 2000,
    unit: "Hz",
    group: "voice",
    audience: "public",
    description: "同机 Live PCM 开发页的合成测试基频；第二源为其二倍频。不会打开麦克风或扬声器。",
  }),
  "voice.liveTonePeakPct": int({
    default: 10,
    min: 0,
    max: 100,
    unit: "percent",
    group: "voice",
    audience: "public",
    description: "同机 Live PCM 合成测试源的原始峰值百分比；实际增益仍按各路由设置。",
  }),
  "voice.liveGainPct": int({
    default: 100,
    min: 0,
    max: 400,
    unit: "percent",
    group: "voice",
    audience: "public",
    description: "同机 Live PCM 开发页每个合成源的初始增益百分比，100 表示单位增益。",
  }),
  "voice.liveMaxGainPct": int({
    default: 200,
    min: 100,
    max: 400,
    unit: "percent",
    group: "voice",
    audience: "public",
    description: "同机 Live PCM 路由增益滑块的最大百分比；混音输出始终限制到 PCM 范围。",
  }),
  "voice.liveUiRefreshMs": int({
    default: 200,
    min: 100,
    max: 1000,
    unit: "ms",
    group: "voice",
    audience: "public",
    description: "同机 Live PCM 开发页更新计数器的间隔，不影响 20ms 音频帧。",
  }),
  "voice.syncLeadMs": int({
    default: 300,
    min: 0,
    max: 3_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "多台设备同时朗读（开关 voice.sync-speak）：Li 的一句话发出时，约定在多少毫秒之后各台设备一起开始读。要比慢的那台设备收到消息所需的时间长；越长越齐，但每句开读也晚这么多。",
  }),
  "voice.syncMaxWaitMs": int({
    default: 1_500,
    min: 0,
    max: 10_000,
    unit: "ms",
    group: "voice",
    audience: "public",
    description:
      "多台设备同时朗读（开关 voice.sync-speak）：一台设备为了和别的设备对齐，最多等多少毫秒才开始读。时钟估计出错时也不会等得比这更久。",
  }),
  "voice.syncSkewMs": int({
    default: 200,
    min: 0,
    max: 2_000,
    unit: "ms",
    group: "voice",
    audience: "public",
    description:
      "多台设备同时朗读（开关 voice.sync-speak）：可以接受的开读时间差（毫秒）。某台设备比约定时刻晚了超过这么多才开读，就记一条日志（voice-sync late），方便调大 voice.syncLeadMs。",
  }),
  "stt.glossaryTopK": int({
    default: 32,
    min: 0,
    max: 128,
    group: "voice",
    audience: "public",
    unit: "terms",
    description: "语音热词：每次识别和润色最多携带几个词；0 关闭热词。",
  }),
  "stt.glossaryCapacity": int({
    default: 512,
    min: 32,
    max: 2048,
    group: "voice",
    audience: "public",
    unit: "terms",
    description: "语音热词：频率与时间衰减排序最多保留多少个候选词，防止词表无限增长。",
  }),
  "stt.glossaryTermChars": int({
    default: 64,
    min: 2,
    max: 128,
    group: "voice",
    audience: "public",
    unit: "chars",
    description: "语音热词：单个候选词最多多少字符，过长的内容不进入提示。",
  }),
  "stt.glossaryOutputChars": int({
    default: 1800,
    min: 32,
    max: 8192,
    group: "voice",
    audience: "public",
    unit: "chars",
    description: "语音热词：每次传给模型的词表和纠错映射 JSON 字符总上限。",
  }),
  "stt.glossaryContextChars": int({
    default: 2000,
    min: 0,
    max: 32768,
    group: "voice",
    audience: "public",
    unit: "chars",
    description: "语音热词：仅从已获准的当前页面和对话上下文读取多少字符；0 不使用上下文。",
  }),
  "stt.glossaryHalfLifeMs": int({
    default: 86400000,
    min: 1000,
    max: 2592000000,
    group: "voice",
    audience: "public",
    unit: "ms",
    description: "语音热词：上下文和明确手动纠错的排序权重经过多少毫秒减半；不自动学习模型润色。",
  }),
  "stt.glossaryFixedWeight": int({
    default: 8,
    min: 0,
    max: 1000,
    group: "voice",
    audience: "public",
    description: "语音热词：用户固定词库中一个词的排序权重；0 不使用固定词。",
  }),
  "stt.glossaryCorrectionWeight": int({
    default: 12,
    min: 0,
    max: 1000,
    group: "voice",
    audience: "public",
    description: "语音热词：明确手动添加的纠错词对的初始排序权重，随后按时间衰减。",
  }),

  // Automatic polish of the owner's spoken lines (lib/chat-polish.ts; the hub,
  // workers/push/src/debug.ts, "Automatic polish"; flag voice.auto-polish).
  "voice.autoPolishMinChars": int({
    default: 2,
    min: 1,
    max: 50,
    unit: "chars",
    group: "voice",
    audience: "server",
    description:
      "语音自动润色（开关 voice.auto-polish）：你说的一句话至少有几个字才送去润色；更短的（一个「嗯」）原样保留。",
  }),
  "voice.autoPolishTailMs": int({
    default: 1500,
    min: 200,
    max: 10_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "语音自动润色：一句话识别完以后等多久（毫秒）再送去润色。这段时间里你接着说的下一句会和它一起送，明显是一句话的碎片就合并成一条；等得越短，润色出来越快，但碎片更可能各润各的。",
  }),
  "voice.autoPolishContextLines": int({
    default: 12,
    min: 0,
    max: 20,
    unit: "lines",
    group: "voice",
    audience: "server",
    description:
      "语音自动润色：送去润色时，带上这次要润色的句子之前的多少条聊天（你自己的话和别人的回复），只当作上下文读、不改不输出，用来判断「他/她/它」这类同音字。0 = 不带上下文。",
  }),
  "voice.autoPolishContextChars": int({
    default: 2000,
    min: 0,
    max: 6000,
    unit: "chars",
    group: "voice",
    audience: "server",
    description:
      "语音自动润色：上下文（之前的聊天）合计最多几个字符，从最近的一条往前数，超过就不再往前带；每条另外最多 300 字。上下文算进这次润色的字数上限和扣费。",
  }),
  // The mic polish API (lib/mic-polish.ts; docs/mic-polish-api.md; flag mic.polish-api).
  "mic.polishDailyMax": int({
    default: 300,
    min: 1,
    max: 100_000,
    unit: "calls/day",
    group: "mic",
    audience: "server",
    description:
      "麦克风润色接口（开关 mic.polish-api）：每个账号每个 UTC 日（UTC 零点换日）最多润色几次，所有令牌和会话合计。到了就回 429 daily-limit，不调用模型、不扣积分；失败或积分不够的那次不算。每次的花费已经有大小上限，所以一天最多花「次数 × 单次上限」。",
  }),
  "mic.polishPerMinute": int({
    default: 30,
    min: 1,
    max: 1000,
    unit: "calls/min",
    group: "mic",
    audience: "server",
    description:
      "麦克风润色接口：同一个令牌（会话调用按账号）每分钟最多几次请求，超过回 429 rate-limit。防止脚本出错死循环；和每日上限 mic.polishDailyMax 分开计。",
  }),
  "mic.polishMaxChars": int({
    default: 8000,
    min: 100,
    max: 20_000,
    unit: "chars",
    group: "mic",
    audience: "server",
    description:
      "麦克风润色接口：一段识别文字（transcript）最多几个字符，超过回 400 too-long。otoji 的代理自己限 8000，这里不要小于 8000，否则合法请求会被拒。",
  }),
  "mic.polishMaxContextChars": int({
    default: 2000,
    min: 0,
    max: 8000,
    unit: "chars",
    group: "mic",
    audience: "server",
    description:
      "麦克风润色接口：提示信息（context，页面标题、网站等，按 JSON 计）最多几个字符，超过回 400 too-long。只当作拼写名字和术语的提示。",
  }),
  "mic.polishMaxBodyBytes": int({
    default: 32 * 1024,
    min: 4096,
    max: 256 * 1024,
    unit: "bytes",
    group: "mic",
    audience: "server",
    description:
      "麦克风润色接口：整个请求体最多多少字节，超过回 400 too-long，不读完、不解析。otoji 的代理限 32 KiB，这里不要小于 32768。",
  }),
  // Echoes of the owner's voice lines (lib/echo-match.ts; the hub, "Echoes";
  // flag voice.echo-dedupe).
  "voice.echoWindowMs": int({
    default: 8000,
    min: 0,
    max: 60_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "回声去重（开关 voice.echo-dedupe）：你在一台设备上说的话，另一台设备在这么多毫秒内识别出几乎同样的一句，就当作回声不再发出。0 = 不查另一台设备的重复。",
  }),
  "voice.echoReadWindowMs": int({
    default: 60_000,
    min: 0,
    max: 300_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "回声去重：助手的回复到达后（或你的话润色读回后）这么多毫秒内，另一台手机把朗读的内容听成你说的话，就当作回声丢掉。朗读排队或很长时要更久；0 = 不查朗读回声。",
  }),
  "voice.echoSimilarity": {
    default: 0.8 as number,
    schema: z.number().min(0.5).max(1),
    min: 0.5,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "server",
    description:
      "回声去重：两句话（去掉标点和空格、按字比较）相似到多少才算同一句；1 = 一字不差，越低越容易把你真正重复的话也当成回声。",
  },
  "voice.echoMinChars": int({
    default: 4,
    min: 1,
    max: 50,
    unit: "chars",
    group: "voice",
    audience: "server",
    description: "回声去重：一句话至少几个字才可能被当作回声；更短的（「好」「嗯」）永远照常发出。",
  }),
  // Play reports (docs/echo-suppression.md, layer (b); flag voice.echo-reports):
  // his pages tell the hub what they read aloud, and when.
  "voice.echoPlaySimilarity": {
    default: 0.6 as number,
    schema: z.number().min(0.3).max(1),
    min: 0.3,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "server",
    description:
      "朗读回声（开关 voice.echo-reports）：你的一台设备正在朗读时，另一台设备的麦克风同时识别出来的话，有多少落在正在读的那几句里面（去掉标点空格、按字比较）就算回声。有时间重叠作证据，所以比 voice.echoSimilarity 低；越低越容易把你跟着念的话也当成回声（可以点「这是我说的」找回）。",
  },
  "voice.echoSlackMs": int({
    default: 1500,
    min: 0,
    max: 10_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "朗读回声（开关 voice.echo-reports）：判断「同时」时，朗读的开始和结束各往外放宽多少毫秒（房间回声、扬声器延迟、时钟误差）。",
  }),
  "voice.echoPlayKeepMs": int({
    default: 120_000,
    min: 10_000,
    max: 600_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "朗读回声（开关 voice.echo-reports）：hub 在内存里记住各设备读过的句子多久（毫秒），过了就忘。只在内存里，不写存储、不进日志、不给任何助手。",
  }),
  // The play window (flag voice.echo-window; lib/echo-reports.ts echoWindowMatch, 2026-11-26).
  "voice.echoWindowTailMs": int({
    default: 2500,
    min: 0,
    max: 10_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "朗读时间窗（开关 voice.echo-window）：你的设备读完一句之后，再过多少毫秒内麦克风识别出来的话还算朗读回声（房间余音、语音检测的收尾）。越长越不容易漏掉回声，但你在 Li 刚读完时马上说的话也更容易被折叠（点「这是我说的」可以找回）。",
  }),
  "voice.echoWindowLeadMs": int({
    default: 300,
    min: 0,
    max: 5000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "朗读时间窗（开关 voice.echo-window）：一句开始朗读之前，往前放宽多少毫秒也算在朗读中（设备之间的时钟误差、扬声器延迟）。",
  }),
  "voice.echoWindowShare": {
    default: 0.5 as number,
    schema: z.number().min(0.1).max(1),
    min: 0.1,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "server",
    description:
      "朗读时间窗（开关 voice.echo-window）：你说的一句话至少有多大比例的时间落在朗读中（含收尾），才算「朗读时说的」，改用较低的内容门槛 voice.echoWindowMatchMin 比对。只看时间从不折叠。0.5 = 一半。调高：你说长句时 Li 正好开始读，更不容易被折叠；调低：更多回声被挡住。",
  },
  "voice.echoWindowMatchMin": {
    default: ECHO_WINDOW_MATCH_MIN as number,
    schema: z.number().min(0.2).max(1),
    min: 0.2,
    max: 1,
    unit: "0–1",
    group: "voice",
    audience: "server",
    description:
      "朗读时间窗（开关 voice.echo-window）：朗读中或刚读完时，麦克风识别出来的话要有多少和刚才读出来的句子对得上（去掉标点、大小写、重音和全角半角，按字比较），才当朗读回声折叠。时间对上只是放低门槛（平时是 voice.echoPlaySimilarity），内容对不上的从不折叠：朗读时别人或你自己说的别的话照常发出。越低越容易把你的话误当回声；越高越容易漏掉识别走样的回声。",
  },
  "voice.echoRecentMs": int({
    default: 15_000,
    min: 0,
    max: 120_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description:
      "朗读回声（开关 voice.echo-reports）：一句读完后多少毫秒内，按内容比对（任何语言，去掉标点、大小写和重音符号）和识别噪声短语（voice.echoHallucinations）仍然算回声。",
  }),
  "voice.echoHallucinations": {
    default: [...ECHO_HALLUCINATIONS] as string[],
    schema: z.array(z.string().min(1).max(120)).max(200),
    group: "voice",
    audience: "server",
    description:
      "识别噪声短语（开关 voice.echo-window）：语音识别把不是人声的声音（音乐、半听清的朗读声）常写成的固定句子，多是训练数据里的字幕署名，比如「明镜需要您的支持」「ご視聴ありがとうございました」。最近读过东西（voice.echoRecentMs 内）时，含有其中一句的话当朗读回声折叠。任何语言都直接加在这里。JSON 字符串数组。",
  },
  "voice.echoShowMax": int({
    default: 50,
    min: 1,
    max: 200,
    unit: "lines",
    group: "voice",
    audience: "server",
    description:
      "回声去重：hub 最多留多少条被当成回声的语音（折叠显示、可以点「这是我说的」恢复）；更早的丢掉。",
  }),
  // Our own TTS voices on the Mac (docs/echo-suppression.md, layer (c); flag stt.self-voice).
  // The page sends the first two to the Mac with {t:"selfVoice"}; the Mac clamps them.
  "stt.selfAccept": {
    default: 0.45 as number,
    schema: z.number().min(0.3).max(0.95),
    min: 0.3,
    max: 0.95,
    unit: "0–1",
    group: "voiceprint",
    audience: "server",
    description:
      "认出我们自己的朗读声（开关 stt.self-voice）：一句话和 Mac 上「我们的朗读声」声纹（self.campp.json）的相似度至少多少，才可能算我们自己的声音。越低越容易把你的话也折叠起来（可以点「这是我说的」找回）。默认 0.45；模拟房间里的朗读声一般在 0.6 以上，你的声音对它很低。",
  },
  "stt.selfMargin": {
    default: 0.15 as number,
    schema: z.number().min(0.05).max(0.8),
    min: 0.05,
    max: 0.8,
    unit: "0–1",
    group: "voiceprint",
    audience: "server",
    description:
      "认出我们自己的朗读声（开关 stt.self-voice）：一句话像我们朗读声的程度，要比像你声纹的程度至少高出多少，才算我们自己的声音。默认 0.15。",
  },
  "stt.selfMeMargin": {
    default: 0.1 as number,
    schema: z.number().min(0).max(0.8),
    min: 0,
    max: 0.8,
    unit: "0–1",
    group: "voiceprint",
    audience: "server",
    description:
      "朗读回声（开关 voice.echo-reports）：你正在跟着朗读念的时候，Mac 声纹说「是你」的那句，要比像我们朗读声的程度至少高出多少，才不当成朗读回声（照常发出）。默认 0.1；Mac 没有朗读声声纹时只看「是你」。",
  },
  "voice.cloudWhileMic": {
    default: "android" as "never" | "android" | "always",
    schema: z.enum(["never", "android", "always"]),
    group: "voice",
    audience: "public",
    description:
      "麦克风开着时 Li 朗读用云端声音（回声消除能听到网页自己的 <audio>，但不一定听得到设备自带的语音，安卓尤其如此）：never = 从不，android = 只在安卓上（默认），always = 所有设备。会多用一点朗读额度。",
  },
  "voice.autoPolishTimeoutMs": int({
    default: 6000,
    min: 500,
    max: 15_000,
    unit: "ms",
    group: "voice",
    audience: "server",
    description: "语音自动润色的云端模型超时（毫秒）；超时就保留识别原文，助手之后仍可以润色。",
  }),
  "voice.autoPolishOutputTokens": int({
    default: 600,
    min: 100,
    max: 3000,
    unit: "tokens",
    group: "voice",
    audience: "server",
    money: true,
    description: "语音自动润色每次最多输出多少 token；按同一 DeepSeek 价格从你的积分预扣后结算。",
  }),
  "voice.autoPolishUserCalls": int({
    default: 300,
    min: 1,
    max: 3000,
    unit: "calls/10min",
    group: "voice",
    audience: "server",
    money: true,
    description: "每个账号十分钟内最多自动润色几次（每次一句或一段连续的话）；D1 限流。",
  }),
  "voice.autoPolishSiteCalls": int({
    default: 5000,
    min: 1,
    max: 100_000,
    unit: "calls/day",
    group: "voice",
    audience: "server",
    money: true,
    description: "全站每天最多自动润色几次；独立于学习伙伴回复和聊天 CLI 整理的额外支出上限。",
  }),
  "voice.azureRegion": {
    default: "eastasia" as string,
    schema: z.string().regex(/^[a-z0-9]{2,30}$/, "an Azure region: eastasia, japaneast…"),
    group: "voice",
    audience: "server",
    description:
      "Azure 语音服务所在的区域（创建 Azure 语音资源时选的那个，例如 eastasia、japaneast）。要和 AZURE_SPEECH_KEY 那把密钥的区域一致，否则 Azure 声音读不出来（会退回原来的声音）。",
  },
  // The voiceprint in his account (docs/local-stt.md, "Voiceprint in your account"):
  // handed to the panel by GET /api/my/voiceprint.
  "voiceprint.extractor": {
    default: "mac" as const,
    schema: z.enum(["mac"]),
    group: "voiceprint",
    audience: "server",
    description:
      "谁从录音算出声纹特征：mac = 你 Mac 上的本地语音服务（开发阶段唯一的实现）。以后有云端实现时在这里切换。",
  },
  // One passkey approval covers every voiceprint op for this long (owner tap card
  // 2026-11-11 01:28 JST; docs/local-stt.md, "One approval for ten minutes").
  // Mic recordings in the account (docs/recordings.md; owner tap card 2026-11-14
  // ~03:35 JST): the daily sweep (worker.ts `scheduled`) deletes clips older than this.
  // Owner, 2026-11-25 22:54 JST: keep forever — default 0 = never swept, kept until
  // he deletes a clip himself. The key stays so a retention can be set again.
  "recordings.retentionDays": int({
    default: 0,
    min: 0,
    max: 3650,
    unit: "days",
    group: "voice",
    audience: "server",
    description:
      "麦克风录音（/my/recordings）保留多少天。0（默认）= 永久保留，从不自动删除，只有你自己在页面上删。填一个天数，每天一次的清理就会删掉比这更早录的片段（音频和文字一起删），删了找不回来；想留的先下载到 Mac。",
  }),
  // The speeds in a recording paragraph's ⋯ menu on /my/recordings (owner, 2026-11-14
  // 22:4x JST: 0.75/1/1.25/1.5/2); the choice is a device preference (lib/recordings-article.ts).
  "recordings.speeds": {
    default: "0.75,1,1.25,1.5,2" as string,
    schema: z
      .string()
      .regex(/^\s*\d(\.\d{1,2})?(\s*,\s*\d(\.\d{1,2})?)*\s*$/, "speeds, comma-separated: 0.75,1,2")
      .refine((s) => s.split(",").every((x) => Number(x) >= 0.25 && Number(x) <= 4), "each 0.25–4"),
    unit: "×",
    group: "voice",
    audience: "public",
    description:
      "/my/recordings 每段录音的「⋯」菜单里可选的播放速度：逗号分隔的倍数（默认 0.75,1,1.25,1.5,2）。1 倍总会在里面。选中的速度记在这台设备上。",
  },
  // /my/recordings reads as a journal (owner, 2026-11-15 JST: not a timestamp per
  // clip): a time shows at the start of each date and after a pause longer than this.
  "recordings.timeMarkGapMin": int({
    default: 10,
    min: 1,
    max: 1440,
    unit: "min",
    group: "voice",
    audience: "public",
    description:
      "/my/recordings 像日记一样连着读：每一天开头写一个时间，之后只有两段录音之间停了超过这么多分钟，才在下一段前面再写一个时间。默认 10 分钟。改小 = 时间更多，改大 = 更少。",
  }),
  // Meetings: screen + sound recorded into the account (docs/meetings.md, "Limits,
  // quotas, retention"; flag meetings.record). The recorder reads the public ones
  // when Start is tapped; the server checks quota, staleness and retention.
  "meetings.transcription": {
    default: MEETING_TRANSCRIPTION_DEFAULTS,
    schema: meetingTranscriptionSchema,
    group: "meetings",
    audience: "public",
    description:
      "会议字幕/会后转写的窗口、重叠、静音门槛、分人阈值和本机队列上限。录制归档不受字幕排队影响；这里只放默认值，使用时读账号可见的实时配置。",
  },
  "meetings.transcriptionRoute": {
    default: "rtc:lianki" as string,
    schema: z.enum(["rtc:lianki", ""]),
    group: "meetings",
    audience: "public",
    description:
      "用户明确为某场会议选择转写后，连接的 Lianki 语音通道；空值禁用。不会读取聊天麦克风设置，也不会自动回退云端。",
  },
  "meetings.voiceprintAssets": {
    default: "" as string,
    schema: z.string().max(8192),
    group: "meetings",
    audience: "public",
    description:
      "浏览器声纹的显式 JSON manifest（model、wasmBaseUrl、workerUrl）；必须同源、指定大小和 SHA-256。默认空：分人显示 unknown。预览仅用本地静态公开模型，不上传录音，不自动托管模型。",
  },
  "meetings.chunkSec": int({
    default: 30,
    min: 10,
    max: 120,
    unit: "s",
    group: "meetings",
    audience: "public",
    description:
      "会议录制（/my/meetings）每一段多长（秒）：录下的画面和声音按这个长度切成一段一段，每段先存进浏览器，再上传到你的账号。默认 30 秒；崩溃或断网最多丢正在录的这一段。",
  }),
  "meetings.maxMinutes": int({
    default: 180,
    min: 1,
    max: 600,
    unit: "min",
    group: "meetings",
    audience: "public",
    description:
      "一次会议最多录多久（分钟）：到了就像点了「停止」一样自动停，并说明原因。默认 180。",
  }),
  "meetings.videoKbps": int({
    default: 1000,
    min: 100,
    max: 8000,
    unit: "kbps",
    group: "meetings",
    audience: "public",
    description:
      "会议录像的画面码率（kbps）：越高越清楚、文件越大。屏幕内容压缩得很好，默认 1000（约 0.5 GB 一小时）。",
  }),
  "meetings.frameRate": int({
    default: 15,
    min: 1,
    max: 30,
    unit: "fps",
    group: "meetings",
    audience: "public",
    description: "会议录像每秒几帧：默认 15。看幻灯片 5 也够；要录动画或视频就调高。",
  }),
  "meetings.audioKbps": int({
    default: 128,
    min: 32,
    max: 320,
    unit: "kbps",
    group: "meetings",
    audience: "public",
    description: "会议录像里混合声音（你的麦克风 + 共享画面的声音）的码率（kbps）。默认 128。",
  }),
  "meetings.trackKbps": int({
    default: 32,
    min: 16,
    max: 128,
    unit: "kbps",
    group: "meetings",
    audience: "public",
    description:
      "给文字记录用的两条单独的声音（只有你的麦克风、只有别人的声音）的码率（kbps）。默认 32，足够识别。",
  }),
  "meetings.quotaGB": int({
    default: 50,
    min: 1,
    max: 1000,
    unit: "GB",
    group: "meetings",
    audience: "server",
    description:
      "每个账号的会议录制最多占多少空间（GB）：满了就不能开始新的会议，正在录的会停下并说明原因。默认 50。",
  }),
  "meetings.retentionDays": int({
    default: 0,
    min: 0,
    max: 3650,
    unit: "days",
    group: "meetings",
    audience: "server",
    description:
      "会议录制保留多少天：0（默认）= 一直留到你自己删。设成别的数字后，每天一次的清理会删掉比这更早开始的会议（画面、声音、文字一起删），删了找不回来。",
  }),
  "meetings.staleMin": int({
    default: 30,
    min: 5,
    max: 1440,
    unit: "min",
    group: "meetings",
    audience: "server",
    description:
      "一个还标着「正在录」的会议，超过这么多分钟没有新的一段上传，每天的清理就把它记为「中断」。默认 30。",
  }),
  "meetings.mimeTypes": {
    default: DEFAULT_MIME_PREFS as string,
    schema: z
      .string()
      .refine((s) => parseMimePrefs(s) !== null, "av: type | type || audio: type | type"),
    group: "meetings",
    audience: "public",
    description:
      "会议录制用的文件格式，按优先顺序：「av:」后面是录像的格式，「audio:」后面是两条单独声音的格式；同一组里用 | 分隔，两组之间用 || 分隔。浏览器支持哪个就用第一个。默认先 MP4（iPhone 能放），再 WebM。",
  },
  "voiceprint.passkeyWindowMs": int({
    default: 600_000,
    min: 0,
    max: 1_800_000,
    unit: "ms",
    group: "voiceprint",
    audience: "server",
    description:
      "声纹操作（录入、存到账号、恢复、删除、重算、导出）的一次 Face ID 管多久（毫秒）：默认 600000 = 10 分钟，在这段时间里同一台设备、同一次登录不再弹出通行密钥。0 = 每次操作都要 Face ID。只管声纹，不管别的验证。改短会让已经发出的授权也跟着变短。",
  }),
  // The owner's remote-eval grant (docs/monitoring.md, "Remote eval (owner debug)"):
  // read by the debug hub (lianki-push) over DebugSessions.config at each pairing,
  // through lib/eval-grant-config.ts (whose defaults must equal these).
  "debug.evalGrantHours": int({
    default: 8,
    min: 1,
    max: 720,
    unit: "h",
    group: "debug",
    audience: "server",
    description:
      "远程调试（eval.ts）配对时你点「允许」后，这次授权管多久（小时）：默认 8；720 = 30 天。只对改了之后的新配对生效，已经给出的授权不变。「结束」随时立刻删除授权，每次执行仍然都记日志。",
  }),
  "debug.evalGrantPages": {
    default: "chosen" as "chosen" | "all",
    schema: z.enum(["chosen", "all"]),
    group: "debug",
    audience: "server",
    description:
      "远程调试的授权覆盖哪些页面：chosen（默认）= 配对弹窗里勾选的页面；all = 你所有设备上的所有页面，包括之后才打开的（只有你自己的页面，朋友的永远不算）。只对新配对生效。",
  },
  // Lianki's own speech server (docs/local-stt.md) booked as if it were a cloud
  // service (docs/payments.md, "Cost ledger"): Workers AI whisper turbo's list price.
  "stt.local.costPerMinUsd": {
    default: 0.000513 as number,
    schema: z.number().min(0).max(1),
    min: 0,
    max: 1,
    unit: "USD/min",
    group: "costs",
    audience: "server",
    description:
      "Lianki 自己的语音服务器（你 Mac 上的本地识别）每听写一分钟音频，在成本账（/dev/costs）里记多少美元：按云服务的价格记账，用户不扣积分。默认 0.000513 = Workers AI whisper turbo 的标价。",
  },
  // Lianki's speech servers for other accounts (flag stt.worker; docs/local-stt.md,
  // "Lianki's speech servers for everyone"): the quotas, signed into each v2 ticket
  // or checked by /api/stt/session and the SttRegistry. Owner's numbers, 2026-11-11.
  "stt.worker.sessionsPerAccount": int({
    default: 1,
    min: 0,
    max: 10,
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：每个账号同时最多几个识别会话（一个会话 = 一个开着麦克风的页面）。0 = 谁都开不了（不影响你自己的麦克风）。",
  }),
  "stt.webgpuModelUrl": {
    default:
      "https://huggingface.co/onnx-community/whisper-tiny/resolve/ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
    schema: z.string().url().max(500),
    group: "stt",
    audience: "public",
    description: "客户端 WebGPU 本地语音识别模型的固定版本基础地址（pinned commit SHA）。",
  },
  "stt.webgpuOrtWasmBase": {
    default: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/",
    schema: z.string().url().max(500),
    group: "stt",
    audience: "public",
    description:
      "客户端 WebGPU 本地语音识别的 onnxruntime-web wasm 文件基础地址（固定到已安装的版本，末尾带 /）。wasm 超过 Workers 单文件 25 MiB 上限，不随站点打包。",
  },
  "stt.webgpuOrtMjsSha256": {
    default: "3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6",
    schema: z.string().regex(/^[0-9a-f]{64}$/),
    group: "stt",
    audience: "public",
    description:
      "onnxruntime-web 1.27.0 的 ort-wasm-simd-threaded.jsep.mjs 的 SHA-256。下载后校验，不一致就拒绝加载。换版本时与基础地址一起改。",
  },
  "stt.webgpuOrtWasmSha256": {
    default: "78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48",
    schema: z.string().regex(/^[0-9a-f]{64}$/),
    group: "stt",
    audience: "public",
    description:
      "onnxruntime-web 1.27.0 的 ort-wasm-simd-threaded.jsep.wasm 的 SHA-256。下载后校验，不一致就拒绝加载。换版本时与基础地址一起改。",
  },
  "stt.webgpuCacheMb": int({
    default: 256,
    min: 32,
    max: 2048,
    unit: "MB",
    group: "stt",
    audience: "public",
    description: "客户端 WebGPU 本地模型在浏览器缓存 / OPFS 中允许占用的最大空间（MB）。",
  }),
  "stt.webgpuIdleUnloadMs": int({
    default: 300000,
    min: 10000,
    max: 3600000,
    unit: "ms",
    group: "stt",
    audience: "public",
    description: "WebGPU 本地语音模型空闲多久后自动释放显存（毫秒）。",
  }),
  "stt.worker.ticketsPerMin": int({
    default: 6,
    min: 1,
    max: 60,
    unit: "/min",
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：每个账号每分钟最多领几张连接票（每次连上语音服务器要一张，60 秒有效、只能用一次）。超过就这一分钟走云端识别。",
  }),
  "stt.worker.minutesPerDay": int({
    default: 30,
    min: 0,
    max: 1440,
    unit: "min",
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：每个账号在滚动窗口里（最近 stt.capWindowHours 小时，默认 24）最多识别多少分钟音频，按成本账里记的 speech.stt.local 累计。用完就走云端识别，旧的用量随时间逐渐释放，不在某个日历日一起清零。0 = 不给语音服务器。",
  }),
  "stt.capWindowHours": int({
    default: 24,
    min: 1,
    max: 168,
    unit: "h",
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器的分钟上限（stt.worker.minutesPerDay）按多少小时的滚动窗口算：默认 24 = 最近 24 小时里用掉的分钟数。",
  }),
  "stt.worker.maxUtteranceS": int({
    default: 40,
    min: 5,
    max: 120,
    unit: "s",
    group: "stt-worker",
    audience: "server",
    description: "语音服务器：一句话最长几秒（写进连接票，语音服务器按这个截断，页面改不了）。",
  }),
  "stt.worker.sessionMaxS": int({
    default: 900,
    min: 60,
    max: 3600,
    unit: "s",
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：一个识别会话最长几秒（写进连接票；到时语音服务器断开，页面重新领票再连）。默认 900 = 15 分钟。",
  }),
  "stt.worker.macCapacity": int({
    default: 3,
    min: 0,
    max: 32,
    group: "stt-worker",
    audience: "server",
    description: "语音服务器：每台服务器（现在是你的 Mac）同时最多接几路其他用户的会话。0 = 不接。",
  }),
  "stt.worker.stunUrls": {
    default: "stun:stun.cloudflare.com:3478" as string,
    schema: z
      .string()
      .max(500)
      .regex(/^(\s*stuns?:[A-Za-z0-9.-]+(:\d{1,5})?\s*[, ]?)*$/, "stun:host:port, comma separated"),
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：WebRTC 直连用的 STUN 服务器（stun:主机:端口，逗号分隔）。空 = 不用 STUN（只有同一网络里能直连）。TURN 中转要另外的密钥，不在这里。",
  },
  "stt.worker.wssUrl": {
    default: "" as string,
    schema: z.union([
      z.literal(""),
      z
        .string()
        .max(200)
        .regex(/^wss:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/),
    ]),
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：WebRTC 连不上时的第二条路，一个 wss:// 隧道地址（直通某台语音服务器的对外监听口）。空（默认）= 没有这条路，直接走云端。要先有隧道和域名（需要你批准）。",
  },
  "stt.worker.macReserved": int({
    default: 1,
    min: 0,
    max: 32,
    group: "stt-worker",
    audience: "server",
    description:
      "语音服务器：每台服务器的容量里留几路给你自己（其他用户最多用 容量 − 留给你的）。默认 1。",
  }),
  "chat.prepareTimeoutMs": int({
    default: 5000,
    min: 200,
    max: 10000,
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "聊天CLI轻量过滤、分段和润色的云端模型超时；超时保留原文并放行。",
  }),
  "chat.prepareOutputTokens": int({
    default: 1200,
    min: 100,
    max: 3000,
    unit: "tokens",
    group: "chat",
    audience: "server",
    money: true,
    description: "聊天CLI每次轻量整理的最大输出token数；按同一DeepSeek价格预扣积分后结算。",
  }),
  "chat.prepareUserCalls": int({
    default: 60,
    min: 1,
    max: 600,
    unit: "calls/10min",
    group: "chat",
    audience: "server",
    money: true,
    description: "每个账号十分钟内最多发起几次聊天轻量整理；D1限流，换token或换Worker不能绕过。",
  }),
  "chat.prepareSiteCalls": int({
    default: 200,
    min: 1,
    max: 10000,
    unit: "calls/day",
    group: "chat",
    audience: "server",
    money: true,
    description: "全站每天最多发起几次聊天轻量整理；是独立于学习伙伴回复的额外支出上限。",
  }),
  // The ETA bar's change ticker (packages/debug-chat/src/eta-ticker.ts;
  // docs/dev-debug-widget.md, "ETA bar").
  "chat.etaTickerSec": int({
    default: ETA_TICKER_SEC,
    min: 1,
    max: 60,
    unit: "s",
    group: "chat",
    audience: "public",
    description:
      "聊天里的任务进度条：agent 改了甘特图上的任务（新增、完成、提前完成、推迟、卡住、等你、到点）时，进度条中间播报这条变化，每条显示几秒，之后回到截止最早的任务（chat.etaBarCycle）。",
  }),
  "chat.etaTickerKeep": int({
    default: ETA_TICKER_KEEP,
    min: 1,
    max: 20,
    unit: "items",
    group: "chat",
    audience: "public",
    description:
      "任务进度条一次播报最近几条变化：默认 1 = 只在 agent 刚更新了甘特图时闪一下并显示那一条，之后回到截止最早的任务，没有变化就安静；设大于 1 则轮流显示最近几条（最新的在前）。你自己在页面上做的修改不播报。",
  }),
  "chat.etaBarCycle": int({
    default: ETA_BAR_CYCLE,
    min: 1,
    max: 10,
    unit: "items",
    group: "chat",
    audience: "public",
    description:
      "任务进度条平时显示截止时间最早的那个未完成任务：名字和“超时 20M”或“还剩 35M”。默认 1 = 只显示最早的那一条；设大于 1 则按截止时间顺序轮流显示最早的几条，每条停留 chat.etaTickerSec 秒。有新变化时先播报变化，之后回到这里；“23 个任务 · 1.4H · 99%”的汇总在悬停提示里。",
  }),
  "chat.gripHoldMs": int({
    default: 500,
    min: 300,
    max: 1200,
    unit: "ms",
    group: "chat",
    audience: "public",
    description: "触屏或触笔按住聊天拖柄多久打开菜单。鼠标拖动立即开始；双击/双点切换全屏。",
  }),
  "chat.dragThresholdPx": int({
    default: SNAP_DEFAULTS.dragThresholdPx,
    min: 2,
    max: 24,
    unit: "px",
    group: "chat",
    audience: "public",
    description:
      "拖动聊天窗口时，手指或鼠标移动超过这个距离才算拖动（少于它算点按）。docs/chat-drag-ux.md",
  }),
  "chat.fullLeavePx": int({
    default: SNAP_DEFAULTS.fullLeavePx,
    min: 16,
    max: 200,
    unit: "px",
    group: "chat",
    audience: "public",
    description: "全屏或右侧栏时，向上拖动这么远才退出、回到原来的浮动位置和大小。",
  }),
  "chat.snapZoneEdgePx": int({
    default: SNAP_DEFAULTS.edgePx,
    min: 16,
    max: 200,
    unit: "px",
    group: "chat",
    audience: "public",
    description:
      "拖动聊天窗口时，屏幕底边（全屏）和右边（右侧栏）的放下区域有多厚。小屏幕会自动缩到不超过边长的四分之一。",
  }),
  "chat.snapZoneCornerPx": int({
    default: SNAP_DEFAULTS.cornerPx,
    min: 24,
    max: 240,
    unit: "px",
    group: "chat",
    audience: "public",
    description:
      "拖动聊天窗口时，右下角“最小化”放下区域的边长。小屏幕会自动缩到不超过短边的三分之一。",
  }),
  "chat.snapHintMs": int({
    default: SNAP_DEFAULTS.hintMs,
    min: 0,
    max: 200,
    unit: "ms",
    group: "chat",
    audience: "public",
    description:
      "拖动时放下区域淡入、结果预览从窗口长到目标大小的动画时长。不超过 200 毫秒（0.2 秒反馈）；系统“减少动态效果”时为 0。",
  }),
  "chat.snapHapticMs": int({
    default: SNAP_DEFAULTS.hapticMs,
    min: 0,
    max: 50,
    unit: "ms",
    group: "chat",
    audience: "public",
    description: "拖动进入一个放下区域时的轻震动时长（安卓；iOS 没有）。0 = 不震动。",
  }),
  "chat.snapPreviewPct": int({
    default: SNAP_DEFAULTS.previewPct,
    min: 10,
    max: 100,
    unit: "%",
    group: "chat",
    audience: "public",
    description: "拖到放下区域时，窗口最终位置的半透明预览有多不透明。",
  }),
  "voice.kwsDownloadMb": int({
    default: 25,
    min: 1,
    max: 1000,
    unit: "MB",
    group: "voice",
    audience: "public",
    description:
      "唤醒词模型和运行时首次下载总量的近似值，用于计量或未知网络下载确认；模型版本变化时更新。",
  }),
  "chat.telemetrySamplePct": int({
    default: 10,
    min: 0,
    max: 100,
    unit: "%",
    group: "chat",
    audience: "public",
    description: "开发账号聊天客户端时间点的确定性采样比例；不收消息正文，零为停止上报。",
  }),
  "chat.telemetryFlushMs": int({
    default: 30_000,
    min: 5_000,
    max: 300_000,
    unit: "ms",
    group: "chat",
    audience: "public",
    description: "开发账号聊天客户端遥测批量上报间隔，不逐消息写数据库。",
  }),
  "chat.telemetryBatchSize": int({
    default: 10,
    min: 1,
    max: 20,
    unit: "records",
    group: "chat",
    audience: "public",
    description: "每批聊天时间点的最多记录数。",
  }),
  "chat.widgetHtmlMaxPx": int({
    default: 480,
    min: 120,
    max: 2_000,
    unit: "px",
    group: "chat",
    audience: "public",
    description:
      "聊天消息里带脚本的 HTML 小组件（沙盒框）最多长多高（像素），超出部分在框里滚动。不带脚本的 HTML 小组件直接画在消息里，不受这个限制（最高为屏幕的 70%）。",
  }),
  "chat.readReceiptThrottleMs": int({
    default: 2_000,
    min: 2_000,
    max: 60_000,
    unit: "ms",
    group: "chat",
    audience: "public",
    description:
      "聊天已读游标的最短上报和持久化间隔（毫秒），至少两秒。只有聊天内容实际出现在可见页面的可见区时才推进；没有新读到的行就不写。",
  }),
  "chat.replayBatch": int({
    default: 100,
    min: 1,
    max: 500,
    unit: "events",
    group: "chat",
    audience: "public",
    description:
      "聊天按线程序号补拉时，一次最多覆盖多少个序号；大缺口分批恢复并在原位置合并，不刷新整页。",
  }),
  // packages/debug-chat/src/chat-outbox.ts; docs/dev-debug-widget.md, "Pending input".
  "chat.outboxAckTimeoutMs": int({
    default: 15000,
    min: 0,
    max: 600000,
    unit: "ms",
    group: "chat",
    audience: "public",
    description:
      "发出的一条聊天消息（虚线那行）等服务器回执最多等这么多毫秒；没等到就用同一个编号再发一次（服务器按编号去重，不会出现两条），之后每次等待翻倍，最多 8 倍，收到回执就恢复。默认 15000 = 15 秒；0 = 一直等，不重发。",
  }),
  "chat.outboxMaxResends": int({
    default: 4,
    min: 0,
    max: 100,
    unit: "times",
    group: "chat",
    audience: "public",
    description:
      "一条聊天消息重发这么多次仍没有服务器回执，就不再重发，标成“未发出”（和被服务器拒收一样，可以修改后再发），后面排队的消息继续发；之后若回执到了，这条照样消失。默认 4；0 = 一直重发，不放弃。",
  }),
  "chat.presenceReadMin": int({
    default: 5,
    min: 1,
    max: 120,
    unit: "min",
    group: "chat",
    audience: "server",
    description:
      "聊天头像栏（进度条左侧链接图标右边）：一个 API token（MCP 等）读过聊天后，算作“在场”多少分钟；开着监听连接的一直在场。",
  }),
  "chat.presenceSpeakerMin": int({
    default: 30,
    min: 1,
    max: 1440,
    unit: "min",
    group: "chat",
    audience: "server",
    description: "聊天头像栏：最近发过言的 agent / lane 在发言后多少分钟内仍显示在头像栏里。",
  }),
  // 全员入群 (owner, 2026-11-15; docs/lane-listen.md, "Every agent joins"): the
  // lanes beyond the built-in four, and more names for those four. The chat
  // (voices.ts setLaneTable), the router (lane-route.ts) and the wake words read it.
  "chat.lanes": {
    default: [] as ChatLaneDef[],
    schema: z
      .array(z.unknown())
      .max(64)
      .refine(
        (rows) => rows.every((r) => parseLaneDef(r) !== null),
        "each row: {id, name?, aliases?, heard?, voice?, color?}",
      ) as unknown as z.ZodType<ChatLaneDef[]>,
    group: "chat",
    audience: "public",
    description:
      '聊天里的「线」和它们的唤醒名（唯一的一张表，原 chat.laneNames 已并入；aliases 就是唤醒名，也进语音识别热词）：每个 agent 一条，名字 = 它的 API token 名。JSON 数组，每条 {id token 名, name 显示名, aliases 叫它的名字, heard 语音识别常写成的样子, voice main/calm/bright/sweet, color oklch 颜色}。内置的 coco（codex）、杰咪（agy）、小克（claude）写同一个 id 就是给它们加名字。例：{"id":"agy","aliases":["咪宝"]}、{"id":"rechrome","name":"小镀","heard":["瑞克罗姆"]}。点名、唤醒词、头像闪烁都按这张表。',
  },
  // Lane names by sound (packages/debug-chat/src/lane-phonetic.ts): the router,
  // the avatar flash and the @mention all read it. The Mac's listeners read
  // env LIANKI_LANES_PHONETIC_MAX_NEAR.
  "lanes.phoneticMaxNear": int({
    default: PHONETIC_MAX_NEAR_DEFAULT,
    min: 0,
    max: PHONETIC_MAX_NEAR_MAX,
    group: "lanes",
    audience: "public",
    description:
      "点名按读音认名字时，一个名字里最多几个字可以「读音相近」（j/q/x、zh/z、n/l、in/ing、an/ang、ie/i 这类混淆；声调不算）。例：1 时「切咪」「杰民」都算叫杰咪；0 = 拼音完全一样才算（「解密」「杰米」照样算）。Mac 上的监听读环境变量 LIANKI_LANES_PHONETIC_MAX_NEAR。",
  }),
  // Same readers; the Mac's listeners read env LIANKI_LANES_PHONETIC_OWN_SYLLABLES.
  "lanes.phoneticOwnSyllables": int({
    default: PHONETIC_OWN_SYLLABLES_DEFAULT,
    min: 0,
    max: PHONETIC_OWN_SYLLABLES_MAX,
    group: "lanes",
    audience: "public",
    description:
      "语音识别写错的名字（heard 里的写法，或读音像名字）至少几个汉字时，后面不用跟标点也算点名。例：3 时「海吉米来看一下」「哈吉米你看一下」都叫哈基米；两个字的（解密、节目）照样要跟标点才算。0 = 关（都要跟标点）。Mac 上的监听读环境变量 LIANKI_LANES_PHONETIC_OWN_SYLLABLES。",
  }),
  // The lanes manager on the Mac (scripts/dev/lanes-manager.ts): it runs there,
  // not in the Worker, so its live value is the env var named in lib/lanes-config.ts.
  "lanes.repos": {
    default: [...LANES_CONFIG_DEFAULTS["lanes.repos"]] as string[],
    schema: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, "a repo folder name")).max(64),
    group: "lanes",
    audience: "server",
    description:
      "哪些仓库里的 agent 自动入群（Lianki 和它依赖的仓库）：仓库文件夹名的 JSON 数组。agent 的工作目录里有这个名字的一段就算（…/lianki/tree/main、…/agent-yes/tree/x）。Mac 上的值是环境变量 LIANKI_LANES_REPOS（逗号分隔）。",
  },
  "lanes.agents": {
    default: [...LANES_CONFIG_DEFAULTS["lanes.agents"]] as LaneAgentDef[],
    schema: z.array(laneAgentSchema).max(64) as z.ZodType<LaneAgentDef[]>,
    group: "lanes",
    audience: "server",
    description:
      '登记过名字的 agent：JSON 数组，每条 {cwd 工作目录结尾, cli 可选 codex/claude/agy…, lane 线名 = token 名, resident 是否常驻实时监听, scope 可选 owner 只听你的/all 全部消息/system 全部消息 + 系统通知}。没登记的 agent 叫 <仓库>-<cli>-<pid>，默认只读，被点名才叫醒。例：{"cwd":"lianki/tree/codex","cli":"codex","lane":"codex","resident":true}。Mac 上的值是环境变量 LIANKI_LANES_AGENTS（JSON）。',
  },
  "lanes.relistSec": int({
    default: LANES_CONFIG_DEFAULTS["lanes.relistSec"],
    min: 10,
    max: 3600,
    unit: "s",
    group: "lanes",
    audience: "server",
    description:
      "入群管理器在 ay 没有报告变化时，最多隔多久重新列一次 agent（秒）；平时靠 ay 自己的变化推送。Mac 上的值是环境变量 LIANKI_LANES_RELIST_SEC。",
  }),
  "lanes.forwardUnknownVoice": {
    default: LANES_CONFIG_DEFAULTS["lanes.forwardUnknownVoice"],
    schema: z.boolean(),
    group: "lanes",
    audience: "server",
    description:
      "声纹没判定是不是你的语音（短句、小声）要不要也发给实时监听你的 agent（第②层）。默认不发（未定不送）；听全部消息的 agent（第①层）照样收到，带「声纹未定」标记。Mac 上的值是环境变量 LIANKI_LANES_FORWARD_UNKNOWN_VOICE（true/false）。",
  },
  "lanes.wakeLiveMin": int({
    default: LANES_CONFIG_DEFAULTS["lanes.wakeLiveMin"],
    min: 0,
    max: 240,
    unit: "min",
    group: "lanes",
    audience: "server",
    description:
      "只读的 agent 被你点名（名字、别名、#仓库、全体、@它）之后，接下来多少分钟里你说的话都实时发给它；每次再点名重新计时，到时间回到只读。0 = 只发点名的那句。Mac 上的值是环境变量 LIANKI_LANES_WAKE_LIVE_MIN。",
  }),
  "lanes.busyIdleSec": int({
    default: LANES_CONFIG_DEFAULTS["lanes.busyIdleSec"],
    min: 1,
    max: 600,
    unit: "s",
    group: "lanes",
    audience: "server",
    description:
      "谁在忙：agent 的实时输出停了这么多秒，就算它闲下来了，头像上的转圈停下。输出一来就又算忙。Mac 上的值是环境变量 LIANKI_LANES_BUSY_IDLE_SEC。",
  }),
  "lanes.digest": {
    default: LANES_CONFIG_DEFAULTS["lanes.digest"],
    schema: z.boolean(),
    group: "lanes",
    audience: "server",
    description:
      "摘要模式：你连着说的几句先攒起来，停顿一会儿（或打字发一句、说「完毕」、到最长时间）再合成一条摘要（润色后的文字 + 原消息 id），只发给小克和摘要里点了名的 agent；没点名的话不发给别的 agent。关掉 = 回到一句一句转。Mac 上的值是环境变量 LIANKI_LANES_DIGEST（true/false），或 lane-listen --no-digest。",
  },
  "lanes.digestPauseSec": int({
    default: LANES_CONFIG_DEFAULTS["lanes.digestPauseSec"],
    min: 1,
    max: 120,
    unit: "s",
    group: "lanes",
    audience: "server",
    description:
      "摘要模式：你停下多少秒没再说话，就把攒着的几句合成一条摘要发出去。Mac 上的值是环境变量 LIANKI_LANES_DIGEST_PAUSE_SEC，或 lane-listen --digest-pause <秒>。",
  }),
  "lanes.digestMaxSec": int({
    default: LANES_CONFIG_DEFAULTS["lanes.digestMaxSec"],
    min: 5,
    max: 600,
    unit: "s",
    group: "lanes",
    audience: "server",
    description:
      "摘要模式：一直在说也最多攒这么多秒（从第一句算起），到时间就先发一条摘要。Mac 上的值是环境变量 LIANKI_LANES_DIGEST_MAX_SEC，或 lane-listen --digest-max <秒>。",
  }),
  "lanes.modeGraceSec": int({
    default: 30,
    min: 0,
    max: 600,
    unit: "s",
    group: "lanes",
    audience: "server",
    description:
      "一条线的实时监听断开后，等几秒还没重连才算「转为只读」并在聊天里说一声；重连得快的不打扰你。0 = 立刻。",
  }),
  "lanes.eventLocale": {
    default: "zh" as string,
    schema: z.string().regex(/^[a-z]{2}$/, "a language code: zh, en, ja…"),
    group: "lanes",
    audience: "server",
    description:
      "「coco 开始实时监听」「哈基米 下线」这类系统消息存进聊天时用哪种语言写（新页面会按你的界面语言显示，旧页面显示这份）。",
  },
  "lanes.greeting": {
    default: LANES_CONFIG_DEFAULTS["lanes.greeting"] as string,
    schema: z.string().min(1).max(200),
    group: "lanes",
    audience: "server",
    description:
      "新 agent 入群时用它自己的 token 发的第一句问候。{name} = 线名，{repo} = 仓库，{cli} = 它是哪种 agent，{mode} = 只读 / 实时监听。Mac 上的值是环境变量 LIANKI_LANES_GREETING。",
  },
  "lanes.greetingAnswerUnnamed": {
    default: LANES_CONFIG_DEFAULTS["lanes.greetingAnswerUnnamed"] as string,
    schema: z.string().min(1).max(200),
    group: "lanes",
    audience: "server",
    description:
      "可以答没点名的话的 agent（coco、哈基米）入群时的第一句问候，占位符同上。Mac 上的值是环境变量 LIANKI_LANES_GREETING_ANSWER_UNNAMED。",
  },
  "chat.presenceShown": int({
    default: 3,
    min: 1,
    max: 12,
    unit: "avatars",
    group: "chat",
    audience: "public",
    description:
      "聊天头像栏最多叠放显示几个头像：只算能马上回答的（实时监听的 agent 和人，最近活跃的在前），其余显示为「+N」；只读车道不画头像，只在最后显示一个「+N 只读」，展开的列表仍列出全部。",
  }),
  "chat.prepareAuthCalls": int({
    default: 120,
    min: 1,
    max: 1200,
    unit: "calls/10min",
    group: "chat",
    audience: "server",
    description: "聊天轻量整理每个API token的独立鉴权限流；不占用发送、提问或读取历史的额度。",
  }),
  "app.autoUpdateIdleMs": int({
    default: 15000,
    min: 3000,
    max: 600000,
    unit: "ms",
    group: "app",
    audience: "public",
    description:
      "有新版本时（开关 app.auto-update），页面干净且多久没有点、滑、打字就自己刷新（毫秒）。切到后台或换页面时不等这段时间。/words 和 /review 上只在切到后台或换页面时刷新。",
  }),
  // The account-age bonus keys (credits.ageBonus.day1Usd / day7Usd / day1Hours /
  // day7Hours) were removed 2026-11-14 with the feature; a stored row under
  // them is ignored (docs/config-store.md, "Removed keys").
  // Login-streak bonus (docs/payments.md, "Login-streak bonus"; owner 2026-11-14):
  // credits for consecutive days of real learning, once per local day. The
  // amounts become credits at CREDITS_PER_USD (lib/payments/credits.ts), rounded.
  "credits.loginStreak.usdByDay": {
    default: "0.02,0.02,0.05,0.05,0.06,0.10,0.20" as string,
    schema: z
      .string()
      .regex(
        /^\s*\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?){0,29}\s*$/,
        "USD per day, comma-separated: 0.02,0.02,0.05,…",
      )
      .refine((s) => s.split(",").every((d) => Number(d) >= 0 && Number(d) <= 10), "0–10 USD each"),
    unit: "USD/day",
    group: "credits",
    audience: "server",
    money: true,
    description:
      "连续学习奖励：每个周期里第 1、2、3…天各送多少美元，逗号分隔（个数 = 周期长度，默认 7 天一轮，共 0.50 美元/轮，第 8 天回到第 1 档）。按 CREDITS_PER_USD 换成积分（四舍五入）。一天只有在服务器记到一次真实学习（复习了卡片、阅读打分）时才算，每个自然日（按账号所在时区）只送一次。某一档填 0 = 那天不送。",
  },
  "credits.loginStreak.missCostDays": int({
    default: 2,
    min: 0,
    max: 1000,
    unit: "days",
    group: "credits",
    audience: "server",
    money: true,
    description:
      "连续学习奖励的断签规则：每漏一天，连续天数扣多少天（不清零）。默认 2：连续 7 天后漏 1 天，再学时按第 6 天算（7−2+1）。0 = 漏天不扣；填很大（如 1000）= 漏一天就从头开始。",
  }),
  // Sign-up bonus (docs/payments.md, "Sign-up bonus"; owner 2026-11-15): a new
  // account's one-time credits, for the first N new accounts per UTC day.
  "credits.signupBonusUsd": {
    default: 1 as number,
    schema: z.number().min(0).max(10),
    min: 0,
    max: 10,
    unit: "USD",
    group: "credits",
    audience: "server",
    money: true,
    description:
      "注册礼：每个新注册的账号一次性送多少美元的积分（按 CREDITS_PER_USD 换成积分，四舍五入），只发给每个 UTC 日的前几个新账号（credits.signupBonusDaily）。功能上线前就有的老账号下次登录或打开钱包时也补发同样金额，一次，不占每日名额。0 = 不送。",
  },
  "credits.signupBonusDaily": int({
    default: 10,
    min: 0,
    max: 10_000,
    unit: "accounts/day",
    group: "credits",
    audience: "server",
    money: true,
    description:
      "注册礼：每个 UTC 日（UTC 零点换日）最多前几个新注册的账号能拿到（每个账号只一次）。超出的人什么也拿不到，也不会看到报错。0 = 新账号都不送（老账号补发不受影响）。",
  }),
  "inbox.maxFileBytes": int({
    default: 20 * 1024 * 1024,
    min: 1024,
    max: 100 * 1024 * 1024,
    unit: "bytes",
    group: "inbox",
    audience: "public",
    description: "每个登录账号的收件箱与共享文件存储：单个上传文件的安全大小上限。",
  }),
  "inbox.maxDayBytes": int({
    default: 200 * 1024 * 1024,
    min: 1024 * 1024,
    max: 20 * 1024 ** 3,
    unit: "bytes",
    group: "inbox",
    audience: "server",
    description: "每个账号滚动24小时上传的安全字节上限。",
  }),
  // /roadmap pace and estimates (lib/roadmap/eta.ts, docs/roadmap-next.md "2a").
  "roadmap.paceWindowDays": int({
    default: 14,
    min: 3,
    max: 90,
    unit: "days",
    group: "roadmap",
    audience: "server",
    description:
      "/roadmap 预计完成时间看最近多少天的学习记录：单词步骤看每天新学的词，文档步骤看每天勾掉的清单项。越近的日子权重越大。",
  }),
  "roadmap.paceMinActiveDays": int({
    default: 3,
    min: 1,
    max: 30,
    unit: "days",
    group: "roadmap",
    audience: "server",
    description:
      "/roadmap 一个步骤在上面的窗口里至少有几天有学习记录才给出预计时间；不够就显示「记录还太少，暂不估计」。",
  }),
  "roadmap.aheadDays": int({
    default: 7,
    min: 1,
    max: 90,
    unit: "days",
    group: "roadmap",
    audience: "public",
    description:
      "/roadmap 预计完成比目标日期早至少多少天才算「提前」；早于目标但不到这个天数算「按计划」，晚于目标算「落后」。",
  }),
  "roadmap.docMaxChars": int({
    default: 20000,
    min: 1000,
    max: 200000,
    unit: "chars",
    group: "roadmap",
    audience: "public",
    description: "/roadmap 一个文档步骤的 Markdown 最长多少字符（图片只占它的链接）。",
  }),
  // inbox.maxStoredBytes (2 GB safety cap) was removed 2026-11-26: files.quotaBytes replaces it.
  "files.quotaBytes": int({
    default: 5 * 1024 ** 3,
    min: 1024 * 1024,
    max: 1024 ** 4,
    unit: "bytes",
    group: "files",
    audience: "server",
    description:
      "每个账号的文件空间（/my/files）：所有来源一起算，聊天里发的图片、导入、自我介绍、书都占这一份。默认 5 GB。",
  }),
  "inbox.uploadsPerMinute": int({
    default: 30,
    min: 1,
    max: 120,
    unit: "uploads/min",
    group: "inbox",
    audience: "server",
    description: "每个账号每个Worker实例一分钟允许的上传次数，账号之间独立。",
  }),
  "chat.hubRpcTimeoutMs": int({
    ...HUB_RPC_LIMITS["chat.hubRpcTimeoutMs"],
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "聊天 hub 普通外呼的总等待上限；超时按失败处理，避免悬挂请求阻止休眠。",
  }),
  "chat.polishRpcTimeoutMs": int({
    ...HUB_RPC_LIMITS["chat.polishRpcTimeoutMs"],
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "聊天 hub 润色外呼的总等待上限，包含配置、额度与模型调用；超时保留原文。",
  }),
  "chat.partnerRpcTimeoutMs": int({
    ...HUB_RPC_LIMITS["chat.partnerRpcTimeoutMs"],
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "聊天 hub 学习伙伴回复外呼的总等待上限；超时明确失败并结束忙碌状态。",
  }),
  // Li in the owner's own thread (flag partner.owner-thread, docs/partner-ai.md):
  // read by the debug hub over DebugSessions.config.
  "partner.checkpointKeepPct": int({
    default: 50,
    min: 10,
    max: 90,
    unit: "%",
    group: "chat",
    audience: "server",
    description:
      "Li 的对话记忆（开关 partner.stable-prompt）：之前的聊天按原样往后追加，不改写，这样模型那边的缓存能命中、更省钱；超过上限（20 条或 12000 字）时重新开一段，只保留最近的这个百分比。越大 Li 记得越多，但重开得越频繁（每次重开缓存失效一次）。",
  }),
  "partner.ownerReplyDelayMs": int({
    default: OWNER_REPLY_DELAY_MS,
    min: 0,
    max: OWNER_REPLY_DELAY_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "你自己的线程里，Li（模型）等多少毫秒再回复：这段时间里有开发通道回复，Li 就不说话。默认 30000 = 30 秒。开关在 /dev/flags 的 partner.owner-thread。",
  }),
  "partner.turnPauseMs": int({
    default: PARTNER_TURN_DELAY_MS,
    min: 0,
    max: PARTNER_TURN_DELAY_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "统一学习伙伴流程（partner.standard-flow）：连续语音停顿多少毫秒后一起回答，默认 8000 = 8 秒。打字的完整消息立即处理；达到一轮上限则提前处理。",
  }),
  "partner.turnMaxWaitMs": int({
    default: PARTNER_TURN_WAIT_MS,
    min: 0,
    max: PARTNER_TURN_WAIT_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "统一学习伙伴流程：即使一直在说话，一轮最多等待多少毫秒再处理，默认 30000 = 30 秒。设为 0 立即处理；不改变原话实时发给助手的路径。",
  }),
  "partner.ownerQuietMs": int({
    default: OWNER_QUIET_MS,
    min: 0,
    max: OWNER_QUIET_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "你在自己的线程里叫 Li 别说话（partner.stopPhrases 里的话，如「没问你」「闭嘴」）后，Li 沉默多少毫秒；其间你直接叫 Li（partner.liNames）它才回答。默认 600000 = 10 分钟；0 = 不沉默。",
  }),
  "partner.stopPhrases": {
    default: [...OWNER_STOP_PHRASES] as string[],
    schema: z.array(z.string().min(1).max(40)).max(200),
    group: "chat",
    audience: "server",
    description:
      "让 Li 沉默的话：你的一句话里含其中任何一条（不分大小写，任何语言都直接加在这里），且没有叫开发通道的名字，Li 就沉默 partner.ownerQuietMs。JSON 字符串数组。",
  },
  "partner.liNames": {
    default: [...OWNER_LI_NAMES] as string[],
    schema: z.array(z.string().min(1).max(40)).max(50),
    group: "chat",
    audience: "server",
    description:
      "Li 自己的名字：你的一句话以其中一个开头、后面跟标点或什么都没有（「Li，…」），就是在叫 Li：结束沉默，开发通道正在说话时也照样回答。JSON 字符串数组。",
  },
  "partner.spokenNeedsName": {
    default: OWNER_SPOKEN_NEEDS_NAME as boolean,
    schema: z.boolean(),
    group: "chat",
    audience: "server",
    description:
      "麦克风转写默认须点名才由 Li 回答。统一流程接受 Li（partner.liNames）或其他助手的点名，随后停顿窗口内的后续语音一起合并；声纹为 unknown/other 时始终不答。设为 false 时，声纹确认是本人也可不点名；没有声纹的环境语音仍不能自行开一轮。旧流程只认 Li 的名字。打字不受影响。",
  },
  "partner.laneActiveMs": int({
    default: OWNER_LANE_ACTIVE_MS,
    min: 0,
    max: OWNER_LANE_ACTIVE_MAX,
    unit: "ms",
    group: "chat",
    audience: "server",
    description:
      "开发通道（不算 Li）最近这么多毫秒内在你的线程里说过话，Li 就不回答你没点名的话（多半是在跟那个通道对话）。默认 300000 = 5 分钟；0 = 不看。",
  }),
  "partner.rollCallReply": {
    default: ROLL_CALL_REPLY_DEFAULT as string,
    schema: z.string().min(1).max(200),
    group: "chat",
    audience: "server",
    description:
      "你在自己的线程里点名 / 报数时，Li 立刻（不调用模型）回的话。默认只报自己「Li 在」（你要求每个人亲自回答，不代答）。可选占位符：{n} = 除 Li 外在场几位，{names} = 他们的名字（「、」隔开，实时监听的在前）；用了 {names} 而没人在场时只说逗号前那段。",
  },
  "partner.otherAgentNames": {
    default: [...OWNER_AGENT_NAMES] as string[],
    schema: z.array(z.string().min(1).max(40)).max(200),
    group: "chat",
    audience: "server",
    description:
      "其他 agent 的名字（在聊天线名单之外再加）：你的一句话里出现其中任何一个（英文按整词、不分大小写），就是给那个 agent 的，Li 不回答，让它去处理。JSON 字符串数组。",
  },
  "partner.devWords": {
    default: [...OWNER_DEV_WORDS] as string[],
    schema: z.array(z.string().min(1).max(40)).max(300),
    group: "chat",
    audience: "server",
    description:
      "开发 / 运维的词（部署、代码、计费、Cloudflare…）：你的一句话里有其中任何一个，就交给开发通道，Li 只润色这句话、不回答。英文按整词、不分大小写。JSON 字符串数组。",
  },
  "partner.studyWords": {
    default: [...OWNER_STUDY_WORDS] as string[],
    schema: z.array(z.string().min(1).max(40)).max(300),
    group: "chat",
    audience: "server",
    description:
      "学习相关的词（今日目标、单词表、复习、到期、语法…）：你自己的线程里，Li 只回答含其中一个的话，或者直接叫 Li 的话；其他的话 Li 只润色、不回答。英文按整词、不分大小写。JSON 字符串数组。",
  },
  "partner.languageIntents": {
    default: [...OWNER_LANGUAGE_INTENTS] as string[],
    schema: z.array(z.string().min(1).max(40)).max(300),
    group: "chat",
    audience: "server",
    description:
      "明确的语言请求（翻译、什么意思、例句、语法、发音…）：一句话里有其中一个，就算带开发词（「commit 是什么意思」「给我一个包含 bug 的例句」）也算学习，Li 照样回答；点名别的 agent 时仍然沉默。英文按整词、不分大小写。JSON 字符串数组。",
  },
  "partner.systemPrompt": {
    default: PARTNER_SYSTEM_PROMPT as string,
    schema: z.string().min(1).max(PARTNER_SYSTEM_PROMPT_MAX),
    group: "chat",
    audience: "server",
    description:
      "Li（学习伙伴模型）的规则，系统提示的固定部分（英文写给模型看）。规则：不列自己做不了什么、不拒绝，给最接近的可行办法，或者说这件事交给聊天里的哪位。改动在下一次回复时生效。",
  },
  // The Learning Partner AI's caps (docs/partner-ai.md, "Caps"): read by the
  // debug hub over DebugSessions.config.
  "partner.capWindowHours": int({
    default: CAP_WINDOW_HOURS,
    min: 1,
    max: CAP_WINDOW_MAX,
    unit: "h",
    group: "chat",
    audience: "server",
    description:
      "学习伙伴 AI 的用量上限按滚动窗口算：每个账号和全站在最近多少小时里的用量（按 UTC 整点分桶）。默认 24 = 最近 24 小时，旧的用量随时间逐渐释放，不在某个日历日一起清零。",
  }),
  "partner.userWindowTokens": int({
    default: USER_DAILY_TOKENS,
    min: 0,
    max: USER_WINDOW_TOKENS_MAX,
    unit: "tokens",
    group: "chat",
    audience: "server",
    description:
      "学习伙伴 AI：每个账号在滚动窗口（partner.capWindowHours，默认最近 24 小时）里最多用多少 token（输入 + 输出，约 40–80 条普通消息 = 60000）。用满后提示大约多少分钟后能再回复。0 = 不回复。",
  }),
  "partner.siteWindowUsd": {
    default: SITE_DAILY_USD as number,
    schema: z.number().min(0).max(SITE_WINDOW_USD_MAX),
    min: 0,
    max: SITE_WINDOW_USD_MAX,
    unit: "USD",
    group: "chat",
    audience: "server",
    money: true,
    description:
      "学习伙伴 AI：全站在滚动窗口（partner.capWindowHours）里最多花多少美元（按模型标价算）。用满后所有人都暂停，旧的用量随时间释放。0 = 全站不回复。",
  },
  // The spend alert (flag partner.spend-alert; lib/payments/spend-alert.ts).
  "partner.spendAlertStepUsd": {
    default: SPEND_STEP_USD as number,
    schema: z.number().min(SPEND_STEP_MIN).max(SPEND_STEP_MAX),
    min: SPEND_STEP_MIN,
    max: SPEND_STEP_MAX,
    unit: "USD",
    group: "chat",
    audience: "server",
    description:
      "AI 花费提醒的步长：全站和你自己账号的 AI 花费（服务商成本）每多这么多美元，就在你的线程里发一条提醒。默认 1 = 每 1 美元一条。改了步长不会重复已经提醒过的金额。开关在 /dev/flags 的 partner.spend-alert。",
  },
  "partner.spendAlertSiteText": {
    default: SPEND_SITE_TEXT as string,
    schema: z.string().min(1).max(200).includes("{n}"),
    group: "chat",
    audience: "server",
    description:
      "全站 AI 花费提醒的那句话（发在你的线程里并朗读）。{n} = 达到的金额（美元，如 3），{today} = 今天（UTC）全站花了多少，{month} = 本月（UTC）全站花了多少（两位小数）。$ 是文字本身的美元符号。",
  },
  "partner.spendAlertMineText": {
    default: SPEND_MINE_TEXT as string,
    schema: z.string().min(1).max(200).includes("{n}"),
    group: "chat",
    audience: "server",
    description:
      "你自己账号的 AI 花费提醒那句话（发在你的线程里并朗读）。{n} = 达到的金额（美元），{today} = 你今天（UTC）花了多少，{month} = 你本月（UTC）花了多少（两位小数）。",
  },
  "chat.partnerModelTimeoutMs": int({
    ...HUB_RPC_LIMITS["chat.partnerModelTimeoutMs"],
    unit: "ms",
    group: "chat",
    audience: "server",
    description: "学习伙伴模型 HTTP 请求超时；总 hub 等待上限仍由 partnerRpcTimeoutMs 控制。",
  }),
  // Mini apps (docs/mini-apps.md): /m/<slug>, one sandboxed HTML file per app.
  "miniApps.maxBytes": int({
    default: 2 * 1024 * 1024,
    min: 1024,
    max: 16 * 1024 * 1024,
    unit: "bytes",
    group: "miniApps",
    audience: "public",
    description:
      "小应用（/m/<名字>）：一个应用的 HTML 文件最大多少字节（默认 2 MB，最多 16 MB，与 Claude Artifacts 相同）。",
  }),
  "miniApps.storageBytes": int({
    default: 256 * 1024,
    min: 1024,
    max: 16 * 1024 * 1024,
    unit: "bytes",
    group: "miniApps",
    audience: "public",
    description: "小应用：每个应用自己的存储（lianki.storage）最多存多少字节（键和值合计）。",
  }),
  "miniApps.perAccount": int({
    default: 20,
    min: 1,
    max: 500,
    unit: "apps",
    group: "miniApps",
    audience: "server",
    description: "小应用：一个账号最多发布几个应用（同名重新发布不算新的）。",
  }),
  "miniApps.callsPerMinute": int({
    default: 120,
    min: 1,
    max: 1200,
    unit: "calls/min",
    group: "miniApps",
    audience: "server",
    description: "小应用：每个账号每分钟最多调用几次能力（存储、设置、聊天），超过就暂时拒绝。",
  }),
  "miniApps.cardWaitMs": int({
    default: 120_000,
    min: 10_000,
    max: 600_000,
    unit: "ms",
    group: "miniApps",
    audience: "server",
    description:
      "小应用的 lianki.ui.card：在聊天里发出选择卡片后，最多等你点多久（毫秒）；超时应用收到「没有回答」。",
  }),
  "miniApps.chatHeightPx": int({
    default: 360,
    min: 120,
    max: 1200,
    unit: "px",
    group: "miniApps",
    audience: "public",
    description: "聊天内嵌迷你应用面板的初始高度，实际大小会夹紧到当前可视窗口。",
  }),
  "miniApps.chatMinHeightPx": int({
    default: 160,
    min: 80,
    max: 600,
    unit: "px",
    group: "miniApps",
    audience: "public",
    description: "聊天内嵌迷你应用面板的最小高度；小屏幕时仍以可视窗口为准。",
  }),
  "miniApps.chatResizeStepPx": int({
    default: 24,
    min: 4,
    max: 120,
    unit: "px",
    group: "miniApps",
    audience: "public",
    description: "键盘方向键每次调整聊天迷你应用面板高度的像素数。",
  }),
  "miniApps.origin": {
    default: "" as string,
    schema: z.union([
      z.literal(""),
      z
        .string()
        .max(120)
        .regex(
          /^https:\/\/(?:\{app\}\.)?[a-z0-9.-]+\.[a-z]{2,}$|^http:\/\/(?:\{app\}\.)?m\.localhost:\d{2,5}$/,
          "https://m.lianki.com, or https://{app}.<another domain>",
        ),
    ]),
    group: "miniApps",
    audience: "server",
    description:
      "小应用从哪个独立的网址运行（不是 lianki.com 本身）：例如 https://m.lianki.com，或者每个应用一个子域名 https://{app}.另一个域名。要先加 DNS 记录和 Worker 路由（需要你批准）。空（默认）= 用 srcdoc 沙盒（没有自己的网址，应用不能用浏览器存储）。",
  },
  "miniApps.scriptOrigins": {
    default:
      "https://cdnjs.cloudflare.com,https://cdn.jsdelivr.net/npm/,https://unpkg.com,https://cdn.tailwindcss.com,https://code.jquery.com" as string,
    schema: z
      .string()
      .max(1000)
      .regex(
        /^\s*https:\/\/[A-Za-z0-9./_-]+(\s*,\s*https:\/\/[A-Za-z0-9./_-]+)*\s*$/,
        "https:// sources, comma-separated",
      ),
    group: "miniApps",
    audience: "public",
    description:
      "小应用可以从哪些 CDN 加载脚本（逗号分隔；和 Claude Artifacts 同一份名单）。脚本地址必须带确切版本号（例如 react@18.3.1），发布时检查。其他一切都要写在 HTML 里。",
  },
  "miniApps.styleOrigins": {
    default: "https://fonts.googleapis.com" as string,
    schema: z
      .string()
      .max(500)
      .regex(
        /^\s*https:\/\/[A-Za-z0-9./_-]+(\s*,\s*https:\/\/[A-Za-z0-9./_-]+)*\s*$/,
        "https:// sources, comma-separated",
      ),
    group: "miniApps",
    audience: "public",
    description:
      "小应用可以从哪里加载样式表（逗号分隔，默认只有 Google Fonts）；Lianki 自己的样式包总是可以用。",
  },
  "miniApps.fontOrigins": {
    default: "https://fonts.gstatic.com" as string,
    schema: z
      .string()
      .max(500)
      .regex(
        /^\s*https:\/\/[A-Za-z0-9./_-]+(\s*,\s*https:\/\/[A-Za-z0-9./_-]+)*\s*$/,
        "https:// sources, comma-separated",
      ),
    group: "miniApps",
    audience: "public",
    description: "小应用可以从哪里加载字体文件（逗号分隔，默认 Google Fonts 的字体服务器）。",
  },
  "miniApps.prefKeys": {
    default:
      "ui.locale,ui.paper,motion.animations,text-size.ui,lang.preferred,words.readAloud,chat-voice.rate" as string,
    schema: z
      .string()
      .max(1000)
      .regex(
        /^\s*[a-z][A-Za-z0-9.-]*(\s*,\s*[a-z][A-Za-z0-9.-]*)*\s*$/,
        "preference keys, comma-separated",
      ),
    group: "miniApps",
    audience: "public",
    description:
      "小应用经你同意后可以读、改哪些账号设置（逗号分隔的设置键；不在 lib/prefs/schema.ts 里的会被忽略）。默认只有界面语言、纸张、动画、字号、偏好语言、朗读和语速。",
  },
  // Agent audio on his phone (docs/li-sound-hub.md, "Playing audio from an agent").
  "chat.play.denyHosts": {
    default: "" as string,
    schema: z
      .string()
      .max(2000)
      .regex(/^[A-Za-z0-9.,\s-]*$/, "host names, comma separated"),
    group: "chat",
    audience: "server",
    description:
      "播放音频（say --play）：不许播放的网站（主机名，逗号分隔；也拦它下面的子域名，如 example.com 也拦 a.example.com）。空（默认）= 任何 https 网站都能播（IP 地址、本地网络和带账号密码的地址永远不行）。",
  },
  "chat.play.perTenMin": int({
    default: 20,
    min: 0,
    max: 600,
    unit: "次/10 分钟",
    group: "chat",
    audience: "server",
    description:
      "播放音频（say --play）：每个通道令牌（或配对的发送端）每 10 分钟最多发几条带音频的消息。0 = 不许播放。",
  }),
  // Li chat from the userscript pill (docs/userscript-li-chat.md, M2/M3).
  "chat.pillTicketsPerMinute": int({
    default: 20,
    min: 1,
    max: 600,
    unit: "张/分钟",
    group: "chat",
    audience: "server",
    description:
      "药丸 Li 聊天：每个账号每分钟最多领几张聊天票据（POST /api/chat/li-ticket，每次连接一张，60 秒一次性）。超过 = 这一分钟里连不上，稍后自动再试。",
  }),
  "chat.pillShareChars": int({
    default: 2000,
    min: 100,
    max: 2000,
    unit: "字",
    group: "chat",
    audience: "server",
    description:
      "药丸 Li 聊天：在别的网站上点「分享选中文字」时，最多带上多少个字（超出部分截掉）。分享的内容先放进输入框，你按发送才会发出。",
  }),
  "mcp.waitP95AlertMs": int({
    default: MCP_MONITOR_DEFAULTS.waitP95AlertMs,
    min: 100,
    max: 60000,
    unit: "ms",
    group: "monitor",
    audience: "server",
    description:
      "MCP 实时消息从发送到 wait 返回的延迟 p95 超过多少毫秒时告警；不含正常空等和历史补读。",
  }),
  "mcp.waitMinSamples": int({
    default: MCP_MONITOR_DEFAULTS.waitMinSamples,
    min: 5,
    max: 256,
    unit: "calls",
    group: "monitor",
    audience: "server",
    description: "最近十分钟至少多少次 MCP 实时消息投递样本后才判断 p95 延迟告警。",
  }),
  "monitor.pathRateMax": int({
    default: MONITOR_BUDGET_DEFAULTS.pathRateMax,
    min: 1,
    max: 10000000,
    unit: "requests/10min",
    group: "monitor",
    audience: "server",
    description: "同一路径最近十个分钟桶请求数超过多少时告警，成功请求也计入；分区近似计数。",
  }),
  "monitor.repeat401Max": int({
    default: MONITOR_BUDGET_DEFAULTS.repeat401Max,
    min: 1,
    max: 10000000,
    unit: "401/hour",
    group: "monitor",
    audience: "server",
    description: "同一路径最近六十个分钟桶返回 401 超过多少时告警；分区近似计数。",
  }),
  "monitor.cpuMsMonthAlert": int({
    default: MONITOR_BUDGET_DEFAULTS.cpuMsMonthAlert,
    min: 1,
    max: 1000000000000,
    unit: "CPU ms/month",
    group: "monitor",
    audience: "server",
    description:
      "按当日观察到的主 Worker CPU 粗略推算整月超过多少毫秒时告警；KV 并发和休眠可能漏计，不是账单。",
  }),
} as const satisfies Record<string, ConfigDef>;

export type ConfigKey = keyof typeof CONFIG;

/** The value type of a key. */
export type ConfigValue<K extends ConfigKey> = (typeof CONFIG)[K]["default"];

export type ConfigValues = { [K in ConfigKey]: ConfigValue<K> };

/** Keys whose value is sent to the browser. */
export type PublicConfigKey = {
  [K in ConfigKey]: (typeof CONFIG)[K]["audience"] extends "public" ? K : never;
}[ConfigKey];

export type PublicConfigValues = { [K in PublicConfigKey]: ConfigValue<K> };

export const CONFIG_KEYS = Object.keys(CONFIG) as ConfigKey[];

export const PUBLIC_CONFIG_KEYS = CONFIG_KEYS.filter(
  (k) => CONFIG[k].audience === "public",
) as PublicConfigKey[];

export function isConfigKey(key: unknown): key is ConfigKey {
  return typeof key === "string" && Object.hasOwn(CONFIG, key);
}

const def = (key: ConfigKey) => CONFIG[key] as ConfigDef;

/** Every key at its registry default. */
export function defaultConfig(): ConfigValues {
  return Object.fromEntries(CONFIG_KEYS.map((k) => [k, CONFIG[k].default])) as ConfigValues;
}

export type Parsed<V> = { ok: true; value: V } | { ok: false; error: string };

/** A value checked against its key's schema. */
export function parseConfigValue<K extends ConfigKey>(
  key: K,
  raw: unknown,
): Parsed<ConfigValue<K>> {
  const r = def(key).schema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data as ConfigValue<K> }
    : { ok: false, error: r.error.issues[0]?.message ?? "invalid" };
}

/** A stored JSON text checked against its key's schema; undefined when it is not valid. */
export function parseStoredConfig<K extends ConfigKey>(
  key: K,
  json: string | null | undefined,
): ConfigValue<K> | undefined {
  if (json == null) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const r = parseConfigValue(key, raw);
  return r.ok ? r.value : undefined;
}

/**
 * The value in effect: the global one (already the default when nothing valid
 * is stored), then the user's own when the key allows one and it validates.
 */
export function resolveConfig<K extends ConfigKey>(
  key: K,
  global: ConfigValue<K>,
  user?: unknown,
): ConfigValue<K> {
  if (user === undefined || !def(key).userPref) return global;
  const r = parseConfigValue(key, user);
  return r.ok ? r.value : global;
}

/** The public keys of a snapshot (what the browser may see). */
export function publicSubset(values: ConfigValues): PublicConfigValues {
  return Object.fromEntries(PUBLIC_CONFIG_KEYS.map((k) => [k, values[k]])) as PublicConfigValues;
}
