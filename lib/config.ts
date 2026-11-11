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

export const CONFIG = {
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
      "语音服务器：每个账号每天（日本时间）最多识别多少分钟音频，按成本账里记的 speech.stt.local 累计。用完当天就走云端识别。0 = 不给语音服务器。",
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
