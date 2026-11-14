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
  files 0600, written atomically), next to the STT server; never the hub or
  the repo. A copy of the features (never audio) goes to the owner's own
  Lianki account only when he taps "Save to my account" with his passkey
  (`Store.export`, the `export` op), and comes back with `restore`.
  `LIANKI_STT_VOICEPRINTS` moves it (the tests).
- **Verification:** each final utterance's embedding against the device's
  print (any device's when this one has none): cosine score, then a decision
  `me | other | unknown` from per-duration bands, with a noise gate (an SNR
  under 10 dB or under 1.5 s of speech is always `unknown`).
- **Progressive learning** (off until he turns it on with his passkey):
  a final that is confidently him, long and clean adds its embedding to this
  device's print (`Verifier.learn`, the PROG_* constants); never its audio.
- **Other voices** (docs/voice-mode.md, "Speaker avatars"): a final that is
  `other` is matched against the voices heard lately (`Voices`, in memory
  only), so each gets a stable id `s1`, `s2`… next to the score (`voice`),
  and his own finals `me`. Nothing of theirs is stored.

The CLI (never touches ~/lianki-voice-clips; it only reads files you name):

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py list
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --device iphone
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete --all            # the prints; recordings stay
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py delete-audio --all      # only the kept recordings
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py score a.wav b.wav [--device iphone]
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint.py progressive [on|off]   # learning from his finals
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

#: A "me" final is also scored in windows this long, this far apart: two
#: speakers in one final (owner, 2026-11-13: half his wife, half him, all ✓)
#: average to a passing score over the whole. A window that is clearly
#: someone else turns the final "unknown" ("mixed"); its score is unchanged.
WINDOW_S = 2.5
WINDOW_HOP_S = 1.25

#: Enrolment: sentences kept at least / at most, and the check on each one.
ENROL_MIN = 10
ENROL_MAX = 20
#: A sentence that scores under this against the others kept so far is not
#: taken (someone else spoke, or the TV): checked once 3 are in.
ENROL_CONSISTENT = 0.2


def _env_num(name: str, default: float) -> float:
    """A threshold from LIANKI_STT_<name> when set to a number, else its default."""
    raw = os.environ.get(f"LIANKI_STT_{name}")
    try:
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


#: Progressive voiceprint (docs/local-stt.md, "Progressive voiceprint"; owner,
#: 2026-11-14 ~04:00 JST: "no need to actively enrol; if a sentence is clean,
#: just take it"). A final that is confidently him, long and clean adds its
#: embedding (never audio) to this device's print. Off until he turns it on
#: with his passkey (`op: progressive`): the enrolment consent covers only the
#: sentences he reads. Each value can be overridden by LIANKI_STT_<NAME>.
#:
#: The whole-final score must clear the "me" line of its band by this much
#: (CAM++ >= 0.40 on 3 s and more): far over the 1 % false-accept point.
PROG_MARGIN = _env_num("PROG_MARGIN", 0.10)
#: Speech seconds at least: the long band, where the embedding is steadiest.
PROG_MIN_SPEECH_S = _env_num("PROG_MIN_SPEECH_S", 3.0)
#: Read SNR at least (a true SNR of about 20 dB; the gate is 10). Higher than
#: the gate also because the Mac cannot know when Li is reading aloud: the
#: mic stays open with echo cancellation, so her voice under his would lower
#: the SNR (and the windows below would see it).
PROG_MIN_SNR_DB = _env_num("PROG_MIN_SNR_DB", 20.0)
#: A sample is also checked against THIS device's own print (or its pending
#: samples, from 3 on): at least its band's "me" line plus this. Matters when
#: another device's print vouched for it; a far sample there is an outlier.
PROG_OUTLIER_MARGIN = _env_num("PROG_OUTLIER_MARGIN", 0.05)
#: One sample per device per this many seconds at most: a long chat in one
#: room cannot fill the print with that room.
PROG_EVERY_S = _env_num("PROG_EVERY_S", 60.0)
#: Samples a device's print holds at most (per model), enrolment included.
#: Full: the oldest progressive sample goes (enrolment samples never do).
PRINT_MAX = int(_env_num("PRINT_MAX", 200))
#: Samples before a print grown from nothing is used: the enrolment minimum.
PROG_CREATE_MIN = int(_env_num("PROG_CREATE_MIN", ENROL_MIN))
#: The Mac's progressive switch (0600 in the store): {"on": bool, "updated"}.
PROGRESSIVE = "progressive.json"
#: Where a device's samples wait until there are PROG_CREATE_MIN of them.
PENDING = "pending"

#: Other voices (Voices): a final that is "other" whose cosine to a voice heard
#: lately is at least VOICE_SAME is that voice again (the whole-clip "me" line
#: of CAM++: a merge of two strangers costs only an avatar). At most VOICES_MAX
#: voices are kept, the one heard longest ago making room; a voice not heard
#: for VOICE_FORGET_S is forgotten and would get a new id. All in memory: a
#: restart starts again at s1.
VOICE_SAME = _env_num("VOICE_SAME", 0.30)
VOICES_MAX = int(_env_num("VOICES_MAX", 8))
VOICE_FORGET_S = _env_num("VOICE_FORGET_S", 2 * 3600)
#: A voice's centroid is the running mean of its embeddings, the last this many counting.
VOICE_MEAN_N = int(_env_num("VOICE_MEAN_N", 20))


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


@dataclass(frozen=True)
class FilterLine:
    """The voiceprint filter stops a final under `below`, with this much clear speech."""

    below: float
    min_speech_s: float
    min_snr_db: float


#: Measured on his clips (scripts/local-stt/voice-filter-eval.py; docs/local-stt.md, "Only my
#: voice"), and far under `reject`: false rejects are the risk that matters. 2 s of speech and a
#: read 8 dB (about 5 dB true SNR) are as far as his own scores stayed clear of the line.
#: Only models with a measured line filter at all: ERes2NetV2 has none.
FILTER_BELOW: dict[str, FilterLine] = {"campp": FilterLine(0.15, 2.0, 8.0)}

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


def bands_info(order: list[str]) -> dict:
    """The decision's thresholds per loaded model, for the panel's test mode (no secrets: the table in docs/local-stt.md)."""
    return {
        m: {
            "minSpeechS": MIN_SPEECH_S,
            "minSnrDb": MIN_SNR_DB,
            "bands": [{"minS": b.min_s, "me": b.accept, "other": b.reject} for b in MODELS[m].bands],
            **({"provisional": True} if MODELS[m].provisional else {}),
        }
        for m in order
        if m in MODELS
    }


def filter_reason(spk: dict | None, device: str | None) -> str | None:
    """
    Why the voiceprint filter should stop this final, or None: None whenever in
    doubt, since a filter that eats his words is worse than none (docs/local-stt.md,
    "Only my voice"). Only against this device's own print, only a model with a
    measured line, only with enough clear speech to judge. Not a security gate.
    """
    if not spk or spk.get("score") is None or not device or spk.get("device") != device:
        return None
    line = FILTER_BELOW.get(spk.get("model") or "")
    if line is None or spk.get("speechS", 0) < line.min_speech_s or spk.get("snrDb", -99) < line.min_snr_db:
        return None
    return "no-match" if spk["score"] < line.below else None


def filter_pending(spk: dict | None, device: str | None) -> bool:
    """Not enough speech yet to judge against this device's print: partials wait, the final never does."""
    if not spk or not device or spk.get("device") != device:
        return False
    line = FILTER_BELOW.get(spk.get("model") or "")
    return line is not None and spk.get("speechS", 0) < line.min_speech_s


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
                src = p["sources"]
                prog = [t for t, s in zip(p["added"], src) if s == "prog"]
                out.append({**{k: p[k] for k in ("device", "model", "n", "created", "updated", "audio", "self")},
                            "enrolN": src.count("enrol"), "progN": src.count("prog"),
                            "lastAdded": iso(max(prog)) if prog and max(prog) > 0 else None})
        return out

    def pending(self) -> list[dict]:
        """The progressive samples still waiting for PROG_CREATE_MIN (no print yet): counts only."""
        out = []
        if not self._ready(create=False):
            return out
        for name in sorted(os.listdir(self.root)):
            m = re.match(rf"^([a-z0-9][a-z0-9-]{{0,31}})\.([a-z0-9]+)\.{PENDING}\.json$", name)
            if not m or m.group(2) not in MODELS:
                continue
            try:
                q = self.load_pending(m.group(1), m.group(2))
            except StoreError:
                continue
            if q:
                out.append({"device": q["device"], "model": q["model"], "n": len(q["embeddings"]),
                            "need": PROG_CREATE_MIN, "lastAdded": iso(max(q["added"])) if q["added"] else None})
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
        # Where each sample came from, and when it was added (epoch s; 0 = unknown):
        # a print from before progressive learning is all enrolment.
        n = len(p.get("embeddings") or [])
        src, added = p.get("sources"), p.get("added")
        p["sources"] = src if isinstance(src, list) and len(src) == n and set(src) <= set(SOURCES) else ["enrol"] * n
        p["added"] = (added if isinstance(added, list) and len(added) == n
                      and all(isinstance(t, int) and not isinstance(t, bool) for t in added) else [0] * n)
        return p

    # -- progressive learning (docs/local-stt.md, "Progressive voiceprint")
    def _pending_file(self, device: str, model: str) -> str:
        if not valid_device(device) or model not in MODELS:
            raise StoreError("bad device or model")
        return os.path.join(self.root, f"{device}.{model}.{PENDING}.json")

    def load_pending(self, device: str, model: str) -> dict | None:
        """This device's samples waiting to become a print: {device, model, embeddings, speechS, added}."""
        if not self._ready(create=False):
            return None
        f = self._pending_file(device, model)
        if not os.path.lexists(f):
            return None
        why = path_problem(f, want_dir=False)
        if why:
            raise StoreError(why)
        try:
            with open(f, encoding="utf-8") as fh:
                q = json.load(fh)
            E = [unit(np.array(e, dtype=np.float32)) for e in q["embeddings"]]
            if (q.get("v") != FORMAT or q.get("device") != device or q.get("model") != model
                    or len(q["speechS"]) != len(E) or len(q["added"]) != len(E)):
                raise ValueError("wrong format")
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise StoreError(f"unreadable ({type(e).__name__})") from e
        q["_embeddings"] = E
        return q

    def save_pending(self, device: str, model: str, embeddings: list[np.ndarray], speech_s: list[float],
                     added: list[int]) -> None:
        self._ready(create=True)
        q = {"v": FORMAT, "device": device, "model": model,
             "embeddings": [[round(float(v), 6) for v in unit(e)] for e in embeddings],
             "speechS": [round(float(s), 2) for s in speech_s], "added": [int(t) for t in added]}
        write_private(self._pending_file(device, model), json.dumps(q).encode())

    def drop_pending(self, device: str, model: str) -> None:
        f = self._pending_file(device, model)
        if os.path.lexists(f):
            os.unlink(f)

    def progressive(self) -> dict:
        """The Mac's progressive switch: {"on": bool, "updated": str|None}. Off unless he turned it on."""
        off = {"on": False, "updated": None}
        if not self._ready(create=False):
            return off
        f = os.path.join(self.root, PROGRESSIVE)
        if not os.path.lexists(f):
            return off
        if path_problem(f, want_dir=False):
            return off  # a file we cannot trust: off
        try:
            with open(f, encoding="utf-8") as fh:
                s = json.load(fh)
        except (OSError, ValueError):
            return off
        if not isinstance(s, dict) or s.get("on") is not True:
            return {**off, "updated": s.get("updated") if isinstance(s, dict) else None}
        return {"on": True, "updated": s.get("updated")}

    def set_progressive(self, on: bool) -> dict:
        self._ready(create=True)
        s = {"on": bool(on), "updated": iso(time.time())}
        write_private(os.path.join(self.root, PROGRESSIVE), json.dumps(s).encode())
        return s

    # -- writing
    def save(self, device: str, model: str, embeddings: list[np.ndarray], speech_s: list[float],
             audio: bool, created: str | None = None, sources: list[str] | None = None,
             added: list[int] | None = None) -> dict:
        """
        `sources`: "enrol" (read at enrolment, or restored as such) or "prog" (taken by
        progressive learning) per sample, default all "enrol"; `added`: when (epoch s), default now.
        """
        self._ready(create=True)
        f = self._file(device, model)
        if len(embeddings) > PRINT_MAX:
            raise StoreError(f"at most {PRINT_MAX} samples")
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
            "created": created or (old or {}).get("created", now),
            "updated": now,
            "audio": bool(audio),
            "self": {"min": round(min(loo), 3), "median": round(float(np.median(loo)), 3)} if loo else None,
            "speechS": [round(float(s), 2) for s in speech_s],
            "centroid": [round(float(v), 6) for v in c],
            "embeddings": [[round(float(v), 6) for v in e] for e in E],
            "sources": list(sources) if sources is not None else ["enrol"] * len(E),
            "added": [int(t) for t in added] if added is not None else [int(time.time())] * len(E),
        }
        if len(p["sources"]) != len(E) or len(p["added"]) != len(E) or not set(p["sources"]) <= set(SOURCES):
            raise StoreError("bad sources")
        write_private(f, json.dumps(p).encode())
        # A print now: samples still waiting for one have no use any more.
        self.drop_pending(device, model)
        p["_centroid"] = c
        return p

    # -- the account copy (docs/local-stt.md, "Voiceprint in your account")
    def export(self, device: str | None) -> list[dict]:
        """
        The features of one device's prints (None: every device), for the
        owner's Lianki account: exactly EXPORT_KEYS, numbers only. Never the
        `audio` flag, never a kept wav, never a path.
        """
        if device is not None and not valid_device(device):
            raise StoreError("bad device")
        out = []
        for s in self.prints():
            if device is not None and s["device"] != device:
                continue
            p = self.load(s["device"], s["model"])
            if p:
                out.append({k: p[k] for k in EXPORT_KEYS if k in p})
        return out

    def recordings(self, device: str | None) -> list[dict]:
        """
        The kept enrolment recordings (`<device>.audio/NN.wav`, the opt-in
        audio), for his account's My Files: read only, never moved or deleted
        here. Regular private files of ours only (a link or a loose file is
        skipped); at most RECORDINGS_MAX per device and RECORDING_MAX_BYTES each.
        """
        import base64

        if device is not None and not valid_device(device):
            raise StoreError("bad device")
        out: list[dict] = []
        if not self._ready(create=False):
            return out
        created = {s["device"]: s.get("created") for s in self.prints()}
        for name in sorted(os.listdir(self.root)):
            m = re.match(r"^([a-z0-9][a-z0-9-]{0,31})\.audio$", name)
            if not m or (device is not None and m.group(1) != device):
                continue
            d = os.path.join(self.root, name)
            if path_problem(d, want_dir=True):
                print(f"recordings skipped: {name} not private", file=sys.stderr, flush=True)
                continue
            n = 0
            for w in sorted(os.listdir(d)):
                f = os.path.join(d, w)
                if not re.fullmatch(r"\d{2}\.wav", w) or path_problem(f, want_dir=False):
                    continue
                if n >= RECORDINGS_MAX or os.lstat(f).st_size > RECORDING_MAX_BYTES:
                    continue
                with open(f, "rb") as fh:
                    data = fh.read()
                out.append({"device": m.group(1), "name": w, "created": created.get(m.group(1)),
                            "wav": base64.b64encode(data).decode("ascii")})
                n += 1
        return out

    def restore(self, p: object) -> dict:
        """
        Write one print read back from the account (export's form, checked
        strictly: any other key is refused). The centroid and self scores are
        recomputed from the embeddings; the audio flag of a print already here
        stays as it was (restore never touches a kept-audio folder).
        """
        q = check_export(p)
        with self.lock():
            old = None
            try:
                old = self.load(q["device"], q["model"])
            except StoreError:
                pass
            E = [np.array(e, dtype=np.float32) for e in q["embeddings"]]
            # Where each sample came from travels with the features; when it was added does not.
            saved = self.save(q["device"], q["model"], E, q["speechS"], bool((old or {}).get("audio")),
                              created=q.get("created"), sources=q.get("sources"), added=[0] * len(E))
        return {k: saved[k] for k in ("device", "model", "n")}

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

    def delete(self, device: str | None, audio: bool = False) -> int:
        """
        Remove one device's prints (every model), or all (device None), and
        bump the generation so a pending enrolment cannot save over the delete.
        The kept enrolment recordings stay unless `audio` is True: deleting the
        print never deletes them implicitly (owner, 2026-11-11; the panel asks
        separately, `delete_audio`). Count of files. Progressive learning is turned
        off too (its pending samples go with the print): left on, another device's
        print would grow a deleted one back. He turns it on again with his passkey.
        """
        if device is not None and not valid_device(device):
            raise StoreError("bad device")
        self._ready(create=True)
        with self.lock():
            n = self._delete(device, prints=True, audio=audio)
            self.bump(device)
            if self.progressive()["on"]:
                self.set_progressive(False)
        return n

    def delete_audio(self, device: str | None) -> int:
        """Only the kept enrolment recordings (`<device>.audio/`) of one device, or all. Count of files."""
        if device is not None and not valid_device(device):
            raise StoreError("bad device")
        if not self._ready(create=False):
            return 0
        with self.lock():
            return self._delete(device, prints=False, audio=True)

    def audio_count(self, device: str | None = None) -> int:
        """How many kept enrolment recordings there are (one device, or all): a count, nothing read."""
        if not self._ready(create=False):
            return 0
        n = 0
        for name in os.listdir(self.root):
            m = re.match(r"^([a-z0-9][a-z0-9-]{0,31})\.audio$", name)
            if not m or (device is not None and m.group(1) != device):
                continue
            d = os.path.join(self.root, name)
            if path_problem(d, want_dir=True):
                continue
            n += sum(1 for w in os.listdir(d) if re.fullmatch(r"\d{2}\.wav", w))
        return n

    def _delete(self, device: str | None, prints: bool = True, audio: bool = False) -> int:
        n = 0
        for name in sorted(os.listdir(self.root)):
            full = os.path.join(self.root, name)
            m = re.match(r"^([a-z0-9][a-z0-9-]{0,31})\.(?:[a-z0-9]+(?:\.pending)?\.json|audio)$", name)
            if not m or (device is not None and m.group(1) != device):
                continue
            if name.endswith(".audio"):
                if not audio:
                    continue
                if os.path.islink(full) or not os.path.isdir(full):
                    os.unlink(full)
                    n += 1
                    continue
                for w in os.listdir(full):
                    os.unlink(os.path.join(full, w))
                    n += 1
                os.rmdir(full)
            elif prints:
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


