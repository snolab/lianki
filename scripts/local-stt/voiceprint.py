#!/usr/bin/env python3
"""
The owner's voiceprint: enrolment, storage and "only my voice" verification
for the local STT server (docs/local-stt.md, "Voiceprint"; the thresholds come
from docs/stt-ab.md, "Noise and speaker grid", #394).

- **What is stored:** speaker embeddings only (CAM++ via sherpa-onnx, 192
  floats per sentence read), never the audio unless the owner opted in at
  enrolment. One file per device and model, so ERes2NetV2 can be added per
  device later without touching the CAM++ print.
- **Where:** on this Mac only, `~/.config/lianki-stt/voiceprints/` (dir 0700,
  files 0600, written atomically), next to the STT server. Never the Worker,
  D1, the hub or the repo. `LIANKI_STT_VOICEPRINTS` moves it (the tests).
- **Verification:** each final utterance's embedding against the device's
  print (any device's when this one has none): cosine score, then a decision
  `me | other | unknown` from per-duration bands, with a noise gate (an SNR
  under 10 dB or under 1.5 s of speech is always `unknown`).

The CLI (never touches ~/lianki-voice-clips; it only reads files you name):

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py list
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --device iphone
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --all
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py score a.wav b.wav [--device iphone]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import tempfile
import time
from dataclasses import dataclass

import numpy as np

RATE = 16_000
MODELS_DIR = os.path.expanduser(os.environ.get("LIANKI_STT_MODELS", "~/.cache/lianki-stt/models"))
STORE_DIR = os.path.expanduser(os.environ.get("LIANKI_STT_VOICEPRINTS", "~/.config/lianki-stt/voiceprints"))
#: The Mac's Ed25519 key that signs each final's speaker tag (Attestor); the hub
#: holds only its public half (STT_SPEAKER_PUB) and stores a tag only if it verifies.
ATTEST_KEY = os.path.expanduser(os.environ.get("LIANKI_STT_ATTEST_KEY", "~/.config/lianki-stt/speaker-attest.key"))
FORMAT = 1
#: Per-device generations: a delete bumps them, and an enrolment begun before cannot commit.
GENERATIONS = "generations.json"

#: The noise gate (docs/stt-ab.md: CAM++ rejects 30-100 % of his speech at 0 dB,
#: and 1 s crops are far less reliable): below either, the decision is "unknown".
MIN_SPEECH_S = 1.5
MIN_SNR_DB = 10.0

#: Enrolment: sentences kept at least / at most, and the check on each one.
ENROL_MIN = 10
ENROL_MAX = 20
#: A sentence that scores under this against the others kept so far is not
#: taken (someone else spoke, or the TV): checked once 3 are in.
ENROL_CONSISTENT = 0.2


@dataclass(frozen=True)
class Band:
    """From `min_s` seconds of speech on: `me` at score >= accept, `other` under reject."""

    min_s: float
    accept: float
    reject: float


@dataclass(frozen=True)
class Model:
    name: str
    file: str
    bands: tuple[Band, ...]
    #: Thresholds measured on his own clips (#394) or still to be checked.
    provisional: bool = False


#: The per-duration bands (docs/stt-ab.md, "Noise and speaker grid"). `accept`
#: is #394's threshold for 1 % false accepts over 109 other voices (TTS, real
#: people, a shop PA, voices in the background) at that length: CAM++ 0.278 at
#: 2 s, 0.300 on whole clips (median 3+ s). `reject` is #380's "other" line
#: (0.2), 0.02 lower on short speech, where his own scores spread lower.
#: Between the two: "unknown". The enrolment caveat applies: these came from
#: a 5-fold enrolment on his conversational iPhone clips, not from sentences
#: read aloud on each device. Re-check them on the scores logged after he
#: enrols (the server logs the score and decision of every final, never text).
MODELS: dict[str, Model] = {
    "campp": Model(
        "campp",
        os.path.join("speaker", "campplus_zh_en.onnx"),
        (Band(MIN_SPEECH_S, 0.28, 0.18), Band(3.0, 0.30, 0.20)),
    ),
    # ERes2NetV2 is stronger in noise on the iPhone but needs a per-device
    # enrolment (#394 rejected 85-98 % of his Android clips against an iPhone
    # enrolment). Its bands are #394's 1 % FA points, untested on a real print.
    "eres2netv2": Model(
        "eres2netv2",
        os.path.join("speaker", "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"),
        (Band(MIN_SPEECH_S, 0.34, 0.25), Band(3.0, 0.37, 0.27)),
        provisional=True,
    ),
}

_DEVICE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def valid_device(d: object) -> bool:
    return isinstance(d, str) and bool(_DEVICE.match(d))


# ---------------------------------------------------------------- the noise gate
def speech_stats(audio: np.ndarray) -> tuple[float, float]:
    """
    (seconds of speech, SNR in dB), estimated from 25 ms frames every 10 ms.
    Speech is a frame 6 dB over the floor (the 10th percentile of frame
    power; the VAD's pre-pad and the endpoint's silence are in every final)
    and within 30 dB of the loudest; the noise is the mean power of the other
    frames, and the SNR is (speech - noise) / noise. Cheap (numpy, ~1 ms per
    10 s). Calibrated on his 20 referenced clips under DEMAND restaurant noise
    (docs/local-stt.md, "Voiceprint"): true 20 / 10 / 5 / 0 dB read as a
    median 19.4 / 11.2 / 7.8 / 5.0 dB, so the 10 dB gate holds back 5 dB and
    passes 10 dB.
    """
    x = np.asarray(audio, dtype=np.float32)
    win, hop = 400, 160
    n = 1 + (len(x) - win) // hop if len(x) >= win else 0
    if n <= 0:
        return 0.0, 0.0
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    p = np.mean(x[idx] ** 2, axis=1) + 1e-12
    db = 10 * np.log10(p)
    floor = float(np.percentile(db, 10))
    top = float(np.percentile(db, 95))
    sp = db >= max(floor + 6.0, top - 30.0)
    if not sp.any():
        return 0.0, 0.0
    speech_s = float(sp.sum()) * hop / RATE
    noise = float(p[~sp].mean()) if (~sp).any() else float(p.min())
    snr = float(10 * np.log10(max(float(p[sp].mean()) - noise, 1e-12) / noise))
    return speech_s, snr


def band_for(model: Model, speech_s: float) -> Band | None:
    b = None
    for x in model.bands:
        if speech_s >= x.min_s:
            b = x
    return b


def decide(model: Model, score: float, speech_s: float, snr_db: float) -> tuple[str, str | None]:
    """(decision, reason): "me" | "other" | "unknown", and why it is unknown."""
    if speech_s < MIN_SPEECH_S:
        return "unknown", "short"
    if snr_db < MIN_SNR_DB:
        return "unknown", "noise"
    b = band_for(model, speech_s)
    if b is None:
        return "unknown", "short"
    if score >= b.accept:
        return "me", None
    if score < b.reject:
        return "other", None
    return "unknown", "between"


def unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-10)


# ---------------------------------------------------------------- the store
def path_problem(path: str, want_dir: bool) -> str | None:
    """Why this voiceprint file or folder must not be used, or None: ours, not a link, 0600/0700."""
    try:
        st = os.lstat(path)
    except OSError as e:
        return f"cannot read ({type(e).__name__})"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if want_dir and not stat.S_ISDIR(st.st_mode):
        return "is not a folder"
    if not want_dir and not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    if st.st_uid != os.getuid():
        return "is not owned by this user"
    if st.st_mode & 0o077:
        return "is readable or writable by others"
    return None


class StoreError(Exception):
    pass


class Store:
    """One JSON file per (device, model): `<device>.<model>.json`, 0600, in a 0700 folder."""

    def __init__(self, root: str = STORE_DIR):
        self.root = root

    # -- the folder
    def _ready(self, create: bool) -> bool:
        if not os.path.lexists(self.root):
            if not create:
                return False
            parent = os.path.dirname(self.root)
            os.makedirs(parent, mode=0o700, exist_ok=True)
            os.mkdir(self.root, 0o700)
            os.chmod(self.root, 0o700)  # whatever the umask
        why = path_problem(self.root, want_dir=True)
        if why:
            raise StoreError(f"{self.root} {why}")
        return True

    def _file(self, device: str, model: str) -> str:
        if not valid_device(device) or model not in MODELS:
            raise StoreError("bad device or model")
        return os.path.join(self.root, f"{device}.{model}.json")

    def audio_dir(self, device: str) -> str:
        if not valid_device(device):
            raise StoreError("bad device")
        return os.path.join(self.root, f"{device}.audio")

    # -- reading
    def prints(self) -> list[dict]:
        """Every usable print's summary (no embeddings), and the files skipped with why."""
        out = []
        if not self._ready(create=False):
            return out
        for name in sorted(os.listdir(self.root)):
            m = re.match(r"^([a-z0-9][a-z0-9-]{0,31})\.([a-z0-9]+)\.json$", name)
            if not m or m.group(2) not in MODELS:
                continue
            try:
                p = self.load(m.group(1), m.group(2))
            except StoreError as e:
                print(f"voiceprint skipped: {name} {e}", file=sys.stderr, flush=True)
                continue
            if p:
                out.append({k: p[k] for k in ("device", "model", "n", "created", "updated", "audio", "self")})
        return out

    def load(self, device: str, model: str) -> dict | None:
        if not self._ready(create=False):
            return None
        f = self._file(device, model)
        if not os.path.lexists(f):
            return None
        why = path_problem(f, want_dir=False)
        if why:
            raise StoreError(why)
        try:
            with open(f, encoding="utf-8") as fh:
                p = json.load(fh)
            c = unit(np.array(p["centroid"], dtype=np.float32))
            if p.get("v") != FORMAT or p.get("device") != device or p.get("model") != model or c.ndim != 1:
                raise ValueError("wrong format")
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise StoreError(f"unreadable ({type(e).__name__})") from e
        p["_centroid"] = c
        return p

    # -- writing
    def save(self, device: str, model: str, embeddings: list[np.ndarray], speech_s: list[float],
             audio: bool) -> dict:
        self._ready(create=True)
        f = self._file(device, model)
        E = np.array([unit(e) for e in embeddings], dtype=np.float32)
        c = unit(E.mean(axis=0))
        # Leave-one-out: how each sentence scores against the others (the
        # enrolment's own spread, for re-checking the bands).
        loo = [float(unit(np.delete(E, i, axis=0).mean(axis=0)) @ E[i]) for i in range(len(E))] if len(E) > 1 else []
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        old = None
        try:
            old = self.load(device, model)
        except StoreError:
            pass
        p = {
            "v": FORMAT,
            "device": device,
            "model": model,
            "dim": int(E.shape[1]),
            "n": int(len(E)),
            "created": (old or {}).get("created", now),
            "updated": now,
            "audio": bool(audio),
            "self": {"min": round(min(loo), 3), "median": round(float(np.median(loo)), 3)} if loo else None,
            "speechS": [round(float(s), 2) for s in speech_s],
            "centroid": [round(float(v), 6) for v in c],
            "embeddings": [[round(float(v), 6) for v in e] for e in E],
        }
        write_private(f, json.dumps(p).encode())
        p["_centroid"] = c
        return p

    # -- the lock
    def lock(self):
        """
        An exclusive flock on `<root>/.lock`, shared by the server and the CLI:
        held across a commit's generation check and all its writes, and across
        a delete and its generation bump, so neither interleaves with the other.
        """
        import contextlib
        import fcntl

        @contextlib.contextmanager
        def held():
            self._ready(create=True)
            f = os.path.join(self.root, ".lock")
            fd = os.open(f, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

        return held()

    # -- generations
    def generation(self, device: str) -> int:
        """How many times this device's prints (or, for "*", all prints) were deleted."""
        g = self._generations()
        return int(g.get(device, 0)) if isinstance(g.get(device, 0), int) else 0

    def _generations(self) -> dict:
        if not self._ready(create=False):
            return {}
        f = os.path.join(self.root, GENERATIONS)
        if not os.path.lexists(f):
            return {}
        why = path_problem(f, want_dir=False)
        if why:
            raise StoreError(f"{GENERATIONS} {why}")
        try:
            with open(f, encoding="utf-8") as fh:
                g = json.load(fh)
        except (OSError, ValueError) as e:
            raise StoreError(f"{GENERATIONS} unreadable ({type(e).__name__})") from e
        return g if isinstance(g, dict) else {}

    def bump(self, device: str | None) -> None:
        """A delete: enrolments of this device (None: of every device) begun before it can no longer commit."""
        self._ready(create=True)
        g = self._generations()
        k = "*" if device is None else device
        g[k] = int(g.get(k, 0)) + 1 if isinstance(g.get(k, 0), int) else 1
        write_private(os.path.join(self.root, GENERATIONS), json.dumps(g).encode())

    def delete(self, device: str | None) -> int:
        """
        Remove one device's prints (every model) and its kept audio, or all
        (device None), and bump the generation so a pending enrolment cannot
        save over the delete. Count of files.
        """
        if device is not None and not valid_device(device):
            raise StoreError("bad device")
        self._ready(create=True)
        with self.lock():
            n = self._delete(device)
            self.bump(device)
        return n

    def _delete(self, device: str | None) -> int:
        n = 0
        for name in sorted(os.listdir(self.root)):
            full = os.path.join(self.root, name)
            m = re.match(r"^([a-z0-9][a-z0-9-]{0,31})\.(?:[a-z0-9]+\.json|audio)$", name)
            if not m or (device is not None and m.group(1) != device):
                continue
            if name.endswith(".audio"):
                if os.path.islink(full) or not os.path.isdir(full):
                    os.unlink(full)
                    n += 1
                    continue
                for w in os.listdir(full):
                    os.unlink(os.path.join(full, w))
                    n += 1
                os.rmdir(full)
            else:
                os.unlink(full)
                n += 1
        return n

    def keep_audio(self, device: str, i: int, audio: np.ndarray) -> None:
        """Opt-in only: one enrolment sentence as 16-bit WAV, 0600, in a 0700 folder."""
        self._ready(create=True)
        d = self.audio_dir(device)
        if not os.path.lexists(d):
            os.mkdir(d, 0o700)
            os.chmod(d, 0o700)
        why = path_problem(d, want_dir=True)
        if why:
            raise StoreError(f"{d} {why}")
        write_private(os.path.join(d, f"{i:02d}.wav"), wav_bytes(audio))


def write_private(path: str, data: bytes) -> None:
    """Atomically, as a fresh 0600 file in the same folder (never through a link)."""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if os.path.islink(path):
            os.unlink(path)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def wav_bytes(audio: np.ndarray) -> bytes:
    import struct

    pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


# ---------------------------------------------------------------- the embedders
class Embedder:
    def __init__(self, model: Model, threads: int = 1):
        import sherpa_onnx

        path = os.path.join(MODELS_DIR, model.file)
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=threads)
        if not cfg.validate():
            raise ValueError(f"bad speaker model {path}")
        self.model = model
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def __call__(self, audio: np.ndarray) -> np.ndarray | None:
        st = self.ex.create_stream()
        st.accept_waveform(RATE, np.asarray(audio, dtype=np.float32))
        st.input_finished()
        if not self.ex.is_ready(st):
            return None
        return unit(np.array(self.ex.compute(st), dtype=np.float32))


