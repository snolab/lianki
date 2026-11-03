-- When a reading material (a book on /read) first passed: 95% of its running
-- words known (lib/read/words.ts COVERAGE). Set once by the first request that
-- computes a pass, never overwritten; a later drop below 95% keeps it, and the
-- tick shows faded with this date.
ALTER TABLE read_materials ADD COLUMN passed_at TEXT;
