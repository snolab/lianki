# YouTube songs as example sentences

Tree: /read/yt-songs

State-tree node `/read/yt-songs`. Owner said go (2026-11-09). Flag
**`read.youtube-songs`**, default off; off, only the owner has it
(<https://lianki.com/dev/flags#read.youtube-songs>,
[feature-flags.md](feature-flags.md)). Status: **M1, M2 (word cards) and M3
built** — /reader → 「+ YouTube song」 (`/reader/youtube`), `POST
/api/read/youtube`, ▶ per line in the reader; a word card made from a song's
line keeps that line's clip, and its example has a ▶ in /words and in the
reader's word review. Not started: a line → sentence card with its clip (the
rest of M2), M4, M5.

**M2 + M3 as built**

- **Stored**: `word_list_entries.clip` (migration 0059), JSON `{v, t0, t1}` in
  ms with the song's offset applied — on the entry, beside `ex`, because the
  example lives there (cards store none). Not on `word_cards`, so the notes /
  cards sync (sync-merge-rules.md) is untouched.
- **Set by the server only**: `bookCtxOf` (`lib/read/reader-route.ts`) gives a
  song's `BookCtx.clipOf` (`songClipFinder`, `lib/yt-songs/card-clip.ts`): the
  first line of the song that holds the example sentence gives the clip. 制卡,
  a graded new word's entry and the review's backfill all go through
  `entryStatements` (`lib/read/book-word-list.ts`), which writes it; an entry
  made before (no clip yet, the same example) gets it then. A client never
  sends a clip.
- **Served**: `GET /api/words/lists/[id]/entries` (`WordEntriesD1Repo`) and the
  reader's `word-session` items carry `clip`; `example-pick.ts` keeps a clip
  with its own sentence.
- **Played**: `YtClipProvider` / `SongClipButton` (`app/components/yt-clip/clip-context.tsx`)
  — one popup per page, mounted on /words and around the reader (whose own line
  ▶ uses the same player) only when songs are on for the viewer. The ▶ sits
  before the example in the row (once the example shows) and in the slip's
  sheet. Grading or moving to another row closes the popup. The popup is the
  M1 one (bottom sheet on a phone, a card near the row on desktop), not yet
  inside the floating word card (open question 1).
- **Tests**: `unit/yt-song-cards.test.ts`; `qa-yt-songs` makes cards from a
  song and plays one from /words.

**M1 as built**

| piece                    | where                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| parser, video id, timing | `lib/yt-songs/timed-text.ts` (`parseTimedText`, `videoIdOf`, `clipSeconds`) |
| song → book, gate        | `lib/yt-songs/song.ts`, `lib/yt-songs/gate.ts` (`ytSongsOn`)                |
| new-song page            | `app/(app)/reader/youtube/` (404 without the flag, owner excepted)          |
| route                    | `app/api/read/youtube/route.ts` (same-origin JSON, 30 per 10 min)           |
| player popup, ▶          | `app/components/yt-clip/`                                                   |
| strings                  | `app/components/yt-clip/yt-songs.content.ts` (16 locales)                   |
| tests                    | `unit/yt-songs.test.ts`                                                     |

