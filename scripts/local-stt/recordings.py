"""Explicit opt-in VAD recording: private WAV segments with a capture-time TTL."""
from __future__ import annotations

import asyncio
import os
import re
import stat
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

RATE = 16000
TTL_S = 24 * 60 * 60
NAME = re.compile(r"stt-(\d{19})-[0-9a-f]{32}\.wav\Z")


class RecordingStore:
    """Only this module's names in one explicitly configured private directory."""

    def __init__(self, directory: str, ttl: int = TTL_S, clock=time.time):
        if not 0 < ttl <= TTL_S:
            raise ValueError("recording TTL must be within (0, 86400]")
        self.root = Path(directory).expanduser().absolute()
        self.ttl = ttl
        self.clock = clock
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._check_root()

    def _check_root(self):
        info = self.root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise ValueError("recording directory must be private, owned, and not a symlink")

    def prune(self) -> int:
        self._check_root()
        cutoff = self.clock() - self.ttl
        n = 0
        for path in self.root.iterdir():
            match = NAME.fullmatch(path.name)
            if not match or int(match[1]) / 1e9 > cutoff:
                continue
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
                path.unlink()
                n += 1
        return n

    def write(self, audio: np.ndarray, captured_at: float) -> str | None:
        self.prune()
        if not len(audio) or captured_at + self.ttl <= self.clock():
            return None
        if not np.isfinite(captured_at) or captured_at > self.clock() + 1:
            raise ValueError("invalid capture time")
        name = f"stt-{int(captured_at * 1e9):019d}-{uuid.uuid4().hex}.wav"
        path = self.root / name
        # Exclusive creation + 0600, including when the caller has a permissive umask.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as output:
                with wave.open(output, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(RATE)
                    pcm = np.rint(np.clip(audio, -1, 32767 / 32768) * 32768).astype('<i2')
                    wav.writeframes(pcm.tobytes())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return name


class RecordingWorker:
    """Bounded, nonblocking admission; disk work and idle pruning use one thread."""

    def __init__(self, store: RecordingStore, log, capacity: int = 4, cleanup_s: float = 30):
        if capacity < 1 or not 0 < cleanup_s <= 60:
            raise ValueError("invalid recording worker settings")
        self.store = store
        self.log = log
        self.queue = asyncio.Queue(maxsize=capacity)
        self.cleanup_s = cleanup_s
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.task = None
        self.saved = self.dropped = self.errors = 0
        self.closed = False

    async def start(self):
        await asyncio.get_running_loop().run_in_executor(self.pool, self.store.prune)
        self.task = asyncio.create_task(self._run())

    def submit(self, audio: np.ndarray, captured_at: float) -> bool:
        if self.closed or self.task is None:
            return False
        try:
            self.queue.put_nowait((audio, captured_at))
            return True
        except asyncio.QueueFull:
            self.dropped += 1
            self.log("recording dropped: queue full")
            return False

    async def _run(self):
        loop = asyncio.get_running_loop()
        while True:
            item = None
            try:
                try:
                    item = await asyncio.wait_for(self.queue.get(), timeout=self.cleanup_s)
                except asyncio.TimeoutError:
                    await loop.run_in_executor(self.pool, self.store.prune)
                    continue
                if item is False:
                    return
                audio, captured_at = item
                name = await loop.run_in_executor(self.pool, self.store.write, audio, captured_at)
                self.saved += int(name is not None)
            except Exception as error:
                self.errors += 1
                self.log(f"recording failed: {type(error).__name__}")
            finally:
                if item is not None:
                    self.queue.task_done()

    async def close(self):
        self.closed = True
        if self.task is not None:
            await self.queue.put(False)
            await self.task
            self.task = None
        self.pool.shutdown(wait=True)
