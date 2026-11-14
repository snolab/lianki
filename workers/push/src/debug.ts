/**
 * The remote-eval and chat hub (docs/monitoring.md, "Remote eval (owner
 * debug)", "Chat with the agent" and "Friends").
 *
 * Two kinds of socket meet here, both held with the hibernation API (all
 * state lives in each socket's attachment, so eviction loses nothing):
 *
 *   page        A signed-in user's page in debug mode (app/components/DebugEval.tsx).
 *               index.ts has already asked the main Worker who it is and
 *               passes that on (x-debug-user/-email/-owner/-name/-image). Each page
 *               belongs to a thread: "owner" for the owner's pages, the
 *               user id for anyone else (a "friend").
 *   controller  The sender (scripts/dev/eval.ts). Unauthenticated, so it can
 *               do nothing until approved on a page: the hub shows a prompt
 *               with the controller's label and a short code the CLI prints
 *               too. "Allow" lets it send code for APPROVAL_MS; "Deny", "End"
 *               or the time running out close it.
 *
 * Audiences. Every pairing is for one audience: the owner (a plain pairing)
 * or one friend (`?for=<email>`, which only an owner-approved chat grant may
 * ask for). Its prompt shows only on that audience's pages, only those pages
 * may answer it, and its evals reach only those pages. So the owner's
 * approval never reaches a friend's device, and a friend's never the owner's.
 *
 * One pairing may wait per audience at a time (PENDING_MS at most), so
 * prompts cannot be spammed. No timers and no polling: expiry is checked
 * whenever the next event arrives, and the CLI gives up on its own clock.
 *
 * Page moves. A page that navigates client-side (the socket outlives it)
 * sends {type:"page", label}; the hub relabels that socket alone — later
 * chat, eval targets and listings use the new path — and tells the listeners
 * {type:"page-changed", label, thread, at}. Not stored, never in the chat.
 *
 * Heartbeat. An owner-approved controller sends {type:"busy", to?} while
 * the agent works on a message; the hub passes {type:"busy", label, at}
 * to that one thread's pages (the owner's by default) and acks {type:"beat"}.
 * Nothing is stored: the page's spinner times out on its own. `busy --every`
 * knocks with `?beat=1`: that socket is heartbeat-only — it keeps its grant
 * and hears the chat (to stop at the agent's reply), but is not a session in
 * the menu nor counted in the pages' `listeners` (the "agent offline" cue).
 *
 * Presence. When the last page of a thread closes, the hub notes it and sets
 * the Durable Object alarm for PAGES_IDLE_MS later (a quiet thread has no
 * other event to check on). Still empty then: the listeners get
 * {type:"pages-idle", thread, at} and that thread's heartbeat sockets are
 * closed (PAGES_IDLE). The first page back: {type:"pages-back", thread,
 * label, at}. Controllers and heartbeat sockets never count as a thread's pages.
 *
 * Chat. A page sends {type:"chat", id, text}; an owner-approved controller
 * sends {type:"say", text, to?}. Each becomes a ChatMessage in its thread
 * (the last CHAT_HISTORY per thread, one storage key each), sent to that
 * thread's pages and to every owner-approved controller in time — which hear
 * every thread. A page gets its own thread's history on connect, never
 * another's. Friends chat without approval, at most FRIEND_CHAT_MAX messages
 * per FRIEND_CHAT_WINDOW_MS; the owner can Block one (/dev/friends →
 * /internal/friends), which closes their sockets and refuses them after.
 *
 * Page errors. An owner page sends {type:"page-error", kind, message, stack?,
 * path, status?, at, rev?} (scrubbed on the page: page-errors.ts); the hub
 * adds the socket's own `label` and `hubAt` and forwards it live to the
 * owner-approved listeners (not heartbeat sockets). Never stored, never sent
 * to a page; a friend's page-error is dropped.
 *
 * Avatars. index.ts also passes the user's name and picture (x-debug-name,
 * percent-encoded, and x-debug-image, from better-auth's user.image). The
 * page keeps them as a Sender (wire.ts: the user id hashed, never the
 * email), hears it on connect as {type:"me", sender}, and every line it
 * sends carries it as `sender`. Agent lines have none: the widget draws the
 * host app's logo. Older lines and pages without either still work.
 *
 * Node paths. Messages are addressed to state-tree nodes ("/words/prefetch");
 * a node's assignee (an agent or a human) receives them. A controller
 * subscribes at a node with `?node=<path>&agent=<id>` (absent = "/", the
 * main thread, as before). A chat line with `to: P` (the owner's "@/words …",
 * or an agent's `say` to "/…") reaches the listeners at P, and every
 * ancestor's as `observed: true` — so the root's sees everything; siblings
 * and descendants never. An agent line carries its `taskPath` and `agentId`.
 * An agent may address its own subtree and any ancestor; anything else needs
 * a node grant ({type:"grant", from, to}) from a listener whose node holds
 * both (the root's always may), else {type:"error", reason:"out of scope…"}.
 * Node grants are stored as `ngrant:<from>><to>`. The owner's pages see
 * every line, whatever its node.
 *
 * Voice edits. A page marks an owner line sent from the widget's mic,
 * unchanged, `source: "stt"`. The agent may polish it ({type:"edit", id,
 * text}). Polish is unrestricted (owner, 2026-11-14): any of the owner's own
 * lines in the owner thread, typed or spoken, any words, any number of times.
 * What stays: the sender holds a live owner grant (chat or eval; never a
 * friend's pairing), and flag stt.polish is on. The first text stays as
 * `raw`; `edited: {at, by, count}` marks it. Pages and
 * listeners hear {type:"edited", id, thread, text, raw, edited}. Friends'
 * lines never. {type:"summary", ids|last, text} collapses a consecutive run
 * of those voice lines (room talk) into one line saying what was said; the
 * others stay stored with `collapsedInto`. {type:"merge", ids, text} rewrites
 * a run of his consecutive voice lines as ONE fluent passage (mergeCheck:
 * two lines and a text, nothing more); the first line keeps what it read in
 * `premerge` and {type:"unmerge", id} (his page, or the lane) restores the
 * run. All need flag stt.polish (on by default).
 *
 * Continuous speech (flag stt.merge, voice-merge.ts; docs/dev-debug-widget.md,
 * "Continuous speech amends the last line"). With the flag on, an owner's voice
 * line is stamped `mergeable`. A next voice line carrying `continues: <that id>`
 * amends it, if it is still the thread's very latest line and mergeVerdict and
 * the checks in merge() pass; else it is a new line, as ever. Same edit path:
 * pages and listeners hear {type:"edited", …, parts, merged}, with the complete
 * text. Every part's raw text is kept in `parts`; {type:"unmerge", id} from an
 * owner's page splits the line back. {type:"passage-end"} from the page that
 * spoke tells the listeners {type:"polish-due", …}: one polish for the passage,
 * read from the merged raw text, none while it is still being spoken.
 *
 * Two mics, one line (flag stt.two-mic-merge, on by default; two-mic.ts;
 * docs/dev-debug-widget.md, "Two mics, one line"). Before an owner's voice
 * line is posted, twoMicMatch looks for his voice line from ANOTHER page
 * within config chat.twoMicWindowMs saying the same sentence: then it is not
 * posted. Its text replaces the stored one in place (the same edit path,
 * edited.by "two-mic") when twoMicKeep prefers it, else it is dropped.
 *
 * Resumable grants. The owner's Allow hands the controller a random grant
 * token; only its SHA-256 is stored (`grant:<hash>`), and reconnecting with
 * it (header x-debug-token, or x-liagent-token via index.ts) restores what
 * was granted without a prompt until it expires or End revokes it:
 *   "Allow chat for 30 days"  scope "chat" (no eval), CHAT_MS.
 *   "Allow" for eval          scope "eval" (and chat), EVAL_GRANT_MS, with the
 *                             page ids it covers (or all) — so a sender that
 *                             disconnects, or is closed because its pages
 *                             were away (PAGES_GONE), comes back silently.
 * A stored eval grant with no socket holding it is still listed in the owner
 * pages' sessions (code "idle"), so End reaches it while it sleeps. A
 * friend's preview pairing is never stored: one socket, APPROVAL_MS.
 *
 * Renewal (the owner's eval grant only). The Allow binds the grant to the
 * answering page's device id and sign-in session (`renew`: {device, session,
 * user, start, count}; a session tag is a hash, lib/dev-eval.ts sessionTag). With
 * at most EVAL_RENEW_BEFORE_MS left, it is extended to EVAL_GRANT_MS from
 * now — never past start + EVAL_CHAIN_MS, after which a tap is needed again —
 * on any of these events, and only while an owner page of that device and
 * session (unexpired) is connected, and the main Worker confirms right then
 * that the session is still live in the auth db (the SESSIONS binding to its
 * DebugSessions RPC entrypoint, worker.ts; at most once per grant per 30 s;
 * any doubt = no renewal, "gone" = stopRenewal). The write after that answer
 * re-reads the grant and re-checks it all under blockConcurrencyWhile, so
 * an End or sign-out that landed meanwhile wins:
 *   use     a message from a socket holding the grant
 *   resume  a reconnect with its token
 *   page    that device's page connecting
 *   alarm   the one alarm set for until − EVAL_RENEW_BEFORE_MS
 * No polling. Each socket holding the grant hears {type:"renewed", until,
 * count} (its attachment's `until` moves too); `debug.renew` logs the count
 * and device. End (revoke) deletes the grant, so nothing renews; the session
 * being deleted (sign-out: the main Worker's POST /internal/signed-out)
 * drops `renew` from every grant bound to it at once, and the session from
 * every owner page attachment that carried it. A chat grant, a
 * friend's preview, and a grant approved without a session (the dev bridge,
 * an older main Worker) are never renewed.
 *
 * Token chat (token-chat.ts; `lianki chat`). A third kind of socket, and
 * POST calls, at /api/version/chat: an API token's say / ask / read / listen,
 * only in its account's own thread (the owner's, or that user's), as an agent
 * line labelled with the token's name. Never a page or a controller: no eval,
 * pairing, grant, inbox, clips or answer. A token ask's `answered` goes to
 * that thread's pages and the same lane's token sockets only.
 *
 * Eval tokens (lib/eval-token.ts; docs/secrets-and-auth.md, "Eval tokens"). A
 * controller that connects with an API token holding `eval` (index.ts passes
 * it as EVAL_TOKEN_HEADER, from Authorization only) is approved by the main
 * Worker, not a tap: an eval session in the owner's thread until the token
 * expires, on every owner page (a box's only with box:eval). The main Worker
 * checks it again, and audits, before each eval; a refusal closes it, as does
 * a revoke notice. Only its hash and tag are kept, never the token.
 *
 * Voice-clip recording (packages/debug-chat/src/clips.ts). The switch is a
 * window session's, held here, never in an origin's storage. An owner page
 * knocks with `?ws=<its window's session id>&dev=<device id>` (and
 * `&hand=<token>` when it came from another origin). Only a recording session
 * is stored, as `clips:<sid>` {device, at, until?, sink?, handoff (a token's
 * SHA-256), goneAt?, hidden?}; it is deleted when recording stops, at its
 * auto-stop, or once no page of it has been connected for CLIPS_GONE_MS
 * (CLIPS_HIDDEN_MS when its last page said it was hidden: a phone's screen
 * off). Every page of the session hears {type:"clips", …} on connect and on
 * each change, with a fresh one-time handoff token: a page that redeems it
 * (`hand=`) joins the session and takes its device id. A page with no token
 * whose device had a session lose its page moments ago (an address typed by
 * hand) continues it; another device's is only offered (`resumable`, a tap).
 * A page silently rejoins its own session after a long gap only when it is
 * the same document coming back (`cont=1`: the screen was off); a tab closed
 * while hidden and restored, or one back from the bfcache (`back=1`: it went
 * through pagehide; never joined by itself, even right away), is offered it.
 * The sink the agent set up (`clipsink`: URL, write key, the owner's exact
 * origins) is what a tap reuses; pages get the key and the origins only
 * while their session records.
 * Pages turn it on (a tap) and off; the agent too ({type:"clips", op}). Never
 * a friend's. Clips themselves never pass through here.
 */
import {
  APPROVAL_MS,
  CHAT_HISTORY,
  CHAT_MS,
  type ChatContext,
  type ChatMessage,
  EVAL_CHAIN_MS,
  EVAL_GRANT_MS,
  EVAL_RENEW_BEFORE_MS,
  FRIEND_CHAT_MAX,
  FRIEND_CHAT_WINDOW_MS,
  type EditedEvent,
  type FriendRecord,
  EDITABLE_LINES,
  MERGE_LINES,
  type SummaryMark,
  type PassageMark,
  type HubState,
  type Identity,
  MAX_LABEL,
  type NodeGrant,
  OWNER_THREAD,
  ROOT_NODE,
  PAGE_ENDED,
  PAGE_GONE_GRACE_MS,
  PAGES_GONE,
  PAGES_IDLE,
  PAGES_IDLE_MS,
  PENDING_MS,
  type PairInfo,
  type Scope,
  type Sender,
  agentIdOf,
  cleanLabel,
  isPageId,
  isSessionTag,
  isWithin,
  mayAddress,
  nodePath,
  isUserId,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  routeTo,
  senderOf,
  shortCode,
} from "../../../lib/dev-eval";
import { type EvalGrantConf, readEvalGrantConf } from "../../../lib/eval-grant-config";
import {
  type Ask,
  type AskAnswer,
  askState,
  askText,
  checkChoices,
} from "../../../packages/debug-chat/src/ask";
import type {
  AnsweredEvent,
  PolishDueEvent,
  SpeakerTag,
  SttScene,
  SttTag,
  WithdrawnEvent,
} from "../../../packages/debug-chat/src/wire";
import { verifySpeakerProofs } from "../../../lib/speaker-proof";
import { mergeCheck, polishCheck, summaryCheck } from "../../../packages/debug-chat/src/polish";
import { MAX_UTTERANCE_MS } from "../../../packages/debug-chat/src/mic";
import {
  type MergeCandidate,
  UNMERGE_BY,
  lastPartAt,
  mergeLines,
  mergeVerdict,
  passageSpeakers,
  splitLine,
} from "../../../packages/debug-chat/src/voice-merge";
import {
  TWO_MIC_BY,
  TWO_MIC_WINDOW_MAX,
  TWO_MIC_WINDOW_MS,
  twoMicKeep,
  twoMicMatch,
} from "../../../packages/debug-chat/src/two-mic";
import { PARTNER_SUBPROTOCOL, STT_TICKET_SKEW_S } from "../../../lib/stt-ticket";
import {
  HISTORY_LINES,
  HISTORY_MAX_CHARS,
  MAX_OUTPUT_TOKENS,
  PARTNER_AI_FLAG,
  PARTNER_AI_LABEL,
  type PartnerRequest,
  type PartnerResult,
  SITE_DAILY_USD,
  USER_DAILY_TOKENS,
  costUsd,
  jstDay,
  reserveInTokens,
} from "../../../lib/partner-ai-config";
import { CHAT_PATH, REVOKED_PATH, TokenChat, partKey, tokenAtt } from "./token-chat";
import {
  type PartRecord,
  nextExpiry,
  presentList,
} from "../../../packages/debug-chat/src/presence";
import { AVATAR_PATH } from "../../../packages/debug-chat/src/svg-avatar";
import { BOX_HEADER, EMBED_HEADER } from "./auth";
import { type ChatLogRequest, chatLogLine, passageLogId } from "../../../lib/chat-log-line";
import {
  ETA_AGENT,
  ETA_FLAG,
  ETA_HEARD_PATH,
  ETA_LABEL,
  ETA_PATH,
  etaLineText,
  forLanes,
  parseEtaPing,
} from "../../../lib/eta-ping";
import {
  CLIPS_GONE_MS,
  CLIPS_HIDDEN_MS,
  type ClipsControl,
  type ClipsState,
  LIANKI_ORIGIN,
  isClipsId,
  isHandoffToken,
  matchesSession,
  parseClipsControl,
  parseClipsPageMessage,
  randomId,
} from "../../../packages/debug-chat/src/clips";

export type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
export type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>;
  /** The Durable Object alarm: one per hub (pages idle, clips auto-stop, eval-grant renewal). */
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
};
export type DebugState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  /**
   * Answer a fixed message without waking the hub (the runtime's
   * WebSocketRequestResponsePair): the listeners' keepalive ping.
   */
  setWebSocketAutoResponse?(pair?: unknown): void;
  /** The runtime's gate: no other event is delivered until `f` settles. */
  blockConcurrencyWhile?<T>(f: () => Promise<T>): Promise<T>;
  storage: Storage;
};
/** A controller's keepalive (scripts/dev/keepalive.ts): "ping" is answered "pong". */
export const KEEPALIVE = { ping: "ping", pong: "pong" } as const;
type PairCtor = new (request: string, response: string) => unknown;
/**
 * `thread` is "owner" or the friend's user id; `email` is the friend's. `id`
 * names the socket in the chat menu's page list; `at` is when it connected.
 * (Sockets from before the list have neither: listed without an End.)
 */
type PageAtt = {
  role: "page";
  label: string;
  thread: string;
  email?: string;
  /** Who the page's user is, for the avatars on their lines (hashed id, name, picture). */
  sender?: Sender;
  id?: string;
  at?: number;
  /** The owner's window session (clips.ts) and device; never on a friend's page. */
  sid?: string;
  device?: string;
  /** The owner's sign-in session (a tag, never the id) and its expiry; never on a friend's page. */
  session?: string;
  sessionUntil?: number;
  /** The owner's user id, kept with the session (the main Worker's lookup key). */
  user?: string;
  /** The page said it is going (pagehide): it no longer holds its session open. */
  leaving?: boolean;
  /**
   * The Learning Partner on another site (a ticket socket, index.ts): the
   * owner's thread, chat only. It never gets eval, never counts for a
   * pairing or a grant's pages, never joins a recording session.
   */
  embed?: true;
  /**
   * The owner's box (docs/box-oauth.md, "Chat on the owner's box"): an embed
   * page from that box client's exact origin. Chat only as above, plus what
   * the chat itself needs (voice amends, ask-card taps). Each line it sends is
   * checked with the main Worker first; revoked, it is closed.
   */
  box?: string;
  /**
   * The owner's box with box:eval (docs/box-oauth.md, "Code on the owner's
   * box"): then not `embed`, but an owner page in full, minus clips and
   * renewal (it carries no session or device): it takes eval, can answer a
   * pairing, sends page errors, and gets the whole state. Asked of the main
   * Worker at connect, before each eval sent to it and before each such
   * message it sends; gone, the page drops back to chat-only.
   */
  boxEval?: true;
};
/** A recording window session (`clips:<sid>`), see "Voice-clip recording" above. */
type ClipsRec = {
  sid: string;
  device: string;
  at: number;
  until?: number;
  sink?: string;
  /** SHA-256 of the current handoff token. */
  handoff?: string;
  /** When its last page left; absent while one is connected. */
  goneAt?: number;
  /** Its last page said it was hidden (a longer grace). */
  hidden?: boolean;
  /** The last page's label, for the agent's list and a "Continue" offer. */
  label?: string;
  /** The sink's write key (clip-sink.ts), for this session's pages only. */
  sinkKey?: string;
  /** The owner's origins the session may be handed to, exactly. */
  origins?: string[];
};
const clipsKey = (sid: string) => `clips:${sid}`;
/**
 * The sink the agent set up (`clips on --sink`, with its write key and the
 * owner's origins), kept so a tap on a page can turn recording on later.
 * Configuration, not a session: replaced by the next `clips on --sink`.
 */
type SinkConfig = { url: string; key: string; origins: string[]; at: number };
const SINK_CONFIG = "clipsink";
/**
 * `grant` is the hash of the resumable chat token this socket holds, if any.
 * `forUser`/`forEmail`: the friend this pairing is for; absent = the owner.
 */
type RememberedTrust = { user: string; device: string; at: number };
const trustKey = (hash: string) => `eval-trust:${hash}`;
/** Security work bound: at most eight distinct auth-session RPCs per remembered use. */
const REMEMBERED_SESSION_CANDIDATES = 8;

type ControllerAtt = {
  rememberedSession?: string;
  remembered?: RememberedTrust;
  role: "controller";
  grant?: string;
  /** Approved for these page ids only ("Authorize this page"); absent = all. Eval only. */
  pages?: string[];
  /** When none of `pages` was last seen open (cleared when one is back). */
  goneSince?: number;
  /**
   * A heartbeat-only socket (`eval.ts busy`, knocking with `?beat=1`): it
   * keeps its grant and hears the chat, but is not a session nor a listener
   * in the pages' count.
   */
  beat?: boolean;
  /** The thread a heartbeat socket last beat for (closed when that thread goes idle). */
  beatThread?: string;
  forUser?: string;
  forEmail?: string;
  /** The state-tree node this listener is subscribed at (`?node=`); absent = "/". */
  node?: string;
  /** The node's assignee (`?agent=`): the agent's id on its lines. */
  assignee?: string;
  /**
   * An eval token's sender (lib/eval-token.ts; docs/secrets-and-auth.md, "Eval
   * tokens"): the token's SHA-256 (never the secret), its tag and its account.
   * Approved by the main Worker, not a tap; every eval it sends is asked again.
   */
  evalToken?: string;
  tokenTag?: string;
  tokenUser?: string;
} & PairInfo;
/**
 * A stored grant (`grant:<sha256 of its token>`). `scope` absent = "chat"
 * (grants from before eval grants were stored). `pages`: the owner's page ids
 * an eval grant reaches (absent = all). `at`: when it was allowed. `renew`:
 * the owner's eval grant only, what its renewal is bound to ("Renewal" above).
 */
type Grant = {
  /** Descriptor only: eval-trust:<controller hash> is the revocable authority. */
  remembered?: RememberedTrust;
  label: string;
  until: number;
  scope?: Scope;
  pages?: string[];
  at?: number;
  renew?: Renewal;
  /** An eval grant's length at the tap (`debug.evalGrantHours`); absent = EVAL_GRANT_MS. Renewals extend by it. */
  ms?: number;
  /**
   * The device each of `pages` was open on when it was granted (the page's
   * `dev=` id), so a page that comes back on that device under a new page id
   * (the app restarted: a new tab, a new sessionStorage) takes its place —
   * "Rejoin" in docs/monitoring.md. Absent for a page with no device id.
   */
  devices?: Record<string, string>;
};
/**
 * The approving page's device id and session tag, when the chain began (the
 * tap), and how many times it was renewed since.
 */
type Renewal = {
  device: string;
  session: string;
  /** The owner's user id: what the main Worker looks the session up under. */
  user?: string;
  start: number;
  count: number;
};
/** In the renewal window: at most EVAL_RENEW_BEFORE_MS left (so "not due" is strictly before it). */
const renewDueAt = (until: number, t: number) => until - t <= EVAL_RENEW_BEFORE_MS;
/**
 * The main Worker's DebugSessions RPC entrypoint (worker.ts, over the
 * SESSIONS service binding: no URL, nothing public): "live" | "gone" | "busy".
 */
