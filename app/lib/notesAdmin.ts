/**
 * Backend-aware admin operations over a user's FSRS notes: the paged/filtered
 * listing, bulk delete, bulk upsert (the Local → Cloud push) and store stats
 * behind `/data`.
 *
 * These deliberately do NOT go through `D1FsrsCollection`. That shim states
 * outright that it "handles ONLY the fixed set of query / update shapes the
 * handler produces" — its `applyQuery` understands `card.due.$lte` and `url`
 * and nothing else — so a `{title: {$regex}}` or `{"card.state": 2}` filter
 * would be *silently ignored* and quietly return every row. Instead each
 * operation branches on `dbBackend()` exactly once, mirroring the switch in
 * `app/lib/getNotesCollection.ts`.
 */
import type { Filter } from "mongodb";
import type { FSRSNote } from "@/app/fsrs";
import { compareHLC, newServerHLC, type HLC } from "@/app/fsrs-helpers";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import {
  FsrsNotesD1Repo,
  clampSize,
  type NotesQueryOptions,
  type NotesSort,
} from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";

export { NOTES_SORTS, NOTES_PAGE_MAX, clampSize, escapeLike } from "@/lib/repos/fsrsNotesD1";
export type { NotesQueryOptions, NotesSort } from "@/lib/repos/fsrsNotesD1";

/** One row of the data table. Plain JSON — safe across the RSC/API boundary. */
export type NoteRow = {
  url: string;
  title: string;
  state: number;
  due: string;
  reps: number;
  lapses: number;
  notes?: string;
  hlc?: HLC;
};

const MONGO_SORT_FIELDS: Record<NotesSort, string> = {
  due: "card.due",
  url: "url",
  title: "title",
  reps: "card.reps",
  lapses: "card.lapses",
  state: "card.state",
};

function toRow(note: FSRSNote): NoteRow {
  const card = note.card ?? ({} as FSRSNote["card"]);
  return {
    url: note.url,
    title: note.title || note.url,
    state: card.state ?? 0,
    due: card.due ? new Date(card.due).toISOString() : "",
    reps: card.reps ?? 0,
    lapses: card.lapses ?? 0,
    notes: note.notes,
    hlc: note.hlc,
  };
}

/** Escape a user string for use inside a MongoDB `$regex`. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function queryNotes(
  email: string,
  opts: NotesQueryOptions,
): Promise<{ rows: NoteRow[]; total: number }> {
  if (dbBackend() === "d1") {
    const { rows, total } = await new FsrsNotesD1Repo(getD1(), email).query(opts);
    return { rows: rows.map(toRow), total };
  }

  const collection = getFSRSNotesCollection(email);
  const filter: Filter<FSRSNote> = {};
  if (opts.q) {
    const rx = { $regex: escapeRegex(opts.q), $options: "i" };
    Object.assign(filter, { $or: [{ url: rx }, { title: rx }] });
  }
  if (opts.state != null) Object.assign(filter, { "card.state": opts.state });
  if (opts.due === "due") Object.assign(filter, { "card.due": { $lte: new Date() } });

  const size = clampSize(opts.size);
  const page = Math.max(0, opts.page ?? 0);
  const sortField = MONGO_SORT_FIELDS[opts.sort ?? "due"] ?? MONGO_SORT_FIELDS.due;
  const direction = opts.order === "desc" ? -1 : 1;

  const [docs, total] = await Promise.all([
    collection
      .find(filter, { sort: { [sortField]: direction } })
      .skip(page * size)
      .limit(size)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  return { rows: docs.map((d) => toRow(d as unknown as FSRSNote)), total };
}

export type BulkDeleteInput = { urls?: string[]; all?: boolean };

export async function bulkDeleteNotes(
  email: string,
  input: BulkDeleteInput,
): Promise<{ deleted: number }> {
  if (dbBackend() === "d1") {
    const repo = new FsrsNotesD1Repo(getD1(), email);
    return {
      deleted: input.all ? await repo.deleteAll() : await repo.deleteMany(input.urls ?? []),
    };
  }

  const collection = getFSRSNotesCollection(email);
  if (input.all) {
    const res = await collection.deleteMany({});
    return { deleted: res.deletedCount ?? 0 };
  }
  const urls = input.urls ?? [];
  if (!urls.length) return { deleted: 0 };
  const res = await collection.deleteMany({ url: { $in: urls } });
  return { deleted: res.deletedCount ?? 0 };
}

export type BulkUpsertResult = {
  upserted: number;
  /** Skipped because the stored copy carries a newer (or equal) HLC. */
  conflicts: number;
  /** Skipped because the payload was unusable (no url, no card). */
  skipped: number;
};

