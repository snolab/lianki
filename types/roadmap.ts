/**
 * A roadmap step. `stage` + optional `lane` is the ordering notation
 * (lib/roadmap/notation.ts): stages 1, 2, 3 run one after another, lettered
 * lanes of one stage (2A, 2B, 2C) run side by side. `order` is the flat
 * position in that order, kept for older readers (the partner's summary).
 * Roadmaps saved before the notation have `order` only; they read as one
 * stage per step (`normalizeSteps`).
 */
export type RoadmapNodeKind = "keywords" | "deck" | "doc";

/** A doc step: Markdown of its own, and/or a link to a /reader doc or an official page. */
export type RoadmapDoc = {
  markdown?: string;
  /** A /reader doc id: opens /reader/<id>. */
  readerId?: string;
  /** An official page (http/https). */
  url?: string;
  /** When each checklist item was ticked (ISO), newest last: the doc's pace. */
  doneLog?: string[];
};

export type RoadmapNode = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  order: number;
  /** 1-based stage; absent on roadmaps saved before the notation. */
  stage?: number;
  /** "A".."Z": a parallel lane inside the stage; absent when the stage has one step. */
  lane?: string;
  /** Absent = "keywords" (progress from page cards matching the keywords). */
  kind?: RoadmapNodeKind;
  /** A deck step: a word-list catalogue id (public/words/index.json). */
  deck?: { id: string };
  doc?: RoadmapDoc;
};

// DB document shape (MongoDB). `_id` is structurally typed (ObjectId satisfies
// it) so this stays MongoDB-import-free and reusable by the CF-native worker.
export type RoadmapGoal = {
  _id?: { toString(): string };
  topic: string;
  nodes: RoadmapNode[];
  /** The learner's target date, YYYY-MM-DD, or absent. */
  targetDate?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// JSON-serialized shape sent to/from API clients
export type RoadmapGoalDTO = {
  _id?: string;
  topic: string;
  nodes: RoadmapNode[];
  targetDate?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What a step's progress is counted in. */
export type ProgressUnit = "cards" | "words" | "items";

/** A step's own measure and pace (lib/roadmap/eta.ts). */
export type StepMeasure = {
  unit: ProgressUnit;
  done: number;
  /** null: nothing to count (a doc without checkboxes): progress n/a. */
  total: number | null;
  /** Units done per UTC day over the recent window, oldest first; null: no log for this kind. */
  daily: number[] | null;
};

export type RoadmapNodeProgress = RoadmapNode & {
  totalCards: number;
  matureCards: number;
  maturityRate: number;
  measure?: StepMeasure;
};

export type RoadmapProgress = {
  goal: RoadmapGoalDTO;
  nodes: RoadmapNodeProgress[];
  overallMaturityRate: number;
  /** The pace settings the server measured with (config roadmap.*). */
  pace?: { windowDays: number; minActiveDays: number; today: string };
};