type SessionsRpc = {
  prepareChatTurn?(req: { userId: string; input: unknown }): Promise<unknown>;
  /** Automatic polish of the owner's spoken lines (lib/chat-polish.ts); an older main Worker has none: no auto polish. */
  polishLines?(req: { userId: string; input: unknown }): Promise<unknown>;
  live(user: string, session: string): Promise<unknown>;
  /** A feature flag's value (lib/flags.ts); an older main Worker has no such method. */
  flag?(key: string): Promise<unknown>;
  /** The Learning Partner's AI reply for a non-owner thread (lib/partner-ai.ts). */
  partnerReply?(req: PartnerRequest): Promise<unknown>;
  /** The chat inbox's agent ops (lib/inbox/agent.ts); an older main Worker has none. */
  inbox?(req: { op: string; id?: string }): Promise<unknown>;
  /** An eval token's connect or use (lib/eval-token.ts); an older main Worker has none: refused. */
  evalToken?(req: {
    op: "connect" | "use";
    token?: string;
    tokenHash?: string;
    len?: number;
    target?: string;
  }): Promise<unknown>;
  /** `lianki chat`: an API token's check for one chat operation (lib/chat-token.ts). */
  chatToken?(req: {
    op: string;
    token?: string;
    tokenHash?: string;
    client?: string;
  }): Promise<unknown>;
  /** May this box keep chatting (docs/box-oauth.md)? An older main Worker has none: no. */
  boxChat?(clientId: string): Promise<unknown>;
  /** May this box hold the owner's page powers (docs/box-oauth.md)? An older main Worker has none: no. */
  boxEval?(clientId: string): Promise<unknown>;
  /** The account's chat history (lib/chat-log.ts); an older main Worker has none: not kept. */
  chatLog?(req: ChatLogRequest): Promise<unknown>;
  /** A live config value (lib/config.ts registry keys; the default when unset or invalid). */
  config?(key: string): Promise<unknown>;
};
/** POST, from the main Worker over its binding: the owner thread's history into D1, once. */
export const CHAT_BACKFILL_PATH = "/internal/chat-backfill";
/** How long the hub trusts its read of PARTNER_AI_FLAG (as lib/flags-store.ts's FLAG_CACHE_MS). */
const AI_FLAG_CACHE_MS = 30_000;
/** The AI's spinner is re-sent this often while the model works (the page's BUSY_MS is 12 s). */
const AI_BEAT_MS = 8_000;
/** Daily usage keys (docs/partner-ai.md, "Caps"): a user's tokens, the site's micro-USD. */
const aiUserKey = (day: string, userId: string) => `ai:${day}:u:${userId}`;
const aiSiteKey = (day: string) => `ai:${day}:site`;
/** The owner's switch for agent polish and summaries of his voice lines: ON (the default) = active (lib/flags.ts, /dev/flags). */
export const POLISH_FLAG = "stt.polish";
/** The owner's switch for continuous speech amending the last line (voice-merge.ts). */
export const MERGE_FLAG = "stt.merge";
/** The owner's switch for one line from two mics (two-mic.ts): ON (the default) = active. */
export const TWO_MIC_FLAG = "stt.two-mic-merge";
/** The live window between two mics' copies of one sentence (lib/config.ts). */
export const TWO_MIC_WINDOW_KEY = "chat.twoMicWindowMs";
/** How many of the newest lines a two-mic look reads: a few seconds hold far fewer. */
const TWO_MIC_SCAN = 20;
/** Automatic polish of the owner's spoken lines (lib/flags.ts, on by default; "Automatic polish" below). */
export const AUTO_POLISH_FLAG = "voice.auto-polish";
/** The `by` an automatic polish or merge is stamped with (an agent's carries its label). */
export const AUTO_POLISH_BY = "auto";
/** Lines further apart than this are never one automatic run (an old unpolished line is left alone). */
export const AUTO_POLISH_RUN_MS = 60_000;
/** Kept lines before the run sent as context (lines, each cut to AUTO_POLISH_CONTEXT_CHARS). */
export const AUTO_POLISH_CONTEXT = 6;
export const AUTO_POLISH_CONTEXT_CHARS = 300;
/** Defaults for the live config the hub reads (lib/config.ts: voice.autoPolish*). */
export const AUTO_POLISH_TAIL_MS = 1500;
export const AUTO_POLISH_MIN_CHARS = 2;
/** How long the hub trusts its read of the auto-polish config. */
const AUTO_POLISH_CONF_MS = 60_000;

/** A timer the hub can set and clear (injectable, so the suites fire it by hand). */
export type HubTimer = {
  set(f: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimer: HubTimer = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
/** At most one live-session check per grant in this long (a burst of uses asks once). */
const SESSION_CHECK_MIN_MS = 30_000;
/** A sleeping eval grant's pair id in the pages' state: "g:" + the start of its hash. */
const DORMANT = "g:";
const dormantPair = (hash: string) => `${DORMANT}${hash.slice(0, 40)}`;
/** A friend's chat rate window. */
type Rate = { start: number; count: number };
/** The header a controller resumes its chat grant with. */
const TOKEN_HEADER = "x-debug-token";
/** An eval token (lib/eval-token.ts), set by index.ts from the sender's Authorization header only. */
export const EVAL_TOKEN_HEADER = "x-debug-eval-token";
/** Who a page is: set by index.ts from the main Worker's answer, never by the page. */
export const IDENTITY_HEADERS = {
  user: "x-debug-user",
  email: "x-debug-email",
  owner: "x-debug-owner",
  /** Percent-encoded display name, and picture URL: the chat's avatars only. */
  name: "x-debug-name",
  image: "x-debug-image",
  /** The sign-in session's tag and expiry (ms): what an eval grant's renewal is bound to. */
  session: "x-debug-session",
  sessionUntil: "x-debug-session-until",
} as const;
/** The main Worker tells the hub a session was deleted (sign-out), over its PUSH binding. */
const SIGNED_OUT_PATH = "/internal/signed-out";
/** The main Worker tells the hub a box lost box:chat, over its PUSH binding. */
const BOX_CLOSED_PATH = "/internal/box-closed";
/** A box chat socket closed because its box lost box:chat (hub-side, on purpose). */
export const BOX_CLOSED = 4401;
/** What a box page may send (docs/box-oauth.md): the chat, and nothing of eval or recording. */
const BOX_PAGE_TYPES = new Set(["chat", "page", "passage-end", "unmerge", "answer"]);
/** What a box page with box:eval may send besides: pairing answers, results, page errors. */
const BOX_EVAL_TYPES = new Set([
  "allow",
  "deny",
  "revoke",
  "end-page",
  "result",
  "chunk",
  "page-error",
]);
type Att = PageAtt | ControllerAtt;
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

const att = (ws: Socket): Att | null => {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
};
const send = (ws: Socket, msg: unknown) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
};
/** The main Worker's yes to an eval token (lib/eval-token.ts), or null for anything else. */
function evalTokenOk(
  v: unknown,
): { id: string; tag: string; name: string; expiresAt: number; userId?: string } | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    r.ok !== true ||
    typeof r.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(r.id) ||
    typeof r.tag !== "string" ||
    typeof r.name !== "string" ||
    typeof r.expiresAt !== "number"
  )
    return null;
  return {
    id: r.id,
    tag: r.tag,
    name: r.name,
    expiresAt: r.expiresAt,
    ...(typeof r.userId === "string" ? { userId: r.userId } : {}),
  };
}
/** A box page's label starts with "box ", so the agent and the page list tell it apart. */
const boxLabel = (label: string, isBox: boolean) =>
  isBox ? cleanLabel(`box ${label}`, MAX_LABEL) : label;
