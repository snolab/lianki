-- Live view (docs/live-view.md): the owner's one pointer to his dev server's
-- front-end JS, signed on his Mac (lib/live-view/rules.ts). One row, id 1.
-- `pointer` is the signed "on" token, NULL when off. `serial` is the highest
-- serial ever accepted, on or off; it is kept when the pointer is cleared, so
-- an older pointer can never be replayed.
CREATE TABLE IF NOT EXISTS live_view (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pointer    TEXT,
  serial     INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);
