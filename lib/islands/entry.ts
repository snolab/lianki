/**
 * The islands the dev server builds from the working tree
 * (scripts/dev/islands-server.ts; docs/dev-hot-islands.md). Never imported by
 * the app. `satisfies` makes an island that breaks its contract fail typecheck.
 *
 * One `import { X } from "…"` per island and `"name": X` in `islands`: the dev
 * server reads that shape to tell which islands a saved file touches.
 */
import { BrandName } from "@/app/components/BrandName";
import { SwipeCard } from "@/lib/words/islands/SwipeCard";
import { SwipeCue } from "@/lib/words/islands/SwipeCue";
import { SwipeGrades } from "@/lib/words/islands/SwipeGrades";
import { SwipeFeelSource } from "@/lib/words/islands/SwipeFeelSource";
import { SwipeTuner } from "@/lib/words/islands/SwipeTuner";
import { BottomIsland } from "@/lib/nav/islands/BottomIsland";
import { NavRows } from "@/lib/nav/islands/NavRows";
import { ISLAND_VERSIONS, type IslandsExport } from "./contract";
import { ISLANDS_API } from "./rules";

export const islands = {
  "header.brand": BrandName,
  "words.swipeCard": SwipeCard,
  "words.swipeCue": SwipeCue,
  "words.swipeGrades": SwipeGrades,
  "words.swipeFeel": SwipeFeelSource,
  "words.swipeTuner": SwipeTuner,
  "nav.bottom": BottomIsland,
  "nav.drawer": NavRows,
} satisfies IslandsExport;

export const versions = ISLAND_VERSIONS;
export { ISLANDS_API };
