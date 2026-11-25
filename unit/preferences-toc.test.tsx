import { afterAll, describe, expect, it } from "bun:test";
import React, { act } from "react";
import { Window } from "happy-dom";
import {
  WIDE_PREFS_QUERY,
  jumpToSection,
  PreferencesToc,
  CollapsibleSection,
  useActiveSection,
  useIsWideScreen,
  observeSectionVisibility,
  observeMediaQuery,
  type TocSection,
} from "@/app/(app)/my/preferences/PreferencesToc";
import { stubGlobals } from "./support/globals";
import type {
  GroupedTocSection,
  PreferenceGroupLabels,
} from "@/app/(app)/my/preferences/preferences-toc-groups";

const groupLabels: PreferenceGroupLabels = {
  appearance: "Language and appearance",
  learning: "Learning and reading",
  tools: "AI and extensions",
  notifications: "Notifications and updates",
  access: "Access and permissions",
  activity: "Activity and recordings",
};

const win = new Window();
let reducedMotionMatches = false;

(win as any).matchMedia = (query: string) => ({
  matches: query.includes("prefers-reduced-motion")
    ? reducedMotionMatches
    : query === WIDE_PREFS_QUERY,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

const restore = stubGlobals({
  window: win,
  document: win.document,
  matchMedia: (win as any).matchMedia,
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => restore());

const { createRoot } = await import("react-dom/client");

function HookProbe({
  sections,
  onResult,
}: {
  sections: TocSection[];
  onResult: (res: any) => void;
}) {
  const active = useActiveSection(sections);
  const isWide = useIsWideScreen();
  onResult({ active, isWide });
  return <div data-active={active} data-wide={String(isWide)} />;
}

describe("PreferencesToc and collapsible behavior", () => {
  it("defines the 35em breakpoint query for wide screen vs mobile fold", () => {
    expect(WIDE_PREFS_QUERY).toBe("(min-width: 35em)");
  });

  it("structures TOC sections cleanly", () => {
    const sections: TocSection[] = [
      { id: "language", title: "Language" },
      { id: "paper", title: "Paper" },
      { id: "tokens", title: "API Tokens" },
    ];
    expect(sections.map((s) => s.id)).toEqual(["language", "paper", "tokens"]);
    expect(sections[0]?.title).toBe("Language");
    expect(sections[1]?.title).toBe("Paper");
    expect(sections[2]?.title).toBe("API Tokens");
  });

  it("handles jumpToSection safely both with normal and reduced-motion", () => {
    expect(() => jumpToSection("nonexistent-section-id")).not.toThrow();

    let behaviorUsed = "";
    const fakeEl = win.document.createElement("div");
    fakeEl.id = "test-sec";
    (fakeEl as any).scrollIntoView = ({ behavior }: { behavior: string }) => {
      behaviorUsed = behavior;
    };
    win.document.body.appendChild(fakeEl);

    // 1. Normal (smooth)
    reducedMotionMatches = false;
    jumpToSection("test-sec");
    expect(behaviorUsed).toBe("smooth");

    // 2. Reduced motion (auto)
    reducedMotionMatches = true;
    jumpToSection("test-sec");
    expect(behaviorUsed).toBe("auto");
    reducedMotionMatches = false;

    fakeEl.remove();
  });

  it("renders PreferencesToc cleanly into DOM with click handler", () => {
    const sections: GroupedTocSection[] = [
      { id: "language", group: "appearance", title: "Language" },
      { id: "paper", group: "appearance", title: "Paper" },
    ];
    let selected = "";
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);

    act(() => {
      root.render(
        <PreferencesToc
          groupLabels={groupLabels}
          label="Table of Contents"
          sections={sections}
          activeId="language"
          onSelect={(id) => {
            selected = id;
          }}
        />,
      );
    });

    expect(host.innerHTML).toContain("Table of Contents");
    expect(host.innerHTML).toContain("Language");
    expect(host.innerHTML).toContain("Paper");

    const chip = host.querySelector('[data-testid="toc-chip-paper"]') as HTMLElement | null;
    chip?.click();
    expect(selected).toBe("paper");

    const link = host.querySelector('[data-testid="toc-link-language"]') as HTMLElement | null;
    link?.click();
    expect(selected).toBe("language");

    act(() => root.unmount());
    host.remove();
  });

  it("renders CollapsibleSection open vs closed on mobile and toggles", () => {
    let toggled = false;
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);

    // Open section
    act(() => {
      root.render(
        <CollapsibleSection
          id="test-open"
          title="Open Section"
          isOpen={true}
          isWide={false}
          onToggle={() => {
            toggled = true;
          }}
        >
          <div>Open Body</div>
        </CollapsibleSection>,
      );
    });
    expect(host.innerHTML).toContain("Open Section");
    expect(host.innerHTML).toContain("Open Body");
    expect(host.innerHTML).toContain('data-open="true"');

    const button = host.querySelector("button") as HTMLElement | null;
    button?.click();
    expect(toggled).toBe(true);

    // Collapsed section on mobile (<35em)
    act(() => {
      root.render(
        <CollapsibleSection id="test-closed" title="Closed Section" isOpen={false} isWide={false}>
          <div>Hidden Body</div>
        </CollapsibleSection>,
      );
    });
    expect(host.innerHTML).toContain("Closed Section");
    expect(host.innerHTML).toContain('data-open="false"');
    expect(host.innerHTML).toContain("hidden min-[35em]:block");

    // Wide screen (>=35em): always open
    act(() => {
      root.render(
        <CollapsibleSection id="test-wide" title="Wide Section" isOpen={false} isWide={true}>
          <div>Wide Body</div>
        </CollapsibleSection>,
      );
    });
    expect(host.innerHTML).toContain('data-open="true"');

    act(() => root.unmount());
    host.remove();
  });

  it("mounts useActiveSection and useIsWideScreen hooks in a component", () => {
    let hookResult: any = null;
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);

    const sections: TocSection[] = [
      { id: "s1", title: "Section 1" },
      { id: "s2", title: "Section 2" },
    ];

    act(() => {
      root.render(
        <HookProbe
          sections={sections}
          onResult={(res) => {
            hookResult = res;
          }}
        />,
      );
    });

    expect(hookResult).not.toBeNull();
    expect(hookResult.active).toBe("s1");
    expect(hookResult.isWide).toBe(true);

    act(() => root.unmount());
    host.remove();
  });

  it("exercises observeMediaQuery and observeSectionVisibility helpers directly", () => {
    // 1. observeMediaQuery
    let changeCb: any = null;
    const fakeMq = {
      matches: true,
      addEventListener: (_ev: string, cb: any) => {
        changeCb = cb;
      },
      removeEventListener: () => {
        changeCb = null;
      },
    };
    const unbindMq = stubGlobals({
      matchMedia: () => fakeMq,
    });

    let observedMatches = false;
    const cleanupMq = observeMediaQuery("(min-width: 35em)", (m) => {
      observedMatches = m;
    });
    expect(observedMatches).toBe(true);
    if (changeCb) changeCb();
    cleanupMq();
    unbindMq();

    // 2. observeSectionVisibility
    let ioCallback: any = null;
    let observedEls: any[] = [];
    const unbindIo = stubGlobals({
      IntersectionObserver: class {
        constructor(cb: any) {
          ioCallback = cb;
        }
        observe(el: any) {
          observedEls.push(el);
        }
        disconnect() {
          observedEls = [];
        }
      },
      document: {
        getElementById: (id: string) => ({ id }),
      },
    });

    let intersectedId = "";
    const cleanupIo = observeSectionVisibility(
      [
        { id: "sec1", title: "Sec 1" },
        { id: "sec2", title: "Sec 2" },
      ],
      (id) => {
        intersectedId = id;
      },
    );

    expect(observedEls.length).toBe(2);
    if (ioCallback) {
      ioCallback([
        { target: { id: "sec2" }, isIntersecting: true },
        { target: { id: "sec1" }, isIntersecting: false },
      ]);
      expect(intersectedId).toBe("sec2");
    }
    cleanupIo();
    unbindIo();
  });

  it("handles empty or missing environments in helpers", () => {
    const unbind = stubGlobals({
      matchMedia: undefined,
      IntersectionObserver: undefined,
    });
    expect(observeMediaQuery("(min-width: 35em)", () => {})).toBeFunction();
    expect(observeSectionVisibility([], () => {})).toBeFunction();
    unbind();
  });

  it("jumps with the URL hash, and works without onSelect or activeId", () => {
    const calls: string[] = [];
    const restoreHistory = stubGlobals({
      history: { replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) },
    });
    const el = win.document.createElement("div");
    el.id = "mail";
    (el as any).scrollIntoView = () => {};
    win.document.body.appendChild(el);
    jumpToSection("mail");
    expect(calls).toEqual(["#mail"]);

    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const sections: GroupedTocSection[] = [{ id: "mail", group: "notifications", title: "Mail" }];
    act(() =>
      root.render(<PreferencesToc groupLabels={groupLabels} label="TOC" sections={sections} />),
    );
    (host.querySelector('[data-testid="toc-chip-mail"]') as HTMLElement).click();
    (host.querySelector('[data-testid="toc-link-mail"]') as HTMLElement).click();
    expect(calls).toEqual(["#mail", "#mail", "#mail"]);
    act(() => root.render(<PreferencesToc groupLabels={groupLabels} label="TOC" sections={[]} />));
    act(() => root.unmount());
    host.remove();
    el.remove();
    restoreHistory();
  });
});

