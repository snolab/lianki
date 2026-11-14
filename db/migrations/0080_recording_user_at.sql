-- /my/recordings reads one continuous feed, newest first, paged by time
-- (`GET /api/my/recordings?before=<at>&limit=<n>`; owner, 2026-11-15: the
-- list is not cut by day, the page groups by the device's own zone).
-- lib/recordings.ts `recent`: WHERE user_id = ? AND at < ? ORDER BY at DESC, id DESC.
CREATE INDEX IF NOT EXISTS recording_user_at ON recording (user_id, at, id);
