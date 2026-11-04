-- What a reader grade replaced, so it can be taken back exactly after it was
-- sent (docs/books-plan.md, "Grading from the selection card"): one row per
-- read (read_reviews.id) or per batch of the card's grade handle (its client
-- id). `sentences`: each graded sentence's card row before the grade, or null
-- for one never graded. `words`: each word card the batch graded, with the
-- card it wrote (an undo restores only a card nothing changed since) and
-- whether the batch made it (制卡; the undo removes it again). Short-lived:
-- rows older than a day go as new ones are written.
CREATE TABLE IF NOT EXISTS read_grade_undo (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  material_id TEXT NOT NULL,
  sentences   TEXT NOT NULL,             -- JSON [{ sid, prev: row | null }]
  words       TEXT,                      -- JSON [{ listId, term, after, made }]
  at          TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_read_grade_undo_at ON read_grade_undo (user_id, at);
