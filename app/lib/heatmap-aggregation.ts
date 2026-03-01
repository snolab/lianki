import type { HeatmapData } from "@/types/heatmap";
import { getFSRSNotesCollection } from "../getFSRSNotesCollection";
import DIE from "phpdie";

export async function aggregateReviewActivity(email?: string): Promise<HeatmapData> {
  if (!email) DIE("aggregateReviewActivity called without email - unauthenticated user");
  const FSRSNotes = getFSRSNotesCollection(email);

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  oneYearAgo.setHours(0, 0, 0, 0);

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
