#!/usr/bin/env python3
"""
Local streaming speech-to-text for the owner's debug-chat mic (docs/local-stt.md).

A WebSocket server on this Mac: the page streams 16 kHz mono PCM while the
owner speaks and gets partial transcripts back as he talks, then the final one
the moment the VAD ends the utterance. It is reached over the tailnet
(`tailscale serve`, never funnel) on --port, from lianki.com pages that carry
`localStorage["lk:agent-local-stt"]`; anything else falls back to
/api/debug/stt.

With --public-port (or ~/.config/lianki-stt/public.json, which tunnel.sh
writes so the oxmgr entry never changes) it also listens for the cloudflared tunnel (wss://stt.lianki.com,
scripts/local-stt/tunnel.sh). That listener admits only a lianki.com Origin
with a valid ticket (ticket.py: Ed25519, 60 s, single use) offered in
Sec-WebSocket-Protocol beside "lianki-stt", at most MAX_PUBLIC sockets at a
time; anything else gets 401/403/503 before the upgrade. No /health there.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/server.py \
        [--port 5193] [--engine sensevoice|mlx-whisper] [--tailnet /lianki-stt] \
        [--public-port 5188 [--ticket-pubkey ~/.config/lianki-stt/ticket.pub]]

Protocol (one socket per page, utterances one after another):

  client → server  text   {"t":"begin","id":N}            a new utterance
                   binary 0x01 + int16le PCM                 frames of the current one
                   binary 0x02 + int16le PCM                 audio from before the
                                                             first frame (VAD pre-pad)
                   text   {"t":"end","id":N}                 decode it now
                   text   {"t":"cancel","id":N}              drop it
                   text   {"t":"recheck","rid":R,"seconds":15,"engine":"mlx-whisper"}
                          re-read recent audio from this socket (0 < seconds <= --recheck-max-sec)
                   text   {"t":"recheck","rid":R,"auto":true,"run":RUN,"fromAgoMs":F,"toAgoMs":T}
                          re-read one continuous-speech run: the utterances that began between
                          F and T ms before now (the page's clock, as durations), whole
  server → client  {"t":"ready","engine":…,"model":…}
                   {"t":"partial","id":N,"text":…,"audioMs":…}
                   {"t":"final","id":N,"text":…,"lang":…,"model":…,"ms":decode ms,
                    "audioMs":…,"endToFinalMs":…[,"langAuto":…]}
                   (langAuto: on a short utterance whose auto-detected language
                   lost to a forced ja/zh reading; engines.LangPicker)
                   final gains "chunks":N when a long one was read in N chunks cut at silences,
                    and "partialKept":true when its read was much shorter than the last partial's
                    and the partial's text stands (docs/local-stt.md, "Long finals in chunks",
                    "A final shorter than its partials"); then Whisper re-reads it unasked:
                   {"t":"recheck_result","rid":"final-<id>","final":N,"partialKept":true,…}
                   {"t":"recheck_result","rid":R,"engine":"mlx-whisper","ok":true,"text":…}
                   (auto: also "auto":true,"run":RUN,"lang":…,"audioMs":…; ok:false + error on failure)
                   {"t":"error","id":N,"error":…}

The voiceprint (voiceprint.py; docs/local-stt.md, "Voiceprint"):

  client → server  {"t":"hello","device":D}                 which device's print to score against
                   {"t":"begin","id":N,"enrol":true}         an enrolment sentence (not scored)
                   {"t":"end","id":N,"textFrom":S}           decode the text from sample S on (after
                                                             "Linky"); the speaker check hears it all
                   {"t":"enrol","op":"start","rid":R,"device":D,"consent":true,"keepAudio":false}
                   {"t":"enrol","op":"commit"|"cancel","rid":R}
                   {"t":"voiceprint","op":"status","rid":R}
                   {"t":"voiceprint","op":"delete","rid":R,"device":D|"*"}   the print only
                   {"t":"voiceprint","op":"delete-audio","rid":R,"device":D|"*"}   the kept recordings only
                   {"t":"voiceprint","op":"export","rid":R,"device":D|"*"[,"recordings":true]}   features
                       (and the kept recordings, base64 wav, for My Files), for the account
                   {"t":"voiceprint","op":"restore","rid":R,"device":D|"*","prints":[…]}   from the account
                   {"t":"filter","on":bool}                  the voiceprint filter on this socket
                   {"t":"selfVoice","on":bool[,"accept":A,"margin":M]}   our own TTS voices tagged
                                                             "self" (voiceprint.py self.<model>.json)
                   {"t":"voiceprint","op":"progressive","rid":R,"on":bool}   progressive learning on the
                       Mac (passkey ticket, device "*"); status answers "progressive":{on,pending,…}
                   {"t":"end",…,"playback":true}             something played while he spoke: never learned
  server → client  ready gains "speaker":{"models":[…]} when the check is on
                   final gains "speaker":{score,decision:"me"|"other"|"unknown",model,device,
                    speechS,snrDb[,reason,voice,cluster,clusterScore]}, or on an enrolment sentence "enrol":{ok,n[,reason],…}
                   {"t":"enrol"|"voiceprint","rid":R,"ok":…[,"error"]…}
                   {"t":"filter","on":bool}                  (the filter's state: voiceprint status, "filter")
                   final gains "filtered":{reason,score} when the filter stopped it (text "",
                    nothing decoded), or "wouldFilter":reason when the filter is not on
                   final gains "parts":[{text,lang,startMs,audioMs,speaker,speakerProof},…] when two
                    speakers were heard in it ("mixed"): each part read and checked on its own audio,
                    its proof over its own text (uid "<uid>-p<i>"); `text` is the parts' texts joined
                    and `speaker`/`speakerProof` stay the whole final's (a page without parts: one line)

GET /health answers {"ok":true,"engine":…,"speaker":[models]|false} (the same port, plain HTTP).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus

import numpy as np
from websockets.exceptions import ConnectionClosed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engines import RATE, load_engine  # noqa: E402
from ticket import (  # noqa: E402
    SUBPROTOCOL, V2_AUD, VOICEPRINT_AUD, Tickets, file_problem, load_public_key, offered,
)
import voiceprint as VP  # noqa: E402
from engines import simplified, tidy  # noqa: E402
from rolling import CTX_S, Rolling, join_spans  # noqa: E402
from switch import FINAL_CHUNK_S as FINAL_CHUNK_DEFAULT, chunk_spans, plan, runs_of  # noqa: E402
from recordings import RecordingStore, RecordingWorker, TTL_S  # noqa: E402

#: A partial every this much new audio (--partial-step)… The owner's bar: the next feedback
#: within 0.2 s of speech, a wrong word being better than none, so the step is well under it.
PARTIAL_STEP_S = 0.1
#: …once the utterance is this long (--partial-min).
PARTIAL_MIN_S = 0.1
#: Partials decode only the unsettled tail with some context (rolling.py) when 1; by default
#: they decode the whole utterance: as fast to change on screen at these lengths, and cleaner
#: (docs/local-stt.md, "Rolling partials").
ROLLING = os.environ.get("LIANKI_STT_ROLLING", "0") == "1"
#: Longest utterance kept (the mic cuts at 30 s).
MAX_S = 40
#: A long final is read in chunks cut at silences (switch.chunk_spans; env
#: LIANKI_STT_FINAL_CHUNK_S, 0: never): SenseVoice's one pass over 17 s dropped most of it.
FINAL_CHUNK_S = float(os.environ.get("LIANKI_STT_FINAL_CHUNK_S", str(FINAL_CHUNK_DEFAULT)))
#: The partial kept (docs/local-stt.md, "A final shorter than its partials"): a final of at
#: least FINAL_GUARD_MIN_S of audio whose text has fewer than this share of the last partial's
#: characters is a dropped read, not a correction (env LIANKI_STT_FINAL_MIN_RATIO; 0: off).
FINAL_MIN_RATIO = float(os.environ.get("LIANKI_STT_FINAL_MIN_RATIO", "0.6"))
FINAL_GUARD_MIN_S = float(os.environ.get("LIANKI_STT_FINAL_GUARD_MIN_S", "6"))


def keep_partial(final_text: str, partial_text: str, audio_s: float,
                 ratio: float = FINAL_MIN_RATIO, min_s: float = FINAL_GUARD_MIN_S) -> bool:
    """True: the final read much less than the last partial of a long utterance, so the partial stands."""
    f, p = len(final_text.strip()), len(partial_text.strip())
    return ratio > 0 and audio_s >= min_s and p > 0 and f < ratio * p
#: Seconds of received audio each socket keeps in RAM for a Whisper recheck (--recheck-max-sec,
#: env LIANKI_STT_RECHECK_MAX_SEC; config stt.recheckMaxSec is the page's side of the same bound).
RECHECK_MAX_S = 60
#: Bounds of --recheck-max-sec: 10 minutes of float32 is 38 MB per socket.
RECHECK_MAX_BOUNDS = (5, 600)
#: How far an utterance's begin may sit outside a run's window (the page's clock against this
#: one's: the network's latency and its jitter, never a whole utterance).
RUN_SLACK_S = 0.5
#: A run id from the page (its chat line id): what the result carries back.
RUN_ID = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
#: An enrolment not saved or cancelled within this long is dropped.
ENROL_TTL_S = 30 * 60

ORIGINS = [
    "https://lianki.com",
    "https://www.lianki.com",
    # The owner's whole-page dev server (docs/dev-whole-page.md): token-gated, owner only.
    "https://preview.lianki.com",
    "http://localhost:3000",
    "http://localhost:5180",
    "http://localhost:5190",
]
#: The tunnel listener: lianki.com pages only (never localhost: nothing local comes through it).
PUBLIC_ORIGINS = ["https://lianki.com", "https://www.lianki.com"]
#: Sockets open at once on the tunnel listener (the page's race opens one; a second page, one more).
MAX_PUBLIC = 2
#: The peer listener (docs/local-stt.md, "Lianki's speech servers for everyone"): other
#: accounts' sessions, bridged from WebRTC by stt-peer on this Mac. 127.0.0.1 only, each
#: socket with its own v2 ticket (ticket.py V2_AUD), checked here before the upgrade.
PEER_SUBPROTOCOL = "lianki-stt2"
PEER_ORIGINS = ["https://lianki.com"]
#: Sockets at once on the peer listener: config stt.worker.macCapacity - macReserved (3 - 1).
MAX_PEER = 2
#: This Mac's own account id (--peer-owner-file): its sessions over WebRTC are the owner's.
PEER_OWNER_FILE = os.path.expanduser("~/.config/lianki-stt/peer-owner")
#: Their own subfolder of the voiceprint store, per account (none enrolled yet; see account_store).
ACCOUNTS_DIR = "accounts"
#: Where tunnel.sh turns the tunnel listener on and off, so the oxmgr entry never changes.
PUBLIC_CONFIG = os.path.expanduser("~/.config/lianki-stt/public.json")
DEFAULT_PUBKEY = os.path.expanduser("~/.config/lianki-stt/ticket.pub")


def now_s() -> float:
    """This server's clock for a run's window (a function, so the tests can move it)."""
    return time.monotonic()


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Utterance:
    def __init__(self, uid: int):
        self.id = uid
        self.pre: np.ndarray | None = None
        self.chunks: list[np.ndarray] = []
        self.n = 0
        self.last_partial = 0
        self.partial_busy = False
        self.last_text = ""
        self.done = False
        self.began = time.perf_counter()
        self.captured_at = time.time()
        self.first_partial_ms: int | None = None
        #: An enrolment sentence (the enrolment's id): its embedding joins it, nothing is scored.
        self.enrol: str | None = None
        #: The page's id for this utterance, signed into the speaker proof (the hub burns it).
        self.uid: str | None = None
        #: The text is decoded from this sample on (the words after "Linky").
        self.text_from = 0
        #: With the filter on, partials wait for this: the check heard enough and did not stop it.
        self.cleared = False
        #: Partials decode only the unsettled tail (rolling.py); the final still reads it all.
        self.roll = Rolling()
        #: Speech runs and their languages, while the speaker talks (switch.py); None: no tracker.
        self.sw = None
        #: The languages of a switched utterance, stretch by stretch (its final was read so).
        self.switched: list[str] | None = None
        #: The page said something was playing while he spoke (end's "playback"): never learned from.
        self.playback = False
        #: How many chunks its final was read in (decode_chunked); 0: one pass.
        self.chunked = 0

    def audio(self) -> np.ndarray:
        parts = ([self.pre] if self.pre is not None else []) + self.chunks
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def pcm(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0


class AudioRingBuffer:
    """Fixed seconds of float32 PCM in RAM (default 60), owned by one socket only.

    `total` counts every sample ever appended: a position in it is a sample's absolute
    place, so a run's utterances are found again while the ring keeps moving.
    """

    def __init__(self, seconds: int = 60):
        self.data = np.zeros(int(seconds * RATE), dtype=np.float32)
        self.end = 0
        self.size = 0
        self.total = 0

    @property
    def oldest(self) -> int:
        """The absolute position of the oldest sample still kept."""
        return self.total - self.size

    def append(self, audio: np.ndarray) -> None:
        x = audio[-len(self.data):]
        n = len(x)
        first = min(n, len(self.data) - self.end)
        self.data[self.end:self.end + first] = x[:first]
        self.data[:n - first] = x[first:]
        self.end = (self.end + n) % len(self.data)
        self.size = min(len(self.data), self.size + n)
        self.total += len(audio)

    def tail(self, n: int) -> np.ndarray:
        n = min(n, self.size)
        start = (self.end - n) % len(self.data)
        first = min(n, len(self.data) - start)
        return np.concatenate((self.data[start:start + first], self.data[:n - first]))

    def prepend_current(self, audio: np.ndarray, current_n: int) -> None:
        # VAD sends pre-pad after streaming frames. Insert before this utterance,
        # preserving the chronological order and evicting only the oldest samples.
        current = self.tail(current_n)
        self.end = (self.end - len(current)) % len(self.data)
        self.size -= len(current)
        self.total -= len(current)
        self.append(audio)
        self.append(current)

    def span(self, start: int, stop: int) -> np.ndarray | None:
        """Absolute samples [start, stop), or None when any of them has left the ring."""
        if start < self.oldest or stop > self.total or start > stop:
            return None
        return self.tail(self.total - start)[:stop - start]

    def clear(self) -> None:
        self.data.fill(0)
        self.size = self.end = 0


class Segment:
    """One utterance's place in a socket's ring, and when (this clock) it began and ended."""

    __slots__ = ("id", "start", "stop", "t0", "t1")

    def __init__(self, uid: int, start: int, t0: float):
        self.id, self.start, self.stop, self.t0, self.t1 = uid, start, start, t0, None


def run_window(m: dict, cap_s: float) -> tuple[float, float] | None:
    """An auto recheck's window in seconds before now (fromAgoMs >= toAgoMs >= 0), or None."""
    fro, to = m.get("fromAgoMs"), m.get("toAgoMs", 0)
    for v in (fro, to):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            return None
    # A run longer than the ring cannot be whole; a little room for the time it waited.
    if to > fro or fro > (cap_s + 60) * 1000:
        return None
    return fro / 1000, to / 1000


