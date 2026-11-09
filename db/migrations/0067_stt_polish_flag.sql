-- stt.polish-off (an inverted kill switch) becomes stt.polish (ON = polish
-- active, default ON; lib/flags.ts, docs/feature-flags.md). The owner's stored
-- choice carries over inverted: polish-off on means stt.polish off. A key with
-- no row reads as its registry default, so nothing is written when polish-off
-- was never stored. The old row stays as history (a key the registry no
-- longer knows is ignored); a stt.polish row already there is left alone.
INSERT INTO feature_flag_log (key, enabled, at, by)
SELECT 'stt.polish', 1 - enabled, updated_at, 'migration 0067 (from stt.polish-off)'
FROM feature_flags
WHERE key = 'stt.polish-off'
  AND NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = 'stt.polish');

INSERT INTO feature_flags (key, enabled, updated_at, updated_by)
SELECT 'stt.polish', 1 - enabled, updated_at, 'migration 0067 (from stt.polish-off)'
FROM feature_flags
WHERE key = 'stt.polish-off'
ON CONFLICT(key) DO NOTHING;
