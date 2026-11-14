-- Optional automatic style pack; existing apps keep their current appearance.
ALTER TABLE mini_app ADD COLUMN style TEXT NOT NULL DEFAULT 'lianki'
  CHECK (style IN ('lianki', 'none'));
