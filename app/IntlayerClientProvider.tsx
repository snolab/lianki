"use client";

import { IntlayerClientProvider as IntlayerClientProviderBase } from "next-intlayer";
import type { ReactNode } from "react";

export function IntlayerClientProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: string;
}) {
  return <IntlayerClientProviderBase locale={locale}>{children}</IntlayerClientProviderBase>;
}
