import type { HeatmapData } from "@/types/heatmap";
import { getFSRSNotesCollection } from "../getFSRSNotesCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import DIE from "phpdie";

export async function aggregateReviewActivity(email?: string): Promise<HeatmapData> {
  if (!email) DIE("aggregateReviewActivity called without email - unauthenticated user");

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  oneYearAgo.setHours(0, 0, 0, 0);

  // D1 has no aggregation pipeline: list the user's notes and bucket each review
  // log entry by UTC day (matching Mongo's default `$dateToString` timezone).
  if (dbBackend() === "d1") {
    try {
      const notes = await new FsrsNotesD1Repo(getD1(), email).listAll();
      const acc: HeatmapData = {};
      for (const note of notes) {
        for (const entry of note.log ?? []) {
          const review = entry.review instanceof Date ? entry.review : new Date(entry.review);
          if (review >= oneYearAgo) {
            const day = review.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
            acc[day] = (acc[day] ?? 0) + 1;
          }
        }
      }
      return acc;
    } catch (error) {
      console.error("Error aggregating review activity:", error);
      return {};
    }
  }

  const FSRSNotes = getFSRSNotesCollection(email);

  const pipeline = [
    {
      $unwind: "$log",
    },
    {
      $match: {
        "log.review": { $gte: oneYearAgo },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$log.review",
          },
        },
        count: { $sum: 1 },
      },
    },
    {
      $sort: { _id: 1 },
    },
  ];

  try {
    const results = await FSRSNotes.aggregate(pipeline).toArray();

    return results.reduce((acc, { _id, count }) => {
      acc[_id] = count;
      return acc;
    }, {} as HeatmapData);
  } catch (error) {
    console.error("Error aggregating review activity:", error);
    return {};
  }
}
