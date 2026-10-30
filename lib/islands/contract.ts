/**
 * The islands contract (docs/dev-hot-islands.md) — the ONLY way islands talk.
 *
 * Islands never import each other and never take live props from a parent.
 * Everything one island shares with another is listed here:
 *
 * - ISLANDS: each island's name, its static props (strings, numbers, booleans
 *   known at render, like locale or a label) and a contract version;
 * - SHARED: each shared-state key (localStorage, through useSharedState): a
 *   zod schema, a default, a version stored with the value, an optional
 *   migrate from an older version;
 * - ACTIONS: each action on the bus (CustomEvent `lk:island-action`), with a
 *   zod schema for its payload.
 *
 * Changing a shape means bumping its version here. A hot-swapped island built
 * from another version then reads the default (shared state), is skipped
 * (an island contract), or has its action dropped — and keeps working.
 */
import { z } from "zod";

/** What an island may take from its parent: static values only. */
export type StaticProps = Record<string, string | number | boolean | null | undefined>;

/** Only static props type-check as an island's props. */
type Static<T extends StaticProps> = T;

/** Each island's static props (`Record<string, never>` for none). */
export interface IslandProps {
  /** The name beside the seal in the top bar (app/components/BrandName.tsx). */
  "header.brand": Static<{ appName: string }>;
  /*
   * The /words swipe's UI over its headless core (docs/swipe-core.md). None
   * takes props: each reads the core's contexts (lib/words/swipe-core.tsx,
   * a shared module) at the interface version it names. Bump these with
   * SWIPE_CORE_IFACE.
   */
  /** The slip the js swipe moves (the core's card slot). */
  "words.swipeCard": Static<Record<string, never>>;
  /** The lift under a pressed or dragged slip. */
  "words.swipeCue": Static<Record<string, never>>;
  /** What a sliding slip uncovers: the grade zones. */
  "words.swipeGrades": Static<Record<string, never>>;
  /** A feel source: token overrides per preset, in force while mounted. */
  "words.swipeFeel": Static<Record<string, never>>;
  /** The tuning panel (debug mode, "Tune swipe"). */
  "words.swipeTuner": Static<Record<string, never>>;
}
export type IslandName = keyof IslandProps;

/** Each island's contract version: bump it when its props change shape. */
export const ISLAND_VERSIONS: { readonly [K in IslandName]: number } = {
  "header.brand": 1,
  "words.swipeCard": 1,
  "words.swipeCue": 1,
  "words.swipeGrades": 1,
  "words.swipeFeel": 1,
  "words.swipeTuner": 1,
};

/** One shared-state key: how its value is checked, its default, its version. */
export type SharedEntry<T> = {
  schema: z.ZodType<T>;
  default: T;
  version: number;
  /** Turn a value stored by an older version into this version's shape (then parsed). */
  migrate?: (fromVersion: number, raw: unknown) => unknown;
};

const entry = <T>(e: SharedEntry<T>) => e;

/**
 * Every shared-state key. Stored in localStorage as `lk:s:<key>` =
 * JSON `{v, data}`.
 */
export const SHARED = {
  /**
   * The hot-island loader's status on this page, for any island (or the
   * debug chat) that wants to show it. Written by lib/islands/loader.ts only.
   */
  "islands.status": entry({
    schema: z.object({
      active: z.boolean(),
      rev: z.string(),
      names: z.array(z.string()),
      note: z.string(),
    }),
    default: { active: false, rev: "", names: [], note: "" },
    version: 1,
  }),
};
export type SharedKey = keyof typeof SHARED;
export type SharedValue<K extends SharedKey> = (typeof SHARED)[K]["default"];

/** Every action on the bus, with its payload's schema. */
export const ACTIONS = {
  /** Ask the hot-island loader to re-import every island now. */
  "islands.reload": z.object({}),
};
export type ActionName = keyof typeof ACTIONS;
export type ActionPayload<A extends ActionName> = z.infer<(typeof ACTIONS)[A]>;

/** What the dev server's islands module exports as `islands` (lib/islands/entry.ts). */
export type IslandsExport = {
  [K in IslandName]?: import("react").ComponentType<IslandProps[K]>;
};
