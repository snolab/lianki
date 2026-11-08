/**
 * The owner's status board for /dev/roadmap. The page renders these in this
 * order, grouped by status. Titles live in ./page.content.ts (`items.<id>`,
 * 16 locales, a context line each): add an item there and here together.
 */
import type devRoadmap from "./page.content";

export type RoadmapStatus = "doing" | "waiting" | "queued" | "planned" | "done";

export type RoadmapItemId = keyof (typeof devRoadmap)["content"]["items"];

export type RoadmapItem = {
  id: RoadmapItemId;
  status: RoadmapStatus;
  /** PR numbers in snolab/lianki. */
  prs?: number[];
  link?: string;
};

/** Page order. `done` comes last and is folded by default. */
export const STATUS_ORDER: RoadmapStatus[] = ["doing", "waiting", "queued", "planned", "done"];

export const ROADMAP: RoadmapItem[] = [
  // In progress
  { id: "permissions", status: "doing" },
  { id: "boxAuth", status: "doing" },
  { id: "readerFixes", status: "doing" },
  { id: "ganttList", status: "doing" },
  { id: "labMoves", status: "doing" },
  { id: "designPage", status: "doing" },
  { id: "devRoadmap", status: "doing" },
  { id: "scriptChat", status: "doing" },
  { id: "loaderHost", status: "doing" },
  // Waiting for the owner
  { id: "stories", status: "waiting" },
  { id: "laneListen", status: "waiting" },
  { id: "memberVoices", status: "waiting" },
  { id: "slackFiles", status: "waiting" },
  // Queued
  { id: "myboxPage", status: "queued" },
  { id: "readerUrl", status: "queued" },
  { id: "reviewSheet", status: "queued" },
  { id: "externalLink", status: "queued" },
  { id: "sealChar", status: "queued" },
  // Planned
  { id: "ytSongs", status: "planned" },
  { id: "importAny", status: "planned" },
  // Done, newest first
  { id: "reviewScopes", status: "done", prs: [703, 707] },
  { id: "gateSpeed", status: "done", prs: [701, 704, 706, 708] },
  { id: "chatDevGroup", status: "done", prs: [699, 705] },
  { id: "progressBar", status: "done", prs: [667, 700, 702] },
  { id: "newReader", status: "done", prs: [689, 690, 698] },
  { id: "box", status: "done", prs: [628, 685, 686, 694, 695, 696, 697] },
  { id: "voices", status: "done", prs: [670, 672, 679, 688] },
  { id: "chatHistory", status: "done", prs: [684] },
  { id: "apiTokens", status: "done", prs: [678, 691] },
  { id: "roadmap16", status: "done", prs: [676] },
  { id: "sealLogo", status: "done", prs: [675] },
  { id: "chatFullScreen", status: "done", prs: [666, 668, 673] },
  { id: "devCli", status: "done", prs: [669] },
  { id: "vibe", status: "done", prs: [647, 649, 652, 654, 655] },
  { id: "ownerRole", status: "done", prs: [613] },
  { id: "lian", status: "done", prs: [597] },
];
