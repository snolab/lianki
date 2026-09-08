# Sync merge rules

Target design for **bidirectional** sync with **soft deletes**. Today's sync is
one-way in both halves — `syncToSiteDB` pushes GM → IndexedDB, `prefetchDueCards`
pulls server → GM — and nothing carries a deletion, which is why a card deleted
on the site keeps being served for review. See
[sync-architecture.md](sync-architecture.md) for what exists now; this document
is what it should become.

Companion to that doc's Edge Cases section, which records the same gap as
"Case 3 … no reconciliation path exists".

## The model

Each card is one **LWW register keyed by normalized url**, carrying a Hybrid
Logical Clock (`app/fsrs-helpers.ts`: `{ timestamp, counter, deviceId }`,
compared in that order — `deviceId` breaks ties, so two devices never deadlock).

A card is in exactly one of three states:

| State | Meaning | Stored |
| ----- | ------- | ------ |
| **live** | normal card | full record + `hlc` |
| **tombstone** | soft-deleted | `deletedAt` + `hlc`, card body dropped |
| **purged** | tombstone garbage-collected after 90 days | nothing |

Deleting sets a tombstone rather than removing the row. That is the whole point:
a deletion has to be a *value* that can win a merge, because an absence cannot —
absence is indistinguishable from "not in this page of results".

The review **log is append-only** and merges as a union keyed by review id, not
by LWW. Two devices reviewing offline produce two real events; last-write-wins on
the log would silently discard one.

## Pairwise merge

`A` = the side being merged in, `B` = the side receiving. Symmetric — the same
table applies in both directions, which is what makes it safe to run on either
client or server.

| A (incoming) | B (local) | Result | Why |
| ------------ | --------- | ------ | --- |
| live @ h1 | live @ h2 | higher HLC wins; logs union | plain LWW |
| live @ h1 | tombstone @ h2 | h1 > h2 → **resurrect**; else stay deleted | **soft-delete vs review: last wins** |
| tombstone @ h1 | live @ h2 | h1 > h2 → **delete**; else stay live | same rule, mirrored |
| tombstone @ h1 | tombstone @ h2 | keep higher HLC; `deletedAt` = the winner's | GC timing follows the surviving tombstone |
| live | absent, never synced | **upload / download** as new | genuinely new card |
| tombstone | absent | store the tombstone until GC | it must still be able to beat a stale live copy arriving later |
| live, never synced (`dirty`) | absent (purged) | **upload** | a card this device created is not a resurrection |
| live, previously synced | absent (purged, > 90d) | **delete locally** | **not-exists wins** |

That last row is the rule that needs care, and it is the reason the whole
protocol needs a watermark rather than a diff.

## Why "not-exists wins" needs a watermark

"The server did not return this card, so it must be deleted" is only true if the
response was **complete**. Today's `prefetchDueCards` asks for `/api/fsrs/due?limit=20`
— cards missing from that are overwhelmingly just not due, or past the limit.
Treating that absence as deletion would wipe a user's collection.

So the sync response carries a horizon:

```jsonc
{
  "changed":  [ /* live cards and tombstones with hlc > cursor */ ],
  "cursor":   "<hlc of this response>",
  "purgedBefore": 1750000000000  // tombstones older than this are GONE
}
```

And the client applies one of two paths:

| Client's last successful sync | Path | Effect |
| ----------------------------- | ---- | ------ |
| newer than `purgedBefore` | **incremental** — apply `changed` only | absence means nothing; never deletes |
| older than `purgedBefore` (or never) | **full reconcile** — server sends the complete id set | any *previously synced* local card absent from it is deleted |

A device offline for more than 90 days therefore heals to the server's state
instead of resurrecting everything the user deleted while it was away. A device
offline for a week does not, because it never asked for the expensive path.

**Never-synced local cards are exempt from reconcile deletion.** They are
uploads, not resurrections — the userscript already tracks this as `dirty`.
Getting this wrong deletes work created while offline, which is worse than the
bug being fixed.

