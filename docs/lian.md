# Study ledger (lian)

A minimal hash-chained ledger of study records, starting with study days.
Owner decision, Slack 2026-11-05 (~15:38 JST, "做"): mount each day's study
records to a hash, chain the days, publish the chain at milestones.

To users this is a **study record** / **学习记录** — never "blockchain". (The
proposed credit unit 莲, if built, is a separate thing that shares the name.)

## What is proven, and what is not

| proven                                                                                                        | not proven                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Integrity after anchoring**: a day once anchored cannot be changed, removed or reordered without it showing | that the study was genuine — the leaf holds what the study-day rule recorded (docs/levels.md), no more  |
| a user's study day is in that day's tree (their leaf + Merkle proof → the day's root)                         | that the server put every real study day in (it could have left one out before anchoring)               |
| with an OpenTimestamps receipt: the chain up to that day existed by that Bitcoin block's time                 | anything between milestones: until a day is timestamped or published, the server could rebuild the tail |

So the guarantee is "what we recorded on day N is what we show you now", and
— from a milestone on — "and it was recorded by then".

## How it works

- `packages/lian` (pure TS, Web Crypto, no dependencies — the same code runs
  in the Worker, the browser and a script):
  - `canonical` — canonical JSON (sorted keys, safe integers only); entries
    are tagged tuples, the tag carries the version (`lian/study-day/1`).
  - `merkleRoot` / `merkleProof` / `verifyProof` — SHA-256 Merkle tree,
    RFC 6962 prefixes (`0x00` leaf, `0x01` node), an odd node carried up
    (never duplicated); the root of no leaves is `H("")`.
  - `chainHash` / `verifyChain` — `chainHash(N) = H(version ‖ day ‖
merkleRoot(N) ‖ chainHash(N−1))`, version one byte, day 10 ASCII bytes,
    hashes 32 bytes; the first day's previous hash is 32 zero bytes.
    `verifyChain` names the first day that does not re-derive.
  - `ots` — OpenTimestamps receipts (stamp, parse, upgrade).
- **Leaves** (`lib/lian/anchor.ts`): one per user per day,
  `H(canonical(["lian/study-day/1", salt, userId, day, {reviews}]))` from the
  `study_day` row (lib/study-days.ts). `reviews` is the count that rule
  already keeps — no card content. A day's leaves are sorted by hash.
- **Salt**: 32 random bytes per user (`lian_salt`), made on their first
  anchored day, kept server-side and given only to that user with their
  proof. Without it a leaf cannot be tested against a guess ("did user X
  study 12 reviews on day D?"), so the public roots reveal only how many
  people studied that day.
- **D1** (`db/migrations/0044_lian_ledger.sql`): `lian_anchor` (day, version,
  merkle_root, prev_hash, chain_hash, leaf_count, created_at), `lian_leaf`
  (day, idx, user_id, leaf_hash, summary — the counts as they were when
  anchored), `lian_salt`, `lian_timestamp`. Triggers refuse any UPDATE or
  DELETE on anchors and leaves.
- **Daily anchor**: a Cloudflare Cron Trigger on the main Worker
  (`wrangler.jsonc` `triggers`, `5 0 * * *` = 00:05 UTC; `worker.ts`
  `scheduled`). It anchors every day not yet anchored that has **ended in
  every time zone** — study days are cut in each user's home zone, and a date
  ends in UTC−12 36 h after it began in UTC — so at 00:05 UTC on the 7th it
  anchors the 5th. Days are anchored in order with no gaps (a day nobody
  studied has 0 leaves), each day's anchor and leaves in one D1 batch;
  `INSERT` on the day key, so a re-run or a retried trigger changes nothing.
  At most 30 days a run (catch-up). A failed run is posted to Slack #lianki by
  the monitor. A late `study_day` row for a day already anchored is not added.
- **API**
  - `GET /api/lian/anchors[?limit=&before=]` — public, CORS-open: day,
    merkle root, previous and chain hash, leaf count, version. No user data.
  - `GET /api/lian/proof?day=YYYY-MM-DD` — signed in: the caller's own leaf
    preimage (salt, user id, day, summary), its Merkle proof, the day's root
    and chain hash. The user id is the session's, never a parameter; others'
    leaves appear only as sibling hashes. Without `day`: the caller's days.
- **/dev/lian** (owner only): the anchors, the chain re-verified in the
  browser, the owner's own leaves checked against the roots, and timestamp
  status.

### Checking it yourself

```ts
import { studyDayLeaf, verifyProof, verifyChain } from "@lianki/lian";
const { anchors } = await (await fetch("https://lianki.com/api/lian/anchors")).json();
await verifyChain(anchors.reverse()); // { ok: true, head } — compare head with a published hash
const p = await (await fetch("/api/lian/proof?day=2026-11-07")).json(); // signed in
(await studyDayLeaf(p.preimage)) === p.leafHash &&
  (await verifyProof(p.leafHash, p.proof, p.merkleRoot));
```

## Publishing (milestones, owner-triggered)

The chain only becomes tamper-evident to outsiders once a chain hash leaves
the server. Owner decision: **event-driven, not daily — at his call**.

- `bun scripts/lian/timestamp.ts <day>` — dry run: prints the chain hash.
- `bun scripts/lian/timestamp.ts <day> --go` — submits that day's chain hash
  to the OpenTimestamps calendars (a/b.pool.opentimestamps.org,
  a.pool.eternitywall.com, ots.btc.catallaxy.com; at least two must answer),
  stores the `.ots` receipt in R2 `lianki-blobs/lian/ots/<day>.ots` and a
  `lian_timestamp` row, and leaves a local copy.
- `bun scripts/lian/timestamp.ts upgrade <day> --go` — a few hours later:
  fetches the Bitcoin-anchored path and rewrites the receipt (`status
bitcoin`, block height). Run again if it says "not in a block yet".
- Verify independently: `ots verify -d <chainHash> <day>.ots` (reference
  client), which also checks the Bitcoin block header.
- Also fine at a milestone: commit the chain hash to git (a blog post, a
  release note) — a public, dated copy.

Nothing contacts a calendar without `--go`; the unit tests use a mocked
calendar (`unit/lian-timestamp.test.ts`). Not yet run against the real
calendars.

## Privacy

- Public: per day, the root, the chain hash and the number of leaves (how many
  people studied that day). Nothing per user.
- A user's proof shows them their own preimage and salt; sibling hashes of
  others' leaves are salted and say nothing.
- Deleting an account should delete its `lian_salt` row: the leaves stay (the
  roots depend on them) but nobody can link them to anyone any more.
  `lian_leaf.user_id` is the internal random id, not the email.

## Not done / later

- Other record kinds (reviews, reading) — a new tag, same tree and chain.
- A user-facing page ("your study record, provable") — UI strings need their
  context lines (docs/i18n.md).
- Account deletion hook (above) — there is no account deletion flow yet.
