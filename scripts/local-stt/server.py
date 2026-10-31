#!/usr/bin/env python3
"""
Local streaming speech-to-text for the owner's debug-chat mic (docs/local-stt.md).

A WebSocket server on this Mac: the page streams 16 kHz mono PCM while the
owner speaks and gets partial transcripts back as he talks, then the final one
the moment the VAD ends the utterance. It is reached over the tailnet only
(`tailscale serve`, never funnel), from lianki.com pages that carry
`localStorage["lk:debug-local-stt"]`; anything else falls back to
/api/debug/stt.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/server.py \
        [--port 5193] [--engine sensevoice|mlx-whisper] [--tailnet /lianki-stt]

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

    async def handler(self, ws):
        peer = ws.request.headers.get("origin", "?")
        log(f"page attached ({peer})")
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
            log(f"page detached ({peer})")


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
    a = ap.parse_args()

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
        log(f"listening on ws://{a.host}:{a.port}")
        if a.tailnet:
            tailnet(a.tailnet, a.port, True)
            log(f"tailnet: {a.tailnet} (tailscale serve, tailnet only)")
        try:
            await asyncio.Future()
        finally:
            if a.tailnet:
                tailnet(a.tailnet, a.port, False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