const close = (ws: Socket, code: number, reason: string) => {
  try {
    ws.close(code, reason);
  } catch {}
};
/** A pairing as pages see it: `scope` is what was granted, or (pending) what is asked for. */
const info = ({
  pair,
  code,
  label,
  at,
  until,
  scope,
  pages,
  grantMs,
  allPages,
  remembered,
}: ControllerAtt): PairInfo =>
  until
    ? {
        pair,
        code,
        label,
        at,
        until,
        scope: scope ?? "eval",
        ...(remembered ? { persistent: true } : {}),
        ...(pages ? { pages } : {}),
      }
    : {
        pair,
        code,
        label,
        at,
        scope: scope ?? "eval",
        // What Allow will grant (the live config read at the knock): the modal says it.
        ...(grantMs ? { grantMs } : {}),
        ...(allPages ? { allPages } : {}),
      };
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const hashToken = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const head = (text: string) => text.slice(0, 80);
/** A clips message (small, JSON, of a known type), parsed; null when it is something else. */
function clipsParse<R>(raw: unknown, f: (m: Record<string, unknown>) => R | null): R | null {
  if (typeof raw !== "string" || raw.length > 2000 || !raw.includes('"clips')) return null;
  try {
    const m = JSON.parse(raw) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? f(m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
/**
 * The state one page is sent. An embedded page (a ticket socket on another
 * site) gets the listener count only: never a pairing, a session, a grant,
 * the page list (labels, ids) or the nodes, and no `self`.
 */
function pageState(a: PageAtt, s: HubState): HubState & { self?: string } {
  if (a.embed) return { type: "state", pending: null, sessions: [], listeners: s.listeners ?? 0 };
  return { ...s, self: a.id };
}

/** Whose a socket is: a page's thread, or the audience a controller was paired for. */
const audience = (a: Att) => (a.role === "page" ? a.thread : (a.forUser ?? OWNER_THREAD));

/**
 * A thread's storage keys. The owner's keep the keys from before threads
 * (`seq`, `msg:<seq>`), so its history carries over; a friend's live under
 * `t:<userId>:` (user ids have no ":", so no prefix holds another's).
 */
const threadKeys = (thread: string) =>
  thread === OWNER_THREAD
    ? { seq: "seq", prefix: "msg:" }
    : { seq: `t:${thread}:seq`, prefix: `t:${thread}:msg:` };
const msgKey = (thread: string, seq: number) =>
  `${threadKeys(thread).prefix}${String(seq).padStart(12, "0")}`;
const friendKey = (userId: string) => `friend:${userId}`;
const nodeGrantKey = (from: string, to: string) => `ngrant:${from}>${to}`;
/** Where a controller listens, from its knock: `?node=` (a node path) and `?agent=`. */
const whereOf = (url: URL) => {
  const node = nodePath(url.searchParams.get("node") ?? undefined);
  const assignee = agentIdOf(url.searchParams.get("agent") ?? undefined);
  return {
    ...(node && node !== ROOT_NODE ? { node } : {}),
    ...(assignee ? { assignee } : {}),
  };
};
/** A history as one listener sees it: only the lines routed to its node. */
const forNode = (list: ChatMessage[], node?: string) =>
  node ? list.filter((m) => routeTo(node, m.to)) : list;

/** The progress hub's namespace (the PROGRESS binding of this Worker). */
type ProgressNs = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
};

export class DebugHub {
  /**
   * Every stored grant by hash: read once per instance (an evicted hub reads
   * it again), then kept in step with each write. Only the pages' listing of
   * sleeping eval grants reads it; a resume always asks storage itself.
   */
  private grants?: Map<string, Grant>;
  private loadingGrants?: Promise<void>;
  /** STT_SPEAKER_PUB: the Mac's attestation key (lib/speaker-proof.ts). */
  private speakerPub?: string;
  /** A renewal in flight per grant hash: two events at once renew once. */
  private renewing = new Map<string, Promise<void>>();
  /** The main Worker (service binding): asked whether a renewal's session is still live. */
  private sessions?: SessionsRpc;
  /** When each grant's session was last checked (the per-grant rate limit). */
  private checkedAt = new Map<string, number>();
  /** The last read of PARTNER_AI_FLAG (AI_FLAG_CACHE_MS). */
  /** `unsure`: the flag could not be read (an RPC error, "busy"); the AI cannot answer then. */
  private aiFlag?: { at: number; on: boolean; unsure?: true };
  private mergeFlag?: { at: number; on: boolean };
  /** The last read of TWO_MIC_FLAG and TWO_MIC_WINDOW_KEY (AI_FLAG_CACHE_MS). */
  private twoMicConf?: { at: number; on: boolean; windowMs: number };
  /** Per thread: when an agent line (a lane's `say`, or the AI's) was last posted. */
  private agentAt = new Map<string, number>();
  /** Per thread: the latest AI turn started (a newer message makes an older reply stale). */
  private aiTurn = new Map<string, number>();
  /** `lianki chat`: API-token sockets and calls, each in its account's own thread (token-chat.ts). */
  private tokens: TokenChat;
  /** The progress hub (same Worker): told when a listener connects, so queued ETA lines go out. */
  private progress?: ProgressNs;

  constructor(
    private ctx: DebugState,
    env?: unknown,
    private now: () => number = Date.now,
    private timer: HubTimer = realTimer,
  ) {
    // The Mac's speaker-attestation public key (voiceprint.py attest-key); without it no tag is kept.
    this.speakerPub = (env as { STT_SPEAKER_PUB?: string } | undefined)?.STT_SPEAKER_PUB;
    this.sessions = (env as { SESSIONS?: SessionsRpc } | undefined)?.SESSIONS;
    this.progress = (env as { PROGRESS?: ProgressNs } | undefined)?.PROGRESS;
    this.tokens = new TokenChat({
      now: () => this.now(),
      rpc: () => this.sessions,
      sockets: () => this.ctx.getWebSockets(),
      post: (m) => this.post(m),
      history: (thread) => this.history(thread),
      blocked: async (userId) =>
        (await this.ctx.storage.get<FriendRecord>(friendKey(userId)))?.blocked === true,
      kv: {
        get: (k) => this.ctx.storage.get(k),
        put: (k, v) => this.ctx.storage.put(k, v),
      },
      presence: (thread) => this.presenceSoon(thread),
    });
    // The listener pings to find a socket that died without a close (a
    // redeploy, a dropped connection); the runtime answers it while the hub
    // hibernates, so it costs no wake-up.
    const Pair = (globalThis as { WebSocketRequestResponsePair?: PairCtor })
      .WebSocketRequestResponsePair;
    if (Pair) ctx.setWebSocketAutoResponse?.(new Pair(KEEPALIVE.ping, KEEPALIVE.pong));
  }

  /** Open sockets of one role, optionally leaving one out (the one closing). */
  private sockets<R extends Att["role"]>(role: R, except?: Socket) {
    const out: { ws: Socket; a: Extract<Att, { role: R }> }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || (ws.readyState !== undefined && ws.readyState > 1)) continue;
      const a = att(ws);
      if (a?.role === role) out.push({ ws, a: a as Extract<Att, { role: R }> });
    }
    return out;
  }

  /** The pages of one thread. */
  private pages(thread: string, except?: Socket) {
    return this.sockets("page", except).filter((p) => p.a.thread === thread);
  }

  /**
   * The pages of `thread` a controller reaches live: all of them, unless it
   * was authorized for some pages only and this is its own audience's thread.
   */
  private reach(c: ControllerAtt, thread: string) {
    // An embedded page (another site) is never reached by eval.
    const all = this.pages(thread).filter(
      (p) =>
        !p.a.embed &&
        (!c.remembered ||
          (p.a.user === c.remembered.user &&
            p.a.device === c.remembered.device &&
            !!p.a.session &&
            p.a.session === c.rememberedSession &&
            (p.a.sessionUntil ?? 0) > this.now())),
    );
    // A chat grant reaches every page (one made before that rule may still carry pages).
    if (!c.pages || c.scope === "chat" || thread !== audience(c)) return all;
    return all.filter((p) => p.a.id && c.pages?.includes(p.a.id));
  }

  private loadGrants(): Promise<void> {
    if (this.grants) return Promise.resolve();
    this.loadingGrants ??= this.ctx.storage.list<Grant>({ prefix: "grant:" }).then((m) => {
      this.grants = new Map([...m].map(([k, g]) => [k.slice("grant:".length), g]));
      this.loadingGrants = undefined;
    });
    return this.loadingGrants;
  }

  private async putGrant(hash: string, g0: Grant) {
    await this.loadGrants();
    const g = this.withDevices(g0);
    await this.ctx.storage.put(`grant:${hash}`, g);
    this.grants?.set(hash, g);
  }

  /** A page-scoped grant with the device of each of its pages that is open now noted (kept for the others). */
  private withDevices(g: Grant): Grant {
    if (!g.pages) {
      const { devices: _drop, ...rest } = g;
      return rest;
    }
    const devices: Record<string, string> = {};
    const open = new Map(
      this.pages(OWNER_THREAD).flatMap((p) => (p.a.id && p.a.device ? [[p.a.id, p.a.device]] : [])),
    );
    for (const id of g.pages) {
      const d = open.get(id) ?? g.devices?.[id];
      if (d) devices[id] = d;
    }
    return { ...g, devices };
  }

  /**
   * An owner page joined under a page id its device's grants do not list: if a
   * page-scoped eval grant covered a page on this same device that is gone now,
   * this page takes its place (the app was restarted, so sessionStorage and the
   * page id with it are new). Never another device's grant, never a friend's
   * page, never a chat-only page. The senders holding the grant reach it at once.
   */
  private async rejoin(ws: Socket) {
    const page = att(ws);
    if (page?.role !== "page" || page.thread !== OWNER_THREAD || page.embed) return;
    const { id, device } = page;
    if (!id || !device) return;
    await this.loadGrants();
    const t = this.now();
    const open = new Set(this.pages(OWNER_THREAD, ws).map((p) => p.a.id));
    let changed = 0;
    for (const [hash, g] of [...(this.grants ?? [])]) {
      if (g.remembered || g.scope !== "eval" || g.until <= t || !g.pages || g.pages.includes(id))
        continue;
      const gone = g.pages.filter((p) => g.devices?.[p] === device && !open.has(p));
      if (!gone.length) continue;
      const pages = [...g.pages.filter((p) => !gone.includes(p)), id];
      const devices = { ...g.devices };
      for (const p of gone) delete devices[p];
      devices[id] = device;
      await this.putGrant(hash, { ...g, pages, devices });
      for (const c of this.sockets("controller"))
        if (c.a.grant === hash)
          c.ws.serializeAttachment({ ...c.a, pages, goneSince: undefined } satisfies ControllerAtt);
      console.log(JSON.stringify({ msg: "debug.rejoin", label: g.label, replaced: gone.length }));
      changed++;
    }
    if (changed) this.broadcast();
  }

  private async dropGrant(hash: string) {
    await this.loadGrants();
    await this.ctx.storage.delete(trustKey(hash));
    await this.ctx.storage.delete(`grant:${hash}`);
    this.grants?.delete(hash);
  }

  /** What one audience's pages see: its own pairings, and how many agents listen. */
  private state(who: string, except?: Socket): HubState {
    const t = this.now();
    let pending: PairInfo | null = null;
    const sessions: PairInfo[] = [];
    const held = new Set<string>();
    for (const { a } of this.sockets("controller", except)) {
      // A heartbeat socket is not a session: its grant, if eval, lists as asleep.
      if (audience(a) !== who || a.beat) continue;
      if (a.until) {
        if (a.until > t) {
          sessions.push(info(a));
          if (a.grant) held.add(a.grant);
        }
      } else if (!a.grant && t - a.at < PENDING_MS) pending = info(a);
    }
    // The owner's eval grants that no socket holds now: asleep, but End reaches them.
    if (who === OWNER_THREAD)
      for (const [hash, g] of this.grants ?? [])
        if (g.scope === "eval" && (g.until > t || g.remembered) && !held.has(hash))
          sessions.push({
            pair: dormantPair(hash),
            code: "idle",
            label: g.label,
            at: g.at ?? 0,
            until: g.until,
            ...(g.remembered ? { persistent: true } : {}),
            scope: "eval",
            ...(g.pages ? { pages: g.pages } : {}),
          });
    // Embedded pages are not listed: nothing can be granted to them.
    const pages = this.pages(who, except)
      .filter(({ a }) => !a.embed)
      .map(({ a }) => ({
        id: a.id ?? "",
        label: a.label,
        at: a.at ?? 0,
      }));
    const agents = this.agents(except);
    const nodes = [...new Set(agents.map((c) => c.a.node).filter((n): n is string => !!n))].sort();
    // A friend's thread answered by the AI counts it as one listener: the chat is online.
    const ai = who !== OWNER_THREAD && this.aiCachedOn() ? 1 : 0;
    return {
      type: "state",
      pending,
      sessions,
      // Lanes listening with an API token in this thread count too (token-chat.ts).
      listeners: agents.length + ai + this.tokens.count(who),
      pages,
      ...(nodes.length ? { nodes } : {}),
    };
  }

  /** Every page its audience's state, each told which page it is. */
  private broadcast(except?: Socket) {
    const by = new Map<string, HubState>();
    for (const { ws, a } of this.sockets("page", except)) {
      let s = by.get(a.thread);
      if (!s) by.set(a.thread, (s = this.state(a.thread, except)));
      send(ws, pageState(a, s));
    }
  }

  private controller(pair: string) {
    return this.sockets("controller").find((c) => c.a.pair === pair);
  }

  /**
   * Owner-approved controllers still in time: the agent. They hear every
   * thread and may `say` to any. A pairing made for a friend is not one.
   */
  private listeners(except?: Socket) {
    const t = this.now();
    return this.sockets("controller", except).filter(
      (c) => !c.a.forUser && c.a.until && c.a.until > t,
    );
  }

  /** The listeners the pages count ("agent listening (n)"): never a heartbeat-only socket. */
  private agents(except?: Socket) {
    return this.listeners(except).filter((c) => !c.a.beat);
  }

  /** One thread's kept chat, oldest first. */
  async history(thread: string = OWNER_THREAD): Promise<ChatMessage[]> {
    const m = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(thread).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    return [...m.values()].reverse().map((x) => ({ thread, ...x }));
  }

  /** Keep one chat message (dropping its thread's oldest past CHAT_HISTORY) and send it on. */
  private async post(m: ChatMessage & { thread: string }, only?: string[]) {
    const { seq: seqKey } = threadKeys(m.thread);
    const seq = ((await this.ctx.storage.get<number>(seqKey)) ?? 0) + 1;
    await this.ctx.storage.put(seqKey, seq);
    await this.ctx.storage.put(msgKey(m.thread, seq), m);
    if (seq > CHAT_HISTORY) await this.ctx.storage.delete(msgKey(m.thread, seq - CHAT_HISTORY));
    if (m.from === "agent") this.agentAt.set(m.thread, Math.max(m.at, this.now()));
    const out = { type: "chat", message: m };
    for (const { ws, a } of this.pages(m.thread))
      if (!only || (a.id && only.includes(a.id))) send(ws, out);
    // Listeners by node: that node's, and its ancestors' as observers (the root's sees all).
    for (const { ws, a } of this.listeners()) {
      const route = routeTo(a.node, m.to);
      if (route) send(ws, route === "observed" ? { ...out, observed: true } : out);
    }
    // API-token listeners: their own thread only (token-chat.ts).
    await this.tokens.chat(m);
    // An agent's line puts it among the thread's recent speakers.
    if (m.from === "agent") this.presenceSoon(m.thread);
    // Sent first: the account's history never holds the chat up.
    const line = chatLogLine(m);
    if (line) await this.chatLog({ op: "put", thread: m.thread, lines: [line] });
  }

  /**
   * Keeps the account's history in step (lib/chat-log.ts, docs/chat-history.md)
   * over SESSIONS.chatLog. Never fails the chat: no binding, "busy" or an error
   * leaves the line in the hub as ever, and is logged.
   */
  private async chatLog(req: ChatLogRequest): Promise<unknown> {
    // Called on the stub itself: `.bind` is sent as an RPC named "bind" and refused (#681).
    if (!this.sessions?.chatLog) return undefined;
    try {
      const out = (await this.sessions.chatLog(req)) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (out && out.ok === false)
        console.log(JSON.stringify({ msg: "debug.chat-log", op: req.op, error: out.error }));
      return out;
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.chat-log", op: req.op, error: String(e).slice(0, 200) }),
      );
      return undefined;
    }
  }

  /** A changed line (polish, merge, answer) in the account's history, where it is still kept. */
  private async chatLogUpdate(thread: string, m: ChatMessage) {
    const line = chatLogLine(m);
    if (line) await this.chatLog({ op: "update", thread, lines: [line] });
  }

  /**
   * POST /internal/chat-backfill: the owner thread's stored history into the
   * owners' accounts, once each (lib/chat-log.ts records it: a second call
   * writes nothing, so a line deleted since stays deleted). From the main
   * Worker's history route over its PUSH binding; index.ts answers it on the
   * binding's hostname alone.
   */
  private async backfillApi(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!this.sessions?.chatLog)
      return Response.json({ error: "no chat history binding" }, { status: 503 });
    const lines = (await this.history(OWNER_THREAD)).map(chatLogLine).filter((l) => l !== null);
    const out = await this.chatLog({ op: "backfill", thread: OWNER_THREAD, lines });
    if (!out) return Response.json({ error: "chat history unreachable" }, { status: 502 });
    return Response.json({ lines: lines.length, ...(out as object) });
  }

  /**
   * The owner thread's kept lines, newest first, and the owner's own last
   * `depth` among them: the lines an agent may summarise or merge (a polish
   * may take any of his kept lines).
   */
  private async editable(depth: number = EDITABLE_LINES) {
    const kept = [
      ...(await this.ctx.storage.list<ChatMessage>({
        prefix: threadKeys(OWNER_THREAD).prefix,
        reverse: true,
        limit: CHAT_HISTORY,
      })),
    ];
    // A line already inside a summary is not one of his lines any more: the summary is.
    const own = kept.filter(([, x]) => x.from === "owner" && !x.collapsedInto);
    return { kept, recent: own.slice(0, depth) };
  }

  /** May this controller edit the owner's lines? A refusal's reason, else null. */
  private async mayEdit(c: ControllerAtt): Promise<string | null> {
    if (c.forUser) return "a pairing for a friend cannot edit";
    const g = c.grant ? await this.ctx.storage.get<Grant>(`grant:${c.grant}`) : undefined;
    if (!g || g.until <= this.now()) return "edit needs a live chat grant from the owner";
    return null;
  }

  /**
   * The agent polishes one of the owner's lines (see "Voice edits" above):
   * unrestricted (owner, 2026-11-14), any of his lines in the thread, any
   * words. Every refusal is an {type:"error"} naming the rule it broke.
   */
  private async edit(ws: Socket, c: ControllerAtt, m: { id: string; text: string }) {
    const no = await this.mayEdit(c);
    if (no) return send(ws, { type: "error", error: no, reason: no });
    const by = cleanLabel(c.assignee ?? c.label, 80) || "agent";
    const refused = await this.polishLine(m, by, { pair: c.pair, sender: ws });
    if (refused) send(ws, { type: "error", error: refused, reason: refused });
  }

  /**
   * The polish itself, once the sender may edit: an agent's (`edit`) or the
   * hub's own (automatic polish, `by` AUTO_POLISH_BY). The refusal's reason,
   * else null once the line is stored and told.
   */
  private async polishLine(
    m: { id: string; text: string },
    by: string,
    opts: { pair?: string; sender?: Socket } = {},
  ): Promise<string | null> {
    const { kept } = await this.editable();
    const target = kept.find(([, x]) => x.id === m.id && x.from === "owner");
    if (!target)
      return `no message ${m.id} of the owner's in his thread (agents' and friends' lines can never be edited)`;
    const [key, line] = target;
    const count = line.edited?.count ?? 0;
    if (m.text === line.text) return `message ${m.id} already reads that way`;
    // Not a polish rule: a line still being spoken is still growing, and would mix with it.
    if (line.parts && !line.settled && this.now() - lastPartAt(line) < MAX_UTTERANCE_MS)
      return `message ${m.id} is still being spoken: polish it on polish-due`;
    const raw = line.raw ?? line.text;
    const v = polishCheck(raw, m.text);
    if (!v.ok) return `not polished, the raw line stands: ${v.reason}`;
    if (!(await this.polishOn()))
      return `polish is off (${POLISH_FLAG} at /dev/flags): the raw line stands`;
    const t = this.now();
    const next: ChatMessage = {
      ...line,
      text: m.text,
      raw,
      edited: { at: t, by, count: count + 1 },
    };
    await this.ctx.storage.put(key, next);
    await this.chatLogUpdate(OWNER_THREAD, next);
    const out: EditedEvent = {
      type: "edited",
      id: line.id,
      thread: OWNER_THREAD,
      text: next.text,
      raw: next.raw as string,
      edited: next.edited as EditedEvent["edited"],
    };
    console.log(
      JSON.stringify({
        msg: "debug.edit",
        ...(opts.pair ? { pair: opts.pair } : {}),
        id: line.id,
        by,
        count: count + 1,
        len: m.text.length,
        head: head(m.text),
      }),
    );
    this.tellEdit(out, line.to, opts.sender);
    return null;
  }

  /**
   * The agent collapses a run of the owner's voice lines that were not
   * addressed to it (room talk, someone else speaking) into one short summary
   * (docs/dev-debug-widget.md, "Summaries"). Only his own `stt` lines among his
   * last EDITABLE_LINES, consecutive in the thread (nobody spoke in between),
   * none still being spoken or already summarised, and the summary passes
   * `summaryCheck`. Nothing is deleted: the first line takes the summary as its
   * text and every line's heard text, joined, as `raw`; the others stay stored
   * with `collapsedInto`. The account's history keeps every line as it was and
   * gains the summary as a line of its own.
   */
  private async summarise(
    ws: Socket,
    c: ControllerAtt,
    m: { ids?: string[]; last?: number; text: string },
  ) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    const no = await this.mayEdit(c);
    if (no) return fail(no);
    const { kept, recent: mine } = await this.editable();
    let picked: [string, ChatMessage][];
    if (m.last) picked = mine.slice(0, m.last);
    else {
      picked = [];
      for (const id of new Set(m.ids ?? [])) {
        const hit = mine.find(([, x]) => x.id === id);
        if (!hit)
          return fail(
            `message ${id} is not among the owner's last ${EDITABLE_LINES} lines: only those may be summarised`,
          );
        picked.push(hit);
      }
    }
    if (!picked.length) return fail("no lines of the owner's to summarise");
    // Oldest first, in thread order (kept is newest first).
    const at = (k: string) => kept.findIndex(([key]) => key === k);
    picked.sort((a, b) => at(b[0]) - at(a[0]));
    const idx = picked.map(([k]) => at(k));
    for (let i = 1; i < idx.length; i++)
      if (idx[i - 1]! - idx[i]! !== 1)
        return fail("the lines are not consecutive: a summary covers one run nobody spoke into");
    for (const [, x] of picked) {
      if (x.source !== "stt")
        return fail(
          `message ${x.id} was typed, not spoken: only voice (stt) lines may be summarised`,
        );
      if (x.summary) return fail(`message ${x.id} is already a summary`);
      if (x.passage) return fail(`message ${x.id} is a merged passage: undo it first`);
      if (x.parts && !x.settled && this.now() - lastPartAt(x) < MAX_UTTERANCE_MS)
        return fail(`message ${x.id} is still being spoken`);
    }
    const heard = picked.map(([, x]) => x.raw ?? x.text);
    const v = summaryCheck(heard, m.text);
    if (!v.ok) {
      console.log(JSON.stringify({ msg: "debug.summary-refused", reason: v.reason }));
      return fail(`not summarised, the lines stand: ${v.reason}`);
    }
    if (!(await this.polishOn()))
      return fail(`polish is off (${POLISH_FLAG} at /dev/flags): the lines stand`);
    const t = this.now();
    const by = cleanLabel(c.assignee ?? c.label, 80) || "agent";
    const [[firstKey, first], ...rest] = picked as [
      [string, ChatMessage],
      ...[string, ChatMessage][],
    ];
    const summary: SummaryMark = { at: t, by, ids: picked.map(([, x]) => x.id) };
    const edited = first.edited ?? { at: t, by, count: 0 };
    const next: ChatMessage = { ...first, text: m.text, raw: heard.join("\n"), edited, summary };
    await this.ctx.storage.put(firstKey, next);
    for (const [k, x] of rest)
      await this.ctx.storage.put(k, { ...x, collapsedInto: first.id } satisfies ChatMessage);
    // History keeps every line as heard (or polished); the summary joins it as its own line.
    const logged = chatLogLine({
      id: `${first.id}.summary`,
      from: "owner",
      text: m.text,
      at: first.at,
    });
    if (logged) await this.chatLog({ op: "put", thread: OWNER_THREAD, lines: [logged] });
    const out: EditedEvent = {
      type: "edited",
      id: first.id,
      thread: OWNER_THREAD,
      text: next.text,
      raw: next.raw as string,
      edited,
      summary,
    };
    console.log(
      JSON.stringify({
        msg: "debug.summary",
        pair: c.pair,
        id: first.id,
        lines: summary.ids.length,
        by,
        len: m.text.length,
      }),
    );
    this.tellEdit(out, first.to, ws);
  }

  /**
   * The agent rewrites a run of the owner's consecutive voice lines as ONE
   * fluent passage (docs/dev-debug-widget.md, "Merged passages"): his own
   * words, joined, with connectives and fragment fixes, the meaning unchanged.
   * Accepted only if the sender may edit, every line is his `stt` line among
   * his last MERGE_LINES, not a summary or passage, not still being spoken,
   * the lines are consecutive in the thread (nothing at all in between: an
   * agent reply, an ask card or anyone's line ends a run), and `mergeCheck`
   * passes (a length cap instead of the per-line word rules). Nothing is
   * deleted: the first line keeps what it read in `premerge` and takes the
   * passage; the others stay stored with `collapsedInto`; undo restores them.
   */
  private async mergeRun(ws: Socket, c: ControllerAtt, m: { ids: string[]; text: string }) {
    const no = await this.mayEdit(c);
    if (no) return send(ws, { type: "error", error: no, reason: no });
    const by = cleanLabel(c.assignee ?? c.label, 80) || "agent";
    const refused = await this.mergeLines(m, by, { pair: c.pair, sender: ws });
    if (refused) send(ws, { type: "error", error: refused, reason: refused });
  }

  /**
   * The merge itself, once the sender may edit: an agent's (`mergeRun`) or the
   * hub's own (automatic polish, `by` AUTO_POLISH_BY). The refusal's reason,
   * else null once the passage is stored and told.
   */
  private async mergeLines(
    m: { ids: string[]; text: string },
    by: string,
    opts: { pair?: string; sender?: Socket } = {},
  ): Promise<string | null> {
    const fail = (reason: string) => reason;
    const { kept, recent: mine } = await this.editable(MERGE_LINES);
    const picked: [string, ChatMessage][] = [];
    for (const id of new Set(m.ids)) {
      const hit = mine.find(([, x]) => x.id === id);
      if (!hit) {
        const known = kept.some(([, x]) => x.id === id);
        return fail(
          known
            ? `message ${id} is not among the owner's last ${MERGE_LINES} lines (or is inside a summary or passage): only those may be merged`
            : `no message ${id} in the owner's thread (friends' lines can never be edited)`,
        );
      }
      picked.push(hit);
    }
    if (picked.length < 2) return fail("a merge joins two or more of the owner's lines");
    for (const [, x] of picked) {
      if (x.source !== "stt")
        return fail(`message ${x.id} was typed, not spoken: only voice (stt) lines may be merged`);
      if (x.summary) return fail(`message ${x.id} is a summary`);
      if (x.passage) return fail(`message ${x.id} is already a merged passage: undo it first`);
      if (x.parts && !x.settled && this.now() - lastPartAt(x) < MAX_UTTERANCE_MS)
        return fail(`message ${x.id} is still being spoken: merge it once the passage ends`);
    }
    // One speaker per passage: someone else's line never joins his, nor rides on his ✓.
    const why = passageSpeakers(picked.map(([, x]) => x));
    if (why) return fail(`not merged, the lines stand: ${why}`);
    // Oldest first, in thread order (kept is newest first).
    const at = (k: string) => kept.findIndex(([key]) => key === k);
    picked.sort((a, b) => at(b[0]) - at(a[0]));
    const idx = picked.map(([k]) => at(k));
    // Nothing at all between them (kept holds every line, hidden ones too): else two runs.
    for (let i = 1; i < idx.length; i++)
      if (idx[i - 1]! - idx[i]! !== 1) {
        const between = kept[idx[i - 1]! - 1]?.[1];
        return fail(
          `the lines are not consecutive: ${between ? `message ${between.id} (${between.from}) is` : "another message is"} between them, so they are separate runs`,
        );
      }
    const heard = picked.map(([, x]) => x.raw ?? x.text);
    const v = mergeCheck(heard, m.text);
    if (!v.ok) {
      console.log(JSON.stringify({ msg: "debug.passage-refused", reason: v.reason }));
      return fail(`not merged, the lines stand: ${v.reason}`);
    }
    if (!(await this.polishOn()))
      return fail(`polish is off (${POLISH_FLAG} at /dev/flags): the lines stand`);
    const t = this.now();
    const [[firstKey, first], ...rest] = picked as [
      [string, ChatMessage],
      ...[string, ChatMessage][],
    ];
    const passage: PassageMark = { at: t, by, ids: picked.map(([, x]) => x.id) };
    const edited = { at: t, by, count: first.edited?.count ?? 0 };
    const premerge: NonNullable<ChatMessage["premerge"]> = {
      text: first.text,
      ...(first.raw !== undefined ? { raw: first.raw } : {}),
      ...(first.edited ? { edited: first.edited } : {}),
    };
    const next: ChatMessage = {
      ...first,
      text: m.text,
      raw: heard.join("\n"),
      edited,
      passage,
      premerge,
    };
    await this.ctx.storage.put(firstKey, next);
    for (const [k, x] of rest)
      await this.ctx.storage.put(k, { ...x, collapsedInto: first.id } satisfies ChatMessage);
    // History keeps every line as it was; the passage joins it as its own line (undo drops it).
    const logged = chatLogLine({
      id: passageLogId(first.id),
      from: "owner",
      text: m.text,
      at: first.at,
    });
    if (logged) await this.chatLog({ op: "put", thread: OWNER_THREAD, lines: [logged] });
    const out: EditedEvent = {
      type: "edited",
      id: first.id,
      thread: OWNER_THREAD,
      text: next.text,
      raw: next.raw as string,
      edited,
      passage,
    };
    console.log(
      JSON.stringify({
        msg: "debug.passage",
        ...(opts.pair ? { pair: opts.pair } : {}),
        id: first.id,
        lines: passage.ids.length,
        by,
        len: m.text.length,
        heard: heard.reduce((n, h) => n + h.length, 0),
      }),
    );
    this.tellEdit(out, first.to, opts.sender);
    return null;
  }

  /** The lane takes back its own merged passage (eval.ts edit --unmerge). */
  private async unmergeByAgent(ws: Socket, c: ControllerAtt, id: string) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    const no = await this.mayEdit(c);
    if (no) return fail(no);
    const kept = [
      ...(await this.ctx.storage.list<ChatMessage>({
        prefix: threadKeys(OWNER_THREAD).prefix,
        reverse: true,
        limit: CHAT_HISTORY,
      })),
    ];
    const at = kept.findIndex(([, x]) => x.id === id);
    if (at < 0 || !kept[at][1].passage) return fail(`message ${id} is not a merged passage`);
    return this.restorePassage(kept, at, cleanLabel(c.assignee ?? c.label, 80) || "agent", ws);
  }

  /**
   * Undo a merged passage: its first line reads again what it read before
   * (`premerge`), the others lose `collapsedInto`, and the history drops the
   * passage line. Never gated by the flag: turning it off must not strand a
   * passage. Pages and listeners hear {type:"edited", …, restored}.
   */
  private async restorePassage(
    kept: [string, ChatMessage][],
    at: number,
    by: string,
    sender?: Socket,
  ) {
    const [key, line] = kept[at];
    const mark = line.passage as PassageMark;
    const { passage: _p, premerge, raw: _r, edited: _e, ...base } = line;
    const pre = premerge ?? { text: line.text };
    const first: ChatMessage = {
      ...base,
      text: pre.text,
      ...(pre.raw !== undefined ? { raw: pre.raw } : {}),
      ...(pre.edited ? { edited: pre.edited } : {}),
    };
    await this.ctx.storage.put(key, first);
    const restored: ChatMessage[] = [first];
    for (const [k, x] of kept)
      if (x.collapsedInto === line.id && mark.ids.includes(x.id)) {
        const { collapsedInto: _c, ...back } = x;
        await this.ctx.storage.put(k, back);
        restored.push(back);
      }
    // Oldest first, as the passage listed them.
    restored.sort((a, b) => mark.ids.indexOf(a.id) - mark.ids.indexOf(b.id));
    await this.chatLog({ op: "drop", thread: OWNER_THREAD, ids: [passageLogId(line.id)] });
    console.log(
      JSON.stringify({ msg: "debug.passage-undo", id: line.id, lines: restored.length, by }),
    );
    this.tellEdit(
      {
        type: "edited",
        id: line.id,
        thread: OWNER_THREAD,
        text: first.text,
        raw: first.raw ?? first.text,
        edited: first.edited ?? { at: this.now(), by: UNMERGE_BY, count: 0 },
        restored,
      },
      line.to,
      sender,
    );
  }

  /** An edit of an owner's line: its pages, and the listeners by the line's node. */
  private tellEdit(out: EditedEvent, to: string | undefined, sender?: Socket) {
    for (const { ws: p } of this.pages(OWNER_THREAD)) send(p, out);
    let told = false;
    for (const { ws: l, a } of this.listeners()) {
      const route = routeTo(a.node, to);
      if (!route) continue;
      if (l === sender) told = true;
      send(l, route === "observed" ? { ...out, observed: true } : out);
    }
    if (sender && !told) send(sender, out);
    this.tokens.edited(out).catch(() => {});
  }

  /**
   * Is MERGE_FLAG on? Asked of the main Worker at most once per AI_FLAG_CACHE_MS,
   * voice lines only. Only exactly true is on: no binding, "busy", an error, all off.
   */
  private async mergeOn(): Promise<boolean> {
    const t = this.now();
    if (this.mergeFlag && t - this.mergeFlag.at < AI_FLAG_CACHE_MS) return this.mergeFlag.on;
    let on = false;
    try {
      on = (await this.flagValue(MERGE_FLAG)) === true;
    } catch {}
    this.mergeFlag = { at: t, on };
    return on;
  }

  /**
   * The owner's voice line amends his last one, when it asked to and everything
   * holds (voice-merge.ts). False: it goes out as a new line. Reads and writes
   * storage only, so no other event lands in between (the Durable Object's gate).
   */
  private async merge(
    page: PageAtt,
    cur: MergeCandidate & { id: string; at: number; continues: string },
  ): Promise<boolean> {
    const kept = [
      ...(await this.ctx.storage.list<ChatMessage>({
        prefix: threadKeys(OWNER_THREAD).prefix,
        reverse: true,
        limit: CHAT_HISTORY,
      })),
    ];
    const refuse = (reason: string) => {
      console.log(JSON.stringify({ msg: "debug.merge-refused", id: cur.id, reason }));
      return false;
    };
    const latest = kept[0];
    // The thread's very latest line, by anyone: an agent's reply or card keeps them apart.
    if (!latest || latest[1].id !== cur.continues) return refuse("not-latest");
    const [key, prev] = latest;
    // The same page on the same path: another device, or a page he moved to, is a new turn.
    if (prev.label !== page.label) return refuse("other-page");
    // A summarised run is closed: nothing more joins it, nor a line hidden inside it.
    if (prev.summary || prev.passage || prev.collapsedInto) return refuse("summarised");
    // A card waiting for him just before it, or one tapped since: an answer stays its own act.
    const before = kept[1]?.[1];
    if (before?.ask && askState(before, cur.at) === "open") return refuse("open-ask");
    if (kept.some(([, x]) => x.answer && x.answer.at >= prev.at)) return refuse("answered");
    const v = mergeVerdict(prev, cur);
    if (!v.ok) return refuse(v.reason);
    const next = mergeLines(prev, cur, cur.at);
    await this.ctx.storage.put(key, next);
    await this.chatLogUpdate(OWNER_THREAD, next);
    console.log(
      JSON.stringify({
        msg: "debug.merge",
        id: prev.id,
        part: cur.id,
        signal: v.signal,
        parts: next.parts?.length,
        len: next.text.length,
        head: head(next.text),
      }),
    );
    this.tellEdit(
      {
        type: "edited",
        id: prev.id,
        thread: OWNER_THREAD,
        text: next.text,
        raw: next.raw as string,
        edited: next.edited as EditedEvent["edited"],
        parts: next.parts,
        merged: { id: cur.id, text: cur.text },
      },
      prev.to,
    );
    return true;
  }

  /**
   * TWO_MIC_FLAG and TWO_MIC_WINDOW_KEY from the main Worker, at most once per
   * AI_FLAG_CACHE_MS. The flag is on by default: only exactly false turns it
   * off. The window falls back to TWO_MIC_WINDOW_MS when it cannot be read.
   */
  private async twoMicOn(): Promise<{ on: boolean; windowMs: number }> {
    const t = this.now();
    if (this.twoMicConf && t - this.twoMicConf.at < AI_FLAG_CACHE_MS) return this.twoMicConf;
    let on = true;
    try {
      on = (await this.flagValue(TWO_MIC_FLAG)) !== false;
    } catch {}
    let windowMs = TWO_MIC_WINDOW_MS;
    try {
      const v = this.sessions?.config ? await this.sessions.config(TWO_MIC_WINDOW_KEY) : undefined;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) windowMs = v;
    } catch {}
    this.twoMicConf = { at: t, on, windowMs };
    return this.twoMicConf;
  }

  /** The owner thread's newest lines, newest first (enough for any two-mic window). */
  private async newest() {
    return [
      ...(await this.ctx.storage.list<ChatMessage>({
        prefix: threadKeys(OWNER_THREAD).prefix,
        reverse: true,
        limit: TWO_MIC_SCAN,
      })),
    ];
  }

  /**
   * His voice line repeats the one his other mic sent a moment ago (two-mic.ts):
   * true when it was taken care of here — its better text replaced the stored
   * line's in place, or it was dropped — so it is not posted. False: post it.
   * The flag and window are asked only when a line could match at all.
   */
  private async twoMic(cur: {
    id: string;
    text: string;
    label: string;
    at: number;
    stt?: SttTag;
    speaker?: SpeakerTag;
  }): Promise<boolean> {
    if (!twoMicMatch(await this.newest(), cur, TWO_MIC_WINDOW_MAX)) return false;
    const conf = await this.twoMicOn();
    if (!conf.on) return false;
    // Read again: other lines may have landed while the main Worker answered.
    const hit = twoMicMatch(await this.newest(), cur, conf.windowMs);
    if (!hit) return false;
    const [key, line] = hit;
    const keep = twoMicKeep(line, cur);
    console.log(
      JSON.stringify({
        msg: "debug.two-mic",
        id: line.id,
        dup: cur.id,
        keep,
        gap: cur.at - lastPartAt(line),
        head: head(cur.text),
      }),
    );
    if (keep === "drop") return true;
    const { speaker: _s, stt: _t, ...rest } = line;
    const next: ChatMessage = {
      ...rest,
      text: cur.text,
      raw: cur.text,
      ...(cur.stt ? { stt: cur.stt } : {}),
      ...(cur.speaker ? { speaker: cur.speaker } : {}),
      edited: { at: cur.at, by: TWO_MIC_BY, count: line.edited?.count ?? 0 },
    };
    await this.ctx.storage.put(key, next);
    await this.chatLogUpdate(OWNER_THREAD, next);
    this.tellEdit(
      {
        type: "edited",
        id: line.id,
        thread: OWNER_THREAD,
        text: next.text,
        raw: next.raw as string,
        edited: next.edited as EditedEvent["edited"],
      },
      line.to,
    );
    return true;
  }

  /**
   * The owner's undo on a merged line: it goes back to the lines it was made
   * from, in its place in the thread, whatever came after it. Polish is dropped
   * with the merge: what stands is what was heard. Never gated by the flag:
   * turning it off must not strand a line already merged.
   */
  private async unmerge(ws: Socket, page: PageAtt, id: string) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    if (page.thread !== OWNER_THREAD) return fail("only the owner's lines are merged");
    const { prefix, seq: seqKey } = threadKeys(OWNER_THREAD);
    const kept = [
      ...(await this.ctx.storage.list<ChatMessage>({ prefix, reverse: true, limit: CHAT_HISTORY })),
    ];
    const at = kept.findIndex(([, x]) => x.id === id);
    const line = at < 0 ? undefined : kept[at][1];
    // A passage the lane wrote goes back to its lines first (its first line may hold parts too).
    if (line?.passage) return this.restorePassage(kept, at, page.label);
    if (!line?.parts) return fail(`message ${id} is not a merged line`);
    const lines = splitLine(line).map((x) => ({ ...x, thread: OWNER_THREAD }));
    const grow = lines.length - 1;
    const seqOf = (k: string) => Number(k.slice(prefix.length));
    const seq = seqOf(kept[at][0]);
    // Newest first: each line moves up by what the split adds, onto a key already moved.
    for (const [k, x] of kept.slice(0, at))
      await this.ctx.storage.put(msgKey(OWNER_THREAD, seqOf(k) + grow), x);
    for (const [i, x] of lines.entries())
      await this.ctx.storage.put(msgKey(OWNER_THREAD, seq + i), x);
    const top = ((await this.ctx.storage.get<number>(seqKey)) ?? seq) + grow;
    await this.ctx.storage.put(seqKey, top);
    for (let s = top - CHAT_HISTORY; s > top - CHAT_HISTORY - grow && s > 0; s--)
      await this.ctx.storage.delete(msgKey(OWNER_THREAD, s));
    console.log(JSON.stringify({ msg: "debug.unmerge", id, lines: lines.length }));
    await this.chatLog({
      op: "split",
      thread: OWNER_THREAD,
      id,
      lines: lines.map(chatLogLine).filter((l) => l !== null),
    });
    this.tellEdit(
      {
        type: "edited",
        id,
        thread: OWNER_THREAD,
        text: lines[0].text,
        raw: lines[0].text,
        edited: { at: this.now(), by: UNMERGE_BY, count: 0 },
        split: lines,
      },
      line.to,
    );
  }

  /**
   * The page that spoke went quiet after a merged line. Nothing more joins it,
   * and the listeners hear it is time for its one polish. With stt.polish off
   * (or unsure) they hear nothing, so no lane wakes for it: the raw line stands.
   */
  private async passageEnd(page: PageAtt) {
    if (page.thread !== OWNER_THREAD) return;
    const kept = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(OWNER_THREAD).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    const latest = [...kept].find(([, x]) => x.from === "owner");
    if (!latest) return;
    const [key, line] = latest;
    if (!line.parts || line.settled || line.label !== page.label) return;
    if (line.collapsedInto || line.passage) return;
    await this.ctx.storage.put(key, { ...line, settled: true } satisfies ChatMessage);
    if (!(await this.polishOn())) return;
    const out: PolishDueEvent = {
      type: "polish-due",
      id: line.id,
      thread: OWNER_THREAD,
      text: line.text,
      raw: line.raw ?? line.text,
      parts: line.parts.length,
    };
    console.log(JSON.stringify({ msg: "debug.polish-due", id: line.id, parts: out.parts }));
    for (const { ws: l, a } of this.agents()) {
      const route = routeTo(a.node, line.to);
      if (route) send(l, route === "observed" ? { ...out, observed: true } : out);
    }
    // The passage is settled: the hub's own polish goes at once, no tail to wait for.
    this.autoPolishNow(page);
  }

  /**
   * The agent asks (ask.ts): kept and sent like a say, to the owner's
   * thread or a friend's (`to`), as an agent line carrying the ask; its text
   * is the question, for pages without cards. A pairing for a friend cannot
   * ask (it cannot chat either).
   */
  private async ask(ws: Socket, c: ControllerAtt, ask: Ask, to?: string) {
    if (c.forUser) return send(ws, { type: "error", error: "a pairing for a friend cannot ask" });
    const dest = await this.sayTarget(to);
    if ("error" in dest) return send(ws, { type: "error", error: dest.error });
    const t = this.now();
    const who = c.assignee;
    const said: ChatMessage & { thread: string } = {
      id: crypto.randomUUID().slice(0, 8),
      from: "agent",
      label: c.label,
      text: askText(ask),
      at: t,
      ask,
      ...dest,
      ...(who ? { agentId: who } : {}),
    };
    console.log(
      JSON.stringify({
        msg: "debug.ask",
        pair: c.pair,
        thread: said.thread,
        askId: ask.askId,
        questions: ask.questions.length,
      }),
    );
    await this.post(said);
    send(ws, { type: "asked", id: said.id, askId: ask.askId, thread: said.thread });
  }

  /**
   * A tap on an ask card, from a page: the ask must be in that page's own
   * thread (a friend can never answer the owner's), still open (one answer
   * only, not expired), and the choices must fit it. The hub stamps it:
   * source "tap", the thread, the page's label, the time. Kept on the ask's
   * line (a reload shows it answered) and sent to the thread's pages and the
   * owner-approved listeners.
   */
  private async answer(ws: Socket, page: PageAtt, askId: string, raw: unknown) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    const kept = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(page.thread).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    const hit = [...kept].find(([, x]) => x.ask?.askId === askId);
    if (!hit) return fail(`no ask ${askId} in this thread`);
    const [key, line] = hit;
    const t = this.now();
    const state = askState(line, t);
    if (state !== "open") return fail(`ask ${askId} is ${state}`);
    const choices = checkChoices(line.ask as Ask, raw);
    if (!choices) return fail(`that answer does not fit ask ${askId}`);
    const answer: AskAnswer = {
      choices,
      source: "tap",
      thread: page.thread,
      label: page.label,
      at: t,
    };
    await this.ctx.storage.put(key, { ...line, answer } satisfies ChatMessage);
    await this.chatLogUpdate(page.thread, { ...line, answer });
    const labels: Record<string, string[]> = {};
    for (const q of (line.ask as Ask).questions)
      labels[q.id] = (choices[q.id] ?? []).map(
        (id) => q.options.find((o) => o.id === id)?.label ?? id,
      );
    const out: AnsweredEvent = { type: "answered", id: line.id, askId, answer, labels };
    console.log(
      JSON.stringify({ msg: "debug.answer", thread: page.thread, page: page.label, askId }),
    );
    for (const { ws: p } of this.pages(page.thread)) send(p, out);
    // An ask posted with an API token: its own lane alone hears the answer (token-chat.ts).
    if (line.via === "token") return this.tokens.answered(page.thread, line, out);
    for (const { ws: l, a } of this.listeners())
      if (audience(a) === page.thread || page.thread === OWNER_THREAD || !a.forUser)
        send(l, page.thread === OWNER_THREAD ? out : { ...out, thread: page.thread });
  }

  /**
   * The agent withdraws an ask card it sent (eval.ts withdraw), so nobody
   * has to tap an obsolete question: by askId or message id, only in the
   * thread named (`to`, as for ask: the owner's by default, else the friend's
   * the card was sent to), only an agent line with an ask, only while open
   * (not answered, expired or already withdrawn), and only with a live chat
   * grant (never a pairing for a friend). Stamped on the ask
   * (`ask.withdrawnAt`), kept (a reload shows it withdrawn; a later tap is
   * refused by askState), and sent to that thread's pages and the listeners.
   */
  private async withdraw(ws: Socket, c: ControllerAtt, m: { id: string; to?: string }) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    if (c.forUser) return fail("a pairing for a friend cannot withdraw");
    const g = c.grant ? await this.ctx.storage.get<Grant>(`grant:${c.grant}`) : undefined;
    if (!g || g.until <= this.now()) return fail("withdraw needs a live chat grant from the owner");
    const dest = await this.sayTarget(m.to);
    if ("error" in dest) return fail(dest.error);
    const kept = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(dest.thread).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    const hit = [...kept].find(([, x]) => x.ask && (x.ask.askId === m.id || x.id === m.id));
    if (!hit) return fail(`no ask ${m.id} in that thread`);
    const [key, line] = hit;
    if (line.from !== "agent" || !line.ask) return fail(`message ${m.id} is not an agent's ask`);
    const t = this.now();
    const state = askState(line, t);
    if (state !== "open") return fail(`ask ${line.ask.askId} is ${state}`);
    const ask: Ask = { ...line.ask, withdrawnAt: t };
    await this.ctx.storage.put(key, { ...line, ask } satisfies ChatMessage);
    const out: WithdrawnEvent = {
      type: "withdrawn",
      id: line.id,
      askId: ask.askId,
      thread: dest.thread,
      withdrawnAt: t,
    };
    console.log(
      JSON.stringify({
        msg: "debug.withdraw",
        pair: c.pair,
        thread: dest.thread,
        askId: ask.askId,
        by: cleanLabel(c.assignee ?? c.label, 80) || "agent",
      }),
    );
    for (const { ws: p } of this.pages(dest.thread)) send(p, out);
    // The owner-approved listeners (never a friend's pairing); the requester among them.
    let told = false;
    for (const { ws: l } of this.listeners()) {
      if (l === ws) told = true;
      send(l, out);
    }
    if (!told) send(ws, out);
  }

  /** The live node grants (`ngrant:`), lapsed ones dropped as they are met. */
  private async nodeGrants(): Promise<NodeGrant[]> {
    const t = this.now();
    const out: NodeGrant[] = [];
    for (const [k, g] of await this.ctx.storage.list<NodeGrant>({ prefix: "ngrant:" }))
      if (g.until > t) out.push(g);
      else await this.ctx.storage.delete(k);
    return out;
  }

  /** Everyone who has used the chat, most recent first. */
  async friends(): Promise<({ userId: string } & FriendRecord)[]> {
    const m = await this.ctx.storage.list<FriendRecord>({ prefix: "friend:" });
    return [...m.entries()]
      .map(([k, v]) => ({ userId: k.slice("friend:".length), ...v }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** A friend by user id or (any case) email. */
  private async findFriend(key: string) {
    if (isUserId(key)) {
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(key));
      if (rec) return { userId: key, ...rec };
    }
    const want = key.trim().toLowerCase();
    return (await this.friends()).find((f) => f.email.toLowerCase() === want);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/internal/friends")) return this.friendsApi(req, url);
    if (url.pathname === SIGNED_OUT_PATH) return this.signedOutApi(req);
    if (url.pathname === ETA_PATH) return this.etaApi(req);
    if (url.pathname === REVOKED_PATH) return this.tokensRevoked(req);
    if (url.pathname.startsWith(AVATAR_PATH)) return this.avatarApi(req, url);
    if (url.pathname === CHAT_PATH) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return this.tokens.http(req);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.tokens.opened(pair[1], req.headers.get("x-lianki-client"));
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (url.pathname === BOX_CLOSED_PATH) return this.boxClosedApi(req);
    if (url.pathname === CHAT_BACKFILL_PATH) return this.backfillApi(req);
    const control = url.pathname.endsWith("/control");
    let who: Identity | undefined;
    if (!control) {
      // Fail closed: a page with no identity from index.ts is nobody.
      const h = req.headers;
      const userId = h.get(IDENTITY_HEADERS.user) ?? "";
      const owner = h.get(IDENTITY_HEADERS.owner) === "1";
      if (!owner && !isUserId(userId)) return new Response("forbidden", { status: 403 });
      let name = "";
      try {
        name = decodeURIComponent(h.get(IDENTITY_HEADERS.name) ?? "");
      } catch {}
      const image = h.get(IDENTITY_HEADERS.image) ?? "";
      const session = h.get(IDENTITY_HEADERS.session);
      const sessionUntil = Number(h.get(IDENTITY_HEADERS.sessionUntil));
      who = {
        userId,
        email: h.get(IDENTITY_HEADERS.email) ?? "",
        owner,
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
        ...(isSessionTag(session) ? { session } : {}),
        ...(Number.isFinite(sessionUntil) && sessionUntil > 0 ? { sessionUntil } : {}),
      };
    }
    // A ticket socket from another site (index.ts verified the signature):
    // its ticket is burned here, once, before the upgrade is accepted.
    const ticket = control ? null : req.headers.get(EMBED_HEADER);
    const embed = ticket !== null;
    if (embed && !(await this.burnTicket(ticket)))
      return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    // Which box client a ticket socket is (index.ts verified its origin); only ever with a ticket.
    const box = embed ? (req.headers.get(BOX_HEADER) ?? undefined) : undefined;
    if (control)
      await this.connectController(
        ws,
        url,
        req.headers.get(TOKEN_HEADER),
        req.headers.get(EVAL_TOKEN_HEADER),
      );
    else await this.connectPage(ws, url, who, embed, box);
    // The browser fails a socket whose offered subprotocol is not selected.
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(embed ? { headers: { "sec-websocket-protocol": PARTNER_SUBPROTOCOL } } : {}),
    } as ResponseInit);
  }

  /**
   * A partner ticket (`<jti>.<exp>`, from index.ts) is good once: its jti is
   * kept until it expires. Expired ones are swept as new ones arrive.
   */
  async burnTicket(raw: string): Promise<boolean> {
    const at = raw.lastIndexOf(".");
    const jti = raw.slice(0, at);
    const exp = Number(raw.slice(at + 1));
    const t = this.now();
    if (at <= 0 || !/^[A-Za-z0-9_-]{8,64}$/.test(jti) || !Number.isFinite(exp)) return false;
    if (exp * 1000 + STT_TICKET_SKEW_S * 1000 < t) return false;
    const key = `pjti:${jti}`;
    if ((await this.ctx.storage.get<number>(key)) !== undefined) return false;
    await this.ctx.storage.put(key, exp);
    const old = await this.ctx.storage.list<number>({ prefix: "pjti:", limit: 200 });
    for (const [k, e] of old)
      if (e * 1000 + STT_TICKET_SKEW_S * 1000 < t) await this.ctx.storage.delete(k);
    return true;
  }

  /**
   * The owner's friends API, reached only over the main Worker's PUSH binding
   * (index.ts answers /internal/* on the binding's hostname alone):
   *   GET  /internal/friends                → {friends}
   *   GET  /internal/friends/thread?user=id → {messages}  (the owner's read-only view)
   *   POST /internal/friends {userId, action: "block" | "unblock"}
   */
  private async friendsApi(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" && url.pathname.endsWith("/thread")) {
      const user = url.searchParams.get("user");
      if (!isUserId(user)) return Response.json({ error: "bad user" }, { status: 400 });
      return Response.json({ messages: await this.history(user) });
    }
    if (req.method === "GET") return Response.json({ friends: await this.friends() });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { userId?: unknown; action?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    if (!isUserId(body.userId) || (body.action !== "block" && body.action !== "unblock"))
      return Response.json({ error: "expected {userId, action: block|unblock}" }, { status: 400 });
    const rec = await this.block(body.userId, body.action === "block");
    if (!rec) return Response.json({ error: "no such chat user" }, { status: 404 });
    return Response.json({ ok: true, friend: { userId: body.userId, ...rec } });
  }

  /**
   * POST /internal/eta {id, title, etaAt, assignee?, kind?, reason?}: a
   * state-tree estimate ran out, or its overrun was explained or went
   * unexplained (lib/eta-ping.ts; docs/state-tree.md, "ETA overrun"). From the progress hub alone, over its DEBUG binding:
   * index.ts forwards no request to this path. With flag chat.eta-bar on, one
   * line in the owner's thread addressed to the main node ("/"), so every
   * listener there hears it as it hears his lines: `from: "agent"` (never
   * the owner), `agentId: "eta"`, `source: "eta"`; quiet for "due" only. It never answers an
   * ask (only a page's tap does) and never carries ownerGrant. 503 when the
   * flag cannot be read: the progress hub tries again.
   */
  private async etaApi(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let ping: ReturnType<typeof parseEtaPing> = null;
    try {
      ping = parseEtaPing(await req.json());
    } catch {}
    if (!ping) return Response.json({ error: "expected {id, title, etaAt}" }, { status: 400 });
    let on: unknown = false;
    try {
      on = await this.flagValue(ETA_FLAG);
    } catch {
      return Response.json({ error: "flag unreadable" }, { status: 503 });
    }
    if (on === "busy") return Response.json({ error: "flag unreadable" }, { status: 503 });
    if (on !== true) return Response.json({ ok: true, delivered: false, reason: "flag off" });
    // A lanes' line with no one listening at the root is not posted: the
    // progress hub keeps it queued and sends it when a listener connects
    // (listenerUp), so its receipt clock starts only once someone has it.
    const listeners = this.agents().filter((c) => routeTo(c.a.node, ROOT_NODE)).length;
    if (forLanes(ping) && listeners === 0)
      return Response.json({ ok: true, delivered: false, queued: true, listeners: 0 });
    const line: ChatMessage & { thread: string } = {
      id: crypto.randomUUID().slice(0, 8),
      from: "agent",
      label: ETA_LABEL,
      text: etaLineText(ping, this.now()),
      at: this.now(),
      thread: OWNER_THREAD,
      to: ROOT_NODE,
      agentId: ETA_AGENT,
      source: "eta",
      // The lanes' lines are quiet; the owner's (late, silent, waiting, blocked on him) are read aloud like any agent line.
      ...(forLanes(ping) ? { quiet: true } : {}),
      eta: {
        id: ping.id,
        etaAt: ping.etaAt,
        ...(ping.kind && ping.kind !== "due" ? { kind: ping.kind } : {}),
        ...(ping.code ? { code: ping.code } : {}),
        ...(ping.lane ? { lane: ping.lane } : {}),
      },
    };
    await this.post(line);
    console.log(
      JSON.stringify({
        msg: "debug.eta",
        kind: ping.kind ?? "due",
        id: ping.id,
        etaAt: ping.etaAt,
      }),
    );
    return Response.json({ ok: true, delivered: true, listeners });
  }

  /**
   * A listener (not a heartbeat-only socket) connected: tell the progress hub
   * (ETA_HEARD_PATH), which sends the lanes' ETA lines it held queued for want
   * of one (docs/state-tree.md, "Receipts"). Best effort: a failure leaves them
   * queued for the next listener.
   */
  private async listenerUp(a: ControllerAtt) {
    if (a.beat || !this.progress || !routeTo(a.node, ROOT_NODE)) return;
    try {
      await this.progress
        .get(this.progress.idFromName("progress"))
        .fetch(new Request(`https://lianki-push${ETA_HEARD_PATH}`, { method: "POST" }));
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.eta-heard-failed", error: String(e).slice(0, 200) }),
      );
    }
  }

  /**
   * POST /internal/signed-out {session}: the main Worker deleted that sign-in
   * session (sign-out). Reached only over its PUSH binding, like the friends API.
   */
  private async signedOutApi(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { session?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    if (!isSessionTag(body.session))
      return Response.json({ error: "expected {session}" }, { status: 400 });
    return Response.json({ ok: true, stopped: await this.stopRenewal(body.session) });
  }

  /**
   * `session` is over (sign-out, or the main Worker says it is gone): no eval
   * grant bound to it renews any more, and the owner pages that connected
   * with it lose it (their attachment no longer names a session, so they can
   * never vouch for a renewal). How many grants were bound.
   */
  async stopRenewal(session: string, why = "signed-out"): Promise<number> {
    // Invalidate page authority synchronously, before ANY storage/RPC yield.
    for (const { ws, a } of this.pages(OWNER_THREAD))
      if (a.session === session) {
        const { session: _s, sessionUntil: _u, user: _user, ...rest } = a;
        ws.serializeAttachment(rest satisfies PageAtt);
      }

    await this.loadGrants();
    let n = 0;
    for (const [hash, g] of this.grants ?? []) {
      if (g.renew?.session !== session) continue;
      if (g.remembered) {
        await this.putGrant(hash, { ...g, until: 0, renew: undefined });
        for (const c of this.sockets("controller"))
          if (c.a.grant === hash) {
            send(c.ws, { type: "expired" });
            close(c.ws, 4408, "signed out; remembered trust paused");
          }
        n++;
        continue;
      }
      const { renew: r, ...rest } = g;
      await this.putGrant(hash, rest satisfies Grant);
      console.log(
        JSON.stringify({ msg: "debug.renew-stop", why, device: r.device, count: r.count }),
      );
      n++;
    }
    return n;
  }

  /**
   * Is the session behind a renewal still live? Asked of the main Worker's
   * DebugSessions RPC entrypoint (SESSIONS binding: an auth-db lookup of the
   * owner's live sessions by tag) right before each renewal, at most once per
   * grant per SESSION_CHECK_MIN_MS. "unsure" — no binding, no user id, an
   * error, "busy", an odd answer, too soon — renews nothing.
   */
  private async sessionLive(hash: string, r: Renewal): Promise<"live" | "gone" | "unsure"> {
    if (!this.sessions || !r.user) return "unsure";
    const t = this.now();
    const last = this.checkedAt.get(hash);
    if (last !== undefined && t - last < SESSION_CHECK_MIN_MS) return "unsure";
    this.checkedAt.set(hash, t);
    try {
      const said = await this.sessions.live(r.user, r.session);
      return said === "live" ? "live" : said === "gone" ? "gone" : "unsure";
    } catch {
      return "unsure";
    }
  }

  // --- Automatic polish (docs/dev-debug-widget.md, "Automatic polish") ---

  /** The pending tail timer, and the page whose voice line set it (its user pays). */
  private autoTimer?: unknown;
  private autoPage?: PageAtt;
  /** One automatic polish at a time; a line that lands meanwhile runs it again after. */
  private autoBusy = false;
  private autoAgain = false;
  private autoConf?: { at: number; tailMs: number; minChars: number };

  /**
   * One of the owner's voice lines was kept: the hub's own polish is due once
   * he has paused for the tail window (config voice.autoPolishTailMs). Another
   * voice line inside the window restarts it, so the fragments of one thought
   * go to the model together and may come back as one passage.
   */
  private autoPolishSoon(page: PageAtt) {
    if (page.thread !== OWNER_THREAD || !this.sessions?.polishLines) return;
    if (this.autoTimer !== undefined) this.timer.clear(this.autoTimer);
    this.autoPage = page;
    const tailMs = this.autoConf?.tailMs ?? AUTO_POLISH_TAIL_MS;
    // The config is refreshed in the background: this line uses the last read.
    void this.autoPolishConf();
    this.autoTimer = this.timer.set(() => {
      this.autoTimer = undefined;
      this.autoPolishNow(page);
    }, tailMs);
  }

  /** The polish goes now (a settled passage, or the tail timer fired). */
  private autoPolishNow(page: PageAtt) {
    if (page.thread !== OWNER_THREAD || !this.sessions?.polishLines) return;
    if (this.autoBusy) {
      this.autoAgain = true;
      this.autoPage = page;
      return;
    }
    this.autoBusy = true;
    this.autoPolishRun(page)
      .catch((e) =>
        console.log(
          JSON.stringify({ msg: "debug.auto-polish-failed", error: String(e).slice(0, 200) }),
        ),
      )
      .finally(() => {
        this.autoBusy = false;
        if (this.autoAgain) {
          this.autoAgain = false;
          this.autoPolishNow(this.autoPage ?? page);
        }
      });
  }

  private async autoPolishConf() {
    const t = this.now();
    if (this.autoConf && t - this.autoConf.at < AUTO_POLISH_CONF_MS) return this.autoConf;
    const num = async (key: string, dflt: number) => {
      try {
        const v = await this.sessions?.config?.(key);
        return typeof v === "number" && v > 0 ? v : dflt;
      } catch {
        return dflt;
      }
    };
    const tailMs = await num("voice.autoPolishTailMs", AUTO_POLISH_TAIL_MS);
    const minChars = await num("voice.autoPolishMinChars", AUTO_POLISH_MIN_CHARS);
    return (this.autoConf = { at: t, tailMs, minChars });
  }

  /**
   * The run: his newest consecutive voice lines that nobody (an agent, the
   * hub's merge, a summary) has touched yet, newest first — ended by any
   * other line, a polished one, one still being spoken, one shorter than
   * voice.autoPolishMinChars, or one more than AUTO_POLISH_RUN_MS older than
   * the newest. Then the kept lines before it, as context.
   */
  private autoPolishPick(kept: [string, ChatMessage][], minChars: number) {
    const run: [string, ChatMessage][] = [];
    let i = 0;
    for (; i < kept.length && run.length < MERGE_LINES; i++) {
      const [, x] = kept[i]!;
      if (x.collapsedInto) continue;
      if (x.from !== "owner" || x.source !== "stt") break;
      if (x.summary || x.passage || (x.edited?.count ?? 0) > 0) break;
      if (x.parts && !x.settled && this.now() - lastPartAt(x) < MAX_UTTERANCE_MS) break;
      if (x.text.trim().length < minChars) break;
      if (run.length && run[0]![1].at - x.at > AUTO_POLISH_RUN_MS) break;
      run.push(kept[i]!);
    }
    const context: { from: string; text: string }[] = [];
    for (; i < kept.length && context.length < AUTO_POLISH_CONTEXT; i++) {
      const [, x] = kept[i]!;
      if (x.collapsedInto || !x.text.trim()) continue;
      context.push({
        from: x.from === "owner" ? "owner" : x.from === "agent" ? "agent" : "friend",
        text: x.text.slice(0, AUTO_POLISH_CONTEXT_CHARS),
      });
    }
    // Oldest first, as spoken.
    run.reverse();
    context.reverse();
    return { run, context };
  }

  /**
   * The hub polishes his latest spoken run itself (owner, 2026-11-14: nearly
   * every line he speaks is to be polished, without waiting for a lane). Off
   * when AUTO_POLISH_FLAG is exactly false (unsure: skipped, logged). The main
   * Worker's `polishLines` (lib/chat-polish.ts) is paid from the page's user's
   * credits, so a page with no user id never asks. The answer goes through the
   * same path as an agent's: `mergeLines` when the model joined the fragments
   * into one passage, else `polishLine` per line, stamped `by: "auto"`, raw
   * kept, the polished mark shown, the read-back fired. A line an agent
   * polished meanwhile, or whose text changed, is left as it is.
   */
  private async autoPolishRun(page: PageAtt) {
    const rpc = this.sessions;
    if (!rpc?.polishLines) return;
    const skip = (why: string, more: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ msg: "debug.auto-polish-skip", why, ...more }));
    let flag: unknown;
    try {
      flag = await this.flagValue(AUTO_POLISH_FLAG);
    } catch {
      return skip("flag-unread");
    }
    if (flag === false) return;
    if (flag === "busy") return skip("flag-busy");
    const conf = await this.autoPolishConf();
    const { kept } = await this.editable();
    const { run, context } = this.autoPolishPick(kept, conf.minChars);
    if (!run.length) return;
    if (!page.user) return skip("no-user", { lines: run.length });
    const newest = run.at(-1)![0];
    const sent = run.map(([, x]) => ({ id: x.id, text: x.text }));
    const requestId = `auto:${newest.replace(/[^\w.-]/g, "-")}:${run.length}`.slice(0, 120);
    const t0 = this.now();
    let res: { ok?: boolean; error?: string; verdict?: unknown } | undefined;
    try {
      res = (await rpc.polishLines({
        userId: page.user,
        input: { v: 1, requestId, lines: sent, context },
      })) as typeof res;
    } catch (e) {
      rpcFailed("polishLines", e);
      return skip("rpc-failed", { lines: run.length });
    }
    if (!res?.ok) return skip(res?.error ?? "no-answer", { lines: run.length });
    const v = res.verdict as { lines?: { id: string; text: string }[]; merged?: string };
    // The thread moved on while the model worked: polish only what still stands as sent.
    const now = new Map((await this.editable()).kept.map(([, x]) => [x.id, x]));
    const fresh = sent.filter((l) => {
      const x = now.get(l.id);
      return !!x && x.text === l.text && !(x.edited?.count ?? 0) && !x.collapsedInto && !x.passage;
    });
    if (!fresh.length) return skip("stale", { lines: run.length });
    let merged = false;
    let polished = 0;
    if (v?.merged && fresh.length === sent.length && sent.length >= 2) {
      const no = await this.mergeLines(
        { ids: sent.map((l) => l.id), text: v.merged },
        AUTO_POLISH_BY,
      );
      if (no) console.log(JSON.stringify({ msg: "debug.auto-polish-refused", reason: no }));
      else merged = true;
    }
    if (!merged)
      for (const l of fresh) {
        const text = v?.lines?.find((x) => x.id === l.id)?.text?.trim();
        if (!text || text === l.text) continue;
        const no = await this.polishLine({ id: l.id, text }, AUTO_POLISH_BY);
        if (no) console.log(JSON.stringify({ msg: "debug.auto-polish-refused", reason: no }));
        else polished++;
      }
    console.log(
      JSON.stringify({
        msg: "debug.auto-polish",
        lines: sent.length,
        merged,
        polished,
        ms: this.now() - t0,
      }),
    );
  }

  /**
   * Is agent polish on (POLISH_FLAG at /dev/flags, on by default)? Asked of the
   * main Worker's DebugSessions entrypoint on each edit (one per voice line at
   * most), uncached. Only an answer of exactly false switches it off. A read
   * that fails — "busy" or an error — is unsure: polish waits and the raw line
   * stands, as before, and it is logged (`debug.polish-flag-unread`). No
   * binding, or a main Worker from before `flag()`: on, as ever.
   */
  private async polishOn(): Promise<boolean> {
    if (!this.sessions?.flag) return true;
    let v: unknown;
    try {
      v = await this.flagValue(POLISH_FLAG);
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.polish-flag-unread", error: String(e).slice(0, 200) }),
      );
      return false;
    }
    if (v === "busy") {
      console.log(JSON.stringify({ msg: "debug.polish-flag-unread", error: "busy" }));
      return false;
    }
    return v !== false;
  }

  /** Run read-check-write with no other event in between (the DO's own gate, where there is one). */
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile ? this.ctx.blockConcurrencyWhile(f) : f();
  }

  /**
   * Renew the owner's eval grant `hash` if it is due ("Renewal" above): less
   * than EVAL_RENEW_BEFORE_MS left, the chain not at its cap, and an owner page
   * of the approving device and session connected. Otherwise nothing.
   */
  private async renew(hash: string, via: "use" | "resume" | "page" | "alarm") {
    if (this.renewing.has(hash)) return this.renewing.get(hash);
    const run = this.renewNow(hash, via).finally(() => this.renewing.delete(hash));
    this.renewing.set(hash, run);
    return run;
  }

  private async renewNow(hash: string, via: string) {
    const t = this.now();
    const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
    const r = g?.renew;
    if (g?.remembered) return;
    if (!g || !r || g.scope !== "eval" || g.until <= t || !renewDueAt(g.until, t)) return;
    // The chain is at its cap: the next grant needs a tap.
    if (Math.min(t + (g.ms ?? EVAL_GRANT_MS), r.start + EVAL_CHAIN_MS) <= g.until) return;
    if (!this.approverHere(r, t)) return;
    // The auth db has the last word: a session it does not know renews nothing.
    const live = await this.sessionLive(hash, r);
    if (live === "gone") await this.stopRenewal(r.session, "session-gone");
    if (live !== "live") return;
    // That answer took a while: End, sign-out or another renewal may have
    // happened meanwhile. Re-read and re-check everything, and write only if
    // it is still the same grant in the same state, with no event in between.
    const next = await this.exclusive(async () => {
      const t2 = this.now();
      const now = await this.ctx.storage.get<Grant>(`grant:${hash}`);
      const r2 = now?.renew;
      if (!now || !r2 || now.scope !== "eval" || now.until !== g.until || now.until <= t2)
        return null;
      if (
        r2.count !== r.count ||
        r2.start !== r.start ||
        r2.device !== r.device ||
        r2.session !== r.session ||
        r2.user !== r.user ||
        !this.approverHere(r2, t2)
      )
        return null;
      const n: Grant = {
        ...now,
        until: Math.min(t2 + (now.ms ?? EVAL_GRANT_MS), r2.start + EVAL_CHAIN_MS),
        renew: { ...r2, count: r2.count + 1 },
      };
      if (n.until <= now.until) return null;
      await this.putGrant(hash, n);
      return n;
    });
    if (!next?.renew) {
      console.log(JSON.stringify({ msg: "debug.renew-skip", why: "changed while checking" }));
      return;
    }
    const { count } = next.renew;
    const until = next.until;
    for (const c of this.sockets("controller"))
      if (c.a.grant === hash) {
        c.ws.serializeAttachment({ ...c.a, until } satisfies ControllerAtt);
        send(c.ws, { type: "renewed", until, count });
      }
    console.log(
      JSON.stringify({
        msg: "debug.renew",
        via,
        label: g.label,
        device: r.device,
        count,
        until,
        chainEnds: r.start + EVAL_CHAIN_MS,
      }),
    );
    this.broadcast();
    await this.scheduleRenewal(next);
  }

  /** An owner page of that device and that (unexpired) session is connected now. */
  private approverHere(r: Renewal, t: number) {
    return this.pages(OWNER_THREAD).some(
      (p) => p.a.device === r.device && p.a.session === r.session && (p.a.sessionUntil ?? 0) > t,
    );
  }

  /** The one alarm for a renewable grant: when its renewal window opens. */
  private async scheduleRenewal(g: Grant) {
    if (!g.remembered && g.renew && g.scope === "eval")
      await this.schedule(g.until - EVAL_RENEW_BEFORE_MS);
  }

  /**
   * The alarm, or an approving page connecting: renew what is due. A grant
   * whose window has not opened yet sets the alarm for when it does; one due
   * with no approving page waits for that page (its connect is the event).
   */
  private async renewDue(via: "page" | "alarm", only?: { device: string; session: string }) {
    await this.loadGrants();
    const t = this.now();
    for (const [hash, g] of this.grants ?? []) {
      const r = g.renew;
      if (g.remembered || !r || g.scope !== "eval" || g.until <= t) continue;
      if (only && (r.device !== only.device || r.session !== only.session)) continue;
      // Not due yet means the window opens strictly later: the alarm always moves forward.
      if (renewDueAt(g.until, t)) await this.renew(hash, via);
      else await this.scheduleRenewal(g);
    }
  }

  /** Block (or unblock) a friend: blocking closes their pages and every pairing made for them. */
  async block(userId: string, blocked: boolean): Promise<FriendRecord | null> {
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (!rec) return null;
    const next: FriendRecord = blocked
      ? { ...rec, blocked: true, blockedAt: this.now() }
      : { ...rec, blocked: false };
    await this.ctx.storage.put(friendKey(userId), next);
    console.log(JSON.stringify({ msg: blocked ? "debug.block" : "debug.unblock", userId }));
    if (!blocked) return next;
    for (const p of this.pages(userId)) {
      send(p.ws, { type: "friend-status", status: "blocked" });
      close(p.ws, 4403, "blocked");
    }
    for (const c of this.sockets("controller"))
      if (c.a.forUser === userId) {
        send(c.ws, { type: "revoked" });
        close(c.ws, 4401, "revoke");
      }
    this.broadcast();
    return next;
  }

  /**
   * A page joins (index.ts has checked who it is): it gets its own thread's
   * history and its audience's state. A blocked friend is told and closed.
   * Called without an identity (the unit tests' shorthand) it is an owner page.
   */
  async connectPage(ws: Socket, url: URL, who?: Identity, ticketSocket = false, box?: string) {
    // A page that says another site frames it (lib/frame-context.ts) is chat-only
    // like a ticket socket: no pairing, no Allow, no eval, no clips (defence in
    // depth: the page itself never connects from such a frame).
    const embed = ticketSocket || url.searchParams.get("frame") === "foreign";
    const isBox = ticketSocket && !!box;
    // The owner's box with box:eval: an owner page (minus clips and renewal), asked now.
    const boxEval = isBox && box ? (await this.boxEvalSays(box)) === "live" : false;
    // A box's lines say so, for the agent: "box /words …".
    const label = boxLabel(cleanLabel(url.searchParams.get("label"), MAX_LABEL), isBox);
    // The tab's own id (kept across reloads), so "this page" grants survive them.
    const tab = url.searchParams.get("tab");
    const id = isPageId(tab) ? tab : crypto.randomUUID().slice(0, 8);
    // For the avatars: a hashed id, the name, the picture. Never the email.
    const sender = who
      ? senderOf({
          userId: who.userId,
          email: who.email,
          name: who.name,
          avatars: [who.image],
        })
      : undefined;
    const me = sender && Object.keys(sender).length ? { sender } : {};
    if (who && !who.owner) {
      if (!isUserId(who.userId)) return close(ws, 4403, "no identity");
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(who.userId));
      if (rec?.blocked) {
        send(ws, { type: "friend-status", status: "blocked" });
        return close(ws, 4403, "blocked");
      }
      ws.serializeAttachment({
        role: "page",
        label,
        thread: who.userId,
        email: cleanLabel(who.email, 320),
        ...me,
        id,
        at: this.now(),
      } satisfies PageAtt);
      // `ai`: replies on this thread come from the model (the page says so in its strings).
      const ai = await this.aiOn();
      send(ws, { type: "friend-status", status: "open", ...(ai ? { ai: true } : {}) });
    } else
      ws.serializeAttachment({
        role: "page",
        label,
        thread: OWNER_THREAD,
        ...me,
        id,
        at: this.now(),
        // A chat-only page (a ticket socket, or a page another site frames) never
        // carries the owner's session: no eval grant is ever bound to or renewed on it.
        ...(boxEval
          ? { box, boxEval: true as const }
          : embed
            ? { embed: true as const, ...(isBox ? { box } : {}) }
            : who?.owner && who.session
              ? { session: who.session, sessionUntil: who.sessionUntil ?? 0, user: who.userId }
              : {}),
      } satisfies PageAtt);
    const thread = audience(att(ws) as PageAtt);
    // The page's own avatar (older pages ignore an unknown type).
    if (me.sender) send(ws, { type: "me", sender: me.sender });
    // A granted page is back: its pairings' grace clock stops at once.
    this.sweep();
    // Everyone sees the new page in their list; this one gets its state first.
    send(ws, pageState(att(ws) as PageAtt, this.state(thread)));
    send(ws, { type: "history", messages: await this.history(thread) });
    // Who is here (presence.ts): this page gets the list now.
    await this.presenceTo(thread, ws);
    this.broadcast(ws);
    // First page since the hub woke: list the sleeping eval grants too.
    if (!this.grants && thread === OWNER_THREAD) {
      await this.loadGrants();
      this.broadcast();
    }
    await this.pageBack(thread, label);
    // The owner's window session: recording follows it across URLs and origins.
    if (thread === OWNER_THREAD && !embed) {
      await this.clipsJoin(ws, url);
      // Now that its device is known: back in the grants its earlier page id had.
      await this.rejoin(ws);
    }
    // The device that approved an eval grant is back: renew what is due on it
    // (never from a chat-only page: it carries no session).
    const joined = att(ws);
    if (
      !embed &&
      joined?.role === "page" &&
      joined.thread === OWNER_THREAD &&
      joined.session &&
      joined.device
    )
      await this.renewDue("page", { device: joined.device, session: joined.session });
  }

  /**
   * A controller knocks. `?for=<email>` asks a friend's pages for an eval
   * pairing, and only an owner-approved grant may ask. With just a grant
   * token it is back in its grant's scope (and pages) at once. Otherwise it
   * waits for the owner: one pending pairing per audience, and only with a
   * page to ask. `?scope=chat` asks for the 30-day chat grant; anything else
   * for eval (and chat) for EVAL_GRANT_MS. Allow grants exactly what was asked.
   */
  async connectController(ws: Socket, url: URL, token?: string | null, evalToken?: string | null) {
    // An eval token is the owner's own grant, made on his token page: no tap, no friend.
    if (evalToken) return this.tokenController(ws, url, evalToken);
    const forKey = url.searchParams.get("for")?.trim();
    if (forKey) return this.pairForFriend(ws, url, forKey, token);
    if (token) return this.resume(ws, url, token);
    const label = cleanLabel(url.searchParams.get("label"), 80) || "unnamed controller";
    if (!this.clearPending(ws, OWNER_THREAD)) return;
    // Only a real owner page can answer a pairing: never a ticket socket or a framed page.
    if (this.pages(OWNER_THREAD, ws).filter((p) => !p.a.embed).length === 0) {
      send(ws, { type: "error", error: "no owner page in debug mode is open" });
      return close(ws, 4404, "no debug page");
    }
    const scope = url.searchParams.get("scope") === "chat" ? "chat" : "eval";
    // The owner's eval grant: its length and page scope are live config, read now
    // so the modal says what Allow grants and Allow grants exactly that.
    // (No config to ask, an older main Worker: no wait, the defaults.)
    const conf = scope === "eval" && this.sessions?.config ? await this.evalGrantConf() : undefined;
    this.knock(ws, {
      label,
      scope,
      ...(conf ? { grantMs: conf.ms, ...(conf.allPages ? { allPages: true } : {}) } : {}),
      ...whereOf(url),
    });
  }

  /** `debug.evalGrantHours` / `debug.evalGrantPages` from the main Worker; defaults when unreadable. */
  private evalGrantConf(): Promise<EvalGrantConf> {
    const rpc = this.sessions;
    return readEvalGrantConf(rpc?.config ? (key) => rpc.config!(key) : undefined);
  }

  /** Make room for one audience's pairing: false (and `ws` closed) if one is still waiting. */
  private clearPending(ws: Socket, who: string) {
    const t = this.now();
    for (const c of this.sockets("controller", ws)) {
      if (c.a.until || audience(c.a) !== who) continue;
      if (t - c.a.at < PENDING_MS) {
        send(ws, { type: "error", error: "another pairing request is waiting for an answer" });
        close(ws, 4429, "pairing busy");
        return false;
      }
      send(c.ws, { type: "expired" });
      close(c.ws, 4408, "pairing expired");
    }
    return true;
  }

  private knock(
    ws: Socket,
    extra: {
      label: string;
      scope: Scope;
      forUser?: string;
      forEmail?: string;
      node?: string;
      assignee?: string;
      grantMs?: number;
      allPages?: boolean;
    },
  ) {
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      at: this.now(),
      ...extra,
    };
    ws.serializeAttachment(a);
    send(ws, { type: "pending", code: a.code, expiresIn: PENDING_MS, for: a.forEmail });
    console.log(
      JSON.stringify({
        msg: "debug.pair",
        pair: a.pair,
        code: a.code,
        label: a.label,
        scope: a.scope,
        for: a.forUser,
      }),
    );
    this.broadcast();
  }

  /** Remembered authority is separate from its finite execution lease. No TTL extension. */
  private async rememberedLease(hash: string): Promise<Grant | null> {
    const trust = await this.ctx.storage.get<RememberedTrust>(trustKey(hash));
    if (!trust || !this.sessions) return null;
    // Newer pages first: stale tabs must not crowd a fresh login out of the
    // bounded check. Group tabs by session so one old login costs one RPC.
    const candidates = new Map<string, { ws: Socket; a: PageAtt }[]>();
    for (const page of this.pages(OWNER_THREAD).reverse()) {
      const { a } = page;
      if (
        a.embed ||
        a.user !== trust.user ||
        a.device !== trust.device ||
        !a.session ||
        (a.sessionUntil ?? 0) <= this.now()
      )
        continue;
      const group = candidates.get(a.session);
      if (group) group.push(page);
      else if (candidates.size < REMEMBERED_SESSION_CANDIDATES) candidates.set(a.session, [page]);
    }
    for (const [session, pages] of candidates) {
      try {
        if ((await this.sessions.live(trust.user, session)) !== "live") continue;
      } catch {
        continue;
      }
      const next = await this.exclusive(async () => {
        const current = await this.ctx.storage.get<RememberedTrust>(trustKey(hash));
        const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
        if (
          !current ||
          current.user !== trust.user ||
          current.device !== trust.device ||
          current.at !== trust.at ||
          !g?.remembered ||
          g.remembered.user !== trust.user ||
          g.remembered.device !== trust.device ||
          g.remembered.at !== trust.at
        )
          return null;
        // Re-read attachments after auth: logout, navigation or socket closure
        // while awaiting the RPC wins. Another live tab of this same session is OK.
        const page = pages.find(({ ws }) => {
          const a = att(ws);
          return (
            a?.role === "page" &&
            a.thread === OWNER_THREAD &&
            !a.embed &&
            a.user === trust.user &&
            a.device === trust.device &&
            a.session === session &&
            (a.sessionUntil ?? 0) > this.now() &&
            (ws.readyState === undefined || ws.readyState <= 1)
          );
        });
        if (!page) return null;
        const a = att(page.ws) as PageAtt;
        const lease: Grant = {
          ...g,
          until: Math.min(this.now() + EVAL_GRANT_MS, a.sessionUntil!),
          renew: { user: trust.user, device: trust.device, session, start: this.now(), count: 0 },
        };
        await this.putGrant(hash, lease);
        return lease;
      });
      if (next) return next;
    }
    return null;
  }

  /** The owner's live grant behind a token, or null (and a lapsed one deleted). */
  private async liveGrant(token: string) {
    const hash = await hashToken(token.slice(0, 256));
    const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
    if (g?.remembered) {
      const renewed = await this.rememberedLease(hash);
      return renewed ? { hash, g: renewed } : null;
    }
    if (g && g.until > this.now()) return { hash, g };
    if (g) await this.dropGrant(hash);
    return null;
  }

  /**
   * An eval pairing on one friend's pages. Only the owner's agent (a live
   * chat grant) may ask; the friend answers on their own device.
   */
  private async pairForFriend(ws: Socket, url: URL, key: string, token?: string | null) {
    const live = token ? await this.liveGrant(token) : null;
    if (!live) {
      send(ws, { type: "error", error: "pairing with a friend needs the owner's chat grant" });
      return close(ws, 4498, "grant invalid");
    }
    const f = await this.findFriend(key);
    if (!f || f.blocked) {
      send(ws, { type: "error", error: `no chat user ${key} (or blocked)` });
      return close(ws, 4404, "no such friend");
    }
    if (!this.clearPending(ws, f.userId)) return;
    if (this.pages(f.userId, ws).length === 0) {
      send(ws, { type: "error", error: `no debug page of ${f.email} is open` });
      return close(ws, 4404, "no debug page");
    }
    this.knock(ws, {
      label: cleanLabel(url.searchParams.get("label"), 80) || live.g.label,
      scope: "eval",
      forUser: f.userId,
      forEmail: f.email,
    });
  }

  /**
   * Reconnecting with a grant token: its scope (and an eval grant's pages)
   * again, no prompt, even with no page open — or 4498 if it is not live.
   */
  /**
   * A sender with an eval token (lib/eval-token.ts): the main Worker says
   * whether the token is live, holds `eval`, and belongs to a site owner now
   * (and audits the connect). Then it is an eval session on every owner page,
   * until the token expires, with no tap; a box page only while that box holds
   * box:eval (its own checks). Refused: closed (GRANT_INVALID); unsure: closed
   * so the sender retries. Nothing is stored here but the token's hash.
   */
  private async tokenController(ws: Socket, url: URL, token: string) {
    const rpc = this.sessions;
    let said: unknown;
    try {
      said = rpc?.evalToken ? await rpc.evalToken({ op: "connect", token }) : undefined;
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.eval-token-failed", error: String(e).slice(0, 200) }),
      );
      send(ws, { type: "error", error: "eval token: could not check it now; try again" });
      return close(ws, 4503, "eval token unsure");
    }
    const ok = evalTokenOk(said);
    if (!ok) {
      const why = (said as { error?: unknown } | undefined)?.error;
      send(ws, { type: "error", error: `eval token refused (${String(why ?? "unavailable")})` });
      console.log(JSON.stringify({ msg: "debug.eval-token-refused", why: String(why ?? "none") }));
      return close(ws, 4498, "eval token refused");
    }
    const until = Math.min(ok.expiresAt, Number.MAX_SAFE_INTEGER);
    if (!(until > this.now())) {
      send(ws, { type: "error", error: "eval token refused (expired)" });
      return close(ws, 4498, "eval token refused");
    }
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label: cleanLabel(url.searchParams.get("label"), 80) || `token ${ok.name}`,
      at: this.now(),
      until,
      scope: "eval",
      evalToken: ok.id,
      tokenTag: ok.tag,
      ...(ok.userId ? { tokenUser: ok.userId } : {}),
      ...(url.searchParams.get("beat") === "1" ? { beat: true } : {}),
      ...whereOf(url),
    };
    ws.serializeAttachment(a);
    send(ws, { type: "approved", until, scope: "eval", via: "token" });
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    console.log(
      JSON.stringify({ msg: "debug.eval-token", pair: a.pair, label: a.label, tag: ok.tag }),
    );
    await this.listenerUp(a);
    this.broadcast();
  }

  /**
   * Before each eval an eval-token sender sends: the main Worker checks the
   * token again (revoked, expired, no longer an owner) and audits the use.
   * Refused: the sender is closed. Unsure: this eval is not sent.
   */
  private async evalTokenStillOk(
    ws: Socket,
    c: ControllerAtt,
    v: { code: string; target?: string },
  ): Promise<boolean> {
    const rpc = this.sessions;
    let said: unknown;
    try {
      said = rpc?.evalToken
        ? await rpc.evalToken({
            op: "use",
            tokenHash: c.evalToken,
            len: v.code.length,
            ...(v.target ? { target: v.target } : {}),
          })
        : undefined;
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.eval-token-failed", error: String(e).slice(0, 200) }),
      );
      send(ws, { type: "error", error: "not sent: the eval token could not be checked now" });
      return false;
    }
    if (evalTokenOk(said)) return true;
    const why = (said as { error?: unknown } | undefined)?.error;
    if (why === "rate") {
      send(ws, { type: "error", error: "not sent: this eval token is over its rate limit" });
      return false;
    }
    send(ws, { type: "revoked", error: `eval token refused (${String(why ?? "unavailable")})` });
    close(ws, 4498, "eval token refused");
    this.broadcast(ws);
    return false;
  }

  /**
   * POST /internal/chat-tokens/revoked {tags?, userId?} (lib/push-chat-tokens.ts):
   * those tokens' eval senders close here, then their chat sockets (token-chat.ts).
   */
  private async tokensRevoked(req: Request): Promise<Response> {
    const text = req.method === "POST" ? await req.text() : "";
    let body: { tags?: unknown; userId?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {}
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const user = isUserId(body.userId) ? body.userId : undefined;
    let n = 0;
    for (const { ws, a } of this.sockets("controller"))
      if (a.tokenTag && (tags.includes(a.tokenTag) || (user && a.tokenUser === user))) {
        send(ws, { type: "revoked" });
        close(ws, 4498, "eval token revoked");
        n++;
      }
    if (n) {
      console.log(JSON.stringify({ msg: "debug.eval-token-revoked", closed: n }));
      this.broadcast();
    }
    return this.tokens.revoked(
      new Request(req.url, { method: req.method, headers: req.headers, body: text || undefined }),
    );
  }

  private async resume(ws: Socket, url: URL, token: string) {
    const live = await this.liveGrant(token);
    if (!live) {
      // Paused authority is not an invalid credential: 4498 would make the
      // CLI discard it and prompt again. Keep it for the next same-account login.
      const remembered = await this.ctx.storage.get<RememberedTrust>(
        trustKey(await hashToken(token.slice(0, 256))),
      );
      if (remembered) {
        send(ws, {
          type: "error",
          error: "remembered trust paused: sign in on the approved device",
        });
        return close(ws, 4409, "remembered trust paused");
      }
      send(ws, { type: "error", error: "grant is not valid (expired or ended)" });
      return close(ws, 4498, "grant invalid");
    }
    const { hash } = live;
    // A reconnect is a use: renew first if it is due, so `approved` carries the new until.
    await this.renew(hash, "resume");
    const g = (await this.ctx.storage.get<Grant>(`grant:${hash}`)) ?? live.g;
    const scope: Scope = g.scope === "eval" ? "eval" : "chat";
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label: cleanLabel(url.searchParams.get("label"), 80) || g.label,
      at: this.now(),
      until: g.until,
      scope,
      grant: hash,
      ...(g.remembered ? { remembered: g.remembered, rememberedSession: g.renew?.session } : {}),
      ...(scope === "eval" && g.pages ? { pages: g.pages } : {}),
      ...(url.searchParams.get("beat") === "1" ? { beat: true } : {}),
      ...whereOf(url),
    };
    ws.serializeAttachment(a);
    send(ws, { type: "approved", until: g.until, scope, resumed: true });
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    console.log(JSON.stringify({ msg: "debug.resume", pair: a.pair, label: a.label, scope }));
    await this.loadGrants();
    this.broadcast();
    await this.listenerUp(a);
  }

  /**
   * Page-scoped eval pairings whose pages are all away: note since when, and
   * close them (PAGES_GONE) once that is PAGE_GONE_GRACE_MS ago. No timer:
   * this runs on every event, the way expiry is checked. Only the socket
   * closes: a stored grant stays, so its sender resumes with the token,
   * without a prompt, once a page is back.
   */
  private sweep(except?: Socket) {
    const t = this.now();
    for (const c of this.sockets("controller", except)) {
      const { pages, until, scope } = c.a;
      if (!pages || scope === "chat" || !until || until <= t) continue;
      const present = this.pages(audience(c.a), except).some(
        (p) => p.a.id && pages.includes(p.a.id),
      );
      if (present) {
        if (c.a.goneSince) c.ws.serializeAttachment({ ...c.a, goneSince: undefined });
      } else if (!c.a.goneSince) c.ws.serializeAttachment({ ...c.a, goneSince: t });
      else if (t - c.a.goneSince >= PAGE_GONE_GRACE_MS) {
        send(c.ws, {
          type: "error",
          error: c.a.grant
            ? "the page you were authorized for is gone: your grant stays, reconnect with its token when the page is back"
            : "the page you were authorized for is gone: pair again",
        });
        close(c.ws, PAGES_GONE, "authorized pages gone");
        console.log(JSON.stringify({ msg: "debug.pages-gone", pair: c.a.pair }));
        this.broadcast(c.ws);
      }
    }
  }

  /**
   * The last page of `thread` closed: remember since when, and wake up
   * PAGES_IDLE_MS later (the Durable Object alarm — nothing else would happen
   * to trigger the check: a quiet thread has no events).
   */
  private async markEmpty(thread: string) {
    const key = `empty:${thread}`;
    if (!(await this.ctx.storage.get<number>(key))) await this.ctx.storage.put(key, this.now());
    await this.schedule(this.now() + PAGES_IDLE_MS);
  }

  /**
   * Burn speaker-proof uids in storage (`proof:<uid>` → until), so a proof
   * serves one line only, across restarts, hibernation and deploys. Storage
   * calls of one event never interleave with another's (the Durable Object's
   * input gate), so check-then-put is atomic. The alarm sweeps them later.
   */
  private async burnProofs(uids: string[], until: number): Promise<boolean> {
    for (const u of uids) if (await this.ctx.storage.get(`proof:${u}`)) return false;
    for (const u of uids) await this.ctx.storage.put(`proof:${u}`, until);
    await this.schedule(until);
    return true;
  }

  /** Forget burned proofs past their window (they can no longer verify anyway). */
  private async proofSweep() {
    const all = await this.ctx.storage.list<number>({ prefix: "proof:" });
    let next = Number.POSITIVE_INFINITY;
    for (const [k, until] of all) {
      if (until <= this.now()) await this.ctx.storage.delete(k);
      else next = Math.min(next, until);
    }
    if (Number.isFinite(next)) await this.schedule(next);
  }

  /** Make sure the alarm goes off by `at` (one already due is the one running now). */
  private async schedule(at: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur <= this.now()) await this.ctx.storage.setAlarm(at);
  }

  /** A page of `thread` opened: not empty any more; if it had gone idle, the agent hears it is back. */
  private async pageBack(thread: string, label: string) {
    await this.ctx.storage.delete(`empty:${thread}`);
    if (!(await this.ctx.storage.delete(`idle:${thread}`))) return;
    const back = { type: "pages-back", thread, label, at: this.now() };
    for (const { ws } of this.listeners()) send(ws, back);
    console.log(JSON.stringify({ msg: "debug.pages-back", thread }));
  }

  private checking?: Promise<void>;

  /**
   * Threads empty for PAGES_IDLE_MS: tell the agent ({type:"pages-idle"}),
   * close the heartbeat sockets beating for them, and keep `idle:<thread>` so
   * the first page back is announced. Run by the alarm, and on every message
   * (one check at a time, so a thread is announced once).
   */
  checkIdle(): Promise<void> {
    this.checking ??= this.idleNow().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async idleNow() {
    const t = this.now();
    let next: number | null = null;
    for (const [key, since] of await this.ctx.storage.list<number>({ prefix: "empty:" })) {
      const thread = key.slice("empty:".length);
      if (this.pages(thread).length > 0) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (t - since < PAGES_IDLE_MS) {
        next = Math.min(next ?? Infinity, since + PAGES_IDLE_MS);
        continue;
      }
      await this.ctx.storage.delete(key);
      await this.ctx.storage.put(`idle:${thread}`, t);
      const idle = { type: "pages-idle", thread, at: t };
      for (const { ws, a } of this.listeners()) {
        send(ws, idle);
        if (a.beat && a.beatThread === thread) close(ws, PAGES_IDLE, "pages idle");
      }
      console.log(JSON.stringify({ msg: "debug.pages-idle", thread }));
    }
    if (next !== null) await this.schedule(next);
  }

  /** The Durable Object alarm (set by markEmpty). */
  async alarm() {
    this.sweep();
    await this.checkIdle();
    await this.clipsSweep();
    await this.proofSweep();
    await this.renewDue("alarm");
    // A read or a line left its presence window: the pages hear who is left.
    for (const thread of new Set(this.sockets("page").map((p) => p.a.thread)))
      await this.pushPresence(thread);
  }

  webSocketMessage(ws: Socket, raw: string | ArrayBuffer): void | Promise<void> {
    // The alarm is what normally announces an idle thread; any message checks too.
    this.checkIdle().catch(() => {});
    this.sweep();
    if (ws.readyState !== undefined && ws.readyState > 1) return;
    // The auto-response normally answers it before the hub sees it.
    if (raw === KEEPALIVE.ping) return ws.send(KEEPALIVE.pong);
    // An API-token socket: never a page or a controller (token-chat.ts).
    const ta = tokenAtt(ws);
    if (ta) return this.tokens.message(ws, ta, raw);
    const a = att(ws);
    if (a?.role === "page") return this.fromPage(ws, a, raw);
    if (a?.role !== "controller") return;
    // A use of the owner's eval grant near its end renews it first (if allowed).
    const t = this.now();
    if (a.grant && a.scope === "eval" && !a.forUser && a.until && a.until > t)
      if (renewDueAt(a.until, t))
        return this.renew(a.grant, "use").then(() => {
          const b = att(ws);
          return b?.role === "controller" ? this.fromController(ws, b, raw) : undefined;
        });
    return this.fromController(ws, a, raw);
  }

  private fromPage(ws: Socket, page: PageAtt, raw: unknown): void | Promise<void> {
    // An embedded page (another site) may only chat and say where it is:
    // no answers, no pairings, no results, no clips, no page errors.
    // The owner's box may also amend voice lines and tap ask cards, and only
    // while the main Worker still says its box:chat is live.
    if (page.box) {
      const em = parsePageMessage(raw);
      if (!em) return;
      if (BOX_PAGE_TYPES.has(em.type))
        return this.boxStillChats(ws, page).then((ok) =>
          ok ? this.fromPageChecked(ws, page, raw) : undefined,
        );
      // box:eval: pairing answers, results and page errors, each checked first.
      if (!page.boxEval || !BOX_EVAL_TYPES.has(em.type)) return;
      return this.boxStillEvals(ws, page).then((ok) =>
        ok ? this.fromPageChecked(ws, att(ws) as PageAtt, raw) : undefined,
      );
    }
    if (page.embed) {
      const em = parsePageMessage(raw);
      if (!em || (em.type !== "chat" && em.type !== "page")) return;
    }
    return this.fromPageChecked(ws, page, raw);
  }

  /**
   * Asked before each line a box sends: "live", or the socket closes
   * ("gone": box:chat removed, box revoked, account no longer an owner, flag
   * off; a main Worker without the check counts as gone). Unsure (busy, an
   * error): this line is dropped and the page told; the socket stays.
   */
  private async boxStillChats(ws: Socket, page: PageAtt): Promise<boolean> {
    // Called on the stub itself: an RPC method taken off it with .bind is refused
    // ("The RPC receiver does not implement the method"), at least under wrangler dev.
    const rpc = this.sessions;
    let said: unknown = "gone";
    try {
      if (rpc?.boxChat && page.box) said = await rpc.boxChat(page.box);
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.box-check-failed", error: String(e).slice(0, 200) }),
      );
      said = "unsure";
    }
    if (said === "live") return true;
    if (said === "gone") {
      console.log(JSON.stringify({ msg: "debug.box-closed", why: "check" }));
      close(ws, BOX_CLOSED, "box chat ended");
      return false;
    }
    if (said !== "unsure")
      console.log(JSON.stringify({ msg: "debug.box-check", said: String(said) }));
    send(ws, { type: "error", error: "not sent: try again in a moment" });
    return false;
  }

  /** The main Worker's word on a box's page powers: "live", "gone", or "unsure". */
  private async boxEvalSays(cid: string): Promise<"live" | "gone" | "unsure"> {
    // Called on the stub itself, as boxChat (a .bind-ed RPC method is refused).
    const rpc = this.sessions;
    try {
      if (!rpc?.boxEval) return "gone";
      const said = await rpc.boxEval(cid);
      if (said === "live" || said === "gone") return said;
      console.log(JSON.stringify({ msg: "debug.box-eval-check", said: String(said) }));
      return "unsure";
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "debug.box-eval-check-failed", error: String(e).slice(0, 200) }),
      );
      return "unsure";
    }
  }

  /**
   * Asked before each eval-power message a box page sends (a pairing answer,
   * a result, a page error): "live", or the box's pages drop back to
   * chat-only ("gone": box:eval removed, or anything box:chat needs). Unsure:
   * this message is dropped; the page keeps its powers.
   */
  private async boxStillEvals(ws: Socket, page: PageAtt): Promise<boolean> {
    if (!page.box) return false;
    const said = await this.boxEvalSays(page.box);
    if (said === "live") return true;
    if (said === "gone") this.boxEvalEnded(page.box);
    else send(ws, { type: "error", error: "not sent: try again in a moment" });
    return false;
  }

  /**
   * A box lost box:eval: its pages become chat-only embed pages again (no
   * eval, no pairing, minimal state). Its chat goes on while box:chat holds.
   */
  private boxEvalEnded(cid: string): number {
    let n = 0;
    for (const { ws, a } of this.sockets("page")) {
      if (a.box !== cid || !a.boxEval) continue;
      const { boxEval: _gone, ...rest } = a;
      const next: PageAtt = { ...rest, embed: true };
      ws.serializeAttachment(next);
      send(ws, pageState(next, this.state(next.thread)));
      n++;
    }
    if (n) {
      console.log(JSON.stringify({ msg: "debug.box-eval-ended", pages: n }));
      this.broadcast();
    }
    return n;
  }

  /**
   * POST /internal/box-closed {client, scope?}: that box lost box:chat. Its
   * chat sockets close now. With `scope: "eval"` it lost box:eval only: its
   * pages drop back to chat-only. Reached only over the main Worker's PUSH binding.
   */
  private async boxClosedApi(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { client?: unknown; scope?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    const client = body.client;
    if (typeof client !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(client))
      return Response.json({ error: "expected {client}" }, { status: 400 });
    if (body.scope === "eval") return Response.json({ ok: true, ended: this.boxEvalEnded(client) });
    let closed = 0;
    for (const { ws, a } of this.sockets("page"))
      if (a.box === client) {
        close(ws, BOX_CLOSED, "box chat ended");
        closed++;
      }
    if (closed) this.broadcast();
    console.log(JSON.stringify({ msg: "debug.box-closed", why: "notice", closed }));
    return Response.json({ ok: true, closed });
  }

  private fromPageChecked(ws: Socket, page: PageAtt, raw: unknown): void | Promise<void> {
    const pm = participantMessage(raw);
    if (pm) return this.participantFromPage(ws, page, pm);
    const cm = clipsParse(raw, parseClipsPageMessage);
    if (cm) return page.thread === OWNER_THREAD ? this.clipsFromPage(ws, page, cm) : undefined;
    const m = parsePageMessage(raw);
    if (!m) return;
    const t = this.now();
    if (m.type === "page") {
      // Only this socket's own label; silent: the agent hears it, the chat never shows it.
      const label = boxLabel(m.label, !!page.box);
      if (label === page.label) return;
      ws.serializeAttachment({ ...page, label } satisfies PageAtt);
      const moved = {
        type: "page-changed",
        label,
        thread: page.thread,
        ...(page.email ? { email: page.email } : {}),
        at: t,
      };
      for (const { ws: c } of this.listeners()) send(c, moved);
      return this.broadcast();
    }
    if (m.type === "end-page") {
      // Only a page of the same audience (the owner's own, or this friend's own).
      const target = this.pages(page.thread).find((p) => p.a.id && p.a.id === m.id);
      if (!target) return send(ws, this.state(page.thread));
      send(target.ws, { type: "page-ended" });
      close(target.ws, PAGE_ENDED, "ended from another page");
      console.log(
        JSON.stringify({ msg: "debug.end-page", thread: page.thread, page: target.a.label }),
      );
      return this.broadcast(target.ws);
    }
    if (m.type === "page-error") {
      // The owner's pages only: a friend's page never reports one (and is
      // ignored if it does). Forwarded live to the owner-approved listeners,
      // never stored, never sent to any page.
      if (page.thread !== OWNER_THREAD) return;
      console.log(
        JSON.stringify({
          msg: "debug.page-error",
          kind: m.kind,
          path: m.path,
          ...(m.status !== undefined ? { status: m.status } : {}),
          head: head(m.message),
        }),
      );
      const out = { ...m, label: page.label, hubAt: t };
      for (const { ws: c } of this.agents()) send(c, out);
      return;
    }
    if (m.type === "chat") {
      console.log(
        JSON.stringify({
          msg: "debug.chat",
          page: page.label,
          thread: page.thread,
          len: m.text.length,
          // A user's words are never logged (docs/partner-ai.md, "Privacy"): the owner's only.
          ...(page.thread === OWNER_THREAD ? { head: head(m.text) } : {}),
          ...(m.to ? { to: m.to } : {}),
          // Its length only: the selection itself is never logged.
          ...(m.context ? { selection: m.context.selection.length } : {}),
          // How many files, never their names.
          ...(m.attachments ? { files: m.attachments.length } : {}),
        }),
      );
      // A friend's line is always their own thread's: no node addressing there.
      // Its attachment (the page selection) stays on the sender's own thread.
      // Files are the owner's only (the upload is owner-only): a friend's refs are dropped.
      if (page.thread !== OWNER_THREAD)
        return this.friendChat(ws, page, m.id, m.text, m.context, m.scene, m.source === "stt");
      const line = async (speaker: SpeakerTag | undefined) => {
        // Voice lines only: a typed line never asks the flag, never merges, never waits.
        const merging = m.source === "stt" && (await this.mergeOn());
        if (
          merging &&
          m.continues &&
          (await this.merge(page, {
            id: m.id,
            at: t,
            continues: m.continues,
            text: m.text,
            ...(m.timing ? { timing: m.timing } : {}),
            ...(m.stt ? { stt: m.stt } : {}),
            ...(m.to ? { to: m.to } : {}),
            ...(m.wake ? { wake: m.wake } : {}),
            ...(m.wakeReason ? { wakeReason: m.wakeReason } : {}),
            ...(m.context ? { context: m.context } : {}),
            ...(m.attachments ? { attachments: m.attachments } : {}),
            ...(speaker ? { speaker } : {}),
          }))
        )
          return;
        // The same sentence from his other mic, a moment ago: one line, not two.
        if (
          m.source === "stt" &&
          (await this.twoMic({
            id: m.id,
            text: m.text,
            label: page.label,
            at: t,
            ...(m.stt ? { stt: m.stt } : {}),
            ...(speaker ? { speaker } : {}),
          }))
        )
          return;
        return this.post({
          id: m.id,
          from: "owner",
          label: page.label,
          text: m.text,
          at: t,
          thread: OWNER_THREAD,
          ...(page.sender ? { sender: page.sender } : {}),
          ...(m.to ? { to: m.to } : {}),
          ...(m.source ? { source: m.source } : {}),
          ...(m.timing ? { timing: m.timing } : {}),
          // Which recognizer made the text (SttTag): route and engine, never text.
          ...(m.stt ? { stt: m.stt } : {}),
          ...(m.wake ? { wake: m.wake } : {}),
          ...(m.wakeReason ? { wakeReason: m.wakeReason } : {}),
          ...(m.context ? { context: m.context } : {}),
          ...(m.attachments ? { attachments: m.attachments } : {}),
          ...(m.scene ? { scene: m.scene } : {}),
          // Only a tag the Mac signed over these words (lib/speaker-proof.ts); voice
          // approvals later must rely on this, never on what a page says.
          ...(speaker ? { speaker } : {}),
          ...(merging ? { mergeable: true as const } : {}),
        });
      };
      // Kept, then (a voice line) the hub's own polish is due after the tail window.
      const spoken = async (speaker: SpeakerTag | undefined) => {
        await line(speaker);
        if (m.source === "stt") this.autoPolishSoon(page);
      };
      // A voice line with the Mac's signed attestations: verified first, then stored.
      if (m.source === "stt" && m.speakerProof?.length)
        return verifySpeakerProofs(
          m.speakerProof,
          m.text,
          page.thread,
          this.speakerPub,
          (uids, until) => this.burnProofs(uids, until),
          this.now(),
        ).then(spoken);
      return spoken(undefined);
    }
    if (m.type === "passage-end") return this.passageEnd(page);
    if (m.type === "unmerge") return this.unmerge(ws, page, m.id);
    // A tap on an ask card: stamped here, never by the page or an agent.
    if (m.type === "answer") return this.answer(ws, page, m.askId, m.choices);
    // A sleeping eval grant (listed to the owner's pages only): End, or add a page.
    if ((m.type === "revoke" || m.type === "allow") && m.pair.startsWith(DORMANT))
      return page.thread === OWNER_THREAD
        ? this.dormant(ws, page, m)
        : send(ws, this.state(page.thread));
    // Only a pairing made for this page's own audience can be answered or sent results.
    const c = this.controller(m.type === "result" || m.type === "chunk" ? m.to : m.pair);
    if (
      !c ||
      audience(c.a) !== page.thread ||
      (c.a.remembered && c.a.remembered.user !== page.user)
    )
      return send(ws, this.state(page.thread));
    if (m.type === "allow") {
      const pages = this.grantPages(page, m.pages);
      // Approved already: another page joins its grant ("Authorize this page" later).
      if (c.a.remembered) return send(ws, this.state(page.thread));
      if (c.a.until && c.a.until > t) return this.widen(c.a, pages);
      if (c.a.until || t - c.a.at >= PENDING_MS) return send(ws, this.state(page.thread));
      // Allow grants what the requester asked for (`scope` from an older page
      // still counts). A friend's answer is always eval on their own pages.
      // A chat grant is for every page: a phone's page comes and goes with the app.
      return (c.a.scope === "chat" || m.scope === "chat") && !c.a.forUser
        ? this.allowChat(c.ws, c.a)
        : this.allowEval(c.ws, c.a, pages, page, m.remember, ws);
    }
    if (m.type === "deny" || m.type === "revoke") return this.end(m.type, c.ws, c.a);
    // A result (or a streamed piece of one) goes back only to an approved
    // controller that is still in time.
    if ((m.type !== "result" && m.type !== "chunk") || !c.a.until || c.a.until <= t) return;
    if (c.a.remembered && !this.reach(c.a, page.thread).some((p) => p.ws === ws)) return;
    const { to: _to, ...rest } = m;
    send(c.ws, { ...rest, page: page.label });
  }

  /**
   * A friend's message: no approval needed, but a blocked friend is closed
   * and more than FRIEND_CHAT_MAX in a window is dropped (and the page told).
   * Their first ever message tells the agent ({type:"friend-new"}).
   */
  private async friendChat(
    ws: Socket,
    page: PageAtt,
    id: string,
    text: string,
    context?: ChatContext,
    scene?: SttScene,
    spoken = false,
  ) {
    const t = this.now();
    const userId = page.thread;
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (rec?.blocked) {
      send(ws, { type: "friend-status", status: "blocked" });
      return close(ws, 4403, "blocked");
    }
    const rateKey = `rate:${userId}`;
    let rate = (await this.ctx.storage.get<Rate>(rateKey)) ?? { start: t, count: 0 };
    if (t - rate.start >= FRIEND_CHAT_WINDOW_MS) rate = { start: t, count: 0 };
    if (rate.count >= FRIEND_CHAT_MAX)
      return send(ws, {
        type: "rate-limited",
        id,
        retryIn: rate.start + FRIEND_CHAT_WINDOW_MS - t,
      });
    await this.ctx.storage.put(rateKey, {
      start: rate.start,
      count: rate.count + 1,
    } satisfies Rate);
    const email = rec?.email || page.email || "";
    await this.ctx.storage.put(friendKey(userId), {
      ...(rec ?? { firstSeen: t }),
      email,
      lastAt: t,
      count: (rec?.count ?? 0) + 1,
    } satisfies FriendRecord);
    if (!rec) {
      console.log(JSON.stringify({ msg: "debug.friend-new", userId, email }));
      for (const l of this.listeners()) send(l.ws, { type: "friend-new", userId, email, at: t });
    }
    await this.post({
      id,
      from: "friend",
      label: page.label,
      text,
      at: t,
      thread: userId,
      email,
      ...(page.sender ? { sender: page.sender } : {}),
      ...(context ? { context } : {}),
      ...(spoken ? { source: "stt", ...(scene ? { scene } : {}) } : {}),
    });
    // The owner's thread never gets here (OWNER_THREAD lines go to the owner's lanes).
    const ai = await this.aiState();
    if (ai === "on") await this.aiReply(page, email, t, context, scene, id);
    // The AI could not even be asked: the page says so, rather than leave the line unanswered.
    else if (ai === "unsure")
      for (const { ws } of this.pages(page.thread)) send(ws, { type: "ai-failed" });
  }

  /**
   * The last read of PARTNER_AI_FLAG, without asking (state() is synchronous).
   * Its age does not matter here: it only counts the AI as a listener, and the
   * next connect or line reads the flag again.
   */
  private aiCachedOn() {
    return this.aiFlag?.on === true;
  }

  /**
   * Is PARTNER_AI_FLAG on? Asked of the main Worker (DebugSessions.flag) at
   * most once per AI_FLAG_CACHE_MS. Only exactly true is on: no binding, an
   * older main Worker, "busy", an error — all off, so friends' chat stays as
   * it was (the lanes answer).
   */
  private async aiOn(): Promise<boolean> {
    return (await this.aiState()) === "on";
  }

  /**
   * aiOn, telling "off" from "unsure": the flag could not be read (an RPC
   * error, already logged as debug.rpc-failed, or "busy"). A friend's line
   * then gets ai-failed ("No reply this time…") instead of silence.
   */
  private async aiState(): Promise<"on" | "off" | "unsure"> {
    const t = this.now();
    const cached = this.aiFlag;
    if (cached && t - cached.at < AI_FLAG_CACHE_MS)
      return cached.on ? "on" : cached.unsure ? "unsure" : "off";
    let said: unknown = false;
    let unsure = false;
    try {
      if (this.sessions?.partnerReply) said = await this.flagValue(PARTNER_AI_FLAG);
    } catch {
      unsure = true;
    }
    if (said === "busy") unsure = true;
    const on = !unsure && said === true;
    this.aiFlag = { at: t, on, ...(unsure ? { unsure: true as const } : {}) };
    return on ? "on" : unsure ? "unsure" : "off";
  }

  /**
   * A flag's value from the main Worker's DebugSessions.flag; undefined with
   * no binding. Called on the stub itself, never through `.bind(stub)`: workerd
   * sends that as a call of a method named "bind", which the main Worker
   * refuses ("The RPC receiver does not implement the method") — every flag
   * read made that way failed in production from #482 until #681.
   * A failure is logged as debug.rpc-failed and thrown.
   */
  private async flagValue(key: string): Promise<unknown> {
    const rpc = this.sessions;
    if (!rpc?.flag) return undefined;
    try {
      return await rpc.flag(key);
    } catch (e) {
      rpcFailed("flag", e, key);
      throw e;
    }
  }

  /**
   * Answer a friend's line with the model (docs/partner-ai.md). The thread is
   * the hub-verified user's own; the owner's is never passed here. Within the
   * daily caps, a reservation is taken before the call (so concurrent calls
   * cannot all pass a nearly spent cap) and settled with the real counts after.
   * The reply is dropped when an agent (a lane) posted in this thread after
   * the line, or a newer line started its own turn: a human reply wins.
   */
  private async aiReply(
    page: PageAtt,
    email: string,
    lineAt: number,
    context?: ChatContext,
    scene?: SttScene,
    msgId?: string,
  ) {
    const thread = page.thread;
    const rpc = this.sessions;
    if (thread === OWNER_THREAD || !isUserId(thread) || !rpc?.partnerReply) return;
    const t = this.now();
    const day = jstDay(t);
    const userKey = aiUserKey(day, thread);
    const siteKey = aiSiteKey(day);
    const used = (await this.ctx.storage.get<number>(userKey)) ?? 0;
    const site = await this.ctx.storage.get<number>(siteKey);
    if (site === undefined) await this.aiDropOldDays(day);
    const lines = (await this.history(thread))
      .filter((m) => m.from === "friend" || m.from === "agent")
      .slice(-HISTORY_LINES)
      .map((m) => ({ role: m.from === "friend" ? "user" : "assistant", text: m.text }) as const);
    // The newest lines within HISTORY_MAX_CHARS (the latest one always).
    const history: typeof lines = [];
    let chars = 0;
    for (const h of lines.toReversed()) {
      if (history.length && chars + h.text.length > HISTORY_MAX_CHARS) break;
      history.unshift(h);
      chars += h.text.length;
    }
    const path = page.label.split(" ")[0]?.slice(0, 300);
    const pageInfo: NonNullable<PartnerRequest["page"]> = {
      ...(context?.path || scene?.path || path
        ? { path: context?.path ?? scene?.path ?? path }
        : {}),
      ...(context?.title || scene?.title ? { title: context?.title ?? scene?.title } : {}),
      ...(context?.selection ? { selection: context.selection } : {}),
      ...(scene?.screen ? { screen: scene.screen } : {}),
    };
    const pageChars = Object.values(pageInfo).reduce((n, v) => n + (v?.length ?? 0), 0);
    // The most this call can cost: a ceiling on input tokens for everything the
    // prompt can hold (lib/partner-ai-config.ts), and every output token used.
    const reserveIn = reserveInTokens(chars + pageChars);
    const reserveTokens = reserveIn + MAX_OUTPUT_TOKENS;
    const reserveMicro = Math.ceil(costUsd(reserveIn, MAX_OUTPUT_TOKENS) * 1e6);
    if (
      used + reserveTokens > USER_DAILY_TOKENS ||
      (site ?? 0) + reserveMicro > SITE_DAILY_USD * 1e6
    ) {
      console.log(
        JSON.stringify({
          msg: "partner.capped",
          which: used + reserveTokens > USER_DAILY_TOKENS ? "user" : "site",
        }),
      );
      for (const { ws } of this.pages(thread)) send(ws, { type: "ai-limit" });
      return;
    }
    await this.ctx.storage.put(userKey, used + reserveTokens);
    await this.ctx.storage.put(siteKey, (site ?? 0) + reserveMicro);
    const turn = (this.aiTurn.get(thread) ?? 0) + 1;
    this.aiTurn.set(thread, turn);
    const beat = () => {
      const b = { type: "busy", label: PARTNER_AI_LABEL, at: this.now() };
      for (const { ws } of this.pages(thread)) send(ws, b);
    };
    beat();
    const timer = setInterval(beat, AI_BEAT_MS);
    const req: PartnerRequest = {
      userId: thread,
      ...(msgId ? { msgId } : {}),
      history,
      page: pageInfo,
    };
    let res: PartnerResult;
    try {
      // On the stub itself: see flagValue.
      res = ((await rpc.partnerReply(req)) ?? {
        ok: false,
        error: "model-failed",
        billed: "unknown",
      }) as PartnerResult;
    } catch (e) {
      // The RPC failed: the model may have run. Keep the reservation.
      rpcFailed("partnerReply", e);
      res = { ok: false, error: "model-failed", billed: "unknown" };
    } finally {
      clearInterval(timer);
    }
    // Settle. Reported usage replaces the reservation; without it, the
    // reservation stands (a ceiling), unless the call surely billed nothing (a
    // refusal before the model, or an error status from it).
    // Each count on its own: a missing (or zero) one keeps its part of the reservation.
    const unbilled = !res.ok && !res.tokensIn && !res.tokensOut && res.billed !== "unknown";
    const tokensIn = res.tokensIn ? res.tokensIn : unbilled ? 0 : reserveIn;
    const tokensOut = res.tokensOut ? res.tokensOut : unbilled ? 0 : MAX_OUTPUT_TOKENS;
    const nowUser = (await this.ctx.storage.get<number>(userKey)) ?? 0;
    const nowSite = (await this.ctx.storage.get<number>(siteKey)) ?? 0;
    await this.ctx.storage.put(
      userKey,
      Math.max(0, nowUser - reserveTokens + tokensIn + tokensOut),
    );
    await this.ctx.storage.put(
      siteKey,
      Math.max(0, nowSite - reserveMicro + Math.ceil(costUsd(tokensIn, tokensOut) * 1e6)),
    );
    const stale = this.aiTurn.get(thread) !== turn || (this.agentAt.get(thread) ?? 0) >= lineAt;
    // Token counts and latency only: never the text, the user or the page.
    console.log(
      JSON.stringify({
        msg: "partner.reply",
        ok: res.ok,
        ...(res.ok
          ? {
              tokensIn,
              tokensOut,
              model: res.model,
              ...(res.charged !== undefined ? { charged: res.charged } : {}),
            }
          : { error: res.error }),
        ...(res.ms !== undefined ? { ms: res.ms } : {}),
        ...(res.ok && stale ? { dropped: true } : {}),
      }),
    );
    if (!res.ok) {
      // Off, the owner, or a line already answered: nothing to say (the lanes
      // still answer). No credits: the page says how to get some. Otherwise it failed.
      if (res.error === "no-credits")
        for (const { ws } of this.pages(thread))
          send(ws, {
            type: "ai-credits",
            // The minimum one reply needs and the balance (numbers only), for the chat's line.
            ...(res.need !== undefined ? { need: res.need, have: res.have ?? 0 } : {}),
          });
      else if (res.error !== "off" && res.error !== "owner" && res.error !== "duplicate")
        for (const { ws } of this.pages(thread)) send(ws, { type: "ai-failed" });
      return;
    }
    if (stale) return;
    await this.post({
      id: crypto.randomUUID().slice(0, 8),
      from: "agent",
      label: PARTNER_AI_LABEL,
      text: res.text,
      at: this.now(),
      thread,
      email,
    });
  }

  /** A new JST day: the usage keys of earlier days go (they only ever counted against caps). */
  private async aiDropOldDays(day: string) {
    const old = await this.ctx.storage.list<number>({ prefix: "ai:" });
    for (const k of old.keys()) if (!k.startsWith(`ai:${day}:`)) await this.ctx.storage.delete(k);
  }

  /**
   * The page ids an Allow covers: "all" (or nothing said, from an older page)
   * is undefined = every page, now and later; a list keeps only this
   * audience's open pages, and never comes out empty (at least the answering one).
   */
  private grantPages(page: PageAtt, want: string[] | "all" | undefined) {
    if (want === undefined || want === "all") return undefined;
    const open = new Set(
      this.pages(page.thread)
        .filter((p) => !p.a.embed)
        .map((p) => p.a.id),
    );
    const ids = want.filter((id) => open.has(id));
    return ids.length ? [...new Set(ids)] : page.id ? [page.id] : undefined;
  }

  /** Add pages to an approved pairing (and every socket sharing its grant); undefined = all. */
  private async widen(a: ControllerAtt, pages: string[] | undefined) {
    if (!a.pages || a.scope === "chat") return this.broadcast();
    const next = pages ? [...new Set([...a.pages, ...pages])] : undefined;
    const targets = this.sockets("controller").filter((c) =>
      a.grant ? c.a.grant === a.grant : c.a.pair === a.pair,
    );
    for (const c of targets)
      c.ws.serializeAttachment({ ...c.a, pages: next } satisfies ControllerAtt);
    if (a.grant) {
      const g = await this.ctx.storage.get<Grant>(`grant:${a.grant}`);
      if (g) await this.putGrant(a.grant, { ...g, pages: next } satisfies Grant);
    }
    console.log(JSON.stringify({ msg: "debug.widen", pair: a.pair, pages: next ?? "all" }));
    this.broadcast();
  }

  /**
   * "Allow" for eval. The owner's: code and chat for EVAL_GRANT_MS, with a
   * grant token the controller resumes with (pages and all). A friend's
   * preview: code only, for APPROVAL_MS, on this socket only — no token.
   * The owner's is bound for renewal to the answering page's device and
   * session, when that page has both ("Renewal" above).
   */
  private async allowEval(
    ws: Socket,
    a: ControllerAtt,
    pages?: string[],
    by?: PageAtt,
    remember = false,
    approver?: Socket,
  ) {
    if (
      remember &&
      (a.forUser ||
        !by?.user ||
        !by.device ||
        !by.session ||
        (by.sessionUntil ?? 0) <= this.now() ||
        !this.sessions ||
        !approver)
    )
      return send(ws, {
        type: "error",
        error: "remember requires a signed-in developer page on this device",
      });
    if (remember) {
      let live = false;
      try {
        live = (await this.sessions!.live(by!.user!, by!.session!)) === "live";
      } catch {
        /* fail closed */
      }
      if (!live)
        return send(ws, { type: "error", error: "remember requires a live developer session" });
    }
    const t = this.now();
    if (a.forUser) {
      const until = t + APPROVAL_MS;
      ws.serializeAttachment({ ...a, until, scope: "eval", pages } satisfies ControllerAtt);
      send(ws, { type: "approved", until, scope: "eval", for: a.forEmail });
      console.log(
        JSON.stringify({ msg: "debug.allow", pair: a.pair, label: a.label, until, for: a.forUser }),
      );
      // A pairing for a friend is eval only: it is handed no chat.
      return this.broadcast();
    }
    // The length and page scope read at the knock (live config); a pairing from
    // before that rule has neither: 8 hours, the pages ticked.
    const ms = a.grantMs ?? EVAL_GRANT_MS;
    if (a.allPages) pages = undefined;
    const until = remember ? Math.min(t + EVAL_GRANT_MS, by!.sessionUntil!) : t + ms;
    const remembered: RememberedTrust | undefined = remember
      ? { user: by!.user!, device: by!.device!, at: t }
      : undefined;
    if (remembered) pages = undefined;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    // Only an owner page signed in with a session, on a known device, starts a chain.
    const renew: Renewal | undefined =
      by?.thread === OWNER_THREAD && by.session && by.device && by.user
        ? { device: by.device, session: by.session, user: by.user, start: t, count: 0 }
        : undefined;
    const g: Grant = {
      label: a.label,
      until,
      scope: "eval",
      ...(remembered ? { remembered } : {}),
      at: t,
      ms,
      ...(pages ? { pages } : {}),
      ...(renew ? { renew } : {}),
    };
    const save = async () => {
      if (remembered) {
        const current = att(ws);
        const page = approver && att(approver);
        if (
          ws.readyState === 3 ||
          current?.role !== "controller" ||
          current.pair !== a.pair ||
          current.until ||
          current.scope !== a.scope ||
          !page ||
          page.role !== "page" ||
          page.thread !== OWNER_THREAD ||
          page.embed ||
          page.user !== by!.user ||
          page.device !== by!.device ||
          page.session !== by!.session ||
          (page.sessionUntil ?? 0) <= this.now() ||
          approver?.readyState === 3
        )
          return false;
        await this.ctx.storage.put(trustKey(grant), remembered);
      }
      await this.putGrant(grant, g);
      ws.serializeAttachment({
        ...a,
        until,
        scope: "eval",
        pages,
        grant,
        ...(remembered ? { remembered, rememberedSession: by!.session } : {}),
      } satisfies ControllerAtt);
      return true;
    };
    if (!(remembered ? await this.exclusive(save) : await save())) return;
    send(ws, {
      type: "approved",
      until,
      scope: "eval",
      token,
      ...(renew && !remembered ? { renewsUntil: t + EVAL_CHAIN_MS } : {}),
    });
    console.log(
      JSON.stringify({
        msg: "debug.allow",
        pair: a.pair,
        label: a.label,
        until,
        scope: "eval",
        ...(renew ? { device: renew.device, renewable: true } : {}),
      }),
    );
    await this.scheduleRenewal(g);
    this.broadcast();
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    await this.listenerUp(a);
  }

  /** End (revoke) a sleeping eval grant, or add the answering page to it. */
  private async dormant(
    ws: Socket,
    page: PageAtt,
    m: { type: string; pair: string; pages?: string[] | "all" },
  ) {
    await this.loadGrants();
    const prefix = m.pair.slice(DORMANT.length);
    const found =
      prefix.length === 40 ? [...(this.grants ?? [])].find(([h]) => h.startsWith(prefix)) : null;
    if (!found || found[1].scope !== "eval") return send(ws, this.state(page.thread));
    const [hash, g] = found;
    if (g.remembered && g.remembered.user !== page.user) return send(ws, this.state(page.thread));
    if (m.type === "revoke") {
      await this.dropGrant(hash);
      // Nothing should hold it (it was listed as asleep), but close any that does.
      for (const c of this.sockets("controller"))
        if (c.a.grant === hash) {
          send(c.ws, { type: "revoked" });
          close(c.ws, 4401, "revoke");
        }
      console.log(JSON.stringify({ msg: "debug.revoke", grant: "idle", label: g.label }));
      return this.broadcast();
    }
    if (g.remembered) return this.broadcast();
    if (g.pages) {
      const more = this.grantPages(page, m.pages);
      const next = more ? [...new Set([...g.pages, ...more])] : undefined;
      await this.putGrant(hash, { ...g, pages: next });
      console.log(JSON.stringify({ msg: "debug.widen", grant: "idle", pages: next ?? "all" }));
    }
    this.broadcast();
  }

  /** "Allow" for chat: 30 days, with a grant token the controller can resume with. */
  private async allowChat(ws: Socket, a: ControllerAtt) {
    const until = this.now() + CHAT_MS;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    await this.putGrant(grant, { label: a.label, until } satisfies Grant);
    ws.serializeAttachment({
      ...a,
      until,
      scope: "chat",
      grant,
      pages: undefined,
    } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "chat", token });
    console.log(
      JSON.stringify({ msg: "debug.allow", pair: a.pair, label: a.label, until, scope: "chat" }),
    );
    this.broadcast();
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    await this.listenerUp(a);
  }

  /**
   * Deny a pairing, or End a session — and with it the stored grant behind it
   * (chat or eval), on every socket using it: the token resumes nothing after.
   */
  private end(kind: "deny" | "revoke", ws: Socket, a: ControllerAtt): void | Promise<void> {
    const targets = a.grant
      ? this.sockets("controller").filter((c) => c.a.grant === a.grant)
      : [{ ws, a }];
    for (const c of targets) {
      send(c.ws, { type: kind === "deny" ? "denied" : "revoked" });
      close(c.ws, kind === "deny" ? 4403 : 4401, kind);
    }
    console.log(JSON.stringify({ msg: `debug.${kind}`, pair: a.pair, label: a.label }));
    if (!a.grant) return this.broadcast(ws);
    const hash = a.grant;
    return this.dropGrant(hash).then(() => this.broadcast(ws));
  }

  /** Where an agent's `say` goes: the owner's thread, or a friend's by user id or email. */
  private async sayTarget(
    to?: string,
  ): Promise<{ thread: string; email?: string } | { error: string }> {
    if (!to || to === OWNER_THREAD) return { thread: OWNER_THREAD };
    const f = await this.findFriend(to);
    if (!f) return { error: `no chat thread for ${to}` };
    if (f.blocked) return { error: `${f.email} is blocked` };
    return { thread: f.userId, email: f.email };
  }

  /**
   * A node grant (the fallback for a scoped token): senders within `from` may
   * address nodes within `to`, for `ms` (EVAL_GRANT_MS by default). Only a
   * listener whose node holds both may grant it or take it back; the root's always may.
   */
  private async nodeGrant(
    ws: Socket,
    c: ControllerAtt,
    m: { type: "grant" | "ungrant"; from: string; to: string; ms?: number },
  ) {
    const home = c.node ?? ROOT_NODE;
    if (!isWithin(m.from, home) || !isWithin(m.to, home)) {
      const reason = `out of scope: a listener at ${home} cannot grant ${m.from} → ${m.to}`;
      return send(ws, { type: "error", error: reason, reason });
    }
    const key = nodeGrantKey(m.from, m.to);
    if (m.type === "ungrant") {
      await this.ctx.storage.delete(key);
      console.log(JSON.stringify({ msg: "debug.node-ungrant", from: m.from, to: m.to }));
      return send(ws, { type: "ungranted", from: m.from, to: m.to });
    }
    const until = this.now() + (m.ms ?? EVAL_GRANT_MS);
    await this.ctx.storage.put(key, { from: m.from, to: m.to, until } satisfies NodeGrant);
    console.log(
      JSON.stringify({ msg: "debug.node-grant", from: m.from, to: m.to, until, by: home }),
    );
    send(ws, { type: "granted", from: m.from, to: m.to, until });
  }

  /**
   * `eval.ts inbox …` (lib/inbox/agent.ts): passed to the main Worker's
   * DebugSessions.inbox over SESSIONS, its answer sent back as
   * inbox-list / inbox-ticket / inbox-done. Ids only in the log, never names.
   */
  private async inbox(ws: Socket, req: { op: string; id?: string }) {
    const sessions = this.sessions;
    if (!sessions?.inbox) return send(ws, { type: "error", error: "the inbox is not available" });
    let a: Record<string, unknown>;
    try {
      a = ((await sessions.inbox(req)) ?? {}) as Record<string, unknown>;
    } catch (e) {
      rpcFailed("inbox", e, req.op);
      return send(ws, { type: "error", error: "the inbox did not answer" });
    }
    console.log(JSON.stringify({ msg: "debug.inbox", op: req.op, ok: a.ok === true }));
    if (a.ok !== true) return send(ws, { type: "error", error: String(a.error ?? "inbox failed") });
    const type =
      req.op === "list" ? "inbox-list" : req.op === "get" ? "inbox-ticket" : "inbox-done";
    send(ws, { ...a, type });
  }

  private fromController(ws: Socket, c: ControllerAtt, raw: unknown): void | Promise<void> {
    if (c.remembered && c.grant)
      return this.rememberedLease(c.grant).then((g) => {
        if (!g)
          return send(ws, {
            type: "error",
            error: "remembered trust paused: sign in on the approved device, or pair again",
          });
        const next = { ...c, until: g.until, rememberedSession: g.renew?.session };
        ws.serializeAttachment(next);
        if (g.until !== c.until) send(ws, { type: "renewed", until: g.until, count: 0 });
        return this.fromApprovedController(ws, next, raw);
      });
    return this.fromApprovedController(ws, c, raw);
  }

  private fromApprovedController(ws: Socket, c: ControllerAtt, raw: unknown): void | Promise<void> {
    const t = this.now();
    if (!c.until) return send(ws, { type: "error", error: "not approved yet" });
    if (c.until <= t) {
      send(ws, { type: "expired" });
      close(ws, 4408, "approval expired");
      return this.broadcast(ws);
    }
    const clip = clipsParse(raw, (j) => (j.type === "clips" ? parseClipsControl(j) : null));
    if (clip) {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot record" });
      if (!clip.ok) return send(ws, { type: "error", error: clip.error });
      return this.clipsControl(ws, c, clip.value);
    }
    const box = inboxRequest(raw);
    if (box) {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot read the inbox" });
      return this.inbox(ws, box);
    }
    const m = parseControllerMessage(raw);
    if (!m.ok) return send(ws, { type: "error", error: m.error });
    if (m.value.type === "busy") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { to, label } = m.value;
      return this.sayTarget(to).then((dest) => {
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        // Only that thread's pages; not stored, not logged (one every few seconds).
        const pages = this.reach(c, dest.thread);
        if (c.beat && c.beatThread !== dest.thread)
          ws.serializeAttachment({ ...c, beatThread: dest.thread } satisfies ControllerAtt);
        const beat = { type: "busy", label: label || c.label, at: t };
        for (const { ws: p } of pages) send(p, beat);
        send(ws, { type: "beat", thread: dest.thread, delivered: pages.length, at: t });
      });
    }
    if (m.value.type === "wake") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { to, mode } = m.value;
      return this.sayTarget(to).then((dest) => {
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        // That thread's pages set their mic's mode (docs/wake-word.md); not stored.
        const pages = this.reach(c, dest.thread);
        for (const { ws: p } of pages) send(p, { type: "wake", mode, at: t });
        console.log(
          JSON.stringify({ msg: "debug.wake", thread: dest.thread, mode, delivered: pages.length }),
        );
        send(ws, { type: "woke", thread: dest.thread, mode, delivered: pages.length, at: t });
      });
    }
    if (m.value.type === "grant" || m.value.type === "ungrant") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      return this.nodeGrant(ws, c, m.value);
    }
    if (m.value.type === "edit") return this.edit(ws, c, m.value);
    if (m.value.type === "withdraw") return this.withdraw(ws, c, m.value);
    if (m.value.type === "summary") return this.summarise(ws, c, m.value);
    if (m.value.type === "merge") return this.mergeRun(ws, c, m.value);
    if (m.value.type === "unmerge") return this.unmergeByAgent(ws, c, m.value.id);
    if (m.value.type === "ask") return this.ask(ws, c, m.value.ask, m.value.to);
    if (m.value.type === "say") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { text, to, node, agentId, quiet, cut, lane, voice } = m.value;
      // The sender's node: what the line says, within the node its socket listens at.
      const home = c.node ?? ROOT_NODE;
      const from = m.value.taskPath ?? home;
      if (!isWithin(from, home)) {
        const reason = `taskPath ${from} is outside this listener's node ${home}`;
        return send(ws, { type: "error", error: reason, reason });
      }
      if (node && to) {
        const reason = "address a thread or a node, not both";
        return send(ws, { type: "error", error: reason, reason });
      }
      const scoped = node
        ? this.nodeGrants().then((grants) => mayAddress(from, node, grants, t))
        : Promise.resolve({ ok: true as const });
      return Promise.all([scoped, this.sayTarget(to)]).then(([scope, dest]) => {
        if (!scope.ok) return send(ws, { type: "error", error: scope.error, reason: scope.error });
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        const who = agentId ?? c.assignee;
        const said: ChatMessage & { thread: string } = {
          id: crypto.randomUUID().slice(0, 8),
          from: "agent",
          label: c.label,
          text,
          at: t,
          ...dest,
          // A friend's pairing never gets here (it cannot chat), nor the partner AI (aiReply).
          ...(dest.thread === OWNER_THREAD ? { ownerGrant: true as const } : {}),
          ...(from !== ROOT_NODE ? { taskPath: from } : {}),
          ...(who ? { agentId: who } : {}),
          ...(node ? { to: node } : {}),
          // say --quiet (already a boolean): shown, never read aloud.
          ...(quiet ? { quiet } : {}),
          // say --supersede | --interject (already checked): how it cuts into the reading, live only.
          ...(cut ? { cut } : {}),
          // Its lane and voice (packages/debug-chat/src/voices.ts), already checked against the table.
          ...(lane ? { lane } : {}),
          ...(voice ? { voice } : {}),
        };
        console.log(
          JSON.stringify({
            msg: "debug.say",
            pair: c.pair,
            controller: c.label,
            thread: said.thread,
            ...(said.taskPath ? { taskPath: said.taskPath } : {}),
            ...(said.to ? { to: said.to } : {}),
            ...(quiet ? { quiet } : {}),
            ...(cut ? { cut } : {}),
            ...(lane ? { lane } : {}),
            ...(voice ? { voice } : {}),
            len: text.length,
            // A reply in a user's thread may quote them: only the owner's thread logs its start.
            ...(said.thread === OWNER_THREAD ? { head: head(text) } : {}),
          }),
        );
        const only = c.scope !== "chat" && said.thread === audience(c) ? c.pages : undefined;
        return this.post(said, only).then(() =>
          send(ws, { type: "said", id: said.id, thread: said.thread }),
        );
      });
    }
    if (c.scope === "chat")
      return send(ws, { type: "error", error: "this session is chat-only: it cannot eval" });
    const ev = m.value;
    // An eval token: the main Worker checks it again, and audits this use, first.
    if (c.evalToken)
      return this.evalTokenStillOk(ws, c, ev).then((ok) =>
        ok ? this.dispatchEval(ws, att(ws) as ControllerAtt, ev) : undefined,
      );
    return this.dispatchEval(ws, c, ev);
  }

  /** One eval to the pages a sender reaches (and the box's, each asked first). */
  private dispatchEval(
    ws: Socket,
    c: ControllerAtt,
    ev: { code: string; target?: string },
  ): void | Promise<void> {
    const id = crypto.randomUUID().slice(0, 8);
    const labels: string[] = [];
    // Only the pages of the audience that approved this pairing — or the ones it named.
    const reach = this.reach(c, audience(c));
    if (c.pages && reach.length === 0)
      // Away, not yet for PAGE_GONE_GRACE_MS (sweep() closes it after that).
      return send(ws, {
        type: "error",
        error: c.grant
          ? "the page you were authorized for is not connected now; this socket closes if it stays away 5 min (the grant stays: reconnect with its token)"
          : "the page you were authorized for is not connected now; the pairing ends if it stays away 5 min",
      });
    const targets = reach.filter((p) => !p.a.embed && matchesTarget(p.a.label, ev.target));
    const deliver = (to: typeof targets) => {
      for (const p of to) {
        send(p.ws, { type: "eval", id, code: ev.code, to: c.pair });
        labels.push(p.a.label);
      }
      this.evalSent(ws, c, ev, id, labels);
    };
    // The owner's box (box:eval): asked of the main Worker before each eval it is sent.
    const boxes = [...new Set(targets.map((p) => p.a.box).filter((b): b is string => !!b))];
    if (!boxes.length) return deliver(targets);
    return Promise.all(boxes.map(async (b) => [b, await this.boxEvalSays(b)] as const)).then(
      (said) => {
        const live = new Set(said.filter(([, s]) => s === "live").map(([b]) => b));
        for (const [b, s] of said) if (s === "gone") this.boxEvalEnded(b);
        deliver(targets.filter((p) => !p.a.box || live.has(p.a.box)));
      },
    );
  }

  /** The agent hears where an eval went (and the log says so). */
  private evalSent(
    ws: Socket,
    c: ControllerAtt,
    v: { code: string; target?: string },
    id: string,
    labels: string[],
  ) {
    const m = { value: v };
    console.log(
      JSON.stringify({
        msg: "debug.eval",
        id,
        pair: c.pair,
        controller: c.label,
        for: c.forUser,
        len: m.value.code.length,
        target: m.value.target,
        head: m.value.code.slice(0, 200),
        delivered: labels.length,
      }),
    );
    send(ws, { type: "sent", id, delivered: labels.length, labels });
  }

  /**
   * A socket left. A page leaving changes its audience's page list (and may
   * empty its thread); a controller, the sessions and the listener count —
   * so every page gets a fresh state either way.
   */
  // --- Who is here (packages/debug-chat/src/presence.ts) ---

  /** The presence windows (live config), read at most once a minute. */
  private presenceConf?: { at: number; readMs: number; speakerMs: number };
  private async presenceWindows() {
    const t = this.now();
    if (this.presenceConf && t - this.presenceConf.at < 60_000) return this.presenceConf;
    const min = async (key: string, dflt: number) => {
      try {
        const v = await this.sessions?.config?.(key);
        return typeof v === "number" && v > 0 ? v : dflt;
      } catch {
        return dflt;
      }
    };
    const readMs = (await min("chat.presenceReadMin", 5)) * 60_000;
    const speakerMs = (await min("chat.presenceSpeakerMin", 30)) * 60_000;
    this.tokens.readMs = readMs;
    return (this.presenceConf = { at: t, readMs, speakerMs });
  }

  /** Threads whose list is pushed on the next turn (one push for a burst of changes). */
  private presenceDue = new Set<string>();
  presenceSoon(thread: string) {
    if (this.presenceDue.has(thread)) return;
    this.presenceDue.add(thread);
    queueMicrotask(() => {
      this.presenceDue.delete(thread);
      this.pushPresence(thread).catch((e) => rpcFailed("presence", e));
    });
  }

  /** The thread's list for one page: token ids only for the tokens of the page's own account. */
  private async presenceFor(thread: string, pages: { ws: Socket; a: PageAtt }[]) {
    const t = this.now();
    const records = [
      ...(await this.ctx.storage.list<PartRecord>({ prefix: partKey("") })).values(),
    ].filter((r) => r.thread === thread);
    const lines = await this.history(thread);
    const live = this.tokens.live(thread);
    // No one to list: no config read either.
    if (!records.length && !live.length && !lines.some((m) => m.from === "agent"))
      return pages.map(({ ws }) => ({ ws, list: [] }));
    const { readMs, speakerMs } = await this.presenceWindows();
    const next = nextExpiry({ now: t, readMs, speakerMs, records, lines });
    if (next !== null) await this.schedule(next + 1);
    return pages.map(({ ws, a }) => {
      // The account a page is signed in as: the owner's (`user`), or the friend's thread.
      const viewer =
        a.embed || a.box ? undefined : (a.user ?? (thread !== OWNER_THREAD ? thread : undefined));
      return {
        ws,
        list: presentList({ now: t, readMs, speakerMs, live, records, lines, viewer }),
      };
    });
  }

  /** Push the thread's list to its pages (each its own), when it changed. */
  private presenceSent = new WeakMap<object, string>();
  async pushPresence(thread: string) {
    const pages = this.pages(thread);
    if (!pages.length) return;
    for (const { ws, list } of await this.presenceFor(thread, pages)) {
      const body = JSON.stringify({ type: "present", list });
      if (this.presenceSent.get(ws) === body) continue;
      this.presenceSent.set(ws, body);
      try {
        ws.send(body);
      } catch {}
    }
  }

  /** One page's list (on connect). */
  private async presenceTo(thread: string, ws: Socket) {
    const page = this.pages(thread).find((p) => p.ws === ws);
    if (!page) return;
    await this.pushPresence(thread);
  }

  /**
   * GET /api/version/chat-avatar/<sha256>: a kept avatar (token-chat.ts), the
   * sanitized SVG only, content-addressed: public, immutable, never scripted.
   */
  private async avatarApi(req: Request, url: URL): Promise<Response> {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const svg = await this.tokens.avatarSvg(url.pathname.slice(AVATAR_PATH.length));
    if (!svg) return new Response("not found", { status: 404 });
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; style-src 'none'; script-src 'none'",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
      },
    });
  }

  /**
   * A page names a participant or sets its picture (PresenceStack.tsx): only
   * a full page (not embedded, not a box) of the account that owns the token
   * (token-chat.ts override). The page hears the result as {type:"participant-result"}.
   */
  private async participantFromPage(ws: Socket, page: PageAtt, m: ParticipantMessage) {
    const viewer =
      page.embed || page.box
        ? undefined
        : (page.user ?? (page.thread !== OWNER_THREAD ? page.thread : undefined));
    const r = await this.tokens.override(viewer, m.tok, m);
    send(ws, { type: "participant-result", tok: m.tok, ...r });
  }

  webSocketClose(ws: Socket, code: number): void | Promise<void> {
    const a = att(ws);
    const ta = tokenAtt(ws);
    close(ws, code === 1005 ? 1000 : code, "");
    // A token's listening socket closed: it may have left the thread.
    if (ta?.thread) this.presenceSoon(ta.thread);
    this.sweep(ws);
    this.broadcast(ws);
    const gone = a?.role === "page" && a.sid ? this.clipsLeft(a.sid, ws) : undefined;
    if (a?.role === "page" && this.pages(a.thread, ws).length === 0)
      return Promise.all([gone, this.markEmpty(a.thread)]).then(() => {});
    return gone;
  }

  // --- Voice-clip recording: one window session at a time (see the header) ---

  /** The owner pages of one window session that hold it open (not ones that said they are going). */
  private clipPages(sid: string, except?: Socket) {
    return this.pages(OWNER_THREAD, except).filter((p) => p.a.sid === sid && !p.a.leaving);
  }

  private async clipRecords(): Promise<ClipsRec[]> {
    return [...(await this.ctx.storage.list<ClipsRec>({ prefix: "clips:" })).values()];
  }

  /** The sink the agent last set up (`clips on --sink`), which a tap on a page reuses. */
  private sinkConfig() {
    return this.ctx.storage.get<SinkConfig>(SINK_CONFIG);
  }

  /** What one page of a session is told; `token` is the session's fresh handoff token. */
  private clipsMsg(
    sid: string,
    device: string,
    rec?: ClipsRec,
    token?: string,
    extra: Partial<ClipsState> = {},
  ): ClipsState {
    const t = this.now();
    return {
      type: "clips",
      sid,
      device,
      on: !!rec,
      ...(rec
        ? {
            since: rec.at,
            ...(rec.until ? { until: rec.until, left: Math.max(0, rec.until - t) } : {}),
            ...(rec.sink ? { sink: rec.sink } : {}),
            ...(rec.sinkKey ? { sinkKey: rec.sinkKey } : {}),
            origins: rec.origins ?? [LIANKI_ORIGIN],
            ...(token ? { handoff: token } : {}),
          }
        : {}),
      ...extra,
    };
  }

  /** Store a recording session with a new handoff token, and tell each of its pages. */
  private async clipsPublish(rec: ClipsRec, extraFor?: { ws: Socket; extra: Partial<ClipsState> }) {
    const token = randomId(24);
    const next: ClipsRec = { ...rec, handoff: await hashToken(token) };
    await this.ctx.storage.put(clipsKey(rec.sid), next);
    for (const p of this.pages(OWNER_THREAD))
      if (p.a.sid === rec.sid)
        send(
          p.ws,
          this.clipsMsg(
            rec.sid,
            rec.device,
            next,
            token,
            p.ws === extraFor?.ws ? extraFor.extra : {},
          ),
        );
    if (next.until) await this.schedule(next.until);
  }

  /** Recording stops (a tap, the agent, the auto-stop): the record goes, its pages hear "off". */
  private async clipsStop(rec: ClipsRec, why: string) {
    await this.ctx.storage.delete(clipsKey(rec.sid));
    const canStart = !!(await this.sinkConfig());
    for (const p of this.pages(OWNER_THREAD))
      if (p.a.sid === rec.sid)
        send(
          p.ws,
          this.clipsMsg(rec.sid, p.a.device ?? rec.device, undefined, undefined, { canStart }),
        );
    console.log(JSON.stringify({ msg: "debug.clips-off", sid: rec.sid.slice(0, 6), why }));
  }

  /**
   * An owner page connected: put it in its window's session (see the header).
   * It joins a recording session silently only when nothing suggests a
   * window was closed in between: a handoff token, the same document coming
   * back (`cont=1`: it was recording when its socket dropped, e.g. the screen
   * went off), or a quick reload or navigation (not hidden, within
   * CLIPS_GONE_MS). A tab closed while hidden and restored later, or a page
   * back from the bfcache, is offered "Continue recording" instead: a tap.
   */
  private async clipsJoin(ws: Socket, url: URL) {
    const page = att(ws) as PageAtt;
    const t = this.now();
    let sid = url.searchParams.get("ws") ?? "";
    let device = url.searchParams.get("dev") ?? "";
    if (!isClipsId(sid)) sid = randomId();
    if (!isClipsId(device)) device = randomId();
    const hand = url.searchParams.get("hand");
    const cont = url.searchParams.get("cont") === "1";
    // The page went through pagehide (a bfcache return): it is only ever offered its session.
    const back = url.searchParams.get("back") === "1";
    const all = await this.clipRecords();
    const canStart = !!(await this.sinkConfig());
    let rec: ClipsRec | undefined;
    if (isHandoffToken(hand)) {
      const h = await hashToken(hand);
      rec = all.find((r) => r.handoff === h);
    }
    const quick = (r: ClipsRec) =>
      !r.hidden && (r.goneAt === undefined || t - r.goneAt < CLIPS_GONE_MS);
    if (!rec) {
      const own = all.find((r) => r.sid === sid);
      if (own && !back && (cont || quick(own))) rec = own;
    }
    // A page that said it is leaving counts as gone already (its close may come after this knock).
    const orphan = (r: ClipsRec) => this.clipPages(r.sid, ws).length === 0;
    // No token (an address typed by hand): this device's session that just lost its page.
    if (!rec && !back) {
      const mine = all.filter((r) => r.device === device && r.sid !== sid && quick(r) && orphan(r));
      if (mine.length === 1) rec = mine[0];
    }
    if (!rec) {
      ws.serializeAttachment({ ...page, sid, device } satisfies PageAtt);
      // Offered, never taken: this window's own session after a gap, or another that just lost its page.
      const resumable = all
        .filter((r) => orphan(r) && (r.sid === sid || quick(r)))
        .map((r) => ({ sid: r.sid, label: r.label ?? "", since: r.at }));
      return send(
        ws,
        this.clipsMsg(sid, device, undefined, undefined, {
          canStart,
          ...(resumable.length ? { resumable } : {}),
        }),
      );
    }
    const paused = rec.goneAt !== undefined ? t - rec.goneAt : undefined;
    ws.serializeAttachment({ ...page, sid: rec.sid, device: rec.device } satisfies PageAtt);
    const { goneAt: _g, hidden: _h, ...live } = rec;
    console.log(
      JSON.stringify({ msg: "debug.clips-join", sid: rec.sid.slice(0, 6), handoff: !!hand, cont }),
    );
    await this.clipsPublish(
      { ...live, label: page.label },
      paused ? { ws, extra: { paused } } : undefined,
    );
  }

  /** A page of a session closed: with none left, the session's grace clock starts. */
  private async clipsLeft(sid: string, ws: Socket) {
    if (this.clipPages(sid, ws).length > 0) return;
    const rec = await this.ctx.storage.get<ClipsRec>(clipsKey(sid));
    if (!rec || rec.goneAt !== undefined) return;
    const t = this.now();
    await this.ctx.storage.put(clipsKey(sid), { ...rec, goneAt: t } satisfies ClipsRec);
    await this.schedule(t + (rec.hidden ? CLIPS_HIDDEN_MS : CLIPS_GONE_MS));
  }

  /** Auto-stops due, and sessions whose pages stayed away past their grace: gone. Never a clip. */
  async clipsSweep() {
    const t = this.now();
    let next: number | null = null;
    const at = (x: number) => (next = Math.min(next ?? Infinity, x));
    for (const rec of await this.clipRecords()) {
      if (rec.until && rec.until <= t) {
        await this.clipsStop(rec, "auto-stop");
        continue;
      }
      if (rec.until) at(rec.until);
      if (this.clipPages(rec.sid).length > 0) continue;
      if (rec.goneAt === undefined) {
        // Woken after an eviction with no page: its clock starts now.
        await this.ctx.storage.put(clipsKey(rec.sid), { ...rec, goneAt: t } satisfies ClipsRec);
        at(t + (rec.hidden ? CLIPS_HIDDEN_MS : CLIPS_GONE_MS));
        continue;
      }
      const end = rec.goneAt + (rec.hidden ? CLIPS_HIDDEN_MS : CLIPS_GONE_MS);
      if (end <= t) {
        await this.ctx.storage.delete(clipsKey(rec.sid));
        console.log(JSON.stringify({ msg: "debug.clips-ended", sid: rec.sid.slice(0, 6) }));
      } else at(end);
    }
    if (next !== null) await this.schedule(next);
  }

  private async clipsFromPage(
    ws: Socket,
    page: PageAtt,
    m: NonNullable<ReturnType<typeof parseClipsPageMessage>>,
  ) {
    const sid = page.sid;
    if (!sid || !page.device) return;
    const t = this.now();
    const rec = await this.ctx.storage.get<ClipsRec>(clipsKey(sid));
    if (m.type === "clips-vis") {
      const leaving = m.state === "leaving";
      if (!!page.leaving !== leaving)
        ws.serializeAttachment({ ...page, leaving: leaving || undefined } satisfies PageAtt);
      const hidden = m.state === "hidden";
      if (rec && !!rec.hidden !== hidden)
        await this.ctx.storage.put(clipsKey(sid), {
          ...rec,
          hidden: hidden || undefined,
        } satisfies ClipsRec);
      return;
    }
    const cfg = await this.sinkConfig();
    if (m.type === "clips-off")
      return rec
        ? this.clipsStop(rec, "page")
        : send(ws, this.clipsMsg(sid, page.device, undefined, undefined, { canStart: !!cfg }));
    if (m.type === "clips-on") {
      // Recording with nowhere to keep the clips would only look like recording.
      const sink = rec?.sink ? rec : cfg ? { sink: cfg.url, sinkKey: cfg.key } : null;
      if (!sink) return send(ws, this.clipsMsg(sid, page.device, rec));
      console.log(
        JSON.stringify({
          msg: "debug.clips-on",
          sid: sid.slice(0, 6),
          by: "page",
          minutes: m.minutes,
        }),
      );
      return this.clipsPublish({
        sid,
        device: page.device,
        at: rec?.at ?? t,
        sink: sink.sink,
        ...(sink.sinkKey ? { sinkKey: sink.sinkKey } : {}),
        origins: rec?.origins ?? cfg?.origins ?? [LIANKI_ORIGIN],
        ...(m.minutes ? { until: t + m.minutes * 60_000 } : {}),
        label: page.label,
      });
    }
    // clips-adopt: a session that has no page now (another window's, or this
    // window's own after a gap), continued here by a tap.
    const other = await this.ctx.storage.get<ClipsRec>(clipsKey(m.sid));
    if (!other || this.clipPages(m.sid, ws).length > 0)
      return send(ws, this.clipsMsg(sid, page.device, rec));
    ws.serializeAttachment({ ...page, sid: other.sid, device: other.device } satisfies PageAtt);
    const { goneAt: _g, hidden: _h, ...live } = other;
    console.log(JSON.stringify({ msg: "debug.clips-adopt", sid: other.sid.slice(0, 6) }));
    return this.clipsPublish({ ...live, label: page.label });
  }

  /** The agent's `eval.ts clips`: list the owner's window sessions, or turn recording on or off. */
  private async clipsControl(ws: Socket, c: ControllerAtt, m: ClipsControl) {
    const t = this.now();
    const recs = await this.clipRecords();
    // Every session: the live ones (from the pages) and the recording ones (stored).
    const by = new Map<string, { sid: string; device: string; labels: string[]; rec?: ClipsRec }>();
    for (const p of this.pages(OWNER_THREAD)) {
      if (!p.a.sid || !p.a.device) continue;
      const s = by.get(p.a.sid) ?? { sid: p.a.sid, device: p.a.device, labels: [] };
      s.labels.push(p.a.label);
      by.set(p.a.sid, s);
    }
    for (const r of recs) {
      const s = by.get(r.sid) ?? { sid: r.sid, device: r.device, labels: r.label ? [r.label] : [] };
      s.rec = r;
      by.set(r.sid, s);
    }
    const view = (s: { sid: string; device: string; labels: string[]; rec?: ClipsRec }) => ({
      sid: s.sid,
      device: s.device,
      on: !!s.rec,
      pages: s.labels,
      ...(s.rec?.until ? { until: s.rec.until } : {}),
      ...(s.rec?.sink ? { sink: s.rec.sink } : {}),
      ...(s.rec?.goneAt !== undefined ? { goneAt: s.rec.goneAt, hidden: !!s.rec.hidden } : {}),
    });
    const hits = [...by.values()].filter((s) => matchesSession(m.match, s));
    if (m.op === "list")
      return send(ws, { type: "clips-list", sessions: [...by.values()].map(view), at: t });
    if (m.op === "off") {
      for (const s of hits) if (s.rec) await this.clipsStop(s.rec, "agent");
      return send(ws, {
        type: "clips-done",
        op: "off",
        sessions: hits.filter((s) => s.rec).map((s) => s.sid),
        at: t,
      });
    }
    // On: the live sessions it matches (a window with a page open now).
    const live = hits.filter((s) => this.clipPages(s.sid).length > 0);
    if (!live.length)
      return send(ws, {
        type: "error",
        error: `no open owner page matches "${m.match}" (eval.ts clips lists them)`,
      });
    // The sink set here is the one a tap on a page reuses later (with its write key and origins).
    let cfg = await this.sinkConfig();
    if (m.sink && m.sinkKey) {
      cfg = {
        url: m.sink,
        key: m.sinkKey,
        origins: m.origins ?? cfg?.origins ?? [LIANKI_ORIGIN],
        at: t,
      };
      await this.ctx.storage.put(SINK_CONFIG, cfg);
    }
    if (!cfg)
      return send(ws, {
        type: "error",
        error: "clips on needs --sink <url>: where the clips are kept",
      });
    for (const s of live) {
      await this.clipsPublish({
        sid: s.sid,
        device: s.device,
        at: s.rec?.at ?? t,
        sink: cfg.url,
        sinkKey: cfg.key,
        origins: m.origins ?? cfg.origins,
        ...(m.minutes ? { until: t + m.minutes * 60_000 } : {}),
        label: s.labels[0] ?? s.rec?.label ?? "",
      });
      console.log(
        JSON.stringify({
          msg: "debug.clips-on",
          sid: s.sid.slice(0, 6),
          by: c.label,
          minutes: m.minutes,
        }),
      );
    }
    send(ws, { type: "clips-done", op: "on", sessions: live.map((s) => s.sid), at: t });
  }

  /** A socket that errored is gone too (the runtime may not also report a close). */
  webSocketError(ws: Socket): void | Promise<void> {
    return this.webSocketClose(ws, 1011);
  }
}

