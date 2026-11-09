"use client";

import { useIntlayer } from "next-intlayer";

/** The heading and explanation of /dev/permissions, in the viewer's locale. */
export default function PermissionsHeader({ seconds }: { seconds: number }) {
  const c = useIntlayer("dev-permissions");
  return (
    <header className="space-y-2">
      <h1 className="font-brush text-4xl">{c.title}</h1>
      <p className="text-sm opacity-80">{c.intro.value.replace("{seconds}", String(seconds))}</p>
    </header>
  );
}
