/**
 * The islands the dev server builds from the working tree
 * (scripts/dev/islands-server.ts; docs/dev-hot-islands.md). Never imported by
 * the app. `satisfies` makes an island that breaks its contract fail typecheck.
 *
 * One `import { X } from "…"` per island and `"name": X` in `islands`: the dev
 * server reads that shape to tell which islands a saved file touches.
 */
import { BrandName } from "@/app/components/BrandName";
import { ISLAND_VERSIONS, type IslandsExport } from "./contract";
import { ISLANDS_API } from "./rules";

export const islands = {
  "header.brand": BrandName,
} satisfies IslandsExport;

export const versions = ISLAND_VERSIONS;
export { ISLANDS_API };