/**
 * A call to the main Worker's DebugSessions failed: an error event in the
 * Worker's logs (`wrangler tail lianki-push`), never silence. The method and a
 * flag key or op only: no user, no text.
 */
function rpcFailed(method: string, e: unknown, what?: string) {
  console.error(
    JSON.stringify({
      msg: "debug.rpc-failed",
      method,
      ...(what ? { what: what.slice(0, 64) } : {}),
      error: String(e).slice(0, 200),
    }),
  );
}

/** A page's {type:"participant", tok, name?, avatar?} (PresenceStack.tsx), or null. */
type ParticipantMessage = { tok: string; name?: unknown; avatar?: unknown };
function participantMessage(raw: unknown): ParticipantMessage | null {
  if (typeof raw !== "string" || raw.length > 8192 || !raw.includes('"participant"')) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown> | null;
    if (!j || j.type !== "participant" || typeof j.tok !== "string") return null;
    return {
      tok: j.tok,
      ...("name" in j ? { name: j.name } : {}),
      ...("avatar" in j ? { avatar: j.avatar } : {}),
    };
  } catch {
    return null;
  }
}

/** A controller's {type:"inbox", op, id?}, or null (any other message). Bounded before the RPC. */
function inboxRequest(raw: unknown): { op: string; id?: string } | null {
  let j: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 512 || !raw.includes("inbox")) return null;
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  if (r.type !== "inbox") return null;
  if (r.op === "list") return { op: "list" };
  if (
    (r.op === "get" || r.op === "done") &&
    typeof r.id === "string" &&
    /^[0-9a-f]{20}$/.test(r.id)
  )
    return { op: r.op, id: r.id };
  return { op: "invalid" };
}