/**
 * Local → Cloud push. Every incoming note is HLC-merged, never blindly written:
 * if the stored note's clock is at or ahead of the client's, the row is left
 * alone and counted as a conflict — the same rule `POST /api/fsrs/review`
 * applies before it accepts a review.
 */
export async function bulkUpsertNotes(email: string, notes: FSRSNote[]): Promise<BulkUpsertResult> {
  const result: BulkUpsertResult = { upserted: 0, conflicts: 0, skipped: 0 };
  const d1 = dbBackend() === "d1" ? new FsrsNotesD1Repo(getD1(), email) : null;
  const collection = d1 ? null : getFSRSNotesCollection(email);

  for (const incoming of notes) {
    if (!incoming?.url || !incoming.card?.due) {
      result.skipped++;
      continue;
    }

    const existing = d1
      ? await d1.getByUrl(incoming.url)
      : ((await collection!.findOne({ url: incoming.url })) as unknown as FSRSNote | null);

    // A brand-new url always lands. An existing one only loses to a strictly
    // newer client clock, so replaying the same push is a no-op rather than a
    // rewrite.
    if (existing && compareHLC(incoming.hlc, existing.hlc) <= 0) {
      result.conflicts++;
      continue;
    }

    const merged: FSRSNote = {
      ...existing,
      ...incoming,
      card: incoming.card,
      log: incoming.log ?? existing?.log ?? [],
      hlc: newServerHLC(incoming.hlc ?? existing?.hlc),
    };

    if (d1) await d1.upsert(merged);
    else await collection!.updateOne({ url: merged.url }, { $set: merged }, { upsert: true });
    result.upserted++;
  }

  return result;
}

export type StoreStats = {
  backend: "mongo" | "d1";
  notes: number;
  due: number;
  goals: number;
};

export async function storeStats(email: string): Promise<StoreStats> {
  const now = new Date();
  if (dbBackend() === "d1") {
    const d1 = getD1();
    const repo = new FsrsNotesD1Repo(d1, email);
    const [notes, due, goals] = await Promise.all([
      repo.countAll(),
      repo.countDue(now),
      new RoadmapGoalsD1Repo(d1, email).listAll().then((g) => g.length),
    ]);
    return { backend: "d1", notes, due, goals };
  }

  const collection = getFSRSNotesCollection(email);
  const [notes, due, goals] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ "card.due": { $lte: now } }),
    getRoadmapGoalsCollection(email).countDocuments({}),
  ]);
  return { backend: "mongo", notes, due, goals };
}

// Re-exported so the route layer can build a query without importing the repo.
export function parseQueryOptions(params: URLSearchParams): NotesQueryOptions {
  const stateRaw = params.get("state");
  const state = stateRaw != null && stateRaw !== "" ? Number(stateRaw) : undefined;
  return {
    q: params.get("q")?.trim() || undefined,
    state: Number.isInteger(state) ? state : undefined,
    due: params.get("due") === "due" ? "due" : "all",
    sort: (params.get("sort") ?? undefined) as NotesSort | undefined,
    order: params.get("order") === "desc" ? "desc" : "asc",
    page: Number(params.get("page") ?? 0) || 0,
    size: Number(params.get("size") ?? 50) || 50,
  };
}
