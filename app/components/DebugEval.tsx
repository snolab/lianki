"use client";
import { evalTrustStrings } from "../../packages/debug-chat/src/eval-trust-strings";

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  type ChatMessage,
  applyEditTo,
  type Heartbeat,
  type EditedEvent,
  type HubState,
  type PairInfo,
  type Sender,
  chunkMessages,
  compile,
  summarize,
  trimHistory,
  busyLeft,
} from "@/lib/dev-eval";
import { DEBUG_EVENT, debugOn, devLog } from "@/lib/debug-client";
import { chatWanted } from "@/lib/partner-entry";
import { noteBadgeSeen } from "@/lib/app-badge";
import { type BoxConfig, boxChatHub } from "@/lib/box-oauth/client";
import { useBoxAccount } from "./BoxApiBridge";
import { ETA_FLAG } from "@/lib/eta-ping";
import { boxViewer, ownerFlagOn } from "@/lib/box-oauth/session";
import { PARTNER_SUBPROTOCOL } from "@/lib/stt-ticket";
import { chatExtra } from "@lianki/debug-chat/chat-ui-locales";
import { getKey, isKey, setKey } from "@lianki/debug-chat/storage-keys";
import { WAS_OWNER_KEY, devParts, mayRunEval, rejoinDelay } from "@/lib/debug-rejoin";
import { type SocketPhase, evalLink, evalSessions } from "@lianki/debug-chat/link-state";
import {
  type ChatContext,
  type ChatStrings,
  type VoiceTiming,
  type WithdrawnEvent,
  applyWithdrawn,
  cleanContext,
  cleanAttachments,
  type AttachmentRef,
  cleanTiming,
} from "@lianki/debug-chat/wire";
import { markWithdrawn } from "@lianki/debug-chat/speak-rules";
import { setLexicon } from "@lianki/debug-chat/lexicon";
import { setCloudVoices } from "@lianki/debug-chat/voices";
import { setTalkOver } from "@lianki/debug-chat/aec";
import { polishReadback, setPolishReadback } from "@lianki/debug-chat/polish-readback";
import { voiceLatency } from "@lianki/debug-chat/latency";
import { pageScene } from "@lianki/debug-chat/scene";
import { liveTreeSource, progressSocketUrl } from "@/lib/progress-tree";
import { TABS_CHANNEL, joinTabs } from "@lianki/debug-chat/debug-chat-tabs";
import { withLane } from "@lianki/debug-chat/voices";
import { type Present, parsePresent } from "@lianki/debug-chat/presence";
import { publicCfg } from "@/lib/config-client";
import { spokenOf } from "@lianki/debug-chat/rich-text";
import { missedReply } from "@lianki/debug-chat/speak-rules";
import { voice } from "@lianki/debug-chat/voice";
import { isDesktop, keepHub, onTakeover, voiceBusy } from "@lianki/debug-chat/voice-bg";
import { useVoiceTitleHint } from "./useVoiceTitleHint";
import {
  clipsConnectQuery,
  installClipsLifecycle,
  onClipsState,
  setClipsSender,
} from "@lianki/debug-chat/clips-store";
import {
  type PageErrorReporter,
  createPageErrorReporter,
  installPageErrorHooks,
  typedText,
} from "@lianki/debug-chat/page-errors";
import { grantUntil } from "@/lib/islands/rules";
import { openBackToClose } from "@/lib/back-to-close";
import { frameContext } from "@/lib/frame-context";
import { islandStore } from "@/lib/islands/store";
import { useIslands } from "@/lib/islands/useIslands";
import { useLiveView, widgetSource } from "@/lib/live-view/client";
import { inboxFiles, linkInboxLine } from "@/lib/inbox/client";
import { pageBuildId } from "@/lib/build-id";

/** Hidden this long before the socket is dropped. */
const IDLE_MS = 30_000;
const TOAST_MS = 4_000;
/** Route changes settle this long before the socket's label is updated. */
const RELABEL_MS = 300;
/** The agent's avatar in the chat log: Lianki's own logo (public/icon-192.png). */
const AGENT_AVATAR = "/icon-192.png";
/** The chat's full screen gets the app's Back-closes-an-overlay entry (lib/back-to-close.ts). */
const backToCloseChat = (onBack: () => void) => openBackToClose(window, onBack);

/**
 * The chat and the pairing modal load only when shown: most pages (a guest's,
 * a learner without the Learning Partner) never show them, and the owner's
 * pages paint and hydrate before the chat's code arrives (docs/cold-start.md).
 * Replies are read aloud through voice() itself, which needs neither.
 */
const DebugChatHost = lazy(() =>
  import("@lianki/debug-chat/DebugChatHost").then((m) => ({ default: m.DebugChatHost })),
);
const DebugPairModal = lazy(() =>
  import("@lianki/debug-chat/DebugPairModal").then((m) => ({ default: m.DebugPairModal })),
);
/** sessionStorage: this tab's page id (docs/monitoring.md, "Remote eval"). */
const TAB_KEY = "lk:debug-tab";
/** The chat lines cut out of page errors: the latest this many. */
const SENSITIVE_LINES = 50;

/** This page as the hub and the agent see it: path, `pwa` when installed, user agent. */
const pageLabel = () => {
  const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
  return `${location.pathname} ${standalone}${navigator.userAgent}`;
};

