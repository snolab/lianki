"""
Shared pieces of the noise / speaker grid (grid-eval.py, speaker-grid.py;
docs/stt-ab.md, "Noise and speaker grid"). Files only: nothing is played.

- audio: load (wav / mp3, any rate, to 16 kHz mono), speech mask, levels;
- noise bank: DEMAND (CC BY 4.0) restaurant / cafeteria / street, babble
  and a single background voice made from the page's TTS voices (never the
  owner's own clips), "through the room" (short reverb) so they sound distant;
- mixing at an SNR over the speech frames, gain with int16 clipping;
- denoisers: none, RNNoise, DeepFilterNet3 (full and 12 dB cap),
  noisereduce (spectral gating), spectral subtraction;
- Silero v5 VAD and the phone's segmentation (vad-web start, the mic's
  endpoint), parametrised by threshold and pre-pad;
- recognisers: SenseVoice (the server's), streaming Paraformer zh-en;
- scoring: CER with substitutions / deletions / insertions, leakage.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys
import time
import unicodedata

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engines import MODELS, RATE, SenseVoice, simplified, tidy  # noqa: E402

CACHE = os.path.expanduser("~/.cache/lianki-stt")
DEMAND = os.path.join(CACHE, "noise-demand")
DEMAND_URL = "https://zenodo.org/records/1227121/files/{env}_16k.zip?download=1"
DEMAND_ENVS = {"restaurant": "PRESTO", "cafeteria": "PCAFETER", "street": "STRAFFIC"}
VOICES = os.path.expanduser("~/.cache/lianki-voice/out/voice")
VAD_MODEL = os.path.join(MODELS, "vad-web-0.0.30", "silero_vad_v5.onnx")
FRAME = 512  # 32 ms, vad-web v5


# ---------------------------------------------------------------- audio
def load(path: str) -> np.ndarray:
    a, sr = sf.read(path, dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    if sr != RATE:
        from scipy.signal import resample_poly

        g = np.gcd(int(sr), RATE)
        a = resample_poly(a, RATE // g, int(sr) // g)
    return a.astype(np.float32)


def frame_db(x: np.ndarray, w: int = 400, hop: int = 160) -> np.ndarray:
    n = max(0, 1 + (len(x) - w) // hop)
    if n == 0:
        return np.zeros(0)
    idx = np.arange(w)[None, :] + hop * np.arange(n)[:, None]
    f = x[idx]
    return 10 * np.log10(np.mean(f * f, axis=1) + 1e-10)


def speech_power(x: np.ndarray) -> float:
    """Mean power over the speech frames (within 25 dB of the loud ones)."""
    db = frame_db(x)
    if len(db) == 0:
        return float(np.mean(x * x) + 1e-12)
    sp = db[db > np.percentile(db, 95) - 25]
    return float(np.mean(10 ** (sp / 10)))


def level_db(x: np.ndarray) -> float:
    return 10 * np.log10(speech_power(x) + 1e-12)


def gain(x: np.ndarray, db: float) -> np.ndarray:
    """Gain then the int16 ceiling, as a hot mic would clip."""
    return np.clip(x * 10 ** (db / 20), -1.0, 32767 / 32768).astype(np.float32)


def normalise(x: np.ndarray, target_db: float = -26.0) -> np.ndarray:
    """An AGC stand-in: speech level to target_db (the owner's median is -26 dBFS)."""
    return gain(x, target_db - level_db(x))


def mix(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """speech + noise at snr_db over the speech frames; noise looped / cut to length."""
    nz = np.resize(noise, len(speech)).astype(np.float32)
    pn = float(np.mean(nz * nz) + 1e-12)
    y = speech + nz * np.sqrt(speech_power(speech) / (pn * 10 ** (snr_db / 10)))
    return np.clip(y, -1.0, 32767 / 32768).astype(np.float32)


def reverb(x: np.ndarray, rng, t60: float = 0.25) -> np.ndarray:
    """A short synthetic room: the other talker is a metre or two away."""
    n = int(t60 * RATE)
    rir = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.05 * RATE))
    rir[0] = 4.0
    m = len(x) + n - 1
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(rir, m), m)[: len(x)]
    return (y / (np.std(y) + 1e-9) * (np.std(x) + 1e-9)).astype(np.float32)


