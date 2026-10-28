-- The card as it was before its latest review, so that review can be replaced
-- (re-grading a word that is not due again yet) or undone. One level only.
ALTER TABLE word_cards ADD COLUMN prev_card TEXT;
