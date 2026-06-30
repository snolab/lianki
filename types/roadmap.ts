export type RoadmapNode = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  order: number;
};

// DB document shape (MongoDB). `_id` is structurally typed (ObjectId satisfies
// it) so this stays MongoDB-import-free and reusable by the CF-native worker.
export type RoadmapGoal = {
  _id?: { toString(): string };
  topic: string;
  nodes: RoadmapNode[];
  createdAt: Date;
  updatedAt: Date;
};

// JSON-serialized shape sent to/from API clients
export type RoadmapGoalDTO = {
  _id?: string;
  topic: string;
  nodes: RoadmapNode[];
  createdAt: string;
  updatedAt: string;
};

export type RoadmapNodeProgress = RoadmapNode & {
  totalCards: number;
  matureCards: number;
  maturityRate: number;
};

export type RoadmapProgress = {
  goal: RoadmapGoalDTO;
  nodes: RoadmapNodeProgress[];
  overallMaturityRate: number;
};
