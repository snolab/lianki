"use client";

import { useEffect, useState } from "react";

export default function UserscriptInstallButton({ locale }: { locale: string }) {
  const [isInstalled, setIsInstalled] = useState(true); // Default to true to avoid flash

  useEffect(() => {
    // Check if userscript is installed by looking for a global marker
    // The userscript should set window.LIANKI_USERSCRIPT_INSTALLED = true
    const checkInstallation = () => {
      const installed = !!(window as any).LIANKI_USERSCRIPT_INSTALLED;
      setIsInstalled(installed);
    };

    // Check immediately
    checkInstallation();

    // Check again after a short delay in case the userscript loads after this component
    const timer = setTimeout(checkInstallation, 1000);

    return () => clearTimeout(timer);
  }, []);

  // Don't show button if userscript is already installed
  if (isInstalled) {
    return null;
  }

  const installText =
    {
      en: "Install Userscript",
      ja: "ユーザースクリプトをインストール",
      zh: "安装用户脚本",
      ko: "유저스크립트 설치",
      es: "Instalar Userscript",
      fr: "Installer le Userscript",
      de: "Userscript installieren",
      ru: "Установить пользовательский скрипт",
      ar: "تثبيت البرنامج النصي",
      hi: "यूज़रस्क्रिप्ट इंस्टॉल करें",
      bn: "ইউজারস্ক্রিপ্ট ইনস্টল করুন",
      pt: "Instalar Userscript",
      id: "Instal Userscript",
      tr: "Userscript'i Yükle",
      ur: "یوزرسکرپٹ انسٹال کریں",
      sw: "Sakinisha Userscript",
      mr: "यूझरस्क्रिप्ट स्थापित करा",
    }[locale] || "Install Userscript";

  return (
    <a
      href="/lianki.user.js"
      className="bg-green-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-green-700 flex items-center gap-2"
      title="Install the Lianki userscript to add flashcards from any webpage"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
          clipRule="evenodd"
        />
      </svg>
      {installText}
    </a>
  );
}
