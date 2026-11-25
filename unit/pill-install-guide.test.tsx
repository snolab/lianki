import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, act } from "react";
import { renderToString } from "react-dom/server";
import { stubGlobals } from "./support/globals";
import PillInstallGuide, { type PillInstallLabels } from "../app/(app)/chat/sites/PillInstallGuide";
import dictionary from "../app/(app)/chat/sites/pill-install.content";
import { USERSCRIPT_VERSION_ATTRIBUTE } from "../lib/userscript-install";

const labels = Object.fromEntries(
  Object.entries(dictionary.content).map(([k, v]) => [k, v.translation.en]),
) as PillInstallLabels;

test("SSR is neutral; mounted guide offers install/update or a safe external trial as the real marker changes", async () => {
  const html = renderToString(createElement(PillInstallGuide, { latestVersion: "2.10.0", labels }));
  expect(html).toContain('data-install-status="checking"');
  expect(html).not.toContain("href=");
  const win = new Window({ url: "https://lianki.com/chat/sites" });
  let reloads = 0;
  Object.defineProperty(win.location, "reload", { configurable: true, value: () => reloads++ });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: win.navigator,
    MutationObserver: win.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.append(host);
    root = createRoot(host as never);
    await act(() =>
      root!.render(createElement(PillInstallGuide, { latestVersion: "2.10.0", labels })),
    );
    const status = () =>
      host.querySelector("[data-install-status]")?.getAttribute("data-install-status");
    expect(status()).toBe("missing");
    expect(host.querySelector('[data-testid="pill-install-link"]')?.getAttribute("href")).toBe(
      "/lianki.user.js",
    );
    expect(host.textContent).toContain(labels.installHelp);
    expect(reloads).toBe(0);
    await act(() =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === labels.reload)!
        .click(),
    );
    expect(reloads).toBe(1);
    expect(host.querySelector('[data-testid="pill-try-site"]')).toBeNull();
    const marker = async (value: string) =>
      act(async () => {
        win.document.documentElement.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, value);
        await win.happyDOM.whenAsyncComplete();
      });
    await marker("2.9.0");
    expect(status()).toBe("outdated");
    expect(host.querySelector("a")?.textContent).toBe(labels.update);
    expect(host.textContent).toContain("2.9.0");
    expect(host.textContent).toContain("2.10.0");
    await marker("2.10.0");
    expect(status()).toBe("ready");
    const trial = host.querySelector('[data-testid="pill-try-site"]');
    expect(trial?.getAttribute("href")).toBe("https://example.com/");
    expect(trial?.getAttribute("target")).toBe("_blank");
    expect(trial?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(host.textContent).toContain(labels.tryHelp);
    expect(host.querySelector('[data-testid="pill-install-link"]')).toBeNull();
    await marker("not-a-version");
    expect(status()).toBe("outdated");
    expect(host.querySelector('[data-testid="pill-try-site"]')).toBeNull();
  } finally {
    if (root) await act(() => root!.unmount());
    restore();
    await win.happyDOM.close();
  }
});

test("all sixteen locales preserve installation/trial actions and both version placeholders", () => {
  const locales = [
    "en",
    "zh",
    "hi",
    "es",
    "fr",
    "ar",
    "bn",
    "pt",
    "ru",
    "ur",
    "id",
    "de",
    "ja",
    "sw",
    "mr",
    "ko",
  ];
  for (const locale of locales) {
    for (const value of Object.values(dictionary.content))
      expect((value.translation as Record<string, string>)[locale]?.trim()).toBeTruthy();
    const versions = (dictionary.content.versions.translation as Record<string, string>)[locale]!;
    expect(versions).toContain("{installed}");
    expect(versions).toContain("{latest}");
    expect((dictionary.content.trySite.translation as Record<string, string>)[locale]).toContain(
      "example.com",
    );
    expect((dictionary.content.tryHelp.translation as Record<string, string>)[locale]).toContain(
      "example.com",
    );
  }
});
