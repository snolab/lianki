// A D1-backed object implementing the small subset of the MongoDB Collection
// API that app/fsrs.ts uses. This lets the FSRS handler run unchanged against
// either backend — only the collection object differs.
//
// It deliberately handles ONLY the fixed set of query / update shapes the
// handler produces, not arbitrary MongoDB queries.

import { createEmptyCard, type Card, type ReviewLog } from "ts-fsrs";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo, type StoredNote } from "@/lib/repos/fsrsNotesD1";
import type { FSRSNote } from "./fsrs";
import type { HLC } from "./fsrs-helpers";

/** Document shape the handler expects — FSRSNote plus a string `_id`. */
export type FsrsDoc = FSRSNote & { _id: string };

function toDoc(n: StoredNote): FsrsDoc {
  const { id, ...note } = n;
  return { ...note, _id: id };
}

type AnyQuery = Record<string, unknown>;

/** Does a note pass the `url` constraints of a query ($ne/$nin/$not, or exact)? */
function urlMatches(url: string | undefined, urlCond: unknown): boolean {
  if (urlCond == null) return true;
  if (typeof urlCond === "string") return url === urlCond;
  if (typeof urlCond === "object") {
    const c = urlCond as Record<string, unknown>;
    if (!url) return false; // $exists:true / $ne:null
    if (Array.isArray(c.$nin) && c.$nin.includes(url)) return false;
    if (c.$not instanceof RegExp && c.$not.test(url)) return false;
  }
  return true;
}

/** Apply the handler's query shapes to an in-memory note list. */
function applyQuery(notes: StoredNote[], query: AnyQuery): StoredNote[] {
  const dueCond = query["card.due"] as { $lte?: Date } | undefined;
  const now = Date.now();
  return notes.filter((n) => {
    if (
      dueCond?.$lte != null &&
      new Date(n.card.due).getTime() > new Date(dueCond.$lte).getTime()
    ) {
      return false;
    }
    if ("url" in query && !urlMatches(n.url, query.url)) return false;
    return true;
  });
}

export class D1FsrsCollection {
  private readonly repo: FsrsNotesD1Repo;
  constructor(db: D1Like, email: string) {
    this.repo = new FsrsNotesD1Repo(db, email);
  }

  private async candidates(query: AnyQuery): Promise<StoredNote[]> {
    // Start from the smallest superset we can: due-only when the query filters
    // by card.due, otherwise every note.
    const all = query["card.due"]
      ? await this.repo.listDue(new Date(), Number.MAX_SAFE_INTEGER)
      : await this.repo.listAll();
    return applyQuery(all, query);
  }

  find(query: AnyQuery = {}, options: { limit?: number } = {}) {
    const rowsPromise = this.candidates(query).then((rows) => {
      const limited = options.limit != null ? rows.slice(0, options.limit) : rows;
      return limited.map(toDoc);
    });
    // listAll/listDue already return rows ordered by card_due ascending.
    return {
      toArray: () => rowsPromise,
      async *[Symbol.asyncIterator]() {
        for (const r of await rowsPromise) yield r;
      },
    };
  }

  async findOne(query: AnyQuery): Promise<FsrsDoc | null> {
    if (typeof query.url === "string" && Object.keys(query).length === 1) {
      const n = await this.repo.getByUrl(query.url);
      return n ? toDoc(n) : null;
    }
    const rows = await this.candidates(query);
    return rows.length > 0 ? toDoc(rows[0]) : null;
  }

  async countDocuments(query: AnyQuery = {}): Promise<number> {
    if (Object.keys(query).length === 0) return this.repo.countAll();
    if (query["card.due"] && Object.keys(query).length === 1) {
      return this.repo.countDue(new Date());
    }
    return (await this.candidates(query)).length;
  }

  aggregate(pipeline: AnyQuery[]) {
    // Only the handler's `[{$set:{_id:toString}},{$match:{_id|url}}]` shape.
    const match = (pipeline.find((s) => "$match" in s)?.$match ?? {}) as Record<string, unknown>;
    const repo = this.repo;
    return {
      async next(): Promise<FsrsDoc | null> {
        if (typeof match._id === "string") {
          const n = await repo.getById(match._id);
          return n ? toDoc(n) : null;
        }
        if (typeof match.url === "string") {
          const n = await repo.getByUrl(match.url);
          return n ? toDoc(n) : null;
        }
        return null;
      },
    };
  }

  async deleteOne(filter: { url: string }): Promise<{ deletedCount: number }> {
    const existed = await this.repo.getByUrl(filter.url);
    await this.repo.delete(filter.url);
    return { deletedCount: existed ? 1 : 0 };
  }

  async findOneAndUpdate(
    filter: { url: string },
    update: {
      $set?: Partial<FSRSNote>;
      $push?: { log: ReviewLog };
      $setOnInsert?: Partial<FSRSNote>;
    },
  ): Promise<FsrsDoc | null> {
    const existing = await this.repo.getByUrl(filter.url);

    // Review: $set card + hlc, $push a log entry.
    if (update.$push?.log) {
      const log = [...(existing?.log ?? []), update.$push.log];
      const note: FSRSNote = {
        url: filter.url,
        title: existing?.title,
        notes: existing?.notes,
        speedMarkers: existing?.speedMarkers,
        deviceId: existing?.deviceId,
        card: (update.$set?.card ?? existing?.card) as Card,
        hlc: update.$set?.hlc as HLC | undefined,
        log,
      };
      const id = await this.repo.upsert(note, existing?.id);
      return toDoc({ ...note, id });
    }

    // saveNote: $setOnInsert card/url/hlc, $set title.
    const ins = update.$setOnInsert ?? {};
    if (existing) {
      if (update.$set?.title && update.$set.title !== existing.title) {
        const { id, ...note } = existing;
        await this.repo.upsert({ ...note, title: update.$set.title }, id);
        return toDoc({ ...existing, title: update.$set.title });
      }
      return toDoc(existing);
    }
    const note: FSRSNote = {
      url: filter.url,
      card: (ins.card ?? createEmptyCard()) as Card,
      hlc: ins.hlc as HLC | undefined,
      log: [],
      ...(update.$set?.title ? { title: update.$set.title } : {}),
    };
    const id = await this.repo.upsert(note);
    return toDoc({ ...note, id });
  }

  async updateOne(
    filter: { url: string },
    update: { $set: Partial<FSRSNote> & { url?: string } },
  ): Promise<{ matchedCount: number }> {
    const set = update.$set;

    // Rename: $set.url with a different filter.url.
    if (typeof set.url === "string") {
      const existing = await this.repo.getByUrl(filter.url);
      if (!existing) return { matchedCount: 0 };
      await this.repo.updateUrl(filter.url, set.url);
      return { matchedCount: 1 };
    }

    const existing = await this.repo.getByUrl(filter.url);

    // speedMarkers: upsert (the Mongo route used upsert:true).
    if (set.speedMarkers !== undefined) {
      const base: FSRSNote = existing
        ? (() => {
            const { id: _id, ...n } = existing;
            return n;
          })()
        : { url: filter.url, card: createEmptyCard(), log: [] };
      await this.repo.upsert({ ...base, speedMarkers: set.speedMarkers }, existing?.id);
      return { matchedCount: 1 };
    }

    // notes update.
    if (set.notes !== undefined) {
      if (!existing) return { matchedCount: 0 };
      const { id, ...n } = existing;
      await this.repo.upsert({ ...n, notes: set.notes }, id);
      return { matchedCount: 1 };
    }

    return { matchedCount: 0 };
  }
}