describe("grouped preferences contents", () => {
  const sections: GroupedTocSection[] = [
    { id: "language", title: "Language", group: "appearance" },
    { id: "paper", title: "Paper", group: "appearance" },
    { id: "tokens", title: "API tokens", group: "access" },
  ];
  it("shows only nonempty primary categories and reveals their settings", () => {
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    let selected = "";
    act(() =>
      root.render(
        <PreferencesToc
          label="Contents"
          sections={sections}
          groupLabels={groupLabels}
          onSelect={(id) => {
            selected = id;
          }}
        />,
      ),
    );
    expect(host.querySelectorAll('[data-testid^="toc-group-"]').length).toBe(2);
    expect(host.querySelectorAll('[data-testid^="toc-category-"]').length).toBe(2);
    expect(host.querySelector('[data-testid="toc-group-learning"]')).toBeNull();
    const access = host.querySelector('[data-testid="toc-group-access"]') as HTMLElement;
    act(() => access.click());
    expect(access.getAttribute("aria-expanded")).toBe("true");
    expect((host.querySelector("#preferences-toc-access") as HTMLElement).hidden).toBe(false);
    act(() => (host.querySelector('[data-testid="toc-link-tokens"]') as HTMLElement).click());
    expect(selected).toBe("tokens");
    act(() => access.click());
    expect(access.getAttribute("aria-expanded")).toBe("false");
    expect((host.querySelector("#preferences-toc-access") as HTMLElement).hidden).toBe(true);
    act(() => (host.querySelector('[data-testid="toc-category-access"]') as HTMLElement).click());
    expect(selected).toBe("tokens");
    expect(
      host.querySelector('[data-testid="toc-category-access"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(host.querySelector('[data-testid="toc-chip-tokens"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="toc-chip-paper"]')).toBeNull();
    act(() =>
      (host.querySelector('[data-testid="toc-category-appearance"]') as HTMLElement).click(),
    );
    expect(selected).toBe("language");
    act(() => (host.querySelector('[data-testid="toc-chip-paper"]') as HTMLElement).click());
    expect(selected).toBe("paper");
    act(() => root.unmount());
    host.remove();
  });

  it("follows the active reading section after a category was manually folded", () => {
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    act(() =>
      root.render(
        <PreferencesToc
          label="Contents"
          sections={sections}
          groupLabels={groupLabels}
          activeId="language"
        />,
      ),
    );
    act(() => (host.querySelector('[data-testid="toc-group-appearance"]') as HTMLElement).click());
    expect(
      host.querySelector('[data-testid="toc-group-appearance"]')?.getAttribute("aria-expanded"),
    ).toBe("false");
    act(() =>
      root.render(
        <PreferencesToc
          label="Contents"
          sections={sections}
          groupLabels={groupLabels}
          activeId="tokens"
        />,
      ),
    );
    expect(
      host.querySelector('[data-testid="toc-group-access"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(host.querySelector('[data-testid="toc-chip-tokens"]')).not.toBeNull();
    act(() =>
      root.render(
        <PreferencesToc
          label="Contents"
          sections={sections}
          groupLabels={groupLabels}
          activeId="unknown"
        />,
      ),
    );
    expect(
      host.querySelector('[data-testid="toc-group-appearance"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    act(() =>
      root.render(<PreferencesToc label="Contents" sections={[]} groupLabels={groupLabels} />),
    );
    expect(host.querySelector('[data-testid^="toc-group-"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