/**
 * Remote eval and the agent chat for a debug session (docs/monitoring.md,
 * "Remote eval (owner debug)" and "Friends"). Only while this device is in
 * debug mode (`lk:debug`) and the page is visible, it holds a WebSocket to
 * lianki-push's /api/version/debug, which accepts any signed-in user: the
 * owner gets the owner's thread and pairings, anyone else (a friend) their
 * own thread and only pairings made for them — shown as a "Preview" request.
 *
 * A sender (scripts/dev/eval.ts) asking to pair shows up here as a prompt with
 * its label and a short code it prints too; nothing runs unless the owner
 * allows it — for as long as the modal says (live config
 * debug.evalGrantHours; resumable with its token, so it is not asked again in that time), or an hour for a friend's preview — and "End"
 * revokes it. Code it sends arrives
 * as {id, code, to}; it is run here, and the result (or error) goes back over
 * the socket to the sender and to /api/dev/log (Worker logs).
 *
 * The same socket carries the owner ⇄ agent chat (DebugChat): the history on
 * connect, then each new message; agent replies that arrive live are read
 * aloud. "Allow chat for 30 days" approves a sender for chat only.
 *
 * A page not in debug mode never opens the socket. Each run shows a toast, and
 * a badge is up while a session is approved, so it is never silent.
 * Reconnects only on events (the socket closing while still visible, coming
 * back to the page, debug turned on) — no timers that touch the network.
 */
/** The chat's user-facing strings, localized by the root layout (learning-partner.content.ts). */
export type PartnerStrings = ChatStrings & {
  unavailable: string;
  /** The inbox's one-tap import of an Anki package (.apkg) as a deck (lib/inbox/client.ts). */
  importDeck: string;
  /** The AI replies on a friend's thread (docs/partner-ai.md): empty-log hint, status, two warnings. */
  aiHint: string;
  aiStatus: string;
  aiLimit: string;
  aiFailed: string;
  /** Out of credits: the model was not asked; the line links to where credits are bought. */
  aiCredits: string;
  aiCreditsLink: string;
  /** "At least {need} credits ({short} more)", when the refusal carried the numbers. */
  aiCreditsNeed?: string;
};

/**
 * `partnerOpen`: the root layout found `partner.ai-reply` on and a signed-in
 * user who is not the owner — the chat connects on every page, not only in
 * debug mode (docs/partner-ai.md). Remote eval still needs debug mode.
 */
