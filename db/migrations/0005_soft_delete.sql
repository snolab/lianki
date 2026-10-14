-- Server-side tombstones, so a deletion can win a merge.
--
-- Until now the cloud deleted rows outright while the userscript kept
-- tombstones locally (`{del: 1, deletedAt, hlc}`, 90-day retention). The
-- asymmetry breaks deletion across devices: the server cannot express
-- "deleted", so any client still holding the card as live re-uploads it on its
-- next addNote and the server happily upserts, because from its side the card
-- simply does not exist. Observed in the wild with two installs on one browser
-- — one deleted, the other resurrected, forever.
--
-- An absence cannot win a merge; only a value can. See docs/sync-merge-rules.md.
--
-- `deleted_at` null means live. Reads filter on it; the row keeps its `hlc` so
-- the tombstone can be compared against an incoming live copy, and keeps `url`
-- so the primary key still suppresses a re-insert. The card body is cleared on
-- delete — a tombstone is a fact about a url, not a copy of what was there.
ALTER TABLE fsrs_notes ADD COLUMN deleted_at TEXT;

-- Every hot read is "live rows for this user", so the index carries the flag.
CREATE INDEX IF NOT EXISTS idx_fsrs_notes_live ON fsrs_notes(email, deleted_at, card_due);