class FakeEmbedder:
    """
    For tests (scripts/local-stt/test_voiceprint.py, `server.py --speaker fake`):
    no model. The "voice" is the audio's dominant frequency, one of 16 bins of
    100 Hz from 100 Hz: the same bin scores 1, another 0.
    """

    def __call__(self, audio: np.ndarray) -> np.ndarray | None:
        x = np.asarray(audio, dtype=np.float32)
        if len(x) < RATE // 2:
            return None
        f = float(np.argmax(np.abs(np.fft.rfft(x))) * RATE / len(x))
        e = np.zeros(16, dtype=np.float32)
        e[int(np.clip((f - 100) // 100, 0, 15))] = 1.0
        return e


class Verifier:
    """
    The server's side: the embedders (loaded once), the store, and the scoring
    of a final. `models` in order of preference: for each device the first
    model that has a print is used.
    """

    def __init__(self, store: Store, models: list[str], threads: int = 1, embedders: dict | None = None):
        self.store = store
        self.embedders: dict[str, object] = {}
        if embedders is not None:
            self.embedders = embedders
        else:
            for name in models:
                self.embedders[name] = Embedder(MODELS[name], threads)
        self.order = [m for m in models if m in self.embedders]
        #: (device, model) -> print, read from disk once and after each change.
        self._cache: dict[tuple[str, str], dict | None] = {}
        self._listed: list[dict] | None = None
        #: The folder's mtime when the cache was filled: a print saved, or deleted
        #: by the CLI while the server runs, changes it, so the next final sees it.
        self._stamp: int | None = -1

    def refresh(self) -> None:
        self._cache.clear()
        self._listed = None
        self._stamp = -1

    def _check(self) -> None:
        try:
            stamp: int | None = os.stat(self.store.root).st_mtime_ns
        except OSError:
            stamp = None
        if stamp != self._stamp:
            self._cache.clear()
            self._listed = None
            self._stamp = stamp

    def _print(self, device: str, model: str) -> dict | None:
        k = (device, model)
        if k not in self._cache:
            try:
                self._cache[k] = self.store.load(device, model)
            except StoreError as e:
                print(f"voiceprint {device}.{model} not used: {e}", file=sys.stderr, flush=True)
                self._cache[k] = None
        return self._cache[k]

    def _all(self) -> list[dict]:
        if self._listed is None:
            try:
                self._listed = self.store.prints()
            except StoreError as e:
                print(f"voiceprints not used: {e}", file=sys.stderr, flush=True)
                self._listed = []
        return self._listed

    def status(self) -> list[dict]:
        self._check()
        return list(self._all())

    def pick(self, device: str | None) -> tuple[str, list[str]] | None:
        """(model, the devices whose prints to score against), or None when nothing is enrolled."""
        self._check()
        listed = self._all()
        for model in self.order:
            if device and valid_device(device) and self._print(device, model):
                return model, [device]
            others = sorted({p["device"] for p in listed if p["model"] == model})
            if others:
                return model, others
        return None

    def embed(self, model: str, audio: np.ndarray) -> np.ndarray | None:
        return self.embedders[model](audio)

    def verify(self, audio: np.ndarray, device: str | None) -> dict:
        """{score, decision, model, device, speechS, snrDb[, reason]} for one final."""
        speech_s, snr = speech_stats(audio)
        base = {"speechS": round(speech_s, 2), "snrDb": round(snr, 1)}
        picked = self.pick(device)
        if not picked:
            return {"decision": "unknown", "reason": "no-print", "model": self.order[0] if self.order else None,
                    "device": None, "score": None, **base}
        model, devices = picked
        e = self.embed(model, audio) if speech_s > 0 else None
        if e is None:
            return {"decision": "unknown", "reason": "short", "model": model, "device": devices[0], "score": None, **base}
        best, who = -1.0, devices[0]
        for d in devices:
            p = self._print(d, model)
            if p is None:
                continue
            s = float(e @ p["_centroid"])
            if s > best:
                best, who = s, d
        decision, reason = decide(MODELS[model], best, speech_s, snr)
        out = {"score": round(best, 3), "decision": decision, "model": model, "device": who, **base}
        if reason:
            out["reason"] = reason
        if MODELS[model].provisional:
            out["provisional"] = True
        return out


class Enrolment:
    """
    One enrolment on one socket: sentences are added one by one (each checked
    for length, noise and consistency), and saved only on commit. Nothing is
    written before commit, except the opted-in audio, which goes to its own
    folder at commit too.
    """

    def __init__(self, verifier: Verifier, device: str, keep_audio: bool):
        if not valid_device(device):
            raise StoreError("bad device")
        self.v = verifier
        self.device = device
        self.keep_audio = keep_audio
        #: The generations when it began: a delete since (server or CLI) makes commit refuse.
        self.gen = (verifier.store.generation(device), verifier.store.generation("*"))
        #: Dropped by a delete on this server: sentences still queued are not kept.
        self.dropped = False
        self.embs: dict[str, list[np.ndarray]] = {m: [] for m in verifier.order}
        self.speech: list[float] = []
        self.audio: list[np.ndarray] = []

    @property
    def n(self) -> int:
        return len(self.speech)

    def add(self, audio: np.ndarray) -> dict:
        speech_s, snr = speech_stats(audio)
        res = {"speechS": round(speech_s, 2), "snrDb": round(snr, 1)}
        if self.dropped:
            return {"ok": False, "reason": "dropped", "n": self.n, **res}
        if self.n >= ENROL_MAX:
            return {"ok": False, "reason": "full", "n": self.n, **res}
        if speech_s < MIN_SPEECH_S:
            return {"ok": False, "reason": "short", "n": self.n, **res}
        if snr < MIN_SNR_DB:
            return {"ok": False, "reason": "noise", "n": self.n, **res}
        es = {}
        for m in self.v.order:
            e = self.v.embed(m, audio)
            if e is None:
                return {"ok": False, "reason": "short", "n": self.n, **res}
            es[m] = e
        first = self.v.order[0]
        if len(self.embs[first]) >= 3:
            c = unit(np.mean(self.embs[first], axis=0))
            s = float(es[first] @ c)
            if s < ENROL_CONSISTENT:
                return {"ok": False, "reason": "mismatch", "n": self.n, "score": round(s, 3), **res}
        for m, e in es.items():
            self.embs[m].append(e)
        self.speech.append(speech_s)
        if self.keep_audio:
            self.audio.append(np.asarray(audio, dtype=np.float32).copy())
        return {"ok": True, "n": self.n, **res}

    def stale(self) -> bool:
        st = self.v.store
        return self.dropped or self.gen != (st.generation(self.device), st.generation("*"))

    def commit(self) -> dict:
        if self.n < ENROL_MIN:
            raise StoreError(f"need {ENROL_MIN} sentences, have {self.n}")
        # Check and write under the store's lock: a delete (another process too)
        # either finished before (stale: refused) or waits until this is written.
        with self.v.store.lock():
            if self.stale():
                self.dropped = True
                raise StoreError("the voiceprint was deleted meanwhile: enrol again")
            return self._write()

    def _write(self) -> dict:
        saved = {}
        for m in self.v.order:
            p = self.v.store.save(self.device, m, self.embs[m], self.speech, self.keep_audio)
            saved[m] = p["self"]
        if self.keep_audio:
            for i, a in enumerate(self.audio):
                self.v.store.keep_audio(self.device, i, a)
        self.v.refresh()
        return {"n": self.n, "models": list(saved), "self": saved[self.v.order[0]]}


# ---------------------------------------------------------------- the attestation
def _b64url(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


class Attestor:
    """
    Signs each final's speaker tag with an Ed25519 key that lives only on this
    Mac (ATTEST_KEY, 0600 in a 0700 folder, made on first use). The hub knows
    only the public key (the lianki-push secret STT_SPEAKER_PUB) and stores a
    tag only when this signature verifies and the signed text matches the line
    (lib/speaker-proof.ts). Wire form: `<payload b64url>.<signature b64url>`,
    the signature over the ASCII of the first part; payload
    `{v:1, uid, at, text, decision, score, model, device, speechS, snrDb[, reason]}`.
    """

    def __init__(self, path: str = ATTEST_KEY, create: bool = True):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        if not os.path.lexists(path):
            if not create:
                raise StoreError(f"no attestation key at {path} (voiceprint.py attest-key makes one)")
            d = os.path.dirname(path)
            if not os.path.lexists(d):
                os.makedirs(d, mode=0o700, exist_ok=True)
                os.chmod(d, 0o700)
            k = Ed25519PrivateKey.generate()
            from cryptography.hazmat.primitives import serialization as ser

            raw = k.private_bytes(ser.Encoding.Raw, ser.PrivateFormat.Raw, ser.NoEncryption())
            write_private(path, (_b64url(raw) + "\n").encode("ascii"))
        why = path_problem(path, want_dir=False)
        if why:
            raise StoreError(f"the attestation key {why}")
        import base64

        with open(path, encoding="ascii") as fh:
            t = fh.read().strip()
        raw = base64.urlsafe_b64decode(t + "=" * (-len(t) % 4))
        if len(raw) != 32:
            raise StoreError("the attestation key is not an Ed25519 key")
        self.key = Ed25519PrivateKey.from_private_bytes(raw)

    def public(self) -> str:
        from cryptography.hazmat.primitives import serialization as ser

        return _b64url(self.key.public_key().public_bytes(ser.Encoding.Raw, ser.PublicFormat.Raw))

    def sign(self, tag: dict, text: str, at_ms: int | None = None, uid: str | None = None,
             thread: str | None = None) -> str:
        """`uid`: the page's id for this utterance; `thread`: the hub thread its socket said (hello)."""
        payload = {
            "v": 1,
            "uid": uid or _b64url(os.urandom(12)),
            **({"thread": thread} if thread else {}),
            "at": int(at_ms if at_ms is not None else time.time() * 1000),
            "text": text[:2000],
            **{k: tag[k] for k in ("decision", "score", "model", "device", "speechS", "snrDb", "reason") if k in tag},
        }
        body = _b64url(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        return f"{body}.{_b64url(self.key.sign(body.encode('ascii')))}"


# ---------------------------------------------------------------- the CLI
def load_wav(path: str) -> np.ndarray:
    import soundfile as sf

    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != RATE:
        n = int(round(len(x) * RATE / sr))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="The owner's voiceprint on this Mac (docs/local-stt.md, 'Voiceprint').")
    ap.add_argument("--store", default=STORE_DIR)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="the prints kept (no embeddings shown)")
    d = sub.add_parser("delete", help="delete a device's voiceprint (every model, and any kept enrolment audio)")
    g = d.add_mutually_exclusive_group(required=True)
    g.add_argument("--device")
    g.add_argument("--all", action="store_true")
    s = sub.add_parser("score", help="score WAV files against the stored print (read-only)")
    s.add_argument("wavs", nargs="+")
    s.add_argument("--device", default=None)
    s.add_argument("--models", default="campp")
    sub.add_parser("attest-key", help="print the public key the hub needs (STT_SPEAKER_PUB); makes the key if missing")
    a = ap.parse_args(argv)
    store = Store(a.store)
    try:
        if a.cmd == "list":
            ps = store.prints()
            if not ps:
                print(f"no voiceprint in {a.store}")
            for p in ps:
                print(f"{p['device']}\t{p['model']}\t{p['n']} sentences\tupdated {p['updated']}"
                      f"\taudio kept: {'yes' if p['audio'] else 'no'}\tself {p['self']}")
            return 0
        if a.cmd == "delete":
            if a.device is not None and not valid_device(a.device):
                print("bad device name", file=sys.stderr)
                return 2
            n = store.delete(None if a.all else a.device)
            print(f"deleted {n} file(s) from {a.store}")
            return 0
        if a.cmd == "attest-key":
            print(Attestor().public())
            return 0
        if a.cmd == "score":
            v = Verifier(store, [m for m in a.models.split(",") if m])
            for w in a.wavs:
                x = load_wav(w)
                t0 = time.perf_counter()
                r = v.verify(x, a.device)
                r["ms"] = round((time.perf_counter() - t0) * 1000, 1)
                print(os.path.basename(w), json.dumps(r))
            return 0
    except StoreError as e:
        print(f"voiceprint: {e}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
