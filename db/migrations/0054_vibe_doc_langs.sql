-- /vibe's list (docs/vibe.md, "Pages") shows each conversation's languages. The
-- doc's text can be large and may live in R2, so the list reads them from here:
-- JSON string[], most lines first, written with each saved line. NULL on a doc
-- from before this: the list works them out once from its text.
ALTER TABLE vibe_doc ADD COLUMN langs TEXT;
