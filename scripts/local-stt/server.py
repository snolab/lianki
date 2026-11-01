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
  server → client  {"t":"ready","engine":…,"model":…}
                   {"t":"partial","id":N,"text":…,"audioMs":…}
                   {"t":"final","id":N,"text":…,"lang":…,"model":…,"ms":decode ms,
                    "audioMs":…,"endToFinalMs":…[,"langAuto":…]}
                   (langAuto: on a short utterance whose auto-detected language
                   lost to a forced ja/zh reading; engines.LangPicker)
                   {"t":"error","id":N,"error":…}

The voiceprint (voiceprint.py; docs/local-stt.md, "Voiceprint"):

  client → server  {"t":"hello","device":D}                 which device's print to score against
                   {"t":"begin","id":N,"enrol":true}         an enrolment sentence (not scored)
                   {"t":"end","id":N,"textFrom":S}           decode the text from sample S on (after
                                                             "Linky"); the speaker check hears it all
                   {"t":"enrol","op":"start","rid":R,"device":D,"consent":true,"keepAudio":false}
                   {"t":"enrol","op":"commit"|"cancel","rid":R}
                   {"t":"voiceprint","op":"status","rid":R}
                   {"t":"voiceprint","op":"delete","rid":R,"device":D|"*"}
  server → client  ready gains "speaker":{"models":[…]} when the check is on
                   final gains "speaker":{score,decision:"me"|"other"|"unknown",model,device,
                    speechS,snrDb[,reason]}, or on an enrolment sentence "enrol":{ok,n[,reason],…}
                   {"t":"enrol"|"voiceprint","rid":R,"ok":…[,"error"]…}

GET /health answers {"ok":true,"engine":…,"speaker":[models]|false} (the same port, plain HTTP).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
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
from ticket import SUBPROTOCOL, VOICEPRINT_AUD, Tickets, file_problem, load_public_key, offered  # noqa: E402
import voiceprint as VP  # noqa: E402

#: A partial every this much new audio…
PARTIAL_STEP_S = 0.4
#: …once the utterance is this long.
PARTIAL_MIN_S = 0.3
#: Longest utterance kept (the mic cuts at 30 s).
MAX_S = 40
#: An enrolment not saved or cancelled within this long is dropped.
ENROL_TTL_S = 30 * 60