export function DebugEval({
  strings,
  partnerOpen = false,
  dev = false,
  etaBar = false,
  fullScreen = false,
  liHub = false,
  lexicon,
  cloudVoices,
  talkOver = false,
  polishReadback: readback,
  box = null,
}: {
  /** Flag `voice.talk-over` + dev: with echo cancellation off, Li's read-aloud does not hold the mic (aec.ts). */
  talkOver?: boolean;
  /**
   * Flag `voice.polish-readback` + dev: a voice line an agent polished is read
   * back once in his cloned voice (polish-readback.ts); config voice.cloneTimeoutMs. None: off.
   */
  polishReadback?: { on: boolean; timeoutMs?: number };
  /**
   * Provider voices (google:, azure:): on with flag voice.cloud-voices and the
   * dev grant, and the language → voice map (config voice.langVoices). None: off.
   */
  cloudVoices?: { on: boolean; map: Record<string, string> };
  /**
   * The read-aloud pronunciation table (config `voice.lexicon`, from the root
   * layout): handed to the voice before anything is read. None: its default.
   */
  lexicon?: unknown;
  /**
   * On a box: its sign-in config (lib/box-oauth/mode.ts). The chat then talks only
   * to lianki.com's hub with a box:chat ticket, never to the box's own host.
   */
  box?: BoxConfig | null;
  strings?: Partial<PartnerStrings>;
  partnerOpen?: boolean;
  /**
   * The viewer holds `dev` (lib/permissions.ts, from the server): only then does
   * this page run remote eval, and the chat show pairings and full page paths.
   */
  dev?: boolean;
  /** Flag chat.eta-bar (lib/eta-ping.ts): the ETA bar on the owner's chat, and its pings. */
  etaBar?: boolean;
  /** `partner.fullscreen` on: the chat's full screen for every chat user (off: the owner only). */
  fullScreen?: boolean;
  /** Flag `voice.li-hub`: on the owner's pages, Li's sound hub observes (docs/li-sound-hub.md). */
  liHub?: boolean;
} = {}) {
  // Idempotent and cheap: the live table is in place before the first reply is read.
  if (lexicon !== undefined) setLexicon(lexicon);
  setCloudVoices(cloudVoices);
  setTalkOver(talkOver);
  setPolishReadback(readback);
  const openRef = useRef(partnerOpen);
  openRef.current = partnerOpen;
  const devRef = useRef(dev);
  devRef.current = dev;
  const boxRef = useRef(box);
  boxRef.current = box;
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  /** The hub said this friend's thread is answered by the AI. */
  const [friendAi, setFriendAi] = useState(false);
  const [live, setLive] = useState(false);
  /** The hub socket's phase, for the connection chip (link-state.ts). */
  const [phase, setPhase] = useState<SocketPhase>("closed");
  const [toast, setToast] = useState<string | null>(null);
  const [state, setState] = useState<HubState | null>(null);
  /** Who is here (presence.ts): the hub pushes this page's list on every change. */
  const [present, setPresent] = useState<Present[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** The chat box stays up across reconnects, until debug mode is turned off. */
  const [chat, setChat] = useState(false);
  /** null on the owner's pages; a friend's chat status otherwise. */
  const [friend, setFriend] = useState<"open" | "blocked" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** The out-of-credits line as last shown: while it is the warning, a link to /membership follows it. */
  const [creditsLine, setCreditsLine] = useState<string | null>(null);
  /** Who this page's user is, from the hub on connect: their own lines' avatar. */
  const [viewer, setViewer] = useState<Sender | undefined>(undefined);
  const sockRef = useRef<WebSocket | null>(null);
  const friendRef = useRef(false);
  /**
   * The hub put this socket in the owner's thread (a state with no friend-status
   * first; never on a box): as good as `dev` for remote eval (lib/debug-rejoin.ts).
   */
  const hubOwnerRef = useRef(false);
  /** The chat's lines, for page-errors to cut out (never sent with an error). */
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  /** The owner's page (a state arrived with no friend-status first): may hot-load the widget. */
  const [owner, setOwner] = useState(false);
  /** The agent's heartbeat (docs/monitoring.md, "Agent is working"). */
  const [busy, setBusy] = useState<{ label: string } | null>(null);
  const beatRef = useRef<(Heartbeat & { label: string }) | null>(null);
  /** Hub time of the newest agent reply: a beat older than it is stale. */
  const agentAtRef = useRef(0);
  /** Agent lines already handed to the voice: one delivered again (a reconnect) is not read again. */
  const spokenIds = useRef(new Set<string>());
  const liveRef = useRef(false);
  const beatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** One local timeout re-checks the spinner when it would lapse; no network. */
  const reBeat = () => {
    clearTimeout(beatTimer.current);
    const b = beatRef.current;
    const left = busyLeft(liveRef.current, b, agentAtRef.current, Date.now());
    setBusy(left > 0 && b ? { label: b.label } : null);
    if (left > 0) beatTimer.current = setTimeout(reBeat, left + 50);
  };
  /** The label the socket was last told (on connect, or by {type:"page"}). */
  const sentLabel = useRef("");
  const pathname = usePathname();
  const router = useRouter();
  // Hot islands (docs/dev-hot-islands.md): on with the code-run grant below, or live view.
  useIslands();
  // The tab title says when Lianki's voice runs on in the background (voice-bg.ts).
  useVoiceTitleHint();
  // Li's sound hub, phase 0 (docs/li-sound-hub.md): it only observes, on the
  // owner's pages with `voice.li-hub` on. Off, the module is not even loaded.
  const liOn = liHub && owner && friend === null;
  useEffect(() => {
    if (!liOn) return;
    let stop = () => {};
    let gone = false;
    void import("@lianki/debug-chat/li-client")
      .then(({ startLiClient }) => {
        if (!gone) stop = startLiClient({ on: true, log: devLog });
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop();
    };
  }, [liOn]);
  /** Live view (docs/live-view.md): the signed pointer, verified on this page. */
  const liveState = useLiveView();
  /** This device's tabs agree on one to read replies aloud (BroadcastChannel). */
  const tabsRef = useRef<ReturnType<typeof joinTabs> | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const join = () => {
      tabsRef.current = joinTabs(
        crypto.randomUUID(),
        new BroadcastChannel(TABS_CHANNEL),
        () => document.visibilityState === "visible" && document.hasFocus(),
        Date.now,
        // Another tab took the voice over (voice-bg.ts): only one tab listens and reads.
        (why) => {
          const looking = document.visibilityState === "visible" && document.hasFocus();
          const d = onTakeover(why, { mic: voice().state().mic, looking });
          if (d.micOff) {
            // Off by itself, with its reason (mic-off.ts): never the plain off he chose.
            const m = (
              globalThis as {
                __lkMic?: {
                  off?: (why?: string) => Promise<void>;
                  autoOff?: (r: "other-tab") => Promise<void>;
                };
              }
            ).__lkMic;
            void (m?.autoOff ? m.autoOff("other-tab") : m?.off?.("other-tab"))?.catch(() => {});
          }
          if (d.stopReading) voice().stop();
        },
      );
      tabsRef.current.mic(voice().state().mic);
    };
    const leave = () => {
      tabsRef.current?.leave();
      tabsRef.current = null;
    };
    const focus = () => {
      if (document.visibilityState === "visible") tabsRef.current?.focus();
    };
    const show = (e: PageTransitionEvent) => e.persisted && !tabsRef.current && join();
    join();
    // Voice diagnostics (output route, echo-guard drops, AEC settings) go to /api/dev/log.
    voice().setLog((ev) => devLog(ev));
    // A tab with the mic on reads replies aloud (hands-free), whichever is focused.
    const unsub = voice().subscribe((s) => tabsRef.current?.mic(s.mic));
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", show);
      unsub();
      leave();
    };
  }, []);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let ws: WebSocket | null = null;
    /** The chat is wanted: debug mode, or the Learning Partner opened to users (partnerOpen). */
    // Never false for a partner user (lib/partner-entry.ts): the chat folds, it never goes away.
    const chatOn = () => chatWanted(debugOn(), openRef.current);
    let idle: ReturnType<typeof setTimeout> | undefined;
    let hideToast: ReturnType<typeof setTimeout> | undefined;
    const opened = new WeakSet<WebSocket>();
    // Page errors (docs/dev-debug-widget.md, "Page errors"): hooked while the
    // socket is wanted, queued until the hub says this is the owner's page,
    // dropped for good on a friend's.
    const newReporter = () =>
      createPageErrorReporter({
        // The build the page runs ("dev" under next dev): from <html data-build>.
        rev: pageBuildId(),
        pagePath: () => location.pathname,
        sensitive: () => [
          ...typedText(document),
          ...messagesRef.current.slice(-SENSITIVE_LINES).map((m) => m.text),
        ],
      });
    let reporter: PageErrorReporter = newReporter();
    let unhook: (() => void) | null = null;
    const unhookErrors = () => {
      unhook?.();
      unhook = null;
    };

    const run = async (sock: WebSocket, id: string, to: string, code: string) => {
      clearTimeout(hideToast);
      setToast(`eval ran · ${id}`);
      hideToast = setTimeout(() => setToast(null), TOAST_MS);
      const t0 = performance.now();
      let result: Record<string, unknown>;
      try {
        // `$lk.send(data)` streams a piece too big for the result (a screenshot)
        // back ahead of it, in chunks (scripts/dev/shot.ts).
        let part = 0;
        const value = await compile(code)({
          send(data) {
            const n = part++;
            for (const m of chunkMessages(id, to, n, String(data))) sock.send(JSON.stringify(m));
            return n;
          },
        });
        result = { ok: true, ms: Math.round(performance.now() - t0), value: summarize(value) };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        result = {
          ok: false,
          error: `${err.name}: ${err.message}`.slice(0, 1000),
          stack: (err.stack ?? "").slice(0, 2000),
        };
      }
      if (!friendRef.current) devLog({ ev: "eval-result", id, ...result });
      try {
        sock.send(JSON.stringify({ type: "result", id, to, ...result }));
      } catch {}
    };

    /** A box chat ticket is being fetched (docs/box-oauth.md, "Chat on the owner's box"). */
    let boxPending = false;
    /** Friend verdicts asked about again on this page (lib/debug-rejoin.ts), and the wait before the next. */
    let rejoinTries = 0;
    let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * The hub called this page a friend's, but the server rendered it for a
     * `dev` holder or this device was the owner's last time: one fail-closed
     * permission read can say that. Ask again on a fresh socket, a few times.
     */
    const doubtFriend = (sock: WebSocket) => {
      const wait = rejoinDelay({
        dev: devRef.current,
        wasOwner: getKey(WAS_OWNER_KEY) === "1",
        tries: rejoinTries,
      });
      if (wait === null) {
        // Asked enough: this device is a friend's now; stop doubting on later loads.
        if (rejoinTries > 0) setKey(WAS_OWNER_KEY, "0");
        return;
      }
      rejoinTries++;
      clearTimeout(rejoinTimer);
      rejoinTimer = setTimeout(() => {
        if (ws !== sock || disposed) return;
        devLog({ ev: "eval-rejoin", tries: rejoinTries });
        // Forget the friend verdict: the next socket's first message decides again.
        friendRef.current = false;
        setFriend(null);
        setFriendAi(false);
        reporter = newReporter();
        sock.close(1000, "rejoin");
      }, wait);
    };
    /** This effect was cleaned up (unmount, or React running it twice in dev): a late ticket opens nothing. */
    let disposed = false;
    const connect = () => {
      if (ws || boxPending) return;
      // On the owner's box: lianki.com's hub with a ticket (box:chat), never a cookie,
      // and never the box's own host. Decided from the server's config, not from
      // whether BoxApiBridge has rendered yet: hydration can run this effect first.
      const hub = boxChatHub(boxRef.current ?? undefined);
      if (boxRef.current) {
        if (!hub) return;
        boxPending = true;
        void hub.ticket().then((ticket) => {
          boxPending = false;
          if (ticket && !ws && !disposed && wanted())
            openSock(hub.url, [PARTNER_SUBPROTOCOL, ticket]);
        });
        return;
      }
      openSock(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/debug`,
      );
    };
    const openSock = (base: string, protocols?: string[]) => {
      if (ws) return;
      if (!unhook && !friendRef.current) unhook = installPageErrorHooks(window, reporter);
      const label = pageLabel();
      sentLabel.current = label;
      // This tab's id, kept across reloads, so a "this page" grant survives one.
      let tab = "";
      try {
        tab = sessionStorage.getItem(TAB_KEY) ?? "";
        if (!tab) sessionStorage.setItem(TAB_KEY, (tab = crypto.randomUUID().slice(0, 12)));
      } catch {}
      // The recording session (packages/debug-chat/src/clips.ts): this window's
      // id, the device's, and a handoff token if the page came from another origin.
      let clipsQ = "";
      try {
        clipsQ = clipsConnectQuery();
      } catch {}
      const sock = new WebSocket(
        `${base}?label=${encodeURIComponent(label)}${tab ? `&tab=${tab}` : ""}${clipsQ}&frame=${frameContext()}`,
        protocols,
      );
      ws = sock;
      sockRef.current = sock;
      setPhase("opening");
      sock.onopen = () => {
        opened.add(sock);
        setPhase("open");
        setClipsSender((m) => {
          if (sock.readyState !== WebSocket.OPEN) return false;
          sock.send(JSON.stringify(m));
          return true;
        });
        liveRef.current = true;
        setLive(true);
        setChat(true);
        if (!friendRef.current) devLog({ ev: "eval-socket", label });
      };
      sock.onmessage = (e) => {
        let msg: {
          type?: unknown;
          id?: unknown;
          to?: unknown;
          code?: unknown;
          messages?: unknown;
          message?: unknown;
          status?: unknown;
          retryIn?: unknown;
          sender?: unknown;
          answer?: unknown;
        };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        // This window's recording session (the hub holds it, not this origin).
        if (msg.type === "clips") return void onClipsState(msg);
        if (msg.type === "friend-status") {
          friendRef.current = true;
          hubOwnerRef.current = false;
          if (msg.status !== "blocked") doubtFriend(sock);
          // Never a friend's errors: nothing queued is sent, nothing more is kept.
          reporter.disable();
          unhookErrors();
          setFriend(msg.status === "blocked" ? "blocked" : "open");
          setFriendAi((msg as { ai?: unknown }).ai === true);
          if (msg.status === "blocked") setChat(true);
          return;
        }
        if (msg.type === "me") {
          if (msg.sender && typeof msg.sender === "object") setViewer(msg.sender as Sender);
          return;
        }
        if (msg.type === "page-ended") {
          setWarning(chatExtra().endedElsewhere);
          return;
        }
        if (msg.type === "ai-credits") {
          const s = stringsRef.current;
          const need = Number((msg as { need?: unknown }).need);
          const have = Number((msg as { have?: unknown }).have);
          const numbers =
            Number.isFinite(need) && Number.isFinite(have) && s?.aiCreditsNeed
              ? ` ${s.aiCreditsNeed
                  .replaceAll("{need}", String(need))
                  .replaceAll("{short}", String(Math.max(0, need - have)))}`
              : "";
          const line =
            (
              s?.aiCredits ?? "Your {name} needs credits to reply. Add credits to keep chatting."
            ).replaceAll("{name}", s?.name || "Learning Partner") + numbers;
          setCreditsLine(line);
          setWarning(line);
          return;
        }
        if (msg.type === "ai-limit" || msg.type === "ai-failed") {
          const s = stringsRef.current;
          const line =
            msg.type === "ai-limit"
              ? (s?.aiLimit ?? "Your {name} is resting for today. Try again tomorrow.")
              : (s?.aiFailed ?? "No reply this time. Please try again in a moment.");
          setWarning(line.replaceAll("{name}", s?.name || "Learning Partner"));
          return;
        }
        if (msg.type === "rate-limited") {
          const min = Math.max(1, Math.ceil(Number(msg.retryIn) / 60_000) || 1);
          setWarning(chatExtra().rateLimited.replace("{n}", String(min)));
          return;
        }
        if (msg.type === "present") {
          const list = parsePresent((msg as { list?: unknown }).list);
          if (list) setPresent(list);
          return;
        }
        if (msg.type === "state") {
          setState(msg as HubState);
          // Friends hear friend-status before any state: no status yet = the owner.
          if (!friendRef.current) {
            setOwner(true);
            if (!boxRef.current) {
              hubOwnerRef.current = true;
              rejoinTries = 0;
              setKey(WAS_OWNER_KEY, "1");
            }
            reporter.attach((m) => {
              if (sock.readyState !== WebSocket.OPEN) throw new Error("socket closed");
              sock.send(JSON.stringify(m));
            });
            // Hot islands follow the owner's code-run grant for this page.
            islandStore.setGrant(grantUntil(msg as HubState, Date.now()));
          }
          return;
        }
        if (msg.type === "busy") {
          const m = msg as { at?: unknown; label?: unknown };
          if (typeof m.at !== "number") return;
          beatRef.current = {
            beatAt: m.at,
            seenAt: Date.now(),
            label: typeof m.label === "string" ? m.label : "agent",
          };
          voiceLatency().ack();
          reBeat();
          return;
        }
        if (msg.type === "wake") {
          // The agent sets the mic's wake-word mode (docs/wake-word.md); the
          // page-wide mic session (packages/debug-chat mic-session.ts) applies it.
          const mode = (msg as { mode?: unknown }).mode;
          const mic = (globalThis as { __lkMic?: { wake?: (m: string) => void } }).__lkMic;
          if (mode === "active" || mode === "passive" || mode === "ignored") mic?.wake?.(mode);
          return;
        }
        if (msg.type === "history" && Array.isArray(msg.messages)) {
          // A `【lane】` prefix becomes the line's lane (voices.ts): its mark, tag and voice.
          const list = trimHistory((msg.messages as ChatMessage[]).map(withLane));
          // After a reconnect, a reply sent while the socket was down comes only
          // in the history: read the newest one past what this page saw (never
          // old history; speak-rules.ts missedReply).
          const missed = missedReply(list, agentAtRef.current, spokenIds.current);
          for (const id of missed.gap) spokenIds.current.add(id);
          for (const m of list)
            if (m.from === "agent") agentAtRef.current = Math.max(agentAtRef.current, m.at);
          setMessages(list);
          reBeat();
          const said = missed.line && spokenOf(missed.line);
          if (missed.line && said && (tabsRef.current?.isSpeaker() ?? true))
            voice().reply(said, missed.line);
          return;
        }
        // An ask answered by a tap (on this page or another): the card shows it.
        if (msg.type === "answered" && typeof msg.id === "string" && msg.answer) {
          const answer = msg.answer as ChatMessage["answer"];
          setMessages((list) => list.map((x) => (x.id === msg.id ? { ...x, answer } : x)));
          return;
        }
        // The agent withdrew an open ask: the card greys out and is never read aloud.
        if (msg.type === "withdrawn" && typeof msg.id === "string") {
          const e = msg as unknown as WithdrawnEvent;
          if (typeof e.askId !== "string" || typeof e.withdrawnAt !== "number") return;
          markWithdrawn(e.id);
          setMessages((list) => list.map((m) => applyWithdrawn(m, e)));
          return;
        }
        if (msg.type === "chat" && msg.message && typeof msg.message === "object") {
          const m = withLane(msg.message as ChatMessage);
          if (typeof m.text !== "string" || typeof m.id !== "string") return;
          setMessages((list) =>
            list.some((x) => x.id === m.id) ? list : trimHistory([...list, m]),
          );
          // Live replies only: history loaded on connect is never read out.
          if (m.from === "agent") {
            agentAtRef.current = Math.max(agentAtRef.current, Number(m.at) || 0);
            reBeat();
            // Every tab shows it; only one reads it aloud. voice().reply queues it
            // (voice.ts): always read while the mic is on, else by the focus rule.
            const fresh = !spokenIds.current.has(m.id);
            spokenIds.current.add(m.id);
            // Never a quiet line; a hidden page reads the newest one when it is
            // back (speak-rules.ts): the line itself is the meta.
            // Its words, not its markup (rich-text.ts): a line of only code says nothing.
            const said = spokenOf(m);
            const spoken =
              fresh &&
              !!said &&
              (tabsRef.current?.isSpeaker() ?? true) &&
              // live: a superseding or interjecting line cuts in (voice.ts); history never does.
              voice().reply(said, m, { live: true });
            voiceLatency().heard(m, spoken === true);
          } else {
            setWarning(null);
            voiceLatency().heard(m);
          }
          return;
        }
        if (msg.type === "edited") {
          // The agent polished a voice line: it changes in place, and is never read aloud again.
          const e = msg as unknown as EditedEvent;
          if (typeof e.id !== "string" || typeof e.text !== "string") return;
          // His own voice line, raw → polished: read back once in his cloned voice (flag
          // voice.polish-readback), by the tab that reads, through Li's one queue.
          polishReadback(
            messagesRef.current.find((m) => m.id === e.id),
            e,
            {
              reply: (text, meta, how) => voice().reply(text, meta, how),
              speaker: () => tabsRef.current?.isSpeaker() ?? true,
              log: (ev) => voice().log(ev),
            },
          );
          setMessages((list) => trimHistory(applyEditTo(list, e)));
          // A line that amended another has no echo of its own: this is its answer.
          if (e.merged) voiceLatency().heard({ id: e.merged.id, from: "owner", at: e.edited.at });
          return;
        }
        if (msg.type !== "eval") return;
        if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
        // Remote eval: debug mode on, and a `dev` holder's page only — as the
        // server rendered it, or as the hub found it when this socket opened.
        if (
          typeof msg.code !== "string" ||
          !mayRunEval({ debug: debugOn(), dev: devRef.current, hubOwner: hubOwnerRef.current })
        )
          return;
        void run(sock, msg.id, msg.to, msg.code);
      };
      // Dropped by the network: reopen on that event if still wanted. One
      // that never opened was refused (a guest, or no push service here), and
      // one the hub closed on purpose (4xxx: blocked) stays closed: leave it
      // until the next visibility or debug event.
      sock.onclose = (e) => {
        if (ws !== sock) return;
        ws = null;
        hubOwnerRef.current = false;
        setPhase("closed");
        setClipsSender(null);
        reporter.detach();
        sockRef.current = null;
        liveRef.current = false;
        beatRef.current = null;
        reBeat();
        setLive(false);
        setState(null);
        if (opened.has(sock) && e.code < 4000 && wanted()) connect();
      };
    };
    const disconnect = () => {
      clearTimeout(idle);
      reporter.detach();
      if (!chatOn()) {
        islandStore.setGrant(null);
        setChat(false);
        setFriend(null);
        setFriendAi(false);
        setOwner(false);
        friendRef.current = false;
        // Debug mode off: no hooks, and a fresh reporter for next time.
        unhookErrors();
        reporter.disable();
        reporter = newReporter();
      }
      const sock = ws;
      ws = null;
      setPhase("closed");
      setClipsSender(null);
      sockRef.current = null;
      liveRef.current = false;
      beatRef.current = null;
      reBeat();
      setLive(false);
      setState(null);
      sock?.close();
    };
    // Never inside another site's frame: no cookie socket, no pairing or Allow UI
    // a parent could clickjack (lib/frame-context.ts). The hub refuses too.
    // A computer keeps it while the voice runs in a background tab (voice-bg.ts):
    // his spoken lines still go out, the replies still come in and are read.
    const wanted = () =>
      keepHub({
        visible: document.visibilityState === "visible",
        desktop: isDesktop(),
        busy: voiceBusy(voice().state()),
      }) &&
      chatOn() &&
      frameContext() !== "foreign";
    /**
     * Tell the hub how this window is doing, while the socket is still open:
     * hidden (screen off, app in the background) keeps a recording session
     * for hours; leaving (closed, or navigating away) only for a couple of
     * minutes, enough to land on the next page (clips.ts CLIPS_GONE_MS).
     */
    const vis = (state: "hidden" | "visible" | "leaving") => {
      try {
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "clips-vis", state }));
      } catch {}
    };
    const leaving = () => vis("leaving");
    // pagehide → departed, pageshow from the bfcache → off until a tap (clips-store.ts).
    const unClips = installClipsLifecycle(window);
    const update = () => {
      vis(document.visibilityState === "visible" ? "visible" : "hidden");
      clearTimeout(idle);
      if (wanted()) connect();
      else if (!chatOn()) disconnect();
      else if (ws) idle = setTimeout(disconnect, IDLE_MS);
    };
    const onStorage = (e: StorageEvent) => {
      if (isKey(e.key, "lk:debug")) update();
    };

    update();
    // The voice starting or stopping in a hidden tab: keep the socket or let it idle out.
    let busy = voiceBusy(voice().state());
    const unVoice = voice().subscribe((st) => {
      const b = voiceBusy(st);
      if (b === busy) return;
      busy = b;
      if (document.visibilityState !== "visible") update();
    });
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", update);
    window.addEventListener(DEBUG_EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("pagehide", leaving);
      unVoice();
      unClips();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener(DEBUG_EVENT, update);
      window.removeEventListener("storage", onStorage);
      clearTimeout(hideToast);
      clearTimeout(beatTimer.current);
      clearTimeout(rejoinTimer);
      disposed = true;
      disconnect();
      unhookErrors();
    };
  }, []);

  // The socket lives in the root layout, so it outlives client-side
  // navigation: tell the hub the new path (silently — the agent's side only),
  // once the route has settled. popstate/hashchange cover what usePathname misses.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sock = sockRef.current;
        const label = pageLabel();
        if (!sock || sock.readyState !== WebSocket.OPEN || label === sentLabel.current) return;
        try {
          sock.send(JSON.stringify({ type: "page", label }));
          sentLabel.current = label;
        } catch {}
      }, RELABEL_MS);
    };
    check();
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", check);
      window.removeEventListener("hashchange", check);
    };
  }, [pathname]);

  /**
   * Answer a pairing. Allow carries the pages it covers (ids, or "all"), and
   * `scope: "chat"` for a chat request too, so a hub from before requested
   * scopes still grants the right thing.
   */
  const answer = (
    type: "allow" | "deny" | "revoke",
    p: PairInfo,
    pages?: string[] | "all",
    remember = false,
  ) => {
    const scope = type === "allow" && p.scope === "chat" && !friendRef.current ? "chat" : undefined;
    try {
      sockRef.current?.send(
        JSON.stringify({
          type,
          pair: p.pair,
          ...(scope ? { scope } : {}),
          ...(type === "allow" && pages ? { pages } : {}),
          ...(type === "allow" && remember ? { remember: true } : {}),
        }),
      );
    } catch {}
    if (!friendRef.current)
      devLog({ ev: `eval-${type}`, label: p.label, code: p.code, scope, pages });
  };
  const endPage = (id: string) => {
    try {
      sockRef.current?.send(JSON.stringify({ type: "end-page", id }));
    } catch {}
  };
  /** `to`: the state-tree node the line is addressed to (absent = the main thread). */
  const sendChat = (
    text: string,
    to?: string,
    opts?: {
      source?: "stt";
      timing?: VoiceTiming;
      speakerProof?: string[];
      context?: ChatContext;
      attachments?: AttachmentRef[];
      continues?: string;
    },
  ) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      const id = crypto.randomUUID().slice(0, 12);
      // A voice line's timestamps ride along (an older hub drops them).
      const timing = opts?.source === "stt" ? cleanTiming(opts.timing) : undefined;
      // The Mac's signed speaker attestations (lib/speaker-proof.ts); the hub verifies them.
      const speakerProof = opts?.source === "stt" ? opts.speakerProof?.slice(0, 8) : undefined;
      // The mic's wake-word mode rides along, so the agent sees it (docs/wake-word.md).
      const mic = (
        globalThis as {
          __lkMic?: { view?: () => { state: string; wake?: string; wakeReason?: string } };
        }
      ).__lkMic?.view?.();
      const wake = mic && mic.state !== "off" ? mic.wake : undefined;
      const wakeReason = wake ? mic?.wakeReason : undefined;
      // The page selection attached with the + menu (bounded as the hub bounds it).
      const context = cleanContext(opts?.context);
      // Files from the owner's inbox (lib/inbox/client.ts): refs only, the bytes are in R2.
      const attachments =
        owner && friend === null ? cleanAttachments(opts?.attachments) : undefined;
      // Where a voice line was spoken (path, title, screen text): its polish draws on it.
      const scene = opts?.source === "stt" ? pageScene() : undefined;
      sock.send(
        JSON.stringify({
          type: "chat",
          id,
          text,
          ...(to ? { to } : {}),
          ...(opts?.source === "stt" ? { source: "stt" } : {}),
          ...(opts?.source === "stt" && opts.continues ? { continues: opts.continues } : {}),
          ...(timing ? { timing } : {}),
          ...(wake === "active" || wake === "passive" ? { wake } : {}),
          ...(speakerProof?.length ? { speakerProof } : {}),
          ...(wakeReason ? { wakeReason } : {}),
          ...(context ? { context } : {}),
          ...(attachments ? { attachments } : {}),
          ...(scene ? { scene } : {}),
        }),
      );
      if (attachments)
        linkInboxLine(
          attachments.map((a) => a.id),
          id,
        );
      // Its reply is timed against it (latency.ts); main-thread lines only.
      if (timing && !to) voiceLatency().sent(id, text, timing);
      return true;
    } catch {
      return false;
    }
  };

  /** A plain message to the hub, on this page's socket. */
  const sendHub = (m: { type: "passage-end" } | { type: "unmerge"; id: string }) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(JSON.stringify(m));
    } catch {}
  };

  /** A tap on an ask card: only which options; the hub stamps who, where, when and source "tap". */
  const sendAnswer = (askId: string, choices: Record<string, string[]>) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(JSON.stringify({ type: "answer", askId, choices }));
      // One fewer unanswered ask on the app-icon badge (docs/app-badge.md).
      noteBadgeSeen({ asks: -1 });
      return true;
    } catch {
      return false;
    }
  };

  const pending = state?.pending ?? null;
  const sessions = state?.sessions ?? [];
  const isFriend = friend !== null;
  /** The chat's developer parts (pairings, the connection chip): a `dev` verdict, the server's or the hub's. */
  const devUi = owner && !isFriend && devParts({ dev, hubOwner: owner && !box });
  // On a box the layout's flag is the box server's own (its local D1, no
  // session): production's answer for the signed-in account decides there.
  const boxAccount = useBoxAccount();
  const etaOn = ownerFlagOn(!!box, boxAccount, ETA_FLAG, etaBar);
  // A friend's thread answered by the AI says so: in the empty log and the status line.
  const friendStrings =
    isFriend && friendAi && strings?.aiHint
      ? { ...strings, hint: strings.aiHint, listening: strings.aiStatus ?? strings.listening }
      : strings;
  // The owner's tree: the bundled outline, with live progress laid over it.
  // Only made once this is the owner's page (the hub said so): nothing is asked before.
  const treeOn = owner && !isFriend;
  const ownerTree = useMemo(() => {
    if (typeof window === "undefined" || !treeOn) return undefined;
    // On the owner's box (docs/box-oauth.md): lianki.com's progress hub with a
    // box chat ticket, never a cookie, never the box's own host. The outline
    // comes through the box's fetch (its token). Not a box:chat box: no tree.
    const box = boxRef.current ? boxChatHub(boxRef.current) : undefined;
    if (box === null) return undefined;
    return liveTreeSource({
      base: async () => {
        const r = await fetch("/api/dev/state-tree", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      },
      url: box ? box.progressUrl : progressSocketUrl(location),
      ...(box
        ? {
            protocols: async () => {
              const t = await box.ticket();
              return t ? [PARTNER_SUBPROTOCOL, t] : null;
            },
          }
        : {}),
      repo: "snolab/lianki",
    });
  }, [treeOn]);
  // The chat inbox's host side (lib/inbox/client.ts): an Anki package imports in one tap.
  const importDeck = strings?.importDeck ?? "Import as a deck";
  const ownerFiles = useMemo(
    () => inboxFiles({ importDeck, go: (path) => router.push(path) }),
    [importDeck, router],
  );
  if (!live && !toast && !chat) return null;
  return (
    <>
      {chat && (
        <Suspense fallback={null}>
          <DebugChatHost
            // A verified pointer is the owner's (the server checked the session).
            hot={(owner && !isFriend) || (liveState.on && !!liveState.claim.widget)}
            src={widgetSource(liveState)}
            busy={busy}
            pages={state?.pages ?? []}
            selfPage={state?.self}
            onEndPage={endPage}
            onOpenPage={(path) => router.push(path)}
            live={live}
            listeners={state?.listeners ?? sessions.length}
            messages={messages}
            onSend={sendChat}
            onAnswer={sendAnswer}
            onPassageEnd={() => sendHub({ type: "passage-end" })}
            onUnmerge={(id) => sendHub({ type: "unmerge", id })}
            nodes={state?.nodes}
            notice={
              friend === "blocked"
                ? (strings?.unavailable ?? "Chat is not available for this account.")
                : undefined
            }
            warning={warning ?? undefined}
            warningHref={
              warning && warning === creditsLine
                ? { href: "/membership", label: strings?.aiCreditsLink ?? "Get credits" }
                : undefined
            }
            sessions={sessions}
            onEnd={(x) => answer("revoke", x)}
            onAddPage={(x) => state?.self && answer("allow", x, [state.self])}
            evalRan={!!toast}
            friend={isFriend}
            owner={devUi}
            // Who is here, right of the connection chip (PresenceStack.tsx).
            presence={
              devUi
                ? {
                    list: present,
                    shown: publicCfg("chat.presenceShown"),
                    onChange: (tok, change) => {
                      const sock = sockRef.current;
                      if (!sock || sock.readyState !== WebSocket.OPEN) return;
                      try {
                        sock.send(JSON.stringify({ type: "participant", tok, ...change }));
                      } catch {}
                    },
                    // The same revoke as /my/preferences (lib/api-token-api.ts): this account's tokens only.
                    onRemove: async (id) => {
                      const r = await fetch("/api/token", {
                        method: "DELETE",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ id }),
                      }).catch(() => null);
                      return !!r?.ok;
                    },
                  }
                : undefined
            }
            // The connection chip (LinkChip.tsx): remote code on this page, and the selection.
            link={
              devUi
                ? {
                    state: evalLink({
                      debug: debugOn(),
                      socket: phase,
                      sessions,
                      self: state?.self,
                      now: Date.now(),
                    }),
                    sessions: evalSessions(sessions, state?.self, Date.now()),
                    now: Date.now(),
                    beatAt: beatRef.current?.beatAt,
                    onEnd: (pair) => {
                      const s = sessions.find((x) => x.pair === pair);
                      if (s) answer("revoke", s);
                    },
                  }
                : undefined
            }
            strings={friendStrings}
            treeSource={treeOn ? ownerTree : undefined}
            etaBar={etaOn && treeOn && !!ownerTree}
            // This page's ETA timer went off: the hub pings the agent at most once per estimate.
            onEtaDue={(id) => ownerTree?.send({ type: "eta", id })}
            treeRepo="snolab/lianki"
            // The chat inbox: the owner's own pages only (owner-only upload, lib/inbox/).
            files={owner && !isFriend ? ownerFiles : undefined}
            // The account's chat history (docs/chat-history.md): every signed-in user's own.
            onHistory={() => router.push("/chat/history")}
            agentAvatar={AGENT_AVATAR}
            viewer={boxViewer(!!box, boxAccount, viewer)}
            fullScreen={fullScreen}
            // Back leaves full screen, as it closes any overlay (docs/ui-state.md).
            backToClose={backToCloseChat}
          />
        </Suspense>
      )}
      {/* A pairing request: a big modal on every open page of its audience. */}
      {pending && (
        <Suspense fallback={null}>
          <DebugPairModal
            pending={pending}
            friend={isFriend}
            pages={state?.pages ?? []}
            selfPage={state?.self}
            onAllow={(pages, remember) => answer("allow", pending, pages, remember)}
            onDeny={() => answer("deny", pending)}
          />
        </Suspense>
      )}
      {/* With the chat box up, the rest lives inside it (nothing debug floats on the page). */}
      {!chat && (
        <div
          aria-live="polite"
          data-debug-eval
          data-testid="debug-eval"
          className="fixed bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-[calc(0.5rem+env(safe-area-inset-left))] z-[var(--lk-z-chat,80)] flex max-w-[calc(100vw-1rem)] flex-col items-start gap-1 text-xs"
          style={{ color: "oklch(0.98 0 0)" }}
        >
          {sessions.map((s) => (
            <div
              key={s.pair}
              data-testid="debug-menu-session"
              className="flex items-center gap-2 rounded-full py-0.5 pl-2 pr-0.5"
              style={{ background: "oklch(0.55 0.15 30 / 0.9)" }}
            >
              <span
                title={
                  s.persistent
                    ? evalTrustStrings().scope
                    : `until ${new Date(s.until ?? 0).toISOString()}`
                }
              >
                {isFriend ? "preview" : s.scope === "chat" ? "chat" : "eval"}: {s.label} ·{" "}
                {s.persistent ? evalTrustStrings().remember : s.code}
              </span>
              <button
                type="button"
                data-testid="debug-menu-session-end"
                onClick={() => answer("revoke", s)}
                className="rounded-full px-2"
                style={{ background: "oklch(0.3 0.05 30)" }}
              >
                End
              </button>
            </div>
          ))}
          {toast && (
            <span
              data-testid="debug-chat-icon-eval"
              className="pointer-events-none rounded px-2 py-0.5 shadow"
              style={{ background: "oklch(0.25 0.02 260 / 0.9)" }}
            >
              {toast}
            </span>
          )}
        </div>
      )}
    </>
  );
}
