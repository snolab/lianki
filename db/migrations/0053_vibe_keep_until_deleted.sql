-- /vibe is the owner's diary (docs/vibe.md, "Keeping"): text stays until it is
-- deleted, and the daily sweep looks only at a number the user chose.
--
-- `chosen` says so. 0052's Preferences field was filled with the old default and
-- saved on blur, so a row holding 30 may never have been chosen: it stays 0 here,
-- which reads as off. Any other number could only have been typed, so it is kept.
-- Writes from the old Worker, until the new one is live, land as 0 as well: the
-- safe way round.
--
-- Nothing is deleted. vibe_doc.other_lang and consent_ms stay as columns, with
-- nothing reading them: the start page writes '' and the time of the tap.
ALTER TABLE vibe_settings ADD COLUMN chosen INTEGER NOT NULL DEFAULT 0;
UPDATE vibe_settings SET chosen = 1 WHERE retention_days != 30;