ORIGINS = [
    "https://lianki.com",
    "https://www.lianki.com",
    "http://localhost:3000",
    "http://localhost:5180",
    "http://localhost:5190",
]
#: The tunnel listener: lianki.com pages only (never localhost: nothing local comes through it).
PUBLIC_ORIGINS = ["https://lianki.com", "https://www.lianki.com"]
#: Sockets open at once on the tunnel listener (the page's race opens one; a second page, one more).
MAX_PUBLIC = 2
#: Where tunnel.sh turns the tunnel listener on and off, so the oxmgr entry never changes.
PUBLIC_CONFIG = os.path.expanduser("~/.config/lianki-stt/public.json")
DEFAULT_PUBKEY = os.path.expanduser("~/.config/lianki-stt/ticket.pub")


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
        self.first_partial_ms: int | None = None
        #: An enrolment sentence (the enrolment's id): its embedding joins it, nothing is scored.
        self.enrol: str | None = None
        #: The text is decoded from this sample on (the words after "Linky").
        self.text_from = 0

    def audio(self) -> np.ndarray:
        parts = ([self.pre] if self.pre is not None else []) + self.chunks
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def pcm(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0


class Server:
    def __init__(self, engine, workers: int = 2, verifier: "VP.Verifier | None" = None,
                 vp_tickets: "Tickets | None" = None, attestor: "VP.Attestor | None" = None):
        self.engine = engine
        self.pool = ThreadPoolExecutor(max_workers=workers)
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
        #: Open enrolments by id (the start answer's `enrolment`), and when each began.
        self.enrolments: dict[str, "VP.Enrolment"] = {}
        self.enrol_at: dict[str, float] = {}

    async def verify(self, audio: np.ndarray, device: str | None):
        if not self.verifier:
            return None
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.spk_pool, self.verifier.verify, audio, device)

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
        ("enrol", "start"): lambda m: {"op": "enrol", "device": m.get("device"), "uv": True},
        ("voiceprint", "delete"): lambda m: {"op": "delete", "device": m.get("device"), "uv": True},
    }

    async def control(self, m: dict) -> dict:
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
                return {**out, "ok": True, **res}
            if t == "voiceprint" and op == "status":
                prints = await loop.run_in_executor(self.spk_pool, v.status)
                return {**out, "ok": True, "prints": prints, "models": v.order}
            if t == "voiceprint" and op == "delete":
                device = m.get("device")
                if device != "*" and not VP.valid_device(device):
                    return {**out, "ok": False, "error": "bad device"}
                who = None if device == "*" else device
                dropped = self._drop_enrolments(who)  # before the delete: queued sentences see it
                n = await loop.run_in_executor(self.spk_pool, v.store.delete, who)
                v.refresh()
                log(f"voiceprint deleted ({device}, {n} files, {dropped} open enrolment(s) dropped)")
                return {**out, "ok": True, "deleted": n}
        except VP.StoreError as e:
            if t == "enrol" and op == "commit" and isinstance(eid, str):
                self.enrolments.pop(eid, None)
                self.enrol_at.pop(eid, None)
            log(f"voiceprint {op} failed: {e}")
            return {**out, "ok": False, "error": str(e)[:200]}
        return {**out, "ok": False, "error": "unknown request"}

    async def decode(self, audio: np.ndarray):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, self.engine.transcribe, audio)

    async def decode_final(self, audio: np.ndarray):
        """(text, lang, the auto language it replaced or None): engines with a final pass use it."""
        fin = getattr(self.engine, "final", None)
        if fin is None:
            return (*(await self.decode(audio)), None)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, fin, audio)

    async def handler(self, ws, via: str = "tailnet"):
        peer = ws.request.headers.get("origin", "?")
        log(f"page attached ({peer}, {via})")
        cur: Utterance | None = None
        #: This socket's device (hello): whose print its finals are scored against.
        conn: dict = {"device": None}

        async def send(obj):
            try:
                await ws.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                pass

        async def partial(u: Utterance):
            u.partial_busy = True
            try:
                text, _lang = await self.decode(u.audio())
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

        async def final(u: Utterance):
            t0 = time.perf_counter()
            audio = u.audio()
            heard = audio[u.text_from:] if u.text_from > 0 else audio
            enrol = self.enrolments.get(u.enrol) if u.enrol else None

            async def text_of():
                if len(heard) < RATE // 10:  # a bare "Linky": nothing after it to read
                    return "", "", None
                return await self.decode_final(heard)

            # The speaker check runs beside the decode (its own thread), on the whole utterance.
            side = self.enrol_add(enrol, audio) if enrol else self.verify(audio, conn["device"])
            res = await asyncio.gather(text_of(), side, return_exceptions=True)
            if isinstance(res[0], BaseException):
                await send({"t": "error", "id": u.id, "error": str(res[0])[:200]})
                return
            text, lang, auto_lang = res[0]
            spk = None if isinstance(res[1], BaseException) else res[1]
            if isinstance(res[1], BaseException):
                log(f"speaker check failed: {type(res[1]).__name__}: {res[1]}")
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
            }
            if auto_lang:
                msg["langAuto"] = auto_lang  # what auto-detect said before the short-utterance pick
            tag = ""
            if enrol and spk is not None:
                msg["enrol"] = spk
                tag = f", enrol {'ok' if spk.get('ok') else spk.get('reason')} ({spk.get('n')})"
            elif u.enrol:
                msg["enrol"] = {"ok": False, "reason": "no-enrolment", "n": 0}
            elif spk is not None:
                msg["speaker"] = spk
                if self.attestor:
                    # Signed for the hub: only a tag that verifies, over this text, is kept on a line.
                    msg["speakerProof"] = self.attestor.sign(spk, text)
                d = spk["decision"]
                self.counts[d] = self.counts.get(d, 0) + 1
                sc = "-" if spk.get("score") is None else f"{spk['score']:.3f}"
                why = f" {spk['reason']}" if spk.get("reason") else ""
                c = self.counts
                tag = f", spk {d} {sc}{why} (me {c['me']} other {c['other']} unknown {c['unknown']})"
            await send(msg)
            picked = f", lang {auto_lang}->{lang}" if auto_lang else ""
            log(f"final #{u.id}: {len(audio) / RATE:.1f}s audio, decode {ms} ms, {len(text)} chars{picked}{tag}")

        ready = {"t": "ready", "engine": self.engine.name, "model": self.engine.model}
        if self.verifier:
            ready["speaker"] = {"models": self.verifier.order}
        await send(ready)
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    if not msg or cur is None or cur.done:
                        continue
                    tag, body = msg[0], msg[1:]
                    if tag == 1:
                        if cur.n >= MAX_S * RATE:
                            continue
                        x = pcm(body)
                        cur.chunks.append(x)
                        cur.n += len(x)
                        if (
                            not cur.partial_busy
                            and cur.n >= PARTIAL_MIN_S * RATE
                            and cur.n - cur.last_partial >= PARTIAL_STEP_S * RATE
                        ):
                            cur.last_partial = cur.n
                            asyncio.create_task(partial(cur))
                    elif tag == 2:
                        cur.pre = pcm(body)
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
                    e = m.get("enrol")
                    cur.enrol = e if isinstance(e, str) and 0 < len(e) <= 64 else None
                elif t == "end" and cur is not None and cur.id == uid and not cur.done:
                    cur.done = True
                    tf = m.get("textFrom")
                    if isinstance(tf, int) and not isinstance(tf, bool) and tf > 0:
                        cur.text_from = tf
                    asyncio.create_task(final(cur))
                elif t == "hello":
                    d = m.get("device")
                    conn["device"] = d if VP.valid_device(d) else None
                elif t in ("enrol", "voiceprint"):
                    await send(await self.control(m))
                elif t == "cancel" and cur is not None and cur.id == uid:
                    cur.done = True
                    cur = None
                elif t == "ping":
                    await send({"t": "pong"})
        except ConnectionClosed:
            pass  # the page went away (reload, backgrounded): no close frame from iOS
        finally:
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