## Retention and GC

| Age of tombstone | Behavior |
| ---------------- | -------- |
| 0 – 90 days | replicated normally; wins/loses merges by HLC |
| > 90 days | hard-deleted by a sweep; `purgedBefore` advances to the sweep time |

90 days must be **longer than any plausible offline period**, because it is the
window in which a returning device can still learn about a deletion cheaply. The
`purgedBefore` watermark is what makes exceeding it safe rather than corrupting.

Never advance `purgedBefore` past a tombstone that has not actually been swept —
a client trusting the watermark will delete cards the server still holds.

## Edge cases

| # | Scenario | Resolution | Note |
| - | -------- | ---------- | ---- |
| 1 | Delete on phone, review on laptop, laptop's review is later | card lives; tombstone loses | review is a real intent expressed later |
| 2 | Review on laptop, delete on phone afterwards | card is deleted | the user's last decision stands |
| 3 | Delete and review with identical HLC timestamp+counter | `deviceId` string comparison decides | deterministic on every replica; arbitrary but consistent beats divergent |
| 4 | Same card deleted on two devices | later tombstone wins; GC clock follows it | second delete is idempotent |
| 5 | Card created offline, never synced, device offline 100 days | uploaded on return, **not** deleted | `dirty`/never-synced exempt from reconcile |
| 6 | Card deleted on server 100 days ago, device returns with a stale live copy | deleted locally via full reconcile | the "not-exists wins" rule |
| 7 | Card deleted 10 days ago, device returns with a stale live copy | deleted locally via the tombstone in `changed` | cheap path; no reconcile needed |
| 8 | Device clock is an hour fast, deletes a card | that tombstone wins until real time catches up | inherent to LWW; HLC bounds it to clock skew, it does not remove it |
| 9 | Two devices review offline, both come online | both review log entries kept; card state = higher HLC | log is a union, state is LWW |
| 10 | Card's url normalization changes (`?utm=` stripped) | two distinct records — normalization is part of the key | migrate by rewriting keys server-side, never by merging silently |
| 11 | Tombstone arrives for a card this device never had | store it until GC | otherwise a later stale live copy resurrects it |
| 12 | User deletes all cards, then reviews one on a stale tab before it syncs | that one card resurrects | correct per rule 1; the review is newer than the delete |
| 13 | Account switch / different user | not a merge at all — namespace by account and clear on switch | merging across accounts is a data leak, not a conflict |

## What this replaces

The current stopgap (`lib/local-purge.ts`) has the site leave a note in
`localStorage` that the userscript drains, because the site cannot reach GM
storage and nothing else carried deletions. It fixes the reported symptom — a
deleted card still being served — but only from site → userscript, only on this
browser, and only while the queue survives.

Tombstones subsume it: once deletions replicate through the sync protocol, the
purge queue and its localStorage key should be deleted, not kept in parallel.

## Implementation sketch

Not yet built. In rough dependency order:

1. **Schema** — `deletedAt: Date | null` on the card record, in both backends
   (Mongo and the D1 migrations under `db/migrations/`). Index `(email, hlc)` for
   the incremental query and `(deletedAt)` for the sweep.
2. **Delete becomes soft** — `/api/fsrs/delete` and `/api/fsrs/bulk-delete` set
   `deletedAt` + a fresh HLC instead of removing rows. Every read path must then
   filter tombstones, or deleted cards come back as due cards — that is the
   change most likely to be missed.
3. **`GET /api/fsrs/sync?cursor=`** — returns `changed` / `cursor` /
   `purgedBefore`, and the full id set when the cursor is older than the horizon.
4. **Userscript** — replace `prefetchDueCards`'s upsert-only loop with the merge
   table above; apply tombstones; keep `dirty` cards exempt.
5. **Sweep** — a scheduled job hard-deleting tombstones older than 90 days and
   advancing `purgedBefore`.
6. **Then** remove `lib/local-purge.ts` and its call sites.
