/** Developer eval pairing duration choices. Translated together with these contexts.
 * temporary: radio label retaining the existing finite approval and renewal rules.
 * remember: explicit opt-in radio label; never selected by default.
 * scope: explanation below remember: this account on the approving device only,
 * logout pauses execution, same-account login restores it, End revokes permanently.
 */
import { chatLocale, type ChatLocale } from "./chat-ui-locales";
export const EVAL_TRUST_CONTEXT = {
  temporary: "Developer remote-code pairing duration radio: retain the existing finite approval; no saved trust.",
  remember: "Developer remote-code pairing duration radio: explicitly save this controller until the user revokes it; off by default.",
  scope: "Developer remote-code pairing note: saved trust covers only this account on this device; logout pauses access, login here restores it, End removes trust.",
};
export const EVAL_TRUST_STRINGS: Record<ChatLocale, {temporary: string; remember: string; scope: string}> = {
"en": {"temporary": "This approval only", "remember": "Remember until revoked", "scope": "All pages of this account on this device. Signing out pauses access; signing in here restores it. End removes the saved trust."},
"zh": {"temporary": "仅本次授权", "remember": "记住，直到撤销", "scope": "仅限此账号在此设备的所有页面。登出会暂停访问，在此重新登录后恢复。结束授权会删除此信任。"},
"ja": {"temporary": "今回の許可のみ", "remember": "取り消すまで記憶する", "scope": "この端末のこのアカウントの全ページが対象です。ログアウトで停止し、ここで再ログインすると再開します。終了で信頼を削除します。"},
"hi": {"temporary": "केवल यह अनुमति", "remember": "रद्द करने तक याद रखें", "scope": "इस डिवाइस पर इस खाते के सभी पेज। साइन आउट से पहुँच रुकती है; यहाँ फिर साइन इन करने पर बहाल होती है। समाप्त करने से विश्वास हटता है।"},
"es": {"temporary": "Solo esta autorización", "remember": "Recordar hasta revocar", "scope": "Todas las páginas de esta cuenta en este dispositivo. Cerrar sesión pausa el acceso; volver a iniciarla aquí lo restaura. Finalizar elimina la confianza guardada."},
"fr": {"temporary": "Cette autorisation uniquement", "remember": "Mémoriser jusqu’à révocation", "scope": "Toutes les pages de ce compte sur cet appareil. La déconnexion suspend l’accès ; une reconnexion ici le rétablit. Terminer supprime la confiance enregistrée."},
"ar": {"temporary": "هذا الإذن فقط", "remember": "تذكّر حتى الإلغاء", "scope": "كل صفحات هذا الحساب على هذا الجهاز. تسجيل الخروج يوقف الوصول؛ وتسجيل الدخول هنا يعيده. الإنهاء يحذف الثقة المحفوظة."},
"bn": {"temporary": "শুধু এই অনুমতি", "remember": "বাতিল না করা পর্যন্ত মনে রাখুন", "scope": "এই ডিভাইসে এই অ্যাকাউন্টের সব পৃষ্ঠা। সাইন আউট করলে অ্যাক্সেস থামে; এখানে আবার সাইন ইন করলে ফেরে। শেষ করলে সংরক্ষিত বিশ্বাস মুছে যায়।"},
"pt": {"temporary": "Somente esta autorização", "remember": "Lembrar até revogar", "scope": "Todas as páginas desta conta neste dispositivo. Sair pausa o acesso; entrar novamente aqui o restaura. Encerrar remove a confiança salva."},
"ru": {"temporary": "Только это разрешение", "remember": "Запомнить до отзыва", "scope": "Все страницы этого аккаунта на этом устройстве. Выход приостанавливает доступ; повторный вход здесь восстанавливает его. Завершение удаляет сохранённое доверие."},
"ur": {"temporary": "صرف یہ اجازت", "remember": "منسوخی تک یاد رکھیں", "scope": "اس آلے پر اس اکاؤنٹ کے تمام صفحات۔ سائن آؤٹ سے رسائی رکتی ہے؛ یہاں دوبارہ سائن ان سے بحال ہوتی ہے۔ ختم کرنے سے محفوظ اعتماد حذف ہوتا ہے۔"},
"id": {"temporary": "Hanya izin ini", "remember": "Ingat hingga dicabut", "scope": "Semua halaman akun ini di perangkat ini. Keluar menghentikan akses; masuk lagi di sini memulihkannya. Akhiri menghapus kepercayaan tersimpan."},
"de": {"temporary": "Nur diese Freigabe", "remember": "Bis zum Widerruf merken", "scope": "Alle Seiten dieses Kontos auf diesem Gerät. Abmelden pausiert den Zugriff; erneutes Anmelden hier stellt ihn wieder her. Beenden löscht das gespeicherte Vertrauen."},
"sw": {"temporary": "Ruhusa hii tu", "remember": "Kumbuka hadi ibatilishwe", "scope": "Kurasa zote za akaunti hii kwenye kifaa hiki. Kuondoka husitisha ufikiaji; kuingia tena hapa huurejesha. Kumaliza huondoa uaminifu uliohifadhiwa."},
"mr": {"temporary": "फक्त ही परवानगी", "remember": "रद्द करेपर्यंत लक्षात ठेवा", "scope": "या उपकरणावर या खात्याची सर्व पाने. साइन आउट केल्यावर प्रवेश थांबतो; येथे पुन्हा साइन इन केल्यावर सुरू होतो. समाप्त केल्यावर जतन केलेला विश्वास काढला जातो."},
"ko": {"temporary": "이번 승인만", "remember": "철회할 때까지 기억", "scope": "이 기기의 이 계정에 속한 모든 페이지입니다. 로그아웃하면 접근이 중지되고 여기서 다시 로그인하면 재개됩니다. 종료하면 저장된 신뢰가 삭제됩니다."},
};
export const evalTrustStrings = () => EVAL_TRUST_STRINGS[chatLocale()];
