import { chatExtra, chatLocale } from "./chat-ui-locales";

/** Native confirmation is optional; refusal/hidden pages keep ordinary STT active. */
export function confirmBrowserModelDownload({ estimatedMb }: { estimatedMb: number }): boolean {
  if (globalThis.document?.visibilityState !== "visible") return false;
  return window.confirm(
    chatExtra().modelDownloadConfirm.replace("{mb}", new Intl.NumberFormat(chatLocale()).format(estimatedMb)),
  );
}
