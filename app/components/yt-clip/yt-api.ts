// YouTube's official IFrame Player API, loaded on the first ▶ tap only
// (docs/youtube-song-examples.md, "The popup player"). The script is
// YouTube's own; the player itself is served from www.youtube-nocookie.com.

/** The part of the IFrame API the clip player uses. */
export interface YtPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  getDuration(): number;
  getVideoData?(): { title?: string };
  destroy(): void;
}

export interface YtPlayerEvent {
  target: YtPlayer;
  data: number;
}

export interface YtNamespace {
  Player: new (
    el: HTMLElement,
    o: {
      host?: string;
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?(e: YtPlayerEvent): void;
        onStateChange?(e: YtPlayerEvent): void;
        onError?(e: YtPlayerEvent): void;
      };
    },
  ) => YtPlayer;
}

/** YT.PlayerState. */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export const YT_HOST = "https://www.youtube-nocookie.com";
const SCRIPT = "https://www.youtube.com/iframe_api";

type Win = Window & {
  YT?: YtNamespace & { loaded?: number };
  onYouTubeIframeAPIReady?: () => void;
};

let loading: Promise<YtNamespace> | null = null;

/** The API, once its script has run; one script tag per page, whoever asks first. */
export function loadYtApi(): Promise<YtNamespace> {
  const w = window as Win;
  if (w.YT?.Player && w.YT.loaded) return Promise.resolve(w.YT);
  if (loading) return loading;
  loading = new Promise<YtNamespace>((resolve, reject) => {
    const before = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      before?.();
      if (w.YT?.Player) resolve(w.YT);
    };
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error("yt-api: script failed"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
