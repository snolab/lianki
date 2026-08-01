// Resolving a YouTube video's spoken language. Framework-neutral: takes a fetch
// and an API key, returns a language tag. No DOM, no DB.
//
// This lives server-side because the client genuinely cannot do it. The audio
// language is only exposed through `ytInitialPlayerResponse`, which sits in the
// page's JS world — invisible to a granted userscript sandbox and to an MV3
// isolated content script alike. And YouTube's `<html lang>` is the *interface*
// locale, so trusting it would label every Japanese video "en".

/** Extract the 11-character video id from any normalized YouTube watch URL. */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    const v = u.searchParams.get("v");
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export type VideoLangLookup = {
  /** BCP-47 tag, e.g. "ja" or "pt-BR". */
  lang?: string;
  title?: string;
};

/**
 * Look up up to 50 videos in one call (the API's per-request cap).
 *
 * Prefers `defaultAudioLanguage` — what is actually spoken — over
 * `defaultLanguage`, which describes the title/description metadata and is often
 * the uploader's own locale rather than the audio. Falls back to it only when
 * the audio tag is absent, since a wrong-but-plausible label is worse than none
 * for someone counting immersion hours per language.
 */
export async function lookupYoutubeLanguages(
  videoIds: string[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, VideoLangLookup>> {
  const out = new Map<string, VideoLangLookup>();
  const ids = [...new Set(videoIds.filter((id) => /^[\w-]{11}$/.test(id)))];
  if (!ids.length || !apiKey) return out;

  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", ids.slice(i, i + 50).join(","));
    url.searchParams.set("key", apiKey);

    const res = await fetchImpl(url.toString());
    if (!res.ok) throw new Error(`YouTube API ${res.status} for ${ids.length} id(s)`);
    const body = (await res.json()) as {
      items?: {
        id: string;
        snippet?: { defaultAudioLanguage?: string; defaultLanguage?: string; title?: string };
      }[];
    };

    for (const item of body.items ?? []) {
      const s = item.snippet ?? {};
      const lang = s.defaultAudioLanguage ?? s.defaultLanguage;
      out.set(item.id, { lang: lang || undefined, title: s.title });
    }
  }
  return out;
}
