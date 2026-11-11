/**
 * Traditional Chinese (zh-Hant: Taiwan, Hong Kong, Macau) for the mail
 * templates. intlayer's locales have one Chinese (`zh`, Simplified), so the
 * Traditional variants live here, keyed like the dictionaries they translate;
 * each key's context line is in that dictionary's file. A missing key is a
 * type error.
 */
import type emailChange from "./email-change-mail.content";
import type loginNotice from "./login-notice-mail.content";
import type mailLayout from "./mail-layout.content";
import type signIn from "./sign-in-mail.content";
import type invite from "@/lib/referrals/invite-mail.content";

type Strings<D extends { content: object }> = Record<keyof D["content"], string>;

export const ZH_HANT_SIGN_IN: Strings<typeof signIn> = {
  codeSubject: "{code} 是你的{brand}登入驗證碼",
  codeIntro: "你的{brandLong}登入驗證碼：",
  linkSubject: "登入{brand}",
  linkIntro: "開啟下方連結登入{brandLong}：",
  linkButton: "登入",
  validity: "15 分鐘內有效。",
  ignore: "如果不是你本人操作，請忽略這封郵件。",
};

export const ZH_HANT_LOGIN_NOTICE: Strings<typeof loginNotice> = {
  subject: "你的{brand}帳號有新的登入",
  intro: "你的{brandLong}帳號剛剛在一個以前未曾使用過的瀏覽器上登入。",
  time: "時間",
  location: "大致位置",
  device: "瀏覽器",
  unknown: "不明",
  ok: "如果是你本人登入，無需處理。",
  notYou:
    "如果不是你本人，請登入後在個人資料頁面刪除不認得的密碼金鑰，並透過 {contactUrl} 聯絡我們。",
};

export const ZH_HANT_EMAIL_CHANGE: Strings<typeof emailChange> = {
  confirmSubject: "確認你的{brand}新電子郵件地址",
  confirmIntro: "有人申請將這個地址用於{brandLong}帳號。請開啟下方連結確認：",
  confirmButton: "確認這個地址",
  confirmValid: "1 小時內有效。確認之前不會有任何變更。",
  ignore: "如果不是你本人操作，請忽略這封郵件。",
  takenSubject: "一項{brand}電子郵件地址變更遭到拒絕",
  takenBody:
    "有人申請將{brand}帳號改用這個地址，但這個地址無法使用：它已屬於某個帳號。沒有任何變更。你可以照常用這個地址登入。",
  requestedSubject: "有人申請變更你的{brand}電子郵件地址",
  requestedBody:
    "已登入你{brand}帳號的人申請將電子郵件地址改為 {address}。必須在該地址確認後才會變更。",
  changedSubject: "你的{brand}電子郵件地址已變更",
  changedBody: "你的{brand}帳號電子郵件地址現在是 {address}。這個地址已無法再登入該帳號。",
  notYou: "如果不是你本人操作，請立即聯絡我們：{contactUrl}",
};

export const ZH_HANT_INVITE: Strings<typeof invite> = {
  subject: "{inviter} 邀請你加入{brandLong}",
  invitedBy: "邀請人：{inviter}",
  intro:
    "{inviter} 正在用{brandLong}學習——一個用間隔重複來學語言、記住任何想記住的事物的應用程式，想邀請你一起來。",
  offer:
    "透過這個邀請註冊，你的免費試用多 {extraDays} 天：總共 {totalDays} 天，而不是 {baseDays} 天。",
  cta: "接受邀請",
  linkLine: "或開啟這個連結：",
  why: "你會收到這封郵件，是因為 {inviter} 在{brand}上填寫了你的電子郵件地址來邀請你。這是一次性的邀請，你並未被加入任何郵寄名單。",
  sentTo: "這封郵件寄送至 {address}，因為 {inviter} 邀請了你。",
  unsubscribe: "取消訂閱：不再接收任何{brand}邀請郵件",
  report: "檢舉濫用",
  sender: "由{brand}（{site}）代 {inviter} 寄出。",
  contact: "有問題嗎？聯絡我們：{contactUrl}",
  aFriend: "一位朋友",
};

export const ZH_HANT_MAIL_LAYOUT: Strings<typeof mailLayout> = {
  securityLabel: "安全提醒",
  footerRequired: "這封郵件與你的{brand}帳號有關，因此一定會寄出。",
  footerSecurity: "你的帳號開啟了這類安全提醒。你可以在{link}中關閉，但我們建議保持開啟。",
  preferencesLink: "偏好設定",
  footerOptional: "不想再收到這類郵件？",
  unsubscribe: "取消訂閱",
};
