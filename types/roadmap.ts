import type { ObjectId } from "mongodb";

export type RoadmapNode = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  order: number;
};

// DB document shape (MongoDB)
export type RoadmapGoal = {
  _id?: ObjectId;
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
