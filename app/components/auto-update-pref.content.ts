import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";

/** Settings → Updates: the switch for a new version applying itself (AutoUpdateSettings.tsx). */
const dictionary = {
  key: "auto-update-pref",
  content: {
    heading: t({
      en: "Updates",
      zh: "更新",
      hi: "अपडेट",
      es: "Actualizaciones",
      fr: "Mises à jour",
      ar: "التحديثات",
      bn: "আপডেট",
      pt: "Atualizações",
      ru: "Обновления",
      ur: "اپڈیٹس",
      id: "Pembaruan",
      de: "Updates",
      ja: "アップデート",
      sw: "Masasisho",
      mr: "अपडेट",
      ko: "업데이트",
    }),
    label: t({
      en: "Update by itself when idle",
      zh: "空闲时自动更新",
      hi: "खाली होने पर अपने-आप अपडेट करें",
      es: "Actualizar sola en reposo",
      fr: "Mettre à jour toute seule au repos",
      ar: "التحديث تلقائيًا عند الخمول",
      bn: "অবসরে নিজে থেকে আপডেট",
      pt: "Atualizar sozinho quando ocioso",
      ru: "Обновляться в простое",
      ur: "فارغ ہونے پر خودکار اپڈیٹ",
      id: "Perbarui sendiri saat senggang",
      de: "Im Leerlauf selbst aktualisieren",
      ja: "操作がないときに自動更新",
      sw: "Jisasishe ukiwa huna shughuli",
      mr: "मोकळ्या वेळी आपोआप अपडेट",
      ko: "쉬는 동안 자동 업데이트",
    }),
    help: t({
      en: "When a new version of Lianki is out, the page reloads by itself once nothing would be lost: no text being typed, no recording, nothing playing. It comes back to the same place. Off: tap the “New version” button yourself.",
      zh: "Lianki 有新版本时，页面在不会丢东西的时候自己刷新：没在打字、没在录音、没在播放。刷新后停在原来的位置。关闭后需要自己点「有新版本」按钮。",
      hi: "Lianki का नया संस्करण आने पर, जब कुछ खोने वाला न हो — न टाइप हो रहा हो, न रिकॉर्डिंग, न कुछ चल रहा हो — पेज अपने-आप रीलोड होता है और उसी जगह लौटता है। बंद होने पर “नया संस्करण” बटन खुद दबाएँ।",
      es: "Cuando sale una nueva versión de Lianki, la página se recarga sola cuando no se pierde nada: sin texto a medio escribir, sin grabar, sin nada sonando. Vuelve al mismo sitio. Desactivado: toca tú el botón «Nueva versión».",
      fr: "Quand une nouvelle version de Lianki sort, la page se recharge toute seule dès que rien ne serait perdu : pas de texte en cours, pas d’enregistrement, rien en lecture. Elle revient au même endroit. Désactivé : touchez vous-même le bouton « Nouvelle version ».",
      ar: "عند صدور إصدار جديد من Lianki، تُعاد تحميل الصفحة تلقائيًا حين لا يضيع شيء: لا نص قيد الكتابة ولا تسجيل ولا تشغيل. وتعود إلى المكان نفسه. عند الإيقاف: اضغط زر «إصدار جديد» بنفسك.",
      bn: "Lianki-র নতুন সংস্করণ এলে, কিছু হারানোর না থাকলে — লেখা চলছে না, রেকর্ডিং নেই, কিছু বাজছে না — পেজ নিজে থেকে রিলোড হয় এবং একই জায়গায় ফেরে। বন্ধ থাকলে “নতুন সংস্করণ” বোতাম নিজে চাপুন।",
      pt: "Quando sai uma nova versão do Lianki, a página recarrega sozinha quando nada se perde: nenhum texto sendo digitado, nenhuma gravação, nada tocando. Volta ao mesmo lugar. Desligado: toque você no botão “Nova versão”.",
      ru: "Когда выходит новая версия Lianki, страница перезагружается сама, если ничего не потеряется: текст не набирается, запись не идёт, ничего не играет. Она вернётся на то же место. Выключено: нажимайте кнопку «Новая версия» сами.",
      ur: "Lianki کا نیا ورژن آنے پر، جب کچھ ضائع نہ ہو — نہ لکھائی جاری ہو، نہ ریکارڈنگ، نہ کچھ چل رہا ہو — صفحہ خود ری لوڈ ہو کر اسی جگہ واپس آتا ہے۔ بند ہو تو “نیا ورژن” بٹن خود دبائیں۔",
      id: "Saat Lianki punya versi baru, halaman memuat ulang sendiri ketika tidak ada yang hilang: tidak sedang mengetik, merekam, atau memutar apa pun. Halaman kembali ke tempat yang sama. Mati: ketuk sendiri tombol “Versi baru”.",
      de: "Gibt es eine neue Lianki-Version, lädt die Seite sich selbst neu, sobald nichts verloren geht: kein Text in Arbeit, keine Aufnahme, nichts läuft. Sie kehrt an dieselbe Stelle zurück. Aus: Tippen Sie selbst auf „Neue Version“.",
      ja: "Lianki の新しいバージョンが出たら、失うものがないとき（入力中・録音中・再生中でないとき）にページが自動で再読み込みされ、同じ位置に戻ります。オフにすると「新しいバージョン」ボタンを自分で押します。",
      sw: "Toleo jipya la Lianki likitoka, ukurasa hujipakia upya wenyewe wakati hakuna kitakachopotea: hakuna maandishi yanayoandikwa, kurekodi, wala kinachocheza. Unarudi mahali pale pale. Kimezimwa: gusa kitufe cha “Toleo jipya” mwenyewe.",
      mr: "Lianki ची नवीन आवृत्ती आल्यावर, काहीही गमावले जाणार नसेल तेव्हा — टाइपिंग, रेकॉर्डिंग किंवा काही वाजत नसेल — पान आपोआप रीलोड होते आणि त्याच जागी परत येते. बंद असल्यास “नवीन आवृत्ती” बटण स्वतः दाबा.",
      ko: "Lianki 새 버전이 나오면 잃을 것이 없을 때(입력 중, 녹음 중, 재생 중이 아닐 때) 페이지가 스스로 새로고침되고 같은 위치로 돌아갑니다. 끄면 “새 버전” 버튼을 직접 누르세요.",
    }),
  },
} satisfies DeclarationContent;

export default {
  ...dictionary,
  title: "Settings: automatic updates",
  description: describeKeys(
    "A section of the settings page (/my/preferences) with one on/off switch: whether the app reloads itself to a newly deployed version when the page holds nothing unsaved.",
    {
      heading:
        "Section heading on the settings page over the automatic-update switch. A short noun: software updates of the app itself (new versions), not data sync.",
      label:
        "Label beside the on/off switch: the app installs (reloads to) a new version by itself at a quiet moment. A short setting name, not a sentence; 'idle' = when the user is not doing anything.",
      help: "Small grey paragraph under the switch: when it reloads by itself (nothing typed, recorded or playing would be lost), that it returns to the same place on the page, and that with it off the user taps the 'New version' pill (the floating button at the bottom right) themselves. Keep Lianki as is; quote the pill's 'New version' the way that pill is translated.",
    },
  ),
} satisfies DeclarationContent;
