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

export interface FlagDef {
  /** Shown on /dev/flags: what turning it on does (the owner's language). */
  description: string;
  /** Always off; a flag is a switch the owner turns ON. */
  default: false;
}

export const FLAGS = {
  "payments.stripe.live": {
    description:
      "Stripe 正式收款：需要 sk_live_ 密钥并打开此开关。关闭 = 紧急停止：30 秒内不再开始新的付款；已经在付款中的会照常入账。",
    default: false,
  },
  "payments.komoju.live": {
    description:
      "KOMOJU 正式收款：需要 sk_live_ 密钥并打开此开关。关闭 = 紧急停止：30 秒内不再开始新的付款；已经在付款中的（含便利店付款）会照常入账。",
    default: false,
  },
  "words.voice-mode": {
    description:
      "/words 语音口令模式：设置里出现「语音口令」开关，打开后不用唤醒词，说「下一张、上一张、上下左右、重来/困难/良好/简单、显示答案、再读一遍、撤销、退出语音模式」来操作。关闭时只有站长本人能预览。",
    default: false,
  },
  "read.reader-v2": {
    description:
      "新阅读器 /read/[id]：整本书连续滚动（按原书段落显示），每个词按熟悉度标记，左右滑动一段给理解评分（同 /words，FSRS 记在每个句子上），同步阅读位置、阅读笔记和语境中见过的词。关闭时只有站长本人在开发预览里能看到。",
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
