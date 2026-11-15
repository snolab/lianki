/**
 * Audio on a chat line (docs/li-sound-hub.md, "Playing audio from an agent"):
 * `lianki-dev say --play <src> "caption"` makes the owner's phone play a file
 * or a stream. One strict parser for the CLI, the hub and the page, and the
 * pure autoplay decision. No I/O here: the server never fetches a `src` (no
 * SSRF); only the page's own <audio> element does.
 *
 * `kind` is open for what comes later, so a line's shape never changes:
 * - `file`   an https file (mp3/ogg/wav/webm/m4a…) or `file:<id>` from My Files;
 * - `stream` an https stream: HLS (.m3u8, where the browser plays it), Icecast/HTTP;
 * - `rtc`    phase 2: a live WebRTC track through the voice lane;
 * - `gen`    phase 2: a server-generated stream (ffmpeg / TTS on the Mac or a Worker);
 * - `webaudio` phase 3: the phone builds the sound from a declarative recipe.
 * The wire takes only `file` and `stream` today; the others are refused by name.
 */

/** The flag (lib/flags.ts): audience owner, default off. */
export const PLAY_FLAG = "chat.play-audio";

export const PLAY_KINDS = ["file", "stream", "rtc", "gen", "webaudio"] as const;
export type PlayKind = (typeof PLAY_KINDS)[number];
/** The kinds a line may carry now (phase 1). */
export const PLAY_KINDS_NOW: readonly PlayKind[] = ["file", "stream"];

/** What a line stores (ChatMessage.audio). */
export type LineAudio = {
  /** `https://…` or `file:<id>` (a My Files id). */
  src: string;
  kind: PlayKind;
  /** Guessed from the URL's extension, never fetched. */
  mime?: string;
  /** A short name shown on the chip. */
  title?: string;
};

export const MAX_SRC = 2048;
export const MAX_TITLE = 120;

/** A My Files id (lib/inbox/keys.ts isInboxId). */
const FILE_ID = /^[0-9a-f]{20}$/;

const EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};
export const HLS_MIME = "application/vnd.apple.mpegurl";

/**
 * Hosts never played, whatever the deny list says: names that reach a local
 * network rather than the internet. An IP literal is refused separately.
 */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];