def pa_chain(x: np.ndarray, rng) -> np.ndarray:
    """
    An in-store PA announcement as the phone hears it: telephone band
    (300-3400 Hz), hard-limited like a cheap amplifier, then a long hall
    (0.8 s decay) from ceiling speakers.
    """
    from scipy.signal import butter, sosfilt

    sos = butter(4, [300, 3400], btype="band", fs=RATE, output="sos")
    y = sosfilt(sos, x)
    y = np.tanh(3.0 * y / (np.max(np.abs(y)) + 1e-9))
    n = int(0.8 * RATE)
    rir = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.12 * RATE))
    rir[0] = 2.0
    m = len(y) + n - 1
    z = np.fft.irfft(np.fft.rfft(y, m) * np.fft.rfft(rir, m), m)[: len(y)]
    return (z / (np.std(z) + 1e-9) * 0.05).astype(np.float32)


# ---------------------------------------------------------------- noise bank
def demand(env: str, seconds: float = 120.0) -> np.ndarray:
    """Channel 1 of a DEMAND environment (16 kHz). Missing: say how to fetch it."""
    code = DEMAND_ENVS[env]
    hits = sorted(glob.glob(os.path.join(DEMAND, "**", code, "ch01.wav"), recursive=True))
    if not hits:
        raise SystemExit(
            f"DEMAND {code} missing: mkdir -p {DEMAND} && curl -Lo {DEMAND}/{code}_16k.zip "
            f"'{DEMAND_URL.format(env=code)}' && unzip -d {DEMAND} {DEMAND}/{code}_16k.zip"
        )
    x = load(hits[0])
    return x[: int(seconds * RATE)]


def tts_voices(langs: tuple[str, ...], per_lang: int, min_s: float = 3.0, skip: int = 0) -> list[str]:
    out = []
    for lang in langs:
        got = 0
        for f in sorted(glob.glob(os.path.join(VOICES, lang, "*.mp3")))[skip:]:
            try:
                if sf.info(f).duration >= min_s:
                    out.append(f)
                    got += 1
            except Exception:
                continue
            if got >= per_lang:
                break
    return out


