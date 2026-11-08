// Who gets YouTube songs on /read (docs/youtube-song-examples.md): the
// `read.youtube-songs` flag, or the owner while it is off
// (docs/feature-flags.md). D1 only: the song is keyed by
// read_materials.source_key, which only D1 has.

import { flagIn, type FlagValues } from "@/lib/flags";

export function ytSongsOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "read.youtube-songs") || owner;
}
