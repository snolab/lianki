import type { ScopeId } from "@/lib/api-tokens";

/**
 * Each permission's label and hint keys in the "api-tokens" dictionary. A plain
 * module, so server pages (the OAuth consent page) can read it as well as the
 * client pickers (TokenPickers.tsx).
 */
export const SCOPE_TEXT: Record<ScopeId, { label: string; hint: string }> = {
  "apps:publish": { label: "scopeAppsPublish", hint: "scopeAppsPublishHint" },
  study: { label: "scopeStudy", hint: "scopeStudyHint" },
  "chat:read": { label: "scopeChatRead", hint: "scopeChatReadHint" },
  "chat:write": { label: "scopeChatWrite", hint: "scopeChatWriteHint" },
  "chat:ask": { label: "scopeChatAsk", hint: "scopeChatAskHint" },
  "chat:play": { label: "scopeChatPlay", hint: "scopeChatPlayHint" },
  "mic:polish": { label: "scopeMicPolish", hint: "scopeMicPolishHint" },
  eval: { label: "scopeEval", hint: "scopeEvalHint" },
  progress: { label: "scopeProgress", hint: "scopeProgressHint" },
  "recordings:read": { label: "scopeRecordingsRead", hint: "scopeRecordingsReadHint" },
  "token:mint-child": { label: "scopeMintChild", hint: "scopeMintChildHint" },
};