Not in M1: tap-to-sync and the offset nudge (M4; `[offset:]` in an LRC is
read), the title from `getVideoData()` (the LRC's `[ti:]` or what he types),
the popup inside the floating word card (M3). Words and sentence cards from
a song's lines work as in any /reader text; their clip on the card is M2.

## Goal

A song the learner loves becomes study material. He pastes a YouTube link
and the song's lyrics with timings; each line becomes a sentence in /reader,
its words become cards, and in word review the example sentence **plays that
line** (t0 → t1) in YouTube's own player, inside a popup. Hearing the line
sung is the point; the text alone is what we already have.

Not a goal: a lyrics catalogue, sharing lyrics, or any audio we hold.

## User flow

1. **/reader → New → YouTube song.** Paste a URL (`youtube.com/watch?v=`,
   `youtu.be/`, `music.youtube.com/watch?v=`; only the video id is kept).
   The page shows the official player so he can check it is the right video.
2. **Lyrics with timings.** One text box that takes:
   - an **LRC** file or paste (`[mm:ss.xx] line`), or
   - an **SRT/VTT** file or paste (cue start/end), or
   - **plain lines**, then **tap-to-sync**: play the video and tap once per
     line as it starts (the tap records `player.getCurrentTime()`); undo the
     last tap; a line's end is the next line's start.
     A global **offset nudge** (−/+ 0.1 s, "the words come early/late") fixes a
     file timed against a different upload of the same song.
3. **Lines → /reader.** The song opens as a /reader document: one passage per
   line, each with a small ▶ that plays that line in the popup. Words are
   marked and graded as in any /reader material (familiarity, the word sheet).
4. **Cards.** Words he adds from a line get that line as their example, with
   the clip attached `{videoId, t0, t1}`; a whole line can also become a
   sentence card.
5. **Review.** In /words (and the read word review) an example sentence that
   has a clip shows a small ▶. **Tap → the popup opens and plays t0 → t1**,
   then stops. Tap ▶ again to replay. Grading closes it.

## The popup player

**Placement.** The player lives in the existing floating word/example card
when one is open (the card grows a 16:9 area above the example), otherwise
in a small modal sheet anchored to the bottom on phones (360 px: full width,
glass, [design-principles.md](design-principles.md)) and near the tapped
row on desktop. One player instance per page, reused for every clip.

**YouTube API terms shape it** (YouTube API Services Developer Policies):
the player must stay **visible** (at least 200 × 200 px), nothing may cover
its controls or branding, and audio must not be separated from video, so
there is no hidden "audio only" player and no background playback. The
popup shows the video; that is the price of using the official player.

**Play after tap (autoplay rules).** iOS Safari and Android Chrome allow
sound only after a user gesture, and the gesture on our page does not
always carry into the cross-origin player iframe.

- The tap that opens the popup creates (first time) or reuses the player
  with `playerVars: {playsinline: 1, controls: 1, rel: 0}` on
  `www.youtube-nocookie.com`, then calls
  `loadVideoById({videoId, startSeconds: t0, endSeconds: t1})` — the
  official API stops at `endSeconds` itself, no timer needed for the end.
- If the player reports it did not start (state stays `CUED`/`UNSTARTED`
  ~1 s after `playVideo()`, the usual iOS case on the first play), the popup
  shows YouTube's own big play button: one more tap, inside the iframe, which
  is a real gesture. Later clips on the same page then play on the first tap
  (the iframe has been activated).
- Keeping the one instance alive while the page lives is what makes replays
  instant; it is destroyed on navigation.
- Clip boundaries: `startSeconds` is honoured at keyframes, so a line may
  start up to ~0.3 s early; the offset nudge absorbs systematic drift.

**Close behaviour.** × button, Escape, tap outside the sheet, the phone's
back gesture (`lib/back-to-close.ts`), grading the card, or moving to the
next card: each **pauses and hides** the popup (the instance is kept for the
next clip). Leaving the page destroys it. Nothing plays after close.

Li sound hub: the player is a sound source, so it registers with `__lkLi`
([li-sound-hub.md](li-sound-hub.md)) — opening a clip pauses Li's read-aloud
and holds the mic closed while it plays.

## Where the timings come from (researched, one picked)

| source                                       | works?                                                                                                                                                     | verdict                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Data API `captions.download`                 | Only for videos **you own** (OAuth as the channel owner); third-party contributions are gone                                                               | **No** — never available for someone else's song               |
| `youtube.com/api/timedtext`                  | Undocumented, unofficial, signed params, breaks without notice; reading it is outside the API terms                                                        | **No**                                                         |
| The IFrame player's caption track            | The player can _show_ captions (`cc_load_policy`), but the API exposes no cue text or times; the iframe is cross-origin, so we cannot read what it renders | **No** — display only                                          |
| **User-pasted LRC/SRT/VTT**                  | Text the user brings; timings in a standard format; nothing fetched from YouTube                                                                           | **Yes — picked**                                               |
| Tap-to-sync on plain lines                   | Official API only (`getCurrentTime`); a few minutes per song                                                                                               | **Yes**, part of the same input (M4)                           |
| Local alignment (whisper on the owner's Mac) | Forced alignment of the lyrics against **audio the user provides** (his own file, never ripped from YouTube); word timestamps → LRC                        | **Later, owner-only helper** (M5): output is just an LRC paste |

**Picked: user-pasted LRC/SRT/VTT**, with tap-to-sync as the no-file path
and local alignment as an optional generator of the same LRC. All three end
in one format (lines with t0/t1), so the rest of the system does not care
where timings came from.

## Architecture

- **Parse** (`lib/yt-songs/timed-text.ts`, pure, unit-tested): LRC (multiple
  stamps per line, `[offset:]` tag), SRT, VTT → `{t0, t1, text}[]` sorted;
  `t1` = next `t0` when missing, last line `t1 = t0 + 8 s` capped by the video
  duration once the player knows it. Video id from the URL: one regex, 11
  chars `[A-Za-z0-9_-]`.
- **Storage (D1)**: the song is a /reader material (`readMaterials`),
  `source_key` `youtube:<videoId>` (the same video again updates it in
  place), its text the lines. **As built in M1** the timings live in the
  material's `BookMeta` (`source: "youtube"`, `yt: {v, offsetMs, clips}`,
  `clips[i] = [t0, t1]` ms for `lines[i]`; `checkYt` in `lib/read/book.ts`)
  instead of a side table: no migration, and it moves with the text. A
  `yt_song_lines` table is only worth it if lines need querying on their own.
  No R2: lyrics are small text. Songs are never offered the AI polish
  (`lib/read/polish-offer.ts`): a rewrite would move words off their times.
- **Cards**: the word's example gains an optional `clip: {v, t0, t1}`
  (milliseconds, offset already applied) next to `ex`/`exTr`; sync carries
  it like any other card field ([sync-merge-rules.md](sync-merge-rules.md)).
- **Player** (`app/components/yt-clip/`): one client island wrapping the
  IFrame API script (`https://www.youtube.com/iframe_api`, loaded on first
  tap only), `play(clip, anchor)`, `close()` (`YtClipPopup.tsx`; the ▶ is
  `ClipButton.tsx`, which stops its events natively so the row's swipe and
  word tap never see them; `use-song-clips.tsx` wires both into the reader).
  The app pages send no CSP today (only `frame-ancestors` on
  `/embed/partner`), so nothing to add; if one comes, it needs
  `frame-src https://www.youtube-nocookie.com` and
  `script-src https://www.youtube.com` on /reader.
- **No YouTube Data API calls in the first slices** (no quota spend); the
  title comes from the player's `getVideoData().title` once loaded, or the
  user types it.

## Security and privacy

- **No audio or video is downloaded, ripped, cached or proxied.** Playback is
  only ever YouTube's embedded player, visible, with its controls.
- **Lyrics are per user and private**: stored in his account only, never in
  a shared cache, a public deck, /books, a blog page, or anything another
  user can open. No "share this song" until a licensing answer exists.
  Export includes them for his own account only.
- Pasted text is untrusted: parsed as text, rendered as text (no HTML), size
  capped (64 KB of lyrics, 500 lines). The URL is reduced to a video id;
  nothing else from it is kept.
- `youtube-nocookie.com` keeps YouTube from setting cookies until play.
- Feature flag off = route 404 and no ▶ on examples.

## Milestones

| #   | slice                                                                                                                                                                                                       | ETA  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1  | **First slice**: /reader → YouTube song: URL + pasted LRC/SRT → lines in a /reader doc; ▶ per line plays t0→t1 in the popup (placement, play-after-tap fallback, close rules). Flag dark, on for the owner. | 3H   |
| M2  | Words from a line → cards carrying `clip`; a line → sentence card                                                                                                                                           | 2.5H |
| M3  | Review: ▶ on an example with a clip in /words and the read word review, popup in the floating card                                                                                                          | 2H   |
| M4  | Tap-to-sync for plain lines + offset nudge                                                                                                                                                                  | 2H   |
| M5  | Owner-only local alignment (whisper on his Mac, his own audio file) → LRC                                                                                                                                   | 3H   |

ETAs include the local gate and ~10M pipeline.

## Open questions

1. Popup on desktop: inside the floating card, or always the modal? (Default
   in M1: the modal; the card in M3.)
2. Is a visible 200 × 200 video acceptable on the phone review screen, or
   should the clip only play from the word sheet?
3. Sentence cards from lines: on by default, or only when he picks a line?
4. M5: which aligner (whisper word timestamps vs a forced aligner such as
   whisperX) — decided when M5 starts, against his local STT setup
   ([local-stt.md](local-stt.md)).
