-- /roadmap: the learner's target date for a goal (YYYY-MM-DD), compared
-- with the pace-based estimate to say on pace / ahead / behind
-- (lib/roadmap/eta.ts paceVerdict). NULL = no target date.
ALTER TABLE roadmap_goals ADD COLUMN target_date TEXT;
