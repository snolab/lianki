-- User-chosen order of word lists. It is also the order new words are
-- learned in when every list is studied together. NULL sorts by creation.
ALTER TABLE word_lists ADD COLUMN position INTEGER;