def run_audio(ring: AudioRingBuffer, segs: list[Segment], start_t: float, end_t: float,
              slack: float = RUN_SLACK_S) -> tuple[np.ndarray | None, str | None]:
    """
    A continuous-speech run's audio: every utterance that began within [start_t, end_t]
    (with `slack` either side), from the first one's start to the last one's end, as one
    stretch of the ring (the gaps between them were never streamed). None and why when
    there is none, one is still being spoken, or the ring no longer holds all of it.
    A run whose first or last utterance is not here (a socket that dropped and came
    back holds only what was replayed on it) is refused: half a run read as the whole
    would replace words he said.
    """
    picked = [s for s in segs if start_t - slack <= s.t0 <= end_t + slack and s.stop > s.start]
    if not picked:
        return None, "no audio"
    if any(s.t1 is None for s in picked):
        return None, "still speaking"
    if picked[0].t0 > start_t + slack or picked[-1].t1 < end_t - slack:
        return None, "run incomplete"
    audio = ring.span(picked[0].start, picked[-1].stop)
    if audio is None:
        return None, "run too long"
    return audio, None


class Server:
    def __init__(self, engine, workers: int = 2, verifier: "VP.Verifier | None" = None,
                 vp_tickets: "Tickets | None" = None, attestor: "VP.Attestor | None" = None,
                 recorder: "RecordingWorker | None" = None):
        self.recorder = recorder
        self.engine = engine
        self.recheck_engine = None
        #: One Whisper job at a time, on its own thread: streaming never waits for it.
        self.recheck_pool = ThreadPoolExecutor(max_workers=1)
        #: Each socket's ring, in seconds (--recheck-max-sec): the longest run re-read.
        self.recheck_max_s = RECHECK_MAX_S
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.partial_step_s = PARTIAL_STEP_S
        self.partial_min_s = PARTIAL_MIN_S
        #: Finals longer than this are read in chunks (0: never); the partial-kept guard's bounds.
        self.final_chunk_s = FINAL_CHUNK_S
        self.final_min_ratio = FINAL_MIN_RATIO
        self.final_guard_min_s = FINAL_GUARD_MIN_S
        #: The speaker check (voiceprint.py), or None when it is off.
        self.verifier = verifier
        #: Voiceprint tickets (aud lianki-voiceprint, lib/voiceprint-ticket.ts): every op but
        #: commit/cancel of an enrolment needs one; without the key no op is possible.
        self.vp_tickets = vp_tickets
        #: Signs each final's speaker tag for the hub (voiceprint.Attestor), or None.
        self.attestor = attestor
        #: Its own thread, beside the decode, so the final waits only for the longer of the two.
        self.spk_pool = ThreadPoolExecutor(max_workers=1)
        #: Decisions so far (the log's counts; never text).
        self.counts = {"me": 0, "other": 0, "unknown": 0}
        #: Finals the voiceprint filter stopped, and those it would have stopped were it on.
        self.filtered = 0
        self.would_filter = 0
        #: Open enrolments by id (the start answer's `enrolment`), and when each began.
        self.enrolments: dict[str, "VP.Enrolment"] = {}
        self.enrol_at: dict[str, float] = {}

    def warm_recheck(self):
        """Load once on the dedicated worker; no audio files are ever created."""
        if self.recheck_engine is None:
            engine = load_engine("mlx-whisper")
            engine.transcribe(np.zeros(RATE // 2, dtype=np.float32))
            self.recheck_engine = engine
        return self.recheck_engine

    async def recheck(self, m: dict, audio: np.ndarray) -> dict:
        out = {"t": "recheck_result", "rid": m.get("rid"), "engine": "mlx-whisper"}
        if m.get("auto") is True:
            out.update(auto=True, run=m.get("run"))

        def read():
            return self.warm_recheck().transcribe(audio)

        try:
            text, lang = await asyncio.get_running_loop().run_in_executor(self.recheck_pool, read)
            return {**out, "ok": True, "text": text, "lang": lang,
                    "audioMs": int(len(audio) / RATE * 1000)}
        except Exception as e:
            log(f"recheck failed: {type(e).__name__}")
            return {**out, "ok": False, "error": "recheck unavailable"}

    async def verify(self, audio: np.ndarray, device: str | None, selfv: tuple[float, float] | None = None):
        """`selfv`: this socket's self-voice lines (`selfVoice`), None when it did not ask."""
        if not self.verifier:
            return None
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.spk_pool, lambda: self.verifier.verify(audio, device, selfv=selfv))

    def filter_state(self, device: str | None) -> str:
        """Why the filter can or cannot work on this socket: "on", "no-print" (this device has none), "off"."""
        v = self.verifier
        if not v:
            return "off"
        try:
            return "on" if v.has_print(device) else "no-print"
        except Exception as e:  # a store it cannot read: as if nothing were enrolled, as today
            log(f"voice filter off: {type(e).__name__}")
            return "off"

    async def enrol_add(self, enrol, audio: np.ndarray):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.spk_pool, enrol.add, audio)

    def _drop_enrolments(self, device: str | None) -> int:
        """A delete: open enrolments of that device (None: all) can neither add nor commit."""
        gone = [k for k, e in self.enrolments.items() if device is None or e.device == device]
        for k in gone:
            self.enrolments.pop(k).dropped = True
            self.enrol_at.pop(k, None)
        return len(gone)

    def _prune_enrolments(self) -> None:
        old = [k for k, t in self.enrol_at.items() if time.time() - t > ENROL_TTL_S]
        for k in old:
            e = self.enrolments.pop(k, None)
            if e:
                e.dropped = True
            self.enrol_at.pop(k, None)

    #: What each op's ticket must say (lib/voiceprint-ticket.ts); commit and cancel need none:
    #: they name an enrolment opened with a ticket, by its unguessable id.
    TICKET_FOR = {
        ("voiceprint", "status"): lambda m: {"op": "status"},
        # keepAudio as approved with the passkey: retention cannot be turned on afterwards.
        ("enrol", "start"): lambda m: {"op": "enrol", "device": m.get("device"), "uv": True,
                                       "keepAudio": m.get("keepAudio") is True},
        ("voiceprint", "delete"): lambda m: {"op": "delete", "device": m.get("device"), "uv": True},
        # The kept enrolment recordings: their own op and ticket, never part of a print delete.
        ("voiceprint", "delete-audio"): lambda m: {"op": "delete-audio", "device": m.get("device"), "uv": True},
        # The account copy (docs/local-stt.md, "Voiceprint in your account"): features out, a print in.
        ("voiceprint", "export"): lambda m: {"op": "export", "device": m.get("device"), "uv": True},
        ("voiceprint", "restore"): lambda m: {"op": "restore", "device": m.get("device"), "uv": True},
        # Progressive learning on or off (docs/local-stt.md, "Progressive voiceprint"): his passkey,
        # as for an enrolment, since it keeps features of what he says without a sentence to read.
        ("voiceprint", "progressive"): lambda m: {"op": "progressive", "device": "*", "uv": True},
    }

    async def control(self, m: dict, device: str | None = None) -> dict:
        """An enrolment or voiceprint request; the reply carries its rid. Ops need a voiceprint ticket."""
        t, op = m.get("t"), m.get("op")
        out: dict = {"t": t, "rid": m.get("rid"), "op": op}
        v = self.verifier
        if not v:
            return {**out, "ok": False, "error": "speaker check off"}
        self._prune_enrolments()
        want = self.TICKET_FOR.get((t, op))
        if want is not None:
            if not self.vp_tickets:
                log(f"voiceprint {op}: refused, no ticket key on this Mac")
                return {**out, "ok": False, "error": "no ticket key on the Mac"}
            ticket = m.get("ticket")
            why = self.vp_tickets.check(ticket if isinstance(ticket, str) else "", want(m))
            if why:
                log(f"voiceprint {op}: refused, ticket {why}")  # the reason only, never the ticket
                return {**out, "ok": False, "error": f"ticket {why}"}
        loop = asyncio.get_running_loop()
        try:
            if t == "enrol" and op == "start":
                device = m.get("device")
                if not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                keep = m.get("keepAudio") is True
                eid = VP._b64url(os.urandom(16))
                self.enrolments[eid] = await loop.run_in_executor(
                    self.spk_pool, lambda: VP.Enrolment(v, device, keep_audio=keep))
                self.enrol_at[eid] = time.time()
                log(f"enrolment started ({device}, audio {'kept' if keep else 'not kept'})")
                return {**out, "ok": True, "enrolment": eid, "min": VP.ENROL_MIN, "max": VP.ENROL_MAX}
            eid = m.get("enrolment")
            if t == "enrol" and op == "cancel":
                if isinstance(eid, str) and self.enrolments.pop(eid, None) is not None:
                    self.enrol_at.pop(eid, None)
                    log("enrolment cancelled")
                return {**out, "ok": True}
            if t == "enrol" and op == "commit":
                e = self.enrolments.get(eid) if isinstance(eid, str) else None
                if not e:
                    return {**out, "ok": False, "error": "no enrolment"}
                res = await loop.run_in_executor(self.spk_pool, e.commit)
                self.enrolments.pop(eid, None)
                self.enrol_at.pop(eid, None)
                log(f"voiceprint saved ({e.device}, {res['n']} sentences, {','.join(res['models'])}, self {res['self']})")
                if m.get("export") is True:
                    # Re-computed from his recordings: the new features back to the page for his
                    # account, under the same passkey approval as the enrolment (features only).
                    res["prints"] = await loop.run_in_executor(self.spk_pool, v.store.export, e.device)
                return {**out, "ok": True, **res}
            if t == "voiceprint" and op == "status":
                prints = await loop.run_in_executor(self.spk_pool, v.status)
                kept = await loop.run_in_executor(self.spk_pool, v.store.audio_count, None)
                prog = await loop.run_in_executor(self.spk_pool, self.progressive_info)
                # Household prints (docs/local-stt.md, "Household voices"): counts and the margins, no features.
                house = await loop.run_in_executor(self.spk_pool, v.store.households)
                return {**out, "ok": True, "prints": prints, "models": v.order, "filter": self.filter_state(device),
                        "bands": VP.bands_info(v.order), "recordings": kept, "progressive": prog,
                        "households": house, "margins": {"me": VP.ME_MARGIN, "other": VP.OTHER_MARGIN}}
            if t == "voiceprint" and op == "progressive":
                on = m.get("on")
                if not isinstance(on, bool):
                    return {**out, "ok": False, "error": "on must be true or false"}
                await loop.run_in_executor(self.spk_pool, v.store.set_progressive, on)
                log(f"progressive voiceprint {'on' if on else 'off'}")
                prog = await loop.run_in_executor(self.spk_pool, self.progressive_info)
                return {**out, "ok": True, "progressive": prog}
            if t == "voiceprint" and op == "delete":
                device = m.get("device")
                if device != "*" and not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                who = None if device == "*" else device
                dropped = self._drop_enrolments(who)  # before the delete: queued sentences see it
                # The print only: kept recordings are a separate question (delete-audio).
                n = await loop.run_in_executor(self.spk_pool, v.store.delete, who)
                v.refresh()
                kept = await loop.run_in_executor(self.spk_pool, v.store.audio_count, who)
                log(f"voiceprint deleted ({device}, {n} files, {dropped} open enrolment(s) dropped, {kept} recording(s) kept, "
                    "progressive off)")
                return {**out, "ok": True, "deleted": n, "recordings": kept, "progressive": False}
            if t == "voiceprint" and op == "delete-audio":
                device = m.get("device")
                if device != "*" and not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                who = None if device == "*" else device
                n = await loop.run_in_executor(self.spk_pool, v.store.delete_audio, who)
                log(f"voiceprint recordings deleted ({device}, {n} file(s))")
                return {**out, "ok": True, "deleted": n}
            if t == "voiceprint" and op == "export":
                # Features only (voiceprint.EXPORT_KEYS): never audio, never a path.
                device = m.get("device")
                if device != "*" and not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                who = None if device == "*" else device
                prints = await loop.run_in_executor(self.spk_pool, v.store.export, who)
                if m.get("recordings") is True:
                    # The kept enrolment audio too, for his account's My Files (read here, never deleted).
                    recs = await loop.run_in_executor(self.spk_pool, v.store.recordings, who)
                    log(f"voiceprint exported ({device}, {len(prints)} print(s), {len(recs)} recording(s))")
                    return {**out, "ok": True, "prints": prints, "recordings": recs}
                log(f"voiceprint exported ({device}, {len(prints)} print(s), features only)")
                return {**out, "ok": True, "prints": prints}
            if t == "voiceprint" and op == "restore":
                device = m.get("device")
                prints = m.get("prints")
                if device != "*" and not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                if not isinstance(prints, list) or not 0 < len(prints) <= 16:
                    return {**out, "ok": False, "error": "no prints"}
                for p in prints:
                    q = VP.check_export(p)  # all checked before anything is written
                    if device != "*" and q["device"] != device:
                        return {**out, "ok": False, "error": "wrong device"}
                done = [await loop.run_in_executor(self.spk_pool, v.store.restore, p) for p in prints]
                v.refresh()
                log(f"voiceprint restored ({device}, {len(done)} print(s))")
                return {**out, "ok": True, "restored": done}
        except VP.StoreError as e:
            if t == "enrol" and op == "commit" and isinstance(eid, str):
                self.enrolments.pop(eid, None)
                self.enrol_at.pop(eid, None)
            log(f"voiceprint {op} failed: {e}")
            return {**out, "ok": False, "error": str(e)[:200]}
        return {**out, "ok": False, "error": "unknown request"}

    def progressive_info(self) -> dict:
        """The status answer's `progressive`: the switch, samples still pending, and the thresholds."""
        v = self.verifier
        st = v.store.progressive()
        return {"on": st["on"], "updated": st["updated"], "pending": v.store.pending(),
                "minSpeechS": VP.PROG_MIN_SPEECH_S, "minSnrDb": VP.PROG_MIN_SNR_DB, "margin": VP.PROG_MARGIN,
                "outlierMargin": VP.PROG_OUTLIER_MARGIN, "everyS": VP.PROG_EVERY_S, "max": VP.PRINT_MAX,
                "createMin": VP.PROG_CREATE_MIN}

    async def learn(self, audio: np.ndarray, device: str | None, spk: dict, uid: int) -> None:
        """
        Progressive learning, after the final is sent (it never delays one): the cheap checks
        first, the embedding only for a candidate. Logs the outcome, never text; keeps no audio.
        """
        v = self.verifier
        if not v or v.learn_gate(spk, device) == "not-me":
            return
        try:
            r = await asyncio.get_running_loop().run_in_executor(self.spk_pool, v.learn, audio, device, spk)
        except Exception as e:  # a store it cannot read: nothing learned, nothing else changes
            log(f"progressive #{uid}: failed ({type(e).__name__}: {e})")
            return
        if r.get("ok"):
            extra = (", print made" if r.get("created") else "") + (f", {r['evicted']} oldest out" if r.get("evicted") else "")
            log(f"progressive #{uid}: added to {device} ({r['n']} sample(s){'' if r.get('active') else ', pending'}{extra})")
        elif r.get("reason") not in ("off",):
            log(f"progressive #{uid}: not taken ({r.get('reason')})")

    def tracker(self):
        """A language switch tracker for a new utterance (switch.py), or None."""
        make = getattr(self.engine, "switch_tracker", None)
        try:
            return make() if make else None
        except Exception as e:  # no switch, as before
            log(f"language switch off: {type(e).__name__}: {e}")
            return None

    async def decode(self, audio: np.ndarray):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, self.engine.transcribe, audio)

    async def decode_partial(self, u: Utterance) -> str:
        """
        A partial's text: the settled segments and a pass over the tail only (rolling.py),
        so its cost stays flat however long the utterance. Engines without token times,
        and the words after "Linky" (text_from), decode the whole utterance as before.
        """
        tail_of = getattr(self.engine, "tail", None) if ROLLING else None
        if tail_of is None or u.text_from:
            text, _lang = await self.decode(u.audio())
            return text
        whole = u.audio()
        ctx = min(u.roll.at, int(CTX_S * RATE))  # settled audio heard again, as context
        audio = whole[u.roll.at - ctx:]
        loop = asyncio.get_running_loop()
        tokens, times, lang = await loop.run_in_executor(self.pool, tail_of, audio)
        tail = u.roll.update(tokens, times, lang, len(audio) - ctx, ctx)
        # Each piece in its own language's script (zh → simplified); spaces between words kept.
        pieces = [(s.text, s.lang) for s in u.roll.segments] + [(tail, lang)]
        return tidy("".join(simplified(t) if lg in ("zh", "yue") else t for t, lg in pieces), "")

    async def decode_final(self, audio: np.ndarray):
        """(text, lang, the auto language it replaced or None): engines with a final pass use it."""
        fin = getattr(self.engine, "final", None)
        if fin is None:
            return (*(await self.decode(audio)), None)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, fin, audio)

    async def decode_chunked(self, audio: np.ndarray, runs: list[tuple[int, int]] | None = None):
        """
        A long final read chunk by chunk, cut in the silences between speech runs
        (switch.chunk_spans; docs/local-stt.md, "Long finals in chunks"): SenseVoice's one
        pass over a long utterance can drop most of it. `runs`: the Tracker's, or None to
        find them here (Silero). (text, lang of the longest chunk read, None, chunks), or
        None when it cannot be cut (no VAD, one run) or no chunk reads as anything: then
        the whole decode stands.
        """
        if runs is None:
            find = getattr(self.engine, "speech_runs", None)
            if find is None:
                return None
            runs = await asyncio.get_running_loop().run_in_executor(self.pool, find, audio)
            if not runs:
                return None
        spans = chunk_spans(runs, len(audio), self.final_chunk_s)
        if len(spans) < 2:
            return None
        got = await asyncio.gather(*(self.decode_final(audio[a:b]) for a, b in spans))
        read = [(r[0], r[1], b - a) for (a, b), r in zip(spans, got) if r[0].strip()]
        if not read:
            return None
        lang = max(read, key=lambda r: r[2])[1]
        return join_spans([t for t, _, _ in read]), lang, None, len(spans)

    async def split(self, audio: np.ndarray, cuts: list[int], device: str | None,
                    selfv: tuple[float, float] | None = None) -> list[dict] | None:
        """
        A final with two speakers in it, cut where the speaker changes (voiceprint.split_points):
        each part read and checked on its own audio, [{text, lang, startMs, audioMs, speaker}].
        None (one "mixed" final, as before) when a part reads as nothing or anything fails.
        """
        edges = [0, *cuts, len(audio)]
        spans = list(zip(edges, edges[1:]))
        try:
            got = await asyncio.gather(*(self.decode_final(audio[a:b]) for a, b in spans),
                                       *(self.verify(audio[a:b], device, selfv) for a, b in spans))
        except Exception as e:
            log(f"speaker split failed: {type(e).__name__}: {e}")
            return None
        reads, checks = got[:len(spans)], got[len(spans):]
        if not all(r[0].strip() for r in reads):
            return None
        out = []
        for (a, b), r, c in zip(spans, reads, checks):
            c.pop("cuts", None)  # one split, never again inside a part
            out.append({"text": r[0], "lang": r[1], "startMs": int(a / RATE * 1000),
                        "audioMs": int((b - a) / RATE * 1000), "speaker": c})
        return out

    async def handler(self, ws, via: str = "tailnet", limits: dict | None = None):
        """
        One page. `limits` (the peer listener: another account's v2 ticket, `lim`):
        that ticket's longest utterance and session, and none of the owner's
        voiceprint features on this socket (no speaker check, no proof, no filter,
        no enrolment or voiceprint ops: those are his, and per-account prints
        are not enrolled yet).
        """
        peer = ws.request.headers.get("origin", "?")
        log(f"page attached ({peer}, {via})")
        guest = limits is not None
        max_samples = int((limits or {}).get("utt", MAX_S)) * RATE
        session_end = None
        if guest:
            async def end_session():
                await asyncio.sleep(int(limits.get("sess", 900)))
                log(f"session over ({via})")
                await ws.close(4408, "session over")

            session_end = asyncio.create_task(end_session())
        ring = AudioRingBuffer(self.recheck_max_s)
        #: The utterances in the ring, oldest first (a run's recheck finds them by time).
        segs: list[Segment] = []
        seg: Segment | None = None
        recheck_task = None

        def forget():
            """The ring was cleared: no utterance in it can be found again."""
            nonlocal seg
            ring.clear()
            segs.clear()
            seg = None
        cur: Utterance | None = None
        #: This socket's device (hello): whose print its finals are scored against.
        #: `self`: the self-voice lines (accept, margin) once the page asked (`selfVoice`, flag
        #: stt.self-voice); None = no "self" decision on this socket, the self print unused.
        conn: dict = {"device": None, "thread": None, "filter": False, "self": None}

        async def send(obj):
            try:
                await ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        async def partial(u: Utterance):
            u.partial_busy = True
            try:
                # The filter on: nothing is decoded before the check has heard enough to speak.
                if conn["filter"] and not u.enrol and not u.cleared:
                    try:
                        spk = await self.verify(u.audio(), conn["device"], conn["self"])
                    except Exception as e:  # the model failed: exactly as with no filter
                        log(f"speaker check failed: {type(e).__name__}: {e}")
                        spk = None
                    if VP.filter_reason(spk, conn["device"]) or VP.filter_pending(spk, conn["device"]):
                        return
                    u.cleared = True
                text = await self.decode_partial(u)
            except Exception as e:  # a partial is best effort
                log(f"partial failed: {e}")
                text = ""
            finally:
                u.partial_busy = False
            if u.done or not text or text == u.last_text:
                return
            u.last_text = text
            if u.first_partial_ms is None:
                u.first_partial_ms = int((time.perf_counter() - u.began) * 1000)
            await send({"t": "partial", "id": u.id, "text": text, "audioMs": int(u.n / RATE * 1000)})

        def recheck_final(u: Utterance, audio: np.ndarray) -> None:
            """
            Whisper re-reads a final whose partial was kept (the same worker and one-at-a-time
            slot as a page's recheck): `{"t":"recheck_result","rid":"final-<id>","final":<id>,
            "partialKept":true,…}`. Skipped, as a page's request would be refused, while one
            runs, while filtering or enrolling, or for a guest socket.
            """
            nonlocal recheck_task
            if guest or conn["filter"] or u.enrol or (recheck_task is not None and not recheck_task.done()):
                log(f"final #{u.id}: partial kept, no recheck (busy or unavailable)")
                return
            request = {"rid": f"final-{u.id}"}

            async def reply():
                out = await self.recheck(request, audio)
                await send({**out, "final": u.id, "partialKept": True})

            recheck_task = asyncio.create_task(reply())

        async def final(u: Utterance):
            t0 = time.perf_counter()
            audio = u.audio()
            heard = audio[u.text_from:] if u.text_from > 0 else audio
            enrol = self.enrolments.get(u.enrol) if u.enrol else None

            # A long final is read in chunks cut at silences (decode_chunked): one pass over
            # 17 s of SenseVoice kept 17 characters of a sentence every partial had read.
            long = (self.final_chunk_s > 0 and len(heard) > self.final_chunk_s * RATE
                    and getattr(self.engine, "speech_runs", None) is not None)

            async def chunked(runs=None):
                try:
                    got = await self.decode_chunked(heard, runs)
                except Exception as e:  # the whole decode, as before
                    log(f"chunked final failed: {type(e).__name__}: {e}")
                    got = None
                if got is None:
                    return await self.decode_final(heard)
                u.chunked = got[3]
                return got[:3]

            async def text_of():
                if len(heard) < RATE // 10:  # a bare "Linky": nothing after it to read
                    return "", "", None
                if u.sw is None or u.text_from:
                    return await (chunked() if long else self.decode_final(heard))
                # The speaker changed language (docs/local-stt.md, "Language switch"): the
                # stretches between silences, each re-read in its own language, are the final
                # (backfill). The whole decode runs beside the last run's language pick, and
                # stands when there is no switch, so most finals wait for nothing more.
                # A long one is not decoded whole: its chunks are, once the runs are known.
                whole = None if long else asyncio.ensure_future(self.decode_final(heard))
                runs = []
                try:
                    runs = u.sw.close()
                    probs = await asyncio.gather(*(asyncio.wrap_future(f) for _, _, f in runs))
                    stretches = plan(runs_of([(a, b, p) for (a, b, _), p in zip(runs, probs)]))
                except Exception as e:  # the whole decode, as before
                    log(f"language switch failed: {type(e).__name__}: {e}")
                    stretches = []

                async def no_switch():
                    if whole is not None:
                        return await whole
                    return await chunked([(a, b) for a, b, _ in runs] or None)

                if len(stretches) < 2:
                    return await no_switch()
                loop = asyncio.get_running_loop()
                got = await loop.run_in_executor(self.pool, self.engine.read_stretches, audio, stretches)
                if not got:
                    return await no_switch()
                u.switched = [lang for _, lang in got]
                main = max(stretches, key=lambda sp: sp[1] - sp[0])[2]
                return join_spans([t for t, _ in got]), main, None

            # The filter on (never an enrolment sentence): the check comes first, and audio it
            # stops is not transcribed at all. A check that fails lets it through, as today.
            checked = None
            if conn["filter"] and self.verifier and not u.enrol:
                try:
                    checked = await self.verify(audio, conn["device"], conn["self"])
                except Exception as e:
                    log(f"speaker check failed: {type(e).__name__}: {e}")
                why = VP.filter_reason(checked, conn["device"]) if checked else None
                if why:
                    self.filtered += 1
                    ms = int((time.perf_counter() - t0) * 1000)
                    await send({
                        "t": "final", "id": u.id, "text": "", "lang": "", "model": self.engine.model, "ms": ms,
                        "audioMs": int(len(audio) / RATE * 1000), "endToFinalMs": ms,
                        "firstPartialMs": u.first_partial_ms,
                        "speaker": checked, "filtered": {"reason": why, "score": checked.get("score")},
                    })
                    log(f"final #{u.id}: {len(audio) / RATE:.1f}s audio, filtered {why} "
                        f"{checked.get('score')} ({self.filtered} filtered)")
                    return

            # The speaker check runs beside the decode (its own thread), on the whole utterance.
            async def no_check():
                return checked

            if guest:
                side = no_check()  # another account: never scored against the owner's prints
            elif enrol:
                side = self.enrol_add(enrol, audio)
            else:
                side = no_check() if checked is not None else self.verify(audio, conn["device"], conn["self"])
            res = await asyncio.gather(text_of(), side, return_exceptions=True)
            if isinstance(res[0], BaseException):
                await send({"t": "error", "id": u.id, "error": str(res[0])[:200]})
                return
            text, lang, auto_lang, *more = res[0]
            spk = None if isinstance(res[1], BaseException) else res[1]
            if isinstance(res[1], BaseException):
                log(f"speaker check failed: {type(res[1]).__name__}: {res[1]}")
            # Two speakers in it (owner, 2026-11-13): one line per speaker, each with its own
            # tag and proof (docs/local-stt.md, "Two speakers in one final"). Not after "Linky":
            # the cuts are in the whole audio, the text only after it.
            cuts = spk.pop("cuts", None) if isinstance(spk, dict) and not enrol else None
            parts = await self.split(audio, cuts, conn["device"], conn["self"]) if cuts and not u.text_from else None
            if parts:
                text = join_spans([p["text"] for p in parts])
            # A final much shorter than the last partial of a long utterance dropped words the
            # partials had (docs/local-stt.md, "A final shorter than its partials"): the partial
            # stands, marked, and Whisper re-reads it. Not after "Linky" (the partials read the
            # whole audio, the final only what follows) nor a split one (each part its own text).
            kept = (not u.text_from and not parts and not enrol and not u.enrol
                    and keep_partial(text, u.last_text, len(heard) / RATE,
                                     self.final_min_ratio, self.final_guard_min_s))
            final_len = len(text)
            if kept:
                text = u.last_text
            ms = int((time.perf_counter() - t0) * 1000)
            msg = {
                "t": "final",
                "id": u.id,
                "text": text,
                "lang": lang,
                "model": self.engine.model,
                "ms": ms,
                "audioMs": int(len(audio) / RATE * 1000),
                "endToFinalMs": ms,
                "firstPartialMs": u.first_partial_ms,
                # The page's silence guard (stt-guard.ts): numbers and the decoder's kind, never text.
                "signals": {"decoder": getattr(self.engine, "decoder", "ctc"), **(more[0] if more else {})},
            }
            if auto_lang:
                msg["langAuto"] = auto_lang  # what auto-detect said before the short-utterance pick
            if u.switched:
                msg["langs"] = u.switched  # a switched utterance: read stretch by stretch, in these
            if u.chunked:
                msg["chunks"] = u.chunked  # a long one: read in this many chunks cut at silences
            tag = ""
            if kept:
                msg["partialKept"] = True
                tag += f", partial kept ({final_len} < {self.final_min_ratio:g} x {len(text)} chars)"
            if enrol and spk is not None:
                msg["enrol"] = spk
                tag = f", enrol {'ok' if spk.get('ok') else spk.get('reason')} ({spk.get('n')})"
            elif u.enrol:
                msg["enrol"] = {"ok": False, "reason": "no-enrolment", "n": 0}
            elif spk is not None:
                msg["speaker"] = spk
                if self.attestor:
                    # Signed for the hub: only a tag that verifies, over this text, is kept on a line.
                    msg["speakerProof"] = self.attestor.sign(spk, text, uid=u.uid, thread=conn.get("thread"))
                if parts:
                    # Each part's proof over its own words, under its own uid (the hub burns each).
                    for i, p in enumerate(parts):
                        if self.attestor:
                            uid = f"{u.uid[:56]}-p{i}" if u.uid else None
                            p["speakerProof"] = self.attestor.sign(p["speaker"], p["text"], uid=uid,
                                                                   thread=conn.get("thread"))
                    msg["parts"] = parts
                d = spk["decision"]
                self.counts[d] = self.counts.get(d, 0) + 1
                # The filter off: what it would have stopped (a count on his device, and a real
                # measure of false rejects on his own speech before he turns it on).
                would = VP.filter_reason(spk, conn["device"]) if not conn["filter"] else None
                if would:
                    self.would_filter += 1
                    msg["wouldFilter"] = would
                sc = "-" if spk.get("score") is None else f"{spk['score']:.3f}"
                why = f" {spk['reason']}" if spk.get("reason") else ""
                # Which other voice (voiceprint.Voices): an id, never anything of theirs.
                who = f" {spk['voice']}" if spk.get("voice") not in (None, "me") else ""
                if spk.get("cluster"):
                    who += f" [{spk['cluster']} {spk.get('clusterScore', 0):.2f}]"  # a label, never theirs
                c = self.counts
                tag = f", spk {d} {sc}{why}{who} (me {c['me']} other {c['other']} unknown {c['unknown']})"
                if spk.get("margin") is not None:
                    # Household voices: numbers only (his score, hers, the margin, his share when mixed).
                    tag += f", margin {spk['margin']:+.3f} (other {spk['otherScore']:.3f})"
                    if spk.get("mixed"):
                        tag += f", mixed me {spk['meShare']:.2f}"
                if spk.get("selfScore") is not None:
                    # Our own playback voices: a number and our voice id, never his.
                    tag += f", self {spk['selfScore']:.3f}" + (f" {spk['selfVoice']}" if d == "self" else "")
                if parts:
                    tag += ", split " + "+".join(p["speaker"].get("voice") or p["speaker"]["decision"] for p in parts)
                if would:
                    tag += f", would filter ({self.would_filter})"
            await send(msg)
            if kept:
                recheck_final(u, heard)
            # Progressive voiceprint: his own clean, confident finals only, after the final went out.
            if spk is not None and not enrol and not u.enrol and not guest and not parts and not u.playback:
                asyncio.create_task(self.learn(audio, conn["device"], spk, u.id))
            picked = f", lang {auto_lang}->{lang}" if auto_lang else ""
            if u.switched:
                picked += f", langs {'+'.join(u.switched)}"
            if u.chunked:
                picked += f", {u.chunked} chunks"
            log(f"final #{u.id}: {len(audio) / RATE:.1f}s audio, decode {ms} ms, {len(text)} chars{picked}{tag}")

        ready = {"t": "ready", "engine": self.engine.name, "model": self.engine.model}
        if self.verifier and not guest:
            ready["speaker"] = {"models": self.verifier.order}
        if self.recorder is not None and not guest:
            ready["recording"] = {"enabled": True, "retentionS": self.recorder.store.ttl}
        await send(ready)
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    if not msg or cur is None or cur.done:
                        continue
                    tag, body = msg[0], msg[1:]
                    if tag == 1:
                        remaining = max_samples - cur.n - (len(cur.pre) if cur.pre is not None else 0)
                        if remaining <= 0:
                            continue
                        if len(body) % 2:
                            continue
                        x = pcm(body)[:remaining]
                        if not cur.enrol and not conn["filter"]:
                            ring.append(x)
                            if seg is not None:
                                seg.stop = ring.total
                        cur.chunks.append(x)
                        cur.n += len(x)
                        if cur.sw is not None:
                            cur.sw.feed(x)
                        if (
                            not cur.partial_busy
                            and cur.n >= self.partial_min_s * RATE
                            and cur.n - cur.last_partial >= self.partial_step_s * RATE
                        ):
                            cur.last_partial = cur.n
                            asyncio.create_task(partial(cur))
                    elif tag == 2:
                        if len(body) % 2 or cur.pre is not None:
                            continue
                        cur.pre = pcm(body)[:max(0, max_samples - cur.n)]
                        if not cur.enrol and not conn["filter"]:
                            ring.prepend_current(cur.pre, cur.n)
                            if seg is not None:
                                seg.stop = ring.total  # the pre-pad went in before it: it starts where it did
                        cur.roll = Rolling()  # the samples moved: settle again from the start
                        if cur.sw is not None:
                            cur.sw.prepend(cur.pre)  # the picks made while he spoke stand
                    continue
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                t, uid = m.get("t"), m.get("id")
                if t == "begin" and isinstance(uid, int):
                    if cur is not None:
                        cur.done = True
                    cur = Utterance(uid)
                    cur.sw = self.tracker()
                    e = m.get("enrol")
                    cur.enrol = e if isinstance(e, str) and 0 < len(e) <= 64 else None
                    if cur.enrol:
                        forget()
                    elif not conn["filter"]:
                        seg = Segment(uid, ring.total, now_s())
                        segs.append(seg)
                        while segs and segs[0].stop <= ring.oldest and segs[0] is not seg:
                            segs.pop(0)
                    q = m.get("uid")
                    cur.uid = q if isinstance(q, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,64}", q) else None
                elif t == "end" and cur is not None and cur.id == uid and not cur.done:
                    cur.done = True
                    if seg is not None and seg.id == uid:
                        seg.t1 = now_s()
                    tf = m.get("textFrom")
                    if isinstance(tf, int) and not isinstance(tf, bool) and tf > 0:
                        cur.text_from = tf
                    cur.playback = m.get("playback") is True
                    if self.recorder is not None and not guest and not cur.enrol:
                        self.recorder.submit(cur.audio(), cur.captured_at - (len(cur.pre) / RATE if cur.pre is not None else 0))
                    asyncio.create_task(final(cur))
                elif t == "hello" and guest:
                    pass  # no device, no thread: nothing of the owner's applies to this socket
                elif t == "hello":
                    d = m.get("device")
                    conn["device"] = d if VP.valid_device(d) else None
                    th = m.get("thread")
                    conn["thread"] = th if isinstance(th, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", th) else None
                elif t == "filter" and guest:
                    await send({"t": "filter", "on": False})
                elif t == "filter":
                    # The page says on or off (docs/local-stt.md, "Only my voice"); no message, no filter.
                    conn["filter"] = m.get("on") is True and self.verifier is not None
                    forget()
                    log(f"voice filter {'on' if conn['filter'] else 'off'} ({conn['device']})")
                    await send({"t": "filter", "on": conn["filter"]})
                elif t == "selfVoice" and guest:
                    await send({"t": "selfVoice", "on": False})
                elif t == "selfVoice":
                    # Our own TTS voices tagged "self" (docs/echo-suppression.md, layer (c)); off until said.
                    on = m.get("on") is True and self.verifier is not None
                    conn["self"] = VP.self_conf(m.get("accept"), m.get("margin")) if on else None
                    log(f"self voice {'on %.2f/%.2f' % conn['self'] if on else 'off'} ({conn['device']})")
                    await send({"t": "selfVoice", "on": on})
                elif t in ("enrol", "voiceprint") and guest:
                    await send({"t": t, "rid": m.get("rid"), "op": m.get("op"), "ok": False,
                                "error": "not on this route"})
                elif t in ("enrol", "voiceprint"):
                    await send(await self.control(m, conn["device"]))
                elif t == "cancel" and cur is not None and cur.id == uid:
                    cur.done = True
                    cur = None
                    if seg is not None and seg.id == uid:
                        seg.t1 = now_s()
                elif t == "recheck":
                    out = {"t": "recheck_result", "rid": m.get("rid"), "engine": "mlx-whisper", "ok": False}
                    auto = m.get("auto") is True
                    if auto:
                        out.update(auto=True, run=m.get("run"))
                    seconds = m.get("seconds", 15)
                    cap = self.recheck_max_s
                    if m.get("engine", "mlx-whisper") != "mlx-whisper":
                        await send({**out, "error": "unsupported engine"})
                    elif auto and not (isinstance(m.get("run"), str) and RUN_ID.fullmatch(m["run"])):
                        await send({**out, "run": None, "error": "bad run"})
                    elif auto and not run_window(m, cap):
                        await send({**out, "error": "bad window"})
                    elif not auto and (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                                       or not math.isfinite(seconds) or not 0 < seconds <= cap):
                        await send({**out, "error": f"seconds must be within (0, {cap}]"})
                    elif recheck_task is not None and not recheck_task.done():
                        await send({**out, "error": "recheck busy"})
                    elif conn["filter"] or (cur is not None and cur.enrol):
                        await send({**out, "error": "recheck unavailable while filtering or enrolling"})
                    elif not ring.size:
                        await send({**out, "error": "no audio"})
                    else:
                        if auto:
                            now_t = now_s()
                            fro, to = run_window(m, cap)
                            audio, why = run_audio(ring, segs, now_t - fro, now_t - to)
                            if audio is None:
                                await send({**out, "error": why})
                                continue
                        else:
                            audio = ring.tail(max(1, int(seconds * RATE)))

                        async def recheck_reply(request, snapshot):
                            await send(await self.recheck(request, snapshot))

                        recheck_task = asyncio.create_task(recheck_reply(m, audio))
                elif t == "ping":
                    await send({"t": "pong"})
        except ConnectionClosed:
            pass  # the page went away (reload, backgrounded): no close frame from iOS
        finally:
            forget()
            if recheck_task:
                recheck_task.cancel()
            if session_end:
                session_end.cancel()
            log(f"page detached ({peer}, {via})")


class PublicGate:
    """The tunnel listener's door: Origin, a free slot, a good ticket — all before the upgrade."""

    def __init__(self, tickets: Tickets, max_open: int = MAX_PUBLIC):
        self.tickets = tickets
        self.max_open = max_open
        self.open = 0

    def check(self, conn, req):
        origin = req.headers.get("Origin")
        if origin not in PUBLIC_ORIGINS:
            log("public: refused, wrong origin")
            return conn.respond(HTTPStatus.FORBIDDEN, "Forbidden\n")
        if self.open >= self.max_open:
            log("public: refused, too many sockets")
            return conn.respond(HTTPStatus.SERVICE_UNAVAILABLE, "Busy\n")
        has, ticket = offered(", ".join(req.headers.get_all("Sec-WebSocket-Protocol")))
        if not has or not ticket:
            log("public: refused, no ticket")
            return conn.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        if self.tickets.full():  # prunes expired jtis first, so a burst never wedges it
            log("public: refused, ticket store full")
            return conn.respond(HTTPStatus.SERVICE_UNAVAILABLE, "Busy\n")
        why = self.tickets.check(ticket)
        if why:
            log(f"public: refused, ticket {why}")  # the reason only, never the ticket
            return conn.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        return None

    def wrap(self, handler):
        async def run(ws):
            self.open += 1
            try:
                if self.open > self.max_open:  # two handshakes raced past check()
                    await ws.close(1013, "busy")
                    return
                await handler(ws, "tunnel")
            finally:
                self.open -= 1

        return run


class PeerGate:
    """
    The peer listener's door (stt-peer's bridge for other accounts): Origin, a free
    slot, and a v2 ticket offered beside "lianki-stt2" - all before the upgrade. The
    ticket's limits go to the handler; its account id is never logged.
    """

    def __init__(self, tickets: Tickets, max_open: int = MAX_PEER, owner: str = ""):
        self.tickets = tickets
        self.max_open = max_open
        self.open = 0
        #: The account this Mac belongs to (--peer-owner-file): its own sessions, reaching it
        #: over WebRTC, are the owner's (his device, thread, voiceprint), not a guest's.
        self.owner = owner

    def check(self, conn, req):
        if req.headers.get("Origin") not in PEER_ORIGINS:
            log("peer: refused, wrong origin")
            return conn.respond(HTTPStatus.FORBIDDEN, "Forbidden\n")
        if self.open >= self.max_open:
            log("peer: refused, too many sockets")
            return conn.respond(HTTPStatus.SERVICE_UNAVAILABLE, "Busy\n")
        raw = ", ".join(req.headers.get_all("Sec-WebSocket-Protocol"))
        names = [x.strip() for x in raw.split(",") if x.strip()]
        others = [n for n in names if n != PEER_SUBPROTOCOL]
        if PEER_SUBPROTOCOL not in names or len(others) != 1:
            log("peer: refused, no ticket")
            return conn.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        if self.tickets.full():
            log("peer: refused, ticket store full")
            return conn.respond(HTTPStatus.SERVICE_UNAVAILABLE, "Busy\n")
        why, p = self.tickets.check_payload(others[0])
        if why:
            log(f"peer: refused, ticket {why}")  # the reason only, never the ticket
            return conn.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        conn.lianki_limits = dict(p["lim"])
        conn.lianki_owner = bool(self.owner) and p.get("sub") == self.owner
        return None

    def wrap(self, handler):
        async def run(ws):
            self.open += 1
            try:
                if self.open > self.max_open:
                    await ws.close(1013, "busy")
                    return
                if getattr(ws, "lianki_owner", False):
                    await handler(ws, "peer-owner")  # this Mac's own account: everything of his applies
                else:
                    await handler(ws, "peer", getattr(ws, "lianki_limits", None) or {"utt": MAX_S, "sess": 60})
            finally:
                self.open -= 1

        return run


def peer_owner(path: str) -> str:
    """
    The account id in --peer-owner-file (one line, written when this Mac was registered
    as that account's own speech server), or "" when there is none or it is not safe:
    a symlink, another user's, or writable by others.
    """
    try:
        st = os.lstat(path)
    except OSError:
        return ""
    if stat.S_ISLNK(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
        log(f"peer owner file ignored: not ours or not private ({path})")
        return ""
    with open(path, encoding="utf-8") as f:
        sub = f.read().strip()
    return sub if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sub) else ""


def account_store(root: str, sub: str) -> str:
    """
    Where an account's own voiceprints would live (per-account keying, docs/local-stt.md):
    a subfolder named by a hash of its id, never the id itself, never the owner's root.
    """
    import hashlib

    if not isinstance(sub, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sub):
        raise ValueError("bad account id")
    tag = hashlib.sha256(f"lianki-stt-account\n{sub}".encode()).hexdigest()[:24]
    return os.path.join(root, ACCOUNTS_DIR, tag)


async def start_peer(serve, gate, srv, port: int):
    """The peer listener, or None: it failing to start never takes the others down."""
    try:
        peer = await serve(gate.wrap(srv.handler), "127.0.0.1", port,
                           origins=PEER_ORIGINS, subprotocols=[PEER_SUBPROTOCOL],
                           process_request=gate.check, max_size=4 * 1024 * 1024)
    except Exception as e:
        log(f"peer listener off: cannot listen on 127.0.0.1:{port} ({type(e).__name__}: {e})")
        return None
    log(f"peer listener on ws://127.0.0.1:{port} (v2 tickets required)")
    return peer


def public_settings(port: int, pubkey: str | None, config: str) -> tuple[int, str]:
    """The tunnel listener's port (0 = off) and key file: the flags, else tunnel.sh's config file."""
    conf: dict = {}
    if config and os.path.lexists(config):
        why = file_problem(config)
        if why:
            log(f"public listener off: {config} {why}")
            return 0, ""
        try:
            with open(config, encoding="utf-8") as f:
                conf = json.load(f)
            if not isinstance(conf, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as e:
            log(f"public listener off: unreadable {config} ({type(e).__name__})")
            return 0, ""
    p = port or conf.get("port") or 0
    k = pubkey or conf.get("pubkey") or DEFAULT_PUBKEY
    if not isinstance(p, int) or not isinstance(k, str):
        log(f"public listener off: bad settings in {config}")
        return 0, ""
    return p, os.path.expanduser(k)


async def start_public(serve, gate, srv, port: int):
    """The tunnel listener, or None: it failing to start never takes the tailnet listener down."""
    try:
        # 127.0.0.1 only: cloudflared on this Mac is the one way in.
        public = await serve(gate.wrap(srv.handler), "127.0.0.1", port,
                             origins=PUBLIC_ORIGINS, subprotocols=[SUBPROTOCOL],
                             process_request=gate.check, max_size=4 * 1024 * 1024)
    except Exception as e:  # port taken, permissions…: log it and keep serving the tailnet
        log(f"public listener off: cannot listen on 127.0.0.1:{port} ({type(e).__name__}: {e})")
        return None
    log(f"public listener on ws://127.0.0.1:{port} (tickets required)")
    return public


def clusters_path(arg: str | None, voiceprints: str) -> str:
    """Where the speaker clusters are kept: --clusters, else beside a moved --voiceprints folder
    (the tests: never the real one), else VP.CLUSTERS_FILE."""
    if arg:
        return arg
    if os.path.abspath(voiceprints) != os.path.abspath(VP.STORE_DIR):
        return os.path.join(os.path.dirname(os.path.abspath(voiceprints)), "clusters", "clusters.json")
    return VP.CLUSTERS_FILE


def load_verifier(models: str, root: str, clusters: str | None = None):
    """The speaker check, or None (logged) when it is off or its model is missing: never fatal."""
    names = [m for m in (models or "").split(",") if m and m != "0"]
    if not names:
        log("speaker check off")
        return None
    if names == ["fake"]:  # the tests: no model (voiceprint.FakeEmbedder)
        log(f"speaker check on (fake, {root})")
        return VP.Verifier(VP.Store(root), ["campp"], embedders={"campp": VP.FakeEmbedder()}, clusters_path=clusters)
    bad = [m for m in names if m not in VP.MODELS]
    if bad:
        log(f"speaker check off: unknown model {','.join(bad)}")
        return None
    try:
        t0 = time.perf_counter()
        v = VP.Verifier(VP.Store(root), names, clusters_path=clusters)
        v.embed(v.order[0], np.full(RATE, 1e-3, dtype=np.float32))  # warm up
        n = len(v.status())
        if clusters:
            log(f"speaker clusters: {len(v.clusters.known())} kept ({' '.join(v.clusters.known()) or '-'}), "
                f"reset {VP.CLUSTER_RESET}, in {clusters}")
        log(f"speaker check on ({','.join(v.order)}, {n} print(s) in {root}) "
            f"in {int((time.perf_counter() - t0) * 1000)} ms")
        return v
    except Exception as e:  # a missing model, an old sherpa-onnx: transcription as before
        log(f"speaker check off: {type(e).__name__}: {e}")
        return None


def tailnet(path: str, port: int, on: bool) -> None:
    args = ["tailscale", "serve", "--bg", "--set-path", path, f"http://127.0.0.1:{port}"] if on else [
        "tailscale", "serve", "--set-path", path, "off"]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"tailscale serve failed: {r.stderr.strip()}")
        sys.exit(1)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5193)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--engine", default="sensevoice")
    ap.add_argument("--tailnet", default="", help="mount at this path with tailscale serve")
    ap.add_argument("--origin", action="append", default=[], help="another allowed page origin")
    ap.add_argument("--public-port", type=int, default=0,
                    help="also listen here for the cloudflared tunnel (tickets required)")
    ap.add_argument("--ticket-pubkey", default=None,
                    help=f"the Ed25519 public key for tickets (default {DEFAULT_PUBKEY})")
    ap.add_argument("--public-config", default=PUBLIC_CONFIG,
                    help='{"port":…,"pubkey":…} written by tunnel.sh; "" for none')
    ap.add_argument("--peer-port", type=int, default=0,
                    help="also listen here for stt-peer (other accounts, v2 tickets required); 0 = off")
    ap.add_argument("--peer-owner-file", default=PEER_OWNER_FILE,
                    help="this Mac's own account id: its WebRTC sessions are the owner's")
    ap.add_argument("--peer-max", type=int, default=MAX_PEER, help="sockets at once on the peer listener")
    ap.add_argument("--speaker", default=os.environ.get("LIANKI_STT_SPEAKER", "campp"),
                    help='speaker check models in order ("campp", "campp,eres2netv2"); "" or 0 = off')
    ap.add_argument("--voiceprints", default=VP.STORE_DIR, help="where the voiceprints are kept (0700)")
    ap.add_argument("--clusters", default=None,
                    help=f"the speaker clusters file (0600; default {VP.CLUSTERS_FILE}, or beside a moved --voiceprints)")
    ap.add_argument("--voiceprint-pubkey", default=None,
                    help=f"the Ed25519 key voiceprint tickets are checked with (default: the ticket key, {DEFAULT_PUBKEY})")
    ap.add_argument("--partial-step", type=float, default=PARTIAL_STEP_S,
                    help="seconds of new audio between partials")
    ap.add_argument("--partial-min", type=float, default=PARTIAL_MIN_S,
                    help="seconds of audio before the first partial")
    ap.add_argument("--attest-key", default=VP.ATTEST_KEY, help='signs speaker tags for the hub; "" = no proofs')
    ap.add_argument("--recordings-dir", default=os.environ.get("LIANKI_STT_RECORDINGS_DIR", ""),
                    help="opt in to private 24h VAD recordings in this directory; empty disables")
    ap.add_argument("--recordings-ttl", type=int, default=TTL_S,
                    help="capture-time retention in seconds, at most 86400")
    ap.add_argument("--recheck-max-sec", type=int,
                    default=int(os.environ.get("LIANKI_STT_RECHECK_MAX_SEC", RECHECK_MAX_S)),
                    help="seconds of audio each socket keeps in RAM for a Whisper recheck "
                         f"(config stt.recheckMaxSec; {RECHECK_MAX_BOUNDS[0]}-{RECHECK_MAX_BOUNDS[1]})")
    a = ap.parse_args()

    port, pubkey = public_settings(a.public_port, a.ticket_pubkey, a.public_config)
    gate = None
    if port:
        try:
            gate = PublicGate(Tickets(load_public_key(pubkey)))
        except (OSError, ValueError) as e:
            # Fail closed: no key, no public listener (the tailnet one still runs).
            reason = str(e) if isinstance(e, ValueError) else type(e).__name__
            log(f"public listener off: no usable ticket key at {pubkey} ({reason})")

    peer_gate = None
    if a.peer_port:
        pk = pubkey or DEFAULT_PUBKEY
        try:
            peer_gate = PeerGate(Tickets(load_public_key(pk), aud=V2_AUD), max_open=max(0, a.peer_max),
                                 owner=peer_owner(a.peer_owner_file))
        except (OSError, ValueError) as e:
            reason = str(e) if isinstance(e, ValueError) else type(e).__name__
            log(f"peer listener off: no usable ticket key at {pk} ({reason})")

    from websockets.asyncio.server import serve
    from websockets.http11 import Response
    from websockets.datastructures import Headers

    import logging

    # Refused handshakes (a wrong Origin, a bad upgrade) are logged here, not in handler().
    logging.basicConfig(format="[%(asctime)s] ws %(message)s", datefmt="%H:%M:%S", level=logging.WARNING)
    logging.getLogger("websockets.server").setLevel(logging.INFO)

    t0 = time.perf_counter()
    engine = load_engine(a.engine)
    engine.transcribe(np.zeros(RATE // 2, dtype=np.float32))  # warm up
    log(f"{engine.name} ({engine.model}) ready in {int((time.perf_counter() - t0) * 1000)} ms")
    verifier = load_verifier(a.speaker, a.voiceprints, clusters_path(a.clusters, a.voiceprints))
    vp_tickets, attestor = None, None
    if verifier:
        vk = a.voiceprint_pubkey or pubkey or DEFAULT_PUBKEY
        try:
            # Spent tickets on disk (0600) until they expire, so a restart forgets none.
            vp_tickets = Tickets(load_public_key(vk), aud=VOICEPRINT_AUD,
                                 persist=os.path.join(a.voiceprints, "used-tickets.json"))
            log(f"voiceprint ops need tickets ({vk})")
        except (OSError, ValueError) as e:
            # Fail closed: no key, no enrolment, status or delete over any socket.
            log(f"voiceprint ops off: no usable ticket key at {vk} ({type(e).__name__})")
        if a.attest_key:
            try:
                attestor = VP.Attestor(a.attest_key, create=False)  # made by `voiceprint.py attest-key`
                log(f"speaker tags signed (STT_SPEAKER_PUB {attestor.public()})")
            except Exception as e:
                log(f"speaker tags unsigned: {type(e).__name__}: {e}")
    recorder = None
    if a.recordings_dir:
        recorder = RecordingWorker(RecordingStore(a.recordings_dir, ttl=a.recordings_ttl), log)
        await recorder.start()
        log("VAD recording on (local, private, capture-time TTL)")
    srv = Server(engine, verifier=verifier, vp_tickets=vp_tickets, attestor=attestor, recorder=recorder)
    if a.engine != "fake":
        try:
            await asyncio.get_running_loop().run_in_executor(srv.recheck_pool, srv.warm_recheck)
        except Exception as e:
            log(f"recheck warmup unavailable: {type(e).__name__}")
    srv.partial_step_s, srv.partial_min_s = max(0.032, a.partial_step), max(0.0, a.partial_min)
    srv.recheck_max_s = min(max(a.recheck_max_sec, RECHECK_MAX_BOUNDS[0]), RECHECK_MAX_BOUNDS[1])
    log(f"whisper recheck: up to {srv.recheck_max_s} s of audio per socket")
    log(f"partials every {srv.partial_step_s:.2f} s of audio, from {srv.partial_min_s:.2f} s")

    def health(conn, req):
        if req.path.split("?")[0].rstrip("/").endswith("/health"):
            body = json.dumps({"ok": True, "engine": engine.name, "model": engine.model,
                               "speaker": verifier.order if verifier else False}).encode()
            return Response(HTTPStatus.OK, "OK", Headers({"content-type": "application/json",
                                                         "access-control-allow-origin": "*"}), body)
        return None

    async with serve(srv.handler, a.host, a.port, origins=ORIGINS + a.origin,
                     process_request=health, max_size=4 * 1024 * 1024):
        public = await start_public(serve, gate, srv, port) if gate else None
        peer = await start_peer(serve, peer_gate, srv, a.peer_port) if peer_gate else None
        log(f"listening on ws://{a.host}:{a.port}")
        if a.tailnet:
            tailnet(a.tailnet, a.port, True)
            log(f"tailnet: {a.tailnet} (tailscale serve, tailnet only)")
        try:
            await asyncio.Future()
        finally:
            if recorder is not None:
                await recorder.close()
            if public:
                public.close()
            if peer:
                peer.close()
            if a.tailnet:
                tailnet(a.tailnet, a.port, False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
