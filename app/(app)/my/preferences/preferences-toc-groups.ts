export const PREFERENCE_GROUP_IDS = [
  "appearance",
  "learning",
  "tools",
  "notifications",
  "access",
  "activity",
] as const;

export type PreferenceGroupId = (typeof PREFERENCE_GROUP_IDS)[number];
export type PreferenceGroupLabels = Record<PreferenceGroupId, string>;
export type TocSection = { id: string; title: string };
export type GroupedTocSection = TocSection & { group: PreferenceGroupId };
export type TocGroup = { id: PreferenceGroupId; title: string; sections: GroupedTocSection[] };

/** Setting ownership is data, shared by the navigation and its hierarchy-size checks. */
export const PREFERENCE_SECTIONS = [
  { id: "language", group: "appearance" },
  { id: "preferred-langs", group: "appearance" },
  { id: "paper", group: "appearance" },
  { id: "text-size", group: "appearance" },
  { id: "notifications", group: "notifications" },
  { id: "byok", group: "tools" },
  { id: "title-rules", group: "appearance" },
  { id: "mail", group: "notifications" },
  { id: "auto-update", group: "notifications" },
  { id: "external-links", group: "access" },
  { id: "reader", group: "learning" },
  { id: "dont-ask", group: "access" },
  { id: "review-order", group: "learning" },
  { id: "tokens", group: "access" },
  { id: "licards-group", group: "tools" },
  { id: "watch-time", group: "activity" },
  { id: "mobile-filters", group: "learning" },
  { id: "mini-apps", group: "tools" },
  { id: "vibe", group: "activity" },
] as const satisfies readonly { id: string; group: PreferenceGroupId }[];
export type PreferenceSectionId = (typeof PREFERENCE_SECTIONS)[number]["id"];

/** Undefined labels are the caller's explicit feature gate; empty labels stay visible. */
export function createPreferenceSections(
  titles: Partial<Record<PreferenceSectionId, string>>,
): GroupedTocSection[] {
  return PREFERENCE_SECTIONS.flatMap(({ id, group }) => {
    const title = titles[id];
    return title === undefined ? [] : [{ id, group, title }];
  });
}

/** The category order stays stable; hidden features never leave empty categories. */
export function groupPreferenceSections(
  sections: GroupedTocSection[],
  labels: PreferenceGroupLabels,
): TocGroup[] {
  return PREFERENCE_GROUP_IDS.map((id) => ({
    id,
    title: labels[id],
    sections: sections.filter((section) => section.group === id),
  })).filter((group) => group.sections.length > 0);
}
