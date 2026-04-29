import type { ObjectId } from "mongodb";

export type RoadmapNode = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  order: number;
};

export type RoadmapGoal = {
  _id?: ObjectId;
  topic: string;
  nodes: RoadmapNode[];
  createdAt: Date;
  updatedAt: Date;
};

export type RoadmapNodeProgress = RoadmapNode & {
  totalCards: number;
  matureCards: number;
  maturityRate: number;
};

export type RoadmapProgress = {
  goal: RoadmapGoal;
  nodes: RoadmapNodeProgress[];
  overallMaturityRate: number;
};
