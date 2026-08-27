/**
 * The single owner of this run's module mocks.
 *
 * `mock.module` patches the module registry for the WHOLE bun test process, not
 * per file. Two files registering competing factories for the same path is
 * therefore order- and version-dependent: it passed locally on bun 1.4.0 and
 * failed in CI, where `notes-admin` left `dbBackend()` returning "d1" and
 * `mongo-crud`'s writes went to D1 instead of its own Mongo collection — the
 * collection then read back empty, so counts were 0 and findOne was null.
 *
 * So the mocks are registered exactly once, here, and every factory reads from
 * this holder. Files install their own values in `beforeEach`, which makes the
 * currently-running file the one that decides — regardless of import order.
 *
 * This file is not itself a test: it does not match bun's test-file globs.
 */
import { mock } from "bun:test";

type Backend = "mongodb" | "d1";

let notesCollection: unknown = null;
let goalsCollection: unknown = null;
let d1Database: unknown = null;
let backend: Backend = "mongodb";

/** Point `getFSRSNotesCollection()` at this collection for the current file. */
export function useNotesCollection(value: unknown) {
  notesCollection = value;
}

/** Point `getRoadmapGoalsCollection()` at this collection for the current file. */
export function useGoalsCollection(value: unknown) {
  goalsCollection = value;
}

/** Point `getD1()` at this database for the current file. */
export function useD1(value: unknown) {
  d1Database = value;
}

/**
 * Choose the backend `dbBackend()` reports. Set this in `beforeEach` even when
 * a file only ever wants "mongodb" — leaving it to whatever ran last is exactly
 * the bug this module exists to prevent.
 */
export function useBackend(value: Backend) {
  backend = value;
}

mock.module("next/cache", () => ({
  revalidateTag: mock(() => {}),
  unstable_cache: mock((fn: () => unknown) => fn),
}));

mock.module("@/app/getFSRSNotesCollection", () => ({
  getFSRSNotesCollection: () => notesCollection,
}));

mock.module("@/app/getRoadmapGoalsCollection", () => ({
  getRoadmapGoalsCollection: () => goalsCollection,
}));

mock.module("@/lib/d1", () => ({
  dbBackend: () => backend,
  getD1: () => d1Database,
  getBlobs: () => {
    throw new Error("getBlobs() is not stubbed for unit tests");
  },
}));