class Bank:
    """
    Noise sources, built once. `get(kind, n, rng)` gives n samples of noise and,
    for the voice kinds, the background talkers' files (their text is the
    leakage reference; they are TTS voices, so their text can be logged).
    """

    def __init__(self, rng, kinds=("restaurant", "cafeteria", "street", "babble", "voice", "pa")):
        self.rng = rng
        self.kinds = kinds
        self.demand = {k: demand(k) for k in kinds if k in DEMAND_ENVS}
        self.babble_src = [(f, reverb(load(f), rng)) for f in tts_voices(("en", "ja", "ko", "de", "es", "fr", "zh"), 3)]
        self.voice_src = [(f, reverb(load(f), rng)) for f in tts_voices(("zh",), 24, min_s=4.0, skip=40)]
        # PA announcements: Japanese TTS sentences through pa_chain, over a quiet shop bed
        self.pa_src = [(f, pa_chain(load(f), rng)) for f in tts_voices(("ja",), 16, min_s=4.0, skip=40)]

    def get(self, kind: str, n: int, rng) -> tuple[np.ndarray, list[str]]:
        if kind in self.demand:
            src = self.demand[kind]
            off = int(rng.integers(0, max(1, len(src) - n)))
            return np.resize(src[off:], n), []
        if kind in ("voice", "pa"):
            # one talker, starting 0-0.5 s in, looping its own sentences: the family member at the
            # table, or the shop's PA
            src = self.voice_src if kind == "voice" else self.pa_src
            i = int(rng.integers(len(src)))
            f, x = src[i]
            y = np.zeros(n, np.float32)
            start = int(rng.integers(0, RATE // 2))
            seg = np.resize(x, max(0, n - start))
            y[start:] = seg
            # (file, how many times its text is heard: 0.6 = the first 60 %, 1.5 = once and a half)
            return y, [(f, len(seg) / len(x))]
        if kind == "babble":
            # six talkers in several languages, each normalised, offset: a busy table nearby
            pick = rng.choice(len(self.babble_src), 6, replace=False)
            y = np.zeros(n, np.float32)
            for k in pick:
                x = self.babble_src[k][1]
                y += np.roll(np.resize(x, n), int(rng.integers(0, n))) / (np.std(x) + 1e-9)
            return y, []
        raise KeyError(kind)


# ---------------------------------------------------------------- denoisers
class NoDenoise:
    name = "none"
    delay_ms = 0.0
    streaming = True

    def __call__(self, x):
        return x


class RNNoise:
    """xiph RNNoise (pyrnnoise's bundled librnnoise), 48 kHz 10 ms frames, causal."""

    name = "rnnoise"
    delay_ms = 20.0  # 10 ms frames, 20 ms windows: the output lags two frames
    streaming = True

    def __init__(self):
        import ctypes

        import pyrnnoise.rnnoise as rn

        self.rn, self.ct = rn, ctypes
        self.lib = rn.lib
        self.N = rn.FRAME_SIZE  # 480

    def __call__(self, x):
        from scipy.signal import resample_poly

        up = resample_poly(x.astype(np.float64), 3, 1) * 32768.0
        n = len(up) // self.N * self.N
        up = np.concatenate([up, np.zeros(self.N - (len(up) - n) if len(up) > n else 0)])
        out = np.empty_like(up, dtype=np.float32)
        st = self.lib.rnnoise_create(None)
        buf = np.zeros(self.N, np.float32)
        ob = np.zeros(self.N, np.float32)
        P = self.ct.POINTER(self.ct.c_float)
        try:
            for i in range(0, len(up), self.N):
                buf[:] = up[i : i + self.N]
                self.lib.rnnoise_process_frame(st, ob.ctypes.data_as(P), buf.ctypes.data_as(P))
                out[i : i + self.N] = ob
        finally:
            self.lib.rnnoise_destroy(st)
        # the output lags the input by two frames (20 ms); align for scoring
        y = np.concatenate([out[2 * self.N :], np.zeros(2 * self.N, np.float32)]) / 32768.0
        return resample_poly(y, 1, 3)[: len(x)].astype(np.float32)


class DFN3:
    name = "dfn3"
    delay_ms = 40.0  # DeepFilterNet3's lookahead (2 frames of 10 ms + the 20 ms window)
    streaming = True

    def __init__(self, atten: float | None = None):
        from engines import DeepFilter

        self.d = DeepFilter(atten)
        if atten is not None:
            self.name = f"dfn3-cap{atten:g}"

    def __call__(self, x):
        return self.d(x)


class NoiseReduce:
    """noisereduce 3 (spectral gating, non-stationary): needs the whole clip, so not streaming."""

    name = "noisereduce"
    delay_ms = 0.0
    streaming = False

    def __init__(self):
        import noisereduce

        self.nr = noisereduce

    def __call__(self, x):
        return self.nr.reduce_noise(y=x, sr=RATE, stationary=False).astype(np.float32)


class SpecSub:
    """
    Plain spectral subtraction, causal: 32 ms Hann frames, 50 % overlap; the
    noise PSD is a running minimum over the last 1.5 s (minimum statistics,
    simplified), over-subtracted by 2 with a 0.05 spectral floor.
    """

    name = "specsub"
    delay_ms = 32.0
    streaming = True

    def __init__(self, alpha: float = 2.0, floor: float = 0.05, win: int = 512):
        self.alpha, self.floor, self.win = alpha, floor, win

    def __call__(self, x):
        w, h = self.win, self.win // 2
        win = np.sqrt(np.hanning(w + 1)[:w])
        pad = np.concatenate([np.zeros(h), x, np.zeros(w)])
        n = 1 + (len(pad) - w) // h
        y = np.zeros(len(pad))
        hist = int(1.5 * RATE / h)
        smooth = None
        mins: list[np.ndarray] = []
        for i in range(n):
            f = pad[i * h : i * h + w] * win
            S = np.fft.rfft(f)
            p = np.abs(S) ** 2
            smooth = p if smooth is None else 0.8 * smooth + 0.2 * p
            mins.append(smooth)
            if len(mins) > hist:
                mins.pop(0)
            noise = np.min(mins, axis=0) * 1.5  # minimum statistics bias
            g = np.sqrt(np.maximum(1 - self.alpha * noise / (p + 1e-12), self.floor**2))
            y[i * h : i * h + w] += np.fft.irfft(S * g, w) * win
        return y[h : h + len(x)].astype(np.float32)


def denoisers(names: list[str]):
    make = {
        "none": NoDenoise,
        "rnnoise": RNNoise,
        "dfn3": DFN3,
        "dfn3-cap12": lambda: DFN3(12.0),
        "noisereduce": NoiseReduce,
        "specsub": SpecSub,
    }
    return [make[n]() for n in names]


# ---------------------------------------------------------------- VAD
class Silero:
    def __init__(self):
        import onnxruntime as ort

        o = ort.SessionOptions()
        o.inter_op_num_threads = o.intra_op_num_threads = 1
        self.s = ort.InferenceSession(VAD_MODEL, o)

    def probs(self, audio: np.ndarray) -> np.ndarray:
        state = np.zeros((2, 1, 128), dtype=np.float32)
        sr = np.array(RATE, dtype=np.int64)
        out = []
        for i in range(len(audio) // FRAME):
            x = audio[i * FRAME : (i + 1) * FRAME][None, :].astype(np.float32)
            p, state = self.s.run(None, {"input": x, "state": state, "sr": sr})
            out.append(float(p[0][0]))
        return np.array(out)


def segment(p: np.ndarray, n_samples: int, pos: float = 0.3, neg: float = 0.25, pad_ms: int = 800,
            min_ms: int = 250, endpoint_ms: int = 600, redemption_ms: int = 1400) -> list[tuple[int, int]]:
    """
    The utterances the phone would send (ab-eval.py's segment, parametrised):
    vad-web starts at `pos` with `pad_ms` of pre-pad, the mic's endpoint
    (noise floor + 0.25 within 0.35-0.8, held `endpoint_ms`) or vad-web's
    redemption ends it, under `min_ms` of speech is a misfire.
    """
    pad_f, min_f, red_f = pad_ms // 32, min_ms // 32, redemption_ms // 32
    ep_f = int(np.ceil(endpoint_ms / 32))
    segs, floor, i, restart, n = [], 0.1, 0, 0, len(p)
    while i < n:
        while i < n and p[i] < pos:
            floor += (p[i] - floor) * 0.05
            i += 1
        if i >= n:
            break
        start_f = max(restart, i - pad_f)
        thr = min(0.8, max(0.35, floor + 0.25))
        heard, quiet, red, speech_f, end_f = False, 0, 0, 0, None
        j = i
        while j < n:
            q = p[j]
            if q >= pos:
                speech_f += 1
            if q >= thr:
                heard, quiet = True, 0
            else:
                quiet += 1
            if heard and quiet >= ep_f:
                end_f = j + 1
                break
            if q >= pos:
                red = 0
            elif q < neg:
                red += 1
                if red >= red_f:
                    end_f = j + 1
                    break
            j += 1
        end_f = n if end_f is None else end_f
        if speech_f >= min_f:
            segs.append((start_f * FRAME, n_samples if end_f == n else end_f * FRAME))
        restart = i = end_f
    return segs


# ---------------------------------------------------------------- recognisers
class Paraformer:
    """sherpa-onnx streaming Paraformer zh-en (already in the models dir), fed the whole piece."""

    name = "paraformer"

    def __init__(self, threads: int = 4):
        import sherpa_onnx

        d = os.path.join(MODELS, "sherpa-onnx-streaming-paraformer-bilingual-zh-en")
        self.model = "paraformer-streaming-zh-en-int8"
        self.r = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=os.path.join(d, "tokens.txt"),
            encoder=os.path.join(d, "encoder.int8.onnx"),
            decoder=os.path.join(d, "decoder.int8.onnx"),
            num_threads=threads,
        )

    def transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        s = self.r.create_stream()
        s.accept_waveform(RATE, audio)
        s.accept_waveform(RATE, np.zeros(int(0.8 * RATE), np.float32))
        s.input_finished()
        while self.r.is_ready(s):
            self.r.decode_stream(s)
        return tidy(self.r.get_result(s), "zh"), "zh"


def recognisers(names: list[str], threads: int = 4):
    make = {"sensevoice": SenseVoice, "paraformer": Paraformer}
    return [make[n](threads=threads) for n in names]


# ---------------------------------------------------------------- scoring
def norm(s: str) -> str:
    s = simplified(unicodedata.normalize("NFKC", s))
    return re.sub(r"[\W_]+", "", s.lower())


def align(ref: str, hyp: str) -> tuple[int, int, int]:
    """(substitutions, deletions, insertions) of a minimum edit alignment."""
    R, H = len(ref), len(hyp)
    d = np.zeros((R + 1, H + 1), np.int32)
    d[:, 0] = np.arange(R + 1)
    d[0, :] = np.arange(H + 1)
    for i in range(1, R + 1):
        for j in range(1, H + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]))
    i, j, S, D, I = R, H, 0, 0, 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]):
            S += ref[i - 1] != hyp[j - 1]
            i, j = i - 1, j - 1
        elif i > 0 and d[i, j] == d[i - 1, j] + 1:
            D += 1
            i -= 1
        else:
            I += 1
            j -= 1
    return S, D, I


