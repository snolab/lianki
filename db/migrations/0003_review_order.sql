-- Which due card comes next: 'oldest' (most overdue first, the historical
-- behaviour) or 'newest' (least overdue first — whatever just came due).
--
-- Both only ever consider cards already past their due date; this reverses the
-- order within that set and never schedules anything early.
--
-- Defaults to 'oldest' so existing users see no change unless they opt in.
ALTER TABLE preferences ADD COLUMN review_order TEXT NOT NULL DEFAULT 'oldest';
