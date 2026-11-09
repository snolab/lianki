import { LevelBadge } from "@/app/components/level-badge";
import { LEVELS, type Level, type LevelId } from "@/lib/levels";

export type LevelNames = Record<LevelId, string>;

/**
 * Every level badge, unlocked and locked, at 20px (nav chip) and 96px
 * (profile), on paper and on ink side by side, named in zh and en. Self-
 * contained styles (oklch, mirroring app/globals.css --brand / --background
 * per scheme) so each panel shows its theme whatever the page's scheme is,
 * and so the same markup can be rendered standalone for screenshots.
 */
const THEMES = {
  light: {
    label: "Light · 紙",
    bg: "oklch(0.945 0.02 82)",
    fg: "oklch(0.22 0.015 65)",
    seal: "oklch(0.53 0.207 22.3)",
    muted: "oklch(0.46 0.02 68)",
    line: "oklch(0.85 0.025 78)",
  },
  dark: {
    label: "Dark · 墨",
    bg: "oklch(0.18 0.01 65)",
    fg: "oklch(0.92 0.02 82)",
    seal: "oklch(0.6 0.205 18.3)",
    muted: "oklch(0.7 0.025 72)",
    line: "oklch(0.37 0.017 65)",
  },
} as const;

function tierNote(l: Level): string {
  if (l.tier === "guest") return "guest · no account";
  if (l.tier === "free") return "free account";
  if (l.unlock === "tier") return "paid · entry";
  return `paid · ${l.studyDays} study days`;
}

function Panel({ theme, zh, en }: { theme: keyof typeof THEMES; zh: LevelNames; en: LevelNames }) {
  const t = THEMES[theme];
  return (
    <section
      data-theme-panel={theme}
      style={
        {
          background: t.bg,
          color: t.fg,
          "--lk-badge-seal": t.seal,
          border: `1px solid ${t.line}`,
          borderRadius: 12,
          padding: 16,
          colorScheme: theme,
        } as React.CSSProperties
      }
    >
      <h2 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: t.muted }}>
        {t.label}
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 230px), 1fr))",
          gap: 12,
        }}
      >
        {LEVELS.map((l) => (
          <figure
            key={l.id}
            style={{
              margin: 0,
              padding: 10,
              border: `1px solid ${t.line}`,
              borderRadius: 10,
              display: "grid",
              gap: 6,
              justifyItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <LevelBadge level={l.id} size={96} label={en[l.id]} />
              <LevelBadge level={l.id} size={96} locked />
            </div>
            <figcaption style={{ textAlign: "center", display: "grid", gap: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 600 }}>
                {zh[l.id]} · {en[l.id]}
              </span>
              <span style={{ fontSize: 12, color: t.muted }}>
                {l.id} · {tierNote(l)}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  fontSize: 13,
                }}
              >
                <Chip name={zh[l.id]} level={l.id} line={t.line} />
                <Chip name={en[l.id]} level={l.id} line={t.line} />
                <Chip name={en[l.id]} level={l.id} line={t.line} locked muted={t.muted} />
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** The 20px nav-chip size, name beside the badge (never in it). */
function Chip({
  name,
  level,
  line,
  locked,
  muted,
}: {
  name: string;
  level: LevelId;
  line: string;
  locked?: boolean;
  muted?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 7px 1px 3px",
        border: `1px solid ${line}`,
        borderRadius: 999,
        whiteSpace: "nowrap",
        color: locked ? muted : undefined,
      }}
    >
      <LevelBadge level={level} size={20} locked={locked} />
      {name}
    </span>
  );
}

export function LevelGallery({ zh, en }: { zh: LevelNames; en: LevelNames }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Learner levels · 修炼等级</h1>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
          Each card: the badge unlocked and locked at 96px; below, 20px nav chips (zh, en, locked).
          lv1 is the guest level (no account), lv2 a free account, lv3 the entry level on paying,
          lv4–lv6 unlock by cumulative study days after paying. Dev only — nothing user-facing uses
          these yet.
        </p>
      </header>
      <Panel theme="light" zh={zh} en={en} />
      <Panel theme="dark" zh={zh} en={en} />
    </div>
  );
}
