-- Where a read material was imported from, when it can be imported again
-- (lib/gdoc: "gdoc:<document id>"). One book per source per user: importing
-- the same Google Doc again updates that book instead of adding a copy.
ALTER TABLE read_materials ADD COLUMN source_key TEXT;
CREATE INDEX IF NOT EXISTS idx_read_materials_user_source ON read_materials (user_id, source_key);
