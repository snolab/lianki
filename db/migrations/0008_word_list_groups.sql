-- Anki-style grouping: a list may sit under a parent. Groups are word_lists
-- rows with source "group:<page>" (no catalog of their own); studying a group
-- studies every list below it.
ALTER TABLE word_lists ADD COLUMN parent_id TEXT;