#: Kept recordings handed over per device at most, and the largest one (a 30 s sentence is ~1 MB).
RECORDINGS_MAX = 40
RECORDING_MAX_BYTES = 2 * 1024 * 1024

#: What leaves the Mac for the owner's account (lib/voiceprint-cloud.ts PRINT_KEYS): features only.
EXPORT_KEYS = ("device", "model", "dim", "n", "created", "updated", "self", "speechS", "centroid", "embeddings",
               "sources")
#: Where a print's sample came from: read at enrolment, or taken by progressive learning.
SOURCES = ("enrol", "prog")
_REQUIRED = ("device", "model", "dim", "n", "speechS", "centroid", "embeddings")


def check_export(p: object) -> dict:
    """A print in export form, exactly: the keys, the device and model, n x dim finite floats."""
    import math

    if not isinstance(p, dict):
        raise StoreError("not a print")
    extra = [k for k in p if k not in EXPORT_KEYS]
    if extra:
        raise StoreError(f"not features: {', '.join(sorted(map(str, extra))[:3])}")
    for k in _REQUIRED:
        if k not in p:
            raise StoreError(f"missing {k}")
    if not valid_device(p["device"]) or p["model"] not in MODELS:
        raise StoreError("bad device or model")
    dim, n = p["dim"], p["n"]
    if not isinstance(dim, int) or isinstance(dim, bool) or not 1 <= dim <= 1024:
        raise StoreError("bad dim")
    if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= PRINT_MAX:
        raise StoreError("bad n")

    def num(x, lim) -> bool:
        return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and abs(x) <= lim

    def vec(v) -> bool:
        return isinstance(v, list) and len(v) == dim and all(num(x, 4) for x in v)

    if not vec(p["centroid"]):
        raise StoreError("bad centroid")
    E = p["embeddings"]
    if not isinstance(E, list) or len(E) != n or not all(vec(e) for e in E):
        raise StoreError("bad embeddings")
    S = p["speechS"]
    if not isinstance(S, list) or len(S) != n or not all(num(x, 600) and x >= 0 for x in S):
        raise StoreError("bad speechS")
    src = p.get("sources")
    if src is not None and not (isinstance(src, list) and len(src) == n and all(x in SOURCES for x in src)):
        raise StoreError("bad sources")
    for k in ("created", "updated"):
        if p.get(k) is not None and not (isinstance(p[k], str) and len(p[k]) <= 40):
            raise StoreError(f"bad {k}")
    return p


def iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


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


def split_points(windows: list[dict], audio: np.ndarray) -> list[int]:
    """
    Where the speaker changes in a "mixed" final, in samples (owner, 2026-11-13:
    split half his wife, half him into two lines, each with its own tag). The
    windows that decided (me or other; the undecided are skipped) form runs of
    one speaker; each cut is halfway through the overlap between the last
    window of one run and the first of the next (or the gap between them).
    None at all unless every part has MIN_SPEECH_S of speech: too short a part
    could not be told apart again, so the final stays one "mixed" line.
    """
    runs: list[list[dict]] = []
    for w in windows:
        if w["decision"] not in ("me", "other"):
            continue
        if runs and runs[-1][-1]["decision"] == w["decision"]:
            runs[-1].append(w)
        else:
            runs.append([w])
    cuts = [(a[-1]["end"] + b[0]["start"]) // 2 for a, b in zip(runs, runs[1:])]
    edges = [0, *cuts, len(audio)]
    if not cuts or any(speech_stats(audio[x:y])[0] < MIN_SPEECH_S for x, y in zip(edges, edges[1:])):
        return []
    return cuts


class Voices:
    """
    The other voices heard lately, each a running centroid of the embeddings
    that were not him (docs/voice-mode.md, "Speaker avatars"): the same voice
    gets the same id ("s1", "s2"…) while it is remembered, so the page can draw
    one stable avatar per voice and split two people's lines between them. Only
    embeddings in memory, never audio, never a file; a restart forgets them.
    Thread-safe: finals (and the parts of a split one) are checked in a pool.
    """

    def __init__(self, same: float = VOICE_SAME, max_n: int = VOICES_MAX, forget_s: float = VOICE_FORGET_S,
                 mean_n: int = VOICE_MEAN_N):
        import threading

        self.same, self.max_n, self.forget_s, self.mean_n = same, max_n, forget_s, mean_n
        #: {id, c (unit centroid), n, at (last heard)}, in order of first hearing.
        self.items: list[dict] = []
        self.next = 1
        self._lock = threading.Lock()

    def tag(self, e: np.ndarray, now: float | None = None) -> str:
        """The id of the voice `e` (a unit embedding) is: a known one, moved towards it, or a new one."""
        t = time.time() if now is None else now
        e = unit(e)
        with self._lock:
            self.items = [v for v in self.items if t - v["at"] <= self.forget_s]
            best = max(self.items, key=lambda v: float(e @ v["c"]), default=None)
            if best is not None and float(e @ best["c"]) >= self.same:
                n = min(best["n"], self.mean_n)
                best["c"] = unit(best["c"] * n + e)
                best["n"] = best["n"] + 1
                best["at"] = t
                return best["id"]
            if len(self.items) >= self.max_n:
                self.items.remove(min(self.items, key=lambda v: v["at"]))
            v = {"id": f"s{self.next}", "c": e, "n": 1, "at": t}
            self.next += 1
            self.items.append(v)
            return v["id"]

    def known(self) -> list[str]:
        """The ids remembered now, oldest first (the tests, the log)."""
        with self._lock:
            return [v["id"] for v in self.items]


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
        #: The other voices heard lately (Voices): one table for the Mac, whoever's device heard them.
        self.voices = Voices()

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
        """(model, the devices whose prints to score against, this one first), or None when nothing is enrolled."""
        self._check()
        listed = self._all()
        for model in self.order:
            others = sorted({p["device"] for p in listed if p["model"] == model})
            # This device's own print first, then every other device's: the best
            # match counts (owner, 2026-11-14: each device was enrolled in another
            # room and mood; scoring only against this one threw that away). The
            # filter still asks for this device's own print (filter_reason).
            if device and valid_device(device) and self._print(device, model):
                return model, [device, *[d for d in others if d != device]]
            if others:
                return model, others
        return None

    def has_print(self, device: str | None) -> bool:
        """This device has its own print: what the voiceprint filter needs (filter_reason)."""
        self._check()
        return bool(device and valid_device(device) and any(self._print(device, m) for m in self.order))

    def embed(self, model: str, audio: np.ndarray) -> np.ndarray | None:
        return self.embedders[model](audio)

    def windows(self, model: str, device: str, audio: np.ndarray) -> list[dict]:
        """
        Each WINDOW_S window of a final long enough for two, scored against that print and
        decided alone: {score, decision, start, end} (samples into the final).
        """
        p = self._print(device, model)
        win, hop = int(WINDOW_S * RATE), int(WINDOW_HOP_S * RATE)
        if p is None or len(audio) < win + hop:
            return []
        out = []
        for at in range(0, len(audio) - win + 1, hop):
            w = audio[at : at + win]
            speech_s, snr = speech_stats(w)
            # Too little clear speech in it to say anything: not a vote.
            if speech_s < MIN_SPEECH_S or snr < MIN_SNR_DB:
                continue
            e = self.embed(model, w)
            if e is None:
                continue
            score = float(e @ p["_centroid"])
            out.append({"score": round(score, 3), "decision": decide(MODELS[model], score, speech_s, snr)[0],
                        "start": at, "end": at + win})
        return out

    def verify(self, audio: np.ndarray, device: str | None) -> dict:
        """
        {score, decision, model, device, speechS, snrDb[, reason, windows, cuts, voice]} for one final.
        `voice` (docs/voice-mode.md, "Speaker avatars"): "me" on his, "s1", "s2"… on an
        `other` (the same voice, the same id: Voices); none on an unknown, and none at
        all without a print, so an account that enrolled nothing never sees one.
        """
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
        windows = self.windows(model, who, audio) if decision == "me" else []
        cuts: list[int] = []
        if any(w["decision"] == "other" for w in windows):
            decision, reason = "unknown", "mixed"
            cuts = split_points(windows, audio)
        out = {"score": round(best, 3), "decision": decision, "model": model, "device": who, **base}
        if decision == "me":
            out["voice"] = "me"
        elif decision == "other":
            out["voice"] = self.voices.tag(e)
        if cuts:
            out["cuts"] = cuts  # where the speaker changes (server.py splits the final there)
        if windows:
            out["windows"] = [w["score"] for w in windows]
        if reason:
            out["reason"] = reason
        if MODELS[model].provisional:
            out["provisional"] = True
        return out

    # -- progressive learning (docs/local-stt.md, "Progressive voiceprint")
    def learn_gate(self, spk: dict | None, device: str | None) -> str | None:
        """
        Why this verified final may not join the print, or None: the checks that need
        no embedding, read from verify's result. Only an unambiguous "me": no reason,
        a model with measured bands, long, clean, every window his, well over the line.
        """
        if not device or not valid_device(device):
            return "no-device"
        if not spk or spk.get("decision") != "me" or spk.get("reason") or spk.get("score") is None:
            return "not-me"
        m = MODELS.get(spk.get("model") or "")
        if m is None or m.provisional:
            return "provisional"
        if spk.get("speechS", 0) < PROG_MIN_SPEECH_S:
            return "short"
        if spk.get("snrDb", -99) < PROG_MIN_SNR_DB:
            return "noise"
        # Every window decided alone must be him too: none undecided-low, none someone else.
        wins = spk.get("windows") or []
        line = band_for(m, WINDOW_S)
        if not wins or line is None or any(w < line.accept for w in wins):
            return "mixed"
        b = band_for(m, spk["speechS"])
        if b is None or spk["score"] < b.accept + PROG_MARGIN:
            return "margin"
        return None

    def _last_added(self, device: str) -> int:
        last = 0
        for m in self.order:
            p = self.store.load(device, m)
            if p:
                last = max([last, *[t for t, s in zip(p["added"], p["sources"]) if s == "prog"]])
            q = self.store.load_pending(device, m)
            if q and q["added"]:
                last = max(last, *q["added"])
        return last

    def learn(self, audio: np.ndarray, device: str | None, spk: dict | None, now: float | None = None) -> dict:
        """
        Offer one verified final to this device's print: {"ok": True, "n", "active"} when its
        embedding was added (to the print, or to the pending samples until PROG_CREATE_MIN),
        else {"ok": False, "reason"}. Only embeddings are kept; the audio goes with the call.
        """
        now = time.time() if now is None else now
        if not self.store.progressive()["on"]:
            return {"ok": False, "reason": "off"}
        why = self.learn_gate(spk, device)
        if why:
            return {"ok": False, "reason": why}
        speech_s = float(spk["speechS"])
        with self.store.lock():
            # Under the lock: a delete since (it turns learning off) wins.
            if not self.store.progressive()["on"]:
                return {"ok": False, "reason": "off"}
            if now - self._last_added(device) < PROG_EVERY_S:
                return {"ok": False, "reason": "rate"}
            embs: dict[str, np.ndarray] = {}
            for m in self.order:
                e = self.embed(m, audio)
                if e is None:
                    return {"ok": False, "reason": "short"}
                # Against this device's own samples: far from them, it is not taken, even
                # when another device's print vouched for it.
                p = self.store.load(device, m)
                ref = p["_centroid"] if p else None
                if ref is None:
                    q = self.store.load_pending(device, m)
                    if q and len(q["_embeddings"]) >= 3:
                        ref = unit(np.mean(q["_embeddings"], axis=0))
                b = band_for(MODELS[m], speech_s)
                if ref is not None and (b is None or float(e @ ref) < b.accept + PROG_OUTLIER_MARGIN):
                    return {"ok": False, "reason": "outlier", "model": m, "score": round(float(e @ ref), 3)}
                embs[m] = e
            res: dict = {"ok": True}
            for m, e in embs.items():
                r = self._add(device, m, e, speech_s, int(now))
                if r.pop("full", False):
                    res = {"ok": False, "reason": "full"}
                    break
                res.update(r)
        self.refresh()
        return res

    def _add(self, device: str, model: str, e: np.ndarray, speech_s: float, at: int) -> dict:
        """One sample into the print (bounded: the oldest progressive one goes when full), or pending."""
        p = self.store.load(device, model)
        if p is None:
            q = self.store.load_pending(device, model)
            E = [*(q["_embeddings"] if q else []), e]
            S = [*(q["speechS"] if q else []), speech_s]
            A = [*(q["added"] if q else []), at]
            if len(E) < PROG_CREATE_MIN:
                self.store.save_pending(device, model, E, S, A)
                return {"n": len(E), "active": False}
            self.store.save(device, model, E, S, audio=False, sources=["prog"] * len(E), added=A)
            return {"n": len(E), "active": True, "created": True}
        E = [np.array(x, dtype=np.float32) for x in p["embeddings"]]
        S, src, A = list(p["speechS"]), list(p["sources"]), list(p["added"])
        evicted = 0
        while len(E) >= PRINT_MAX:
            # The oldest progressive sample (enrolment samples are the anchor and stay).
            prog = [i for i, s in enumerate(src) if s == "prog"]
            if not prog:
                return {"n": len(E), "active": True, "full": True}
            i = min(prog, key=lambda k: A[k])
            for lst in (E, S, src, A):
                del lst[i]
            evicted += 1
        E.append(e)
        S.append(speech_s)
        src.append("prog")
        A.append(at)
        self.store.save(device, model, E, S, bool(p.get("audio")), created=p.get("created"), sources=src, added=A)
        return {"n": len(E), "active": True, **({"evicted": evicted} if evicted else {})}


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
    `{v:1, uid, at, text, decision, score, model, device, speechS, snrDb[, reason, voice]}`.
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
            **{k: tag[k] for k in ("decision", "score", "model", "device", "speechS", "snrDb", "reason", "voice")
               if k in tag},
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
    d = sub.add_parser("delete", help="delete a device's voiceprint (every model); the kept recordings only with --audio")
    g = d.add_mutually_exclusive_group(required=True)
    g.add_argument("--device")
    g.add_argument("--all", action="store_true")
    d.add_argument("--audio", action="store_true", help="also delete the kept enrolment recordings")
    da = sub.add_parser("delete-audio", help="delete only the kept enrolment recordings (the print stays)")
    ga = da.add_mutually_exclusive_group(required=True)
    ga.add_argument("--device")
    ga.add_argument("--all", action="store_true")
    s = sub.add_parser("score", help="score WAV files against the stored print (read-only)")
    s.add_argument("wavs", nargs="+")
    s.add_argument("--device", default=None)
    s.add_argument("--models", default="campp")
    sub.add_parser("attest-key", help="print the public key the hub needs (STT_SPEAKER_PUB); makes the key if missing")
    pr = sub.add_parser("progressive", help="progressive learning on this Mac: on, off, or show it")
    pr.add_argument("state", nargs="?", choices=["on", "off"])
    a = ap.parse_args(argv)
    store = Store(a.store)
    try:
        if a.cmd == "list":
            ps = store.prints()
            if not ps:
                print(f"no voiceprint in {a.store}")
            for p in ps:
                print(f"{p['device']}\t{p['model']}\t{p['n']} samples ({p['enrolN']} enrolled, {p['progN']} learned,"
                      f" last {p['lastAdded'] or '-'})\tupdated {p['updated']}"
                      f"\taudio kept: {'yes' if p['audio'] else 'no'}\tself {p['self']}")
            return 0
        if a.cmd == "delete":
            if a.device is not None and not valid_device(a.device):
                print("bad device name", file=sys.stderr)
                return 2
            n = store.delete(None if a.all else a.device, audio=a.audio)
            print(f"deleted {n} file(s) from {a.store}")
            left = store.audio_count(None if a.all else a.device)
            if left:
                print(f"{left} kept recording(s) left (delete-audio, or delete --audio, removes them)")
            return 0
        if a.cmd == "delete-audio":
            if a.device is not None and not valid_device(a.device):
                print("bad device name", file=sys.stderr)
                return 2
            n = store.delete_audio(None if a.all else a.device)
            print(f"deleted {n} recording(s) from {a.store}")
            return 0
        if a.cmd == "progressive":
            if a.state:
                with store.lock():
                    store.set_progressive(a.state == "on")
            st = store.progressive()
            print(f"progressive learning {'on' if st['on'] else 'off'} (since {st['updated'] or '-'})")
            for q in store.pending():
                print(f"{q['device']}\t{q['model']}\t{q['n']} of {q['need']} samples pending")
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
