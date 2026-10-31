-- Where an imported word list came from (/words/import, docs/wordlists-pipeline.md §3a, §4).
--
-- word_lists.src / license: the deck's AnkiWeb page (https://ankiweb.net/shared/info/<id>)
-- and the licence the user got it under ("AnkiWeb (personal use)").
-- word_list_entries.src: the same attribution per word, as JSON
-- ({"source":"ankiweb","url":…,"title":…,"licence":…}); later builds add per-field sources.
ALTER TABLE word_lists ADD COLUMN src TEXT;
ALTER TABLE word_lists ADD COLUMN license TEXT;
ALTER TABLE word_list_entries ADD COLUMN src TEXT;