/** A host as an IP literal: dotted IPv4 (the URL parser normalizes 0x7f.1, 2130706433…) or [IPv6]. */
export function isIpHost(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Deny-list entries (a cfg string "a.com, b.org"): lower case, no dots around. */
export function denyList(raw: string | readonly string[] | undefined | null): string[] {
  const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : (raw ?? []);
  return parts.map((s) => s.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
}

/** Is `host` on the list (the name itself or under it)? */
export function hostDenied(host: string, deny: readonly string[]): boolean {
  const h = host.toLowerCase();
  return deny.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The host a src plays from ("lianki.com" for a My Files id): the audit log keeps only this. */
export function srcHost(src: string): string {
  if (src.startsWith("file:")) return "lianki.com";
  try {
    return new URL(src).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export type PlayInput = { src?: unknown; title?: unknown; kind?: unknown };
export type ParsedPlay = { ok: true; audio: LineAudio } | { ok: false; error: string };

const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * A `say --play` checked: an https URL with no credentials and a named,
 * public host, not on the deny list; or `file:<id>`. An explicit `kind` must
 * be one of today's; otherwise the URL says it (.m3u8 or no audio extension:
 * a stream). Anything else is refused with the reason, never guessed.
 */
export function parsePlay(input: PlayInput, opts: { deny?: readonly string[] } = {}): ParsedPlay {
  const raw = typeof input.src === "string" ? input.src.trim() : "";
  if (!raw) return { ok: false, error: "--play needs a src: an https URL or file:<id>" };
  if (raw.length > MAX_SRC) return { ok: false, error: `--play src longer than ${MAX_SRC} chars` };
  let title: string | undefined;
  if (input.title !== undefined) {
    if (typeof input.title !== "string") return { ok: false, error: "title must be text" };
    title = clean(input.title).slice(0, MAX_TITLE) || undefined;
  }
  let kind: PlayKind | undefined;
  if (input.kind !== undefined) {
    if (!(PLAY_KINDS as readonly unknown[]).includes(input.kind))
      return { ok: false, error: `unknown kind ${String(input.kind)} (${PLAY_KINDS_NOW.join(", ")})` };
    if (!PLAY_KINDS_NOW.includes(input.kind as PlayKind))
      return { ok: false, error: `kind ${String(input.kind)} is not built yet (file or stream today)` };
    kind = input.kind as PlayKind;
  }
  const t = title ? { title } : {};
  if (raw.startsWith("file:")) {
    const id = raw.slice(5);
    if (!FILE_ID.test(id)) return { ok: false, error: "file:<id> takes a My Files id (20 hex)" };
    if (kind === "stream") return { ok: false, error: "a My Files file is kind file" };
    return { ok: true, audio: { src: raw, kind: "file", ...t } };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "--play src is not a URL (https://… or file:<id>)" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "--play plays https URLs only" };
  if (u.username || u.password) return { ok: false, error: "no credentials in a --play URL" };
  const host = u.hostname.toLowerCase();
  if (isIpHost(host)) return { ok: false, error: "--play needs a host name, not an IP address" };
  if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))
    return { ok: false, error: `--play needs a public host, not ${host}` };
  if (hostDenied(host, opts.deny ?? []))
    return { ok: false, error: `${host} is on the play deny list` };
  const ext = /\.([a-z0-9]{2,5})$/i.exec(u.pathname)?.[1]?.toLowerCase();
  const hls = ext === "m3u8";
  const fileMime = ext ? EXT_MIME[ext] : undefined;
  const k: PlayKind = kind ?? (fileMime ? "file" : "stream");
  const mime = hls ? HLS_MIME : fileMime;
  return { ok: true, audio: { src: u.href, kind: k, ...(mime ? { mime } : {}), ...t } };
}

/** A stored line's audio read back (history, a hot-loaded bundle): checked again, else dropped. */
export function lineAudioOf(v: unknown): LineAudio | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Record<string, unknown>;
  const p = parsePlay({ src: a.src, title: a.title, kind: a.kind });
  return p.ok ? p.audio : undefined;
}

/** Is this an HLS playlist (the browser must play it natively)? */
export const isHls = (a: Pick<LineAudio, "mime">) => a.mime === HLS_MIME;

/** Why a line's audio did not start by itself. */
export type AutoplayBlock =
  | "flag"
  | "desktop"
  | "hidden"
  | "locked"
  | "mic"
  | "quiet"
  | "history"
  | "tab";

export type AutoplayInput = {
  /** Flag `chat.play-audio` on, and the page's viewer holds `dev` (the flag's audience). */
  flag: boolean;
  /** voice-bg.ts isDesktop(): a computer never plays by itself (his Mac). */
  desktop: boolean;
  /** document.visibilityState is visible. */
  visible: boolean;
  /** This page's player was unlocked in a tap (or the browser says it has been activated). */
  unlocked: boolean;
  /** His mic is open (chat mic or /vibe): never play over it. */
  micOpen: boolean;
  /** `say --quiet`: shown, never sounded by itself. */
  quiet?: boolean;
  /** The line arrived live, not in history after a (re)connect. */
  fresh: boolean;
  /** This tab reads replies aloud for the device (tabs agree on one). */
  speakerTab: boolean;
};

/**
 * Plays by itself only when every condition holds; otherwise the ▶ waits for
 * a tap, with the reason (the chip says it, never silence).
 */
export function autoplayDecision(i: AutoplayInput): { play: true } | { play: false; why: AutoplayBlock } {
  if (!i.flag) return { play: false, why: "flag" };
  if (!i.fresh) return { play: false, why: "history" };
  if (i.desktop) return { play: false, why: "desktop" };
  if (!i.speakerTab) return { play: false, why: "tab" };
  if (i.quiet) return { play: false, why: "quiet" };
  if (!i.visible) return { play: false, why: "hidden" };
  if (i.micOpen) return { play: false, why: "mic" };
  if (!i.unlocked) return { play: false, why: "locked" };
  return { play: true };
}

/** What the hub says to a sender for a refusal (one line, the next step in it). */
export function playRefusal(error: string): string {
  switch (error) {
    case "flag":
      return "playing audio is off (flag chat.play-audio, https://lianki.com/dev/flags#chat.play-audio)";
    case "denied":
      return "that host is on the play deny list (config chat.play.denyHosts)";
    case "scope":
      return "this token lacks the chat:play permission";
    case "rate":
      return "too many audio lines for now (config chat.play.perTenMin); try again later";
    case "unavailable":
      return "could not check the play permission now; nothing was sent";
    default:
      return `play refused: ${error}`;
  }
}