def load_verifier(models: str, root: str):
    """The speaker check, or None (logged) when it is off or its model is missing: never fatal."""
    names = [m for m in (models or "").split(",") if m and m != "0"]
    if not names:
        log("speaker check off")
        return None
    if names == ["fake"]:  # the tests: no model (voiceprint.FakeEmbedder)
        log(f"speaker check on (fake, {root})")
        return VP.Verifier(VP.Store(root), ["campp"], embedders={"campp": VP.FakeEmbedder()})
    bad = [m for m in names if m not in VP.MODELS]
    if bad:
        log(f"speaker check off: unknown model {','.join(bad)}")
        return None
    try:
        t0 = time.perf_counter()
        v = VP.Verifier(VP.Store(root), names)
        v.embed(v.order[0], np.full(RATE, 1e-3, dtype=np.float32))  # warm up
        n = len(v.status())
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
    ap.add_argument("--speaker", default=os.environ.get("LIANKI_STT_SPEAKER", "campp"),
                    help='speaker check models in order ("campp", "campp,eres2netv2"); "" or 0 = off')
    ap.add_argument("--voiceprints", default=VP.STORE_DIR, help="where the voiceprints are kept (0700)")
    ap.add_argument("--voiceprint-pubkey", default=None,
                    help=f"the Ed25519 key voiceprint tickets are checked with (default: the ticket key, {DEFAULT_PUBKEY})")
    ap.add_argument("--attest-key", default=VP.ATTEST_KEY, help='signs speaker tags for the hub; "" = no proofs')
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
    verifier = load_verifier(a.speaker, a.voiceprints)
    vp_tickets, attestor = None, None
    if verifier:
        vk = a.voiceprint_pubkey or pubkey or DEFAULT_PUBKEY
        try:
            vp_tickets = Tickets(load_public_key(vk), aud=VOICEPRINT_AUD)
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
    srv = Server(engine, verifier=verifier, vp_tickets=vp_tickets, attestor=attestor)

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
        log(f"listening on ws://{a.host}:{a.port}")
        if a.tailnet:
            tailnet(a.tailnet, a.port, True)
            log(f"tailnet: {a.tailnet} (tailscale serve, tailnet only)")
        try:
            await asyncio.Future()
        finally:
            if public:
                public.close()
            if a.tailnet:
                tailnet(a.tailnet, a.port, False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
