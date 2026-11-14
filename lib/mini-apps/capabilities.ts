/**
 * What a mini app may ask for (docs/mini-apps.md, "Capabilities"). A
 * capability is one permission the user grants per (account, app), like a
 * browser's per-site permissions; each SDK method needs exactly one. A
 * manifest may only declare ids listed here, and the host refuses, without a
 * prompt, any method whose capability the manifest did not declare.
 *
 * Adding one later (voice, cards in messages, cross-app messages) is a row
 * here, its methods, a server handler in lib/mini-apps/handlers.ts and its
 * prompt line (`label`, a key of app/(app)/m/mini-app.content.ts). Client-safe: no I/O.
 */
export const CAPABILITIES = {
  /** lianki.storage.get/set/list: this app's own small key-value store. */
  storage: { methods: ["storage.get", "storage.set", "storage.list"], label: "capStorage" },
  /** lianki.prefs.get: read the allowlisted account preferences (miniApps.prefKeys). */
  "prefs:read": { methods: ["prefs.get"], label: "capPrefsRead" },
  /** lianki.prefs.set: change those preferences (each value checked by its schema). */
  "prefs:write": { methods: ["prefs.set"], label: "capPrefsWrite" },
  /** lianki.chat.read: the last lines of the user's own chat thread. */
  "chat:read": { methods: ["chat.read"], label: "capChatRead" },
  /** lianki.chat.say: post a line in the user's own thread, marked with the app's name. */
  "chat:write": { methods: ["chat.say"], label: "capChatWrite" },
  /** lianki.ui.card: post an ask card in the chat; resolves with the user's tap. */
  "chat:ask": { methods: ["ui.card"], label: "capChatAsk" },
} as const satisfies Record<string, { methods: readonly string[]; label: string }>;

export type CapabilityId = keyof typeof CAPABILITIES;
export type MethodId = (typeof CAPABILITIES)[CapabilityId]["methods"][number];

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

export const isCapability = (v: unknown): v is CapabilityId =>
  typeof v === "string" && Object.hasOwn(CAPABILITIES, v);

const BY_METHOD = new Map<string, CapabilityId>(
  CAPABILITY_IDS.flatMap((id) => CAPABILITIES[id].methods.map((m) => [m, id] as const)),
);

/** The capability a method needs, or null for an unknown method. */
export function capabilityOf(method: unknown): CapabilityId | null {
  return typeof method === "string" ? (BY_METHOD.get(method) ?? null) : null;
}

export const isMethod = (v: unknown): v is MethodId => capabilityOf(v) !== null;
