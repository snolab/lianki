/** Shared default/schema bounds for the config registry and the small push Worker. */
export const HUB_RPC_LIMITS = {
  "chat.hubRpcTimeoutMs": { default: 20_000, min: 500, max: 60_000 },
  "chat.polishRpcTimeoutMs": { default: 20_000, min: 500, max: 120_000 },
  "chat.partnerRpcTimeoutMs": { default: 60_000, min: 500, max: 180_000 },
  "chat.partnerModelTimeoutMs": { default: 60_000, min: 500, max: 180_000 },
} as const;
