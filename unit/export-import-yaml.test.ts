import { describe, test, expect } from "vitest";
import { stringify, parse } from "yaml";
import {
  serializeNoteForExport,
  serializeGoalForExport,
  restoreNoteFromExport,
  restoreGoalFromExport,
  EXPORT_VERSION,
} from "@/lib/yaml-export";

// ── serializeNoteForExport ────────────────────────────────────────────────────

describe("serializeNoteForExport", () => {
  test("strips _id field", () => {
    const note = {
      _id: "some-mongo-id",
      url: "https://example.com",
      card: { due: new Date("2026-01-01T00:00:00Z") },
    };
    const result = serializeNoteForExport(note as any);
    expect(result).not.toHaveProperty("_id");
    expect(result.url).toBe("https://example.com");
  });

  test("converts Date fields to ISO strings", () => {
    const due = new Date("2026-05-01T00:00:00Z");
    const review = new Date("2026-04-20T12:00:00Z");
    const note = {
      url: "https://example.com",
      card: { due, last_review: review, reps: 3 },
      log: [{ due, review, rating: 3 }],
    };
    const result = serializeNoteForExport(note as any);
    expect((result.card as any).due).toBe("2026-05-01T00:00:00.000Z");
    expect((result.card as any).last_review).toBe("2026-04-20T12:00:00.000Z");
    expect((result.log as any[])[0].due).toBe("2026-05-01T00:00:00.000Z");
    expect((result.log as any[])[0].review).toBe("2026-04-20T12:00:00.000Z");
  });
});

// ── serializeGoalForExport ────────────────────────────────────────────────────

describe("serializeGoalForExport", () => {
  test("strips _id and converts dates", () => {
    const goal = {
      _id: "goal-id",
      topic: "Japanese",
      nodes: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-03-15T00:00:00Z"),
    };
    const result = serializeGoalForExport(goal as any);
    expect(result).not.toHaveProperty("_id");
    expect(result.topic).toBe("Japanese");
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.updatedAt).toBe("2026-03-15T00:00:00.000Z");
  });
});

// ── restoreNoteFromExport ─────────────────────────────────────────────────────

describe("restoreNoteFromExport", () => {
  test("converts ISO date strings back to Date objects in card", () => {
    const data = {
      url: "https://example.com",
      card: { due: "2026-05-01T00:00:00.000Z", last_review: "2026-04-20T12:00:00.000Z", reps: 3 },
      log: [],
    };
    const result = restoreNoteFromExport(data);
    expect((result.card as any).due).toBeInstanceOf(Date);
    expect((result.card as any).last_review).toBeInstanceOf(Date);
    expect(((result.card as any).due as Date).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  test("converts ISO date strings in log entries", () => {
    const data = {
      url: "https://example.com",
      card: { due: "2026-05-01T00:00:00.000Z", reps: 1 },
      log: [{ due: "2026-04-01T00:00:00.000Z", review: "2026-04-01T10:00:00.000Z", rating: 3 }],
    };
    const result = restoreNoteFromExport(data);
    expect((result.log as any[])[0].due).toBeInstanceOf(Date);
    expect((result.log as any[])[0].review).toBeInstanceOf(Date);
  });

  test("preserves non-date fields", () => {
    const data = {
      url: "https://example.com",
      title: "Test",
      notes: "my notes",
      card: { due: "2026-05-01T00:00:00.000Z", reps: 5, stability: 2.5 },
      log: [],
    };
    const result = restoreNoteFromExport(data);
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Test");
    expect(result.notes).toBe("my notes");
    expect((result.card as any).reps).toBe(5);
    expect((result.card as any).stability).toBe(2.5);
  });
});

// ── restoreGoalFromExport ─────────────────────────────────────────────────────

describe("restoreGoalFromExport", () => {
  test("converts createdAt and updatedAt to Date", () => {
    const data = {
      topic: "Japanese",
      nodes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    };
    const result = restoreGoalFromExport(data);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
  });
});

// ── Round-trip: serialize → YAML string → parse → restore ────────────────────

describe("round-trip through YAML", () => {
  test("FSRSNote dates survive serialize → yaml → parse → restore", () => {
    const due = new Date("2026-06-01T00:00:00Z");
    const lastReview = new Date("2026-05-15T08:00:00Z");
    const note = {
      _id: "mongo-id",
      url: "https://example.com",
      title: "Test",
      card: { due, last_review: lastReview, reps: 2, stability: 1.5 },
      log: [{ due, review: lastReview, rating: 3 }],
      notes: "",
    };

    const serialized = serializeNoteForExport(note as any);
    const yamlStr = stringify({ version: EXPORT_VERSION, fsrsNotes: [serialized] });
    const parsed = parse(yamlStr);
    const restored = restoreNoteFromExport(parsed.fsrsNotes[0]);

    expect((restored.card as any).due).toBeInstanceOf(Date);
    expect((restored.card as any).due.toISOString()).toBe(due.toISOString());
    expect((restored.card as any).last_review.toISOString()).toBe(lastReview.toISOString());
    expect((restored.log as any[])[0].due.toISOString()).toBe(due.toISOString());
  });

  test("exported YAML has all expected top-level keys", () => {
    const data = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      email: "test@example.com",
      fsrsNotes: [],
      roadmapGoals: [],
      preferences: { mobileExcludePatterns: [] },
    };
    const yamlStr = stringify(data);
    const parsed = parse(yamlStr);
    expect(parsed).toHaveProperty("version", EXPORT_VERSION);
    expect(parsed).toHaveProperty("exportedAt");
    expect(parsed).toHaveProperty("email");
    expect(parsed).toHaveProperty("fsrsNotes");
    expect(parsed).toHaveProperty("roadmapGoals");
    expect(parsed).toHaveProperty("preferences");
  });
});
