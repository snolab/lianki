"use client";

import { useEffect, useState } from "react";

type Props = {
  locale: string;
  latestVersion: string;
};

type Status = "loading" | "not-installed" | "outdated" | "up-to-date";

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

const installLabels: Record<string, string> = {
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
};

export default function UserscriptInstallButton({ locale, latestVersion }: Props) {
  const [status, setStatus] = useState<Status>("loading");
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("lk:status");
      if (raw) {
        const { version } = JSON.parse(raw);
        setInstalledVersion(version);
        setStatus(semverGt(latestVersion, version) ? "outdated" : "up-to-date");
      } else {
        setStatus("not-installed");
      }
    } catch {
      setStatus("not-installed");
    }
  }, [latestVersion]);

  if (status === "loading" || status === "up-to-date") return null;

  if (status === "outdated") {
    return (
      <a
        href="/lianki.user.js"
        className="bg-yellow-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-yellow-600 flex items-center gap-2"
        title={`Installed: v${installedVersion} → Latest: v${latestVersion}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        Update Userscript (v{latestVersion})
      </a>
    );
  }

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
      {installLabels[locale] ?? installLabels.en}
    </a>
  );
}
