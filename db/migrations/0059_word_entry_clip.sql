-- A word's example sung in a YouTube song (docs/youtube-song-examples.md, M2):
-- the line of the song the example came from, as JSON {"v":<video id>,"t0":ms,"t1":ms}
-- (the song's offset already applied). Set only by the server, from the song's
-- own stored timings, when a card is made from a song's line; /words plays it in
-- YouTube's own player. NULL for every other entry.
ALTER TABLE word_list_entries ADD COLUMN clip TEXT;
