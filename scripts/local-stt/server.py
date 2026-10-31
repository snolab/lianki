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

GET /health answers {"ok":true,"engine":…} (the same port, plain HTTP).
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
from ticket import SUBPROTOCOL, Tickets, file_problem, load_public_key, offered  # noqa: E402

#: A partial every this much new audio…
PARTIAL_STEP_S = 0.4
#: …once the utterance is this long.
PARTIAL_MIN_S = 0.3
#: Longest utterance kept (the mic cuts at 30 s).
MAX_S = 40

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

    def audio(self) -> np.ndarray:
        parts = ([self.pre] if self.pre is not None else []) + self.chunks
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def pcm(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0


class Server:
    def __init__(self, engine, workers: int = 2):
        self.engine = engine
        self.pool = ThreadPoolExecutor(max_workers=workers)

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
            try:
                text, lang, auto_lang = await self.decode_final(audio)
            except Exception as e:
                await send({"t": "error", "id": u.id, "error": str(e)[:200]})
                return
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
            await send(msg)
            picked = f", lang {auto_lang}->{lang}" if auto_lang else ""
            log(f"final #{u.id}: {len(audio) / RATE:.1f}s audio, decode {ms} ms, {len(text)} chars{picked}")

        await send({"t": "ready", "engine": self.engine.name, "model": self.engine.model})
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
                t, uid = m.get("t"), m.get("id")
                if t == "begin" and isinstance(uid, int):
                    if cur is not None:
                        cur.done = True
                    cur = Utterance(uid)
                elif t == "end" and cur is not None and cur.id == uid and not cur.done:
                    cur.done = True
                    asyncio.create_task(final(cur))
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
    srv = Server(engine)

    def health(conn, req):
        if req.path.split("?")[0].rstrip("/").endswith("/health"):
            body = json.dumps({"ok": True, "engine": engine.name, "model": engine.model}).encode()
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
