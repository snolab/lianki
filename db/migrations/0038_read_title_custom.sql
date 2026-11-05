-- A read material renamed by its owner (/read row menu → Rename). Once set,
-- re-importing the source (a Google Doc's "Sync again") updates the text but
-- keeps the user's title (lib/getReadMaterialsCollection.ts,
-- replaceReadMaterialText).
ALTER TABLE read_materials ADD COLUMN title_custom INTEGER NOT NULL DEFAULT 0;