def score(ref: str, hyp: str) -> dict:
    r, h = norm(ref), norm(hyp)
    if not r:
        return {"n": 0, "cer": 0.0 if not h else 1.0, "sub": 0, "del": 0, "ins": len(h)}
    S, D, I = align(r, h)
    return {"n": len(r), "cer": min(1.0, (S + D + I) / len(r)), "sub": S, "del": D, "ins": I}


def lcs(a: str, b: str) -> int:
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b):
            cur.append(prev[j] + 1 if ca == cb else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def leakage(ref: str, hyp: str, background: str) -> tuple[int, int]:
    """
    Characters of the background talker's text that made it into the
    transcript, beyond what the reference shares with it by chance:
    (leaked, background length).
    """
    r, h, b = norm(ref), norm(hyp), norm(background)
    return max(0, lcs(h, b) - lcs(r, b)), len(b)


# ---------------------------------------------------------------- refs
def references(clips: str) -> dict[str, tuple[str, str]]:
    """name -> (text, source): the owner's <name>.ref.txt wins over refs-agent.json."""
    out = {}
    p = os.path.join(clips, "refs-agent.json")
    if os.path.exists(p):
        for k, v in json.load(open(p)).items():
            if not k.startswith("_") and isinstance(v, dict) and v.get("text"):
                out[k] = (v["text"], "agent")
    for f in glob.glob(os.path.join(clips, "*.ref.txt")):
        out[os.path.basename(f)[: -len(".ref.txt")]] = (open(f).read().strip(), "owner")
    return out


def sidecar(wav: str) -> dict:
    p = wav[:-4] + ".json"
    try:
        return json.load(open(p))
    except Exception:
        return {}


def timed(fn, *a):
    t = time.perf_counter()
    r = fn(*a)
    return r, (time.perf_counter() - t) * 1000


# ---------------------------------------------------------------- live batches, sharing the Mac
def live_labels(wavs: list[str], batches: str) -> dict[str, tuple[str, str]]:
    """
    {wav: (batch, path)} for the live clips. `batches` is "start=label,…"
    with clip-name prefixes (UTC, '-' for ':'); a clip belongs to the latest
    start before it. A clip whose sidecar transcript says 吵了 starts a
    "noisy" batch and 安静了 a "quiet" one, until the next start (his spoken
    markers; the transcript is only tested for them). path: the STT path the
    clip went through at the time, from the sidecar's `model`.
    """
    starts = sorted((kv.split("=", 1) for kv in batches.split(",") if "=" in kv), key=lambda t: t[0])
    out, marker = {}, None
    for w in sorted(wavs):
        name = os.path.basename(w)[:-4]
        if not starts or name < starts[0][0]:
            continue
        start, label = [(s, lab) for s, lab in starts if name >= s][-1]
        meta = sidecar(w)
        said = str(meta.get("transcript") or "")
        if "吵了" in said:
            marker = (name, "noisy")
        elif "安静了" in said:
            marker = (name, "quiet")
        if marker and marker[0] >= start:
            label = marker[1]
        model = str(meta.get("model") or "")
        out[w] = (label, "local" if model.startswith("local:") else "cloud" if model.startswith("@cf/") else "unknown")
    return out


def wait_quiet(d: str, quiet_s: float = 120.0):
    """While a clip landed in d within quiet_s, he is talking: wait before the next piece of heavy work."""
    if not d:
        return
    said = False
    while True:
        newest = max((os.path.getmtime(p) for p in glob.glob(os.path.join(d, "*"))), default=0)
        left = quiet_s - (time.time() - newest)
        if left <= 0:
            if said:
                print(f"  resumed ({time.strftime('%H:%M')})", file=sys.stderr, flush=True)
            return
        if not said:
            print(f"  paused: he is talking ({time.strftime('%H:%M')})", file=sys.stderr, flush=True)
            said = True
        time.sleep(min(left + 1, 30))
