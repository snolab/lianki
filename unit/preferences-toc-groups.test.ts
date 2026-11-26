import { describe, expect, it } from "bun:test";
import {
  PREFERENCE_GROUP_IDS,
  PREFERENCE_SECTIONS,
  createPreferenceSections,
  groupPreferenceSections,
  type GroupedTocSection,
  type PreferenceGroupLabels,
} from "@/app/(app)/my/preferences/preferences-toc-groups";
const labels: PreferenceGroupLabels = {
  appearance: "Appearance",
  learning: "Learning",
  tools: "Tools",
  notifications: "Notifications",
  access: "Access",
  activity: "Activity",
};
describe("preferences category hierarchy", () => {
  it("has at most seven unique primary categories", () => {
    expect(PREFERENCE_GROUP_IDS.length).toBeLessThanOrEqual(7);
    expect(new Set(PREFERENCE_GROUP_IDS).size).toBe(PREFERENCE_GROUP_IDS.length);
  });
  it("keeps every enabled setting as a child without mutating the source order", () => {
    const sections: GroupedTocSection[] = [
      { id: "tokens", title: "Tokens", group: "access" },
      { id: "paper", title: "Paper", group: "appearance" },
      { id: "reader", title: "Reader", group: "learning" },
      { id: "mini-apps", title: "Mini apps", group: "tools" },
      { id: "mail", title: "Mail", group: "notifications" },
      { id: "watch-time", title: "Watch time", group: "activity" },
      { id: "language", title: "Language", group: "appearance" },
    ];
    const before = JSON.stringify(sections);
    const groups = groupPreferenceSections(sections, labels);
    expect(groups.map((g) => g.id)).toEqual([...PREFERENCE_GROUP_IDS]);
    expect(groups.flatMap((g) => g.sections.map((s) => s.id)).sort()).toEqual(
      sections.map((s) => s.id).sort(),
    );
    expect(groups.every((g) => g.sections.length <= 7)).toBe(true);
    expect(groups[0]?.sections.map((s) => s.id)).toEqual(["paper", "language"]);
    expect(groups[0]?.title).toBe("Appearance");
    expect(JSON.stringify(sections)).toBe(before);
  });
  it("omits empty categories, including when optional features are absent", () => {
    expect(
      groupPreferenceSections([{ id: "paper", title: "Paper", group: "appearance" }], labels).map(
        (g) => g.id,
      ),
    ).toEqual(["appearance"]);
    expect(groupPreferenceSections([], labels)).toEqual([]);
  });
});

it("keeps the real preference inventory within seven children per category", () => {
  const titles = Object.fromEntries(PREFERENCE_SECTIONS.map(({ id }) => [id, id]));
  const all = createPreferenceSections(titles);
  const grouped = groupPreferenceSections(all, labels);
  expect(all.length).toBe(PREFERENCE_SECTIONS.length);
  expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  expect(grouped.length).toBeLessThanOrEqual(7);
  expect(grouped.every((g) => g.sections.length <= 7)).toBe(true);
  expect(grouped.flatMap((g) => g.sections).length).toBe(all.length);
  expect(createPreferenceSections({ paper: "Paper", "mini-apps": undefined })).toEqual([
    { id: "paper", group: "appearance", title: "Paper" },
  ]);
  expect(createPreferenceSections({ paper: "" })[0]?.title).toBe("");
});
