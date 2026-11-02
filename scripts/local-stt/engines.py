"""
The local speech models behind scripts/local-stt/server.py (docs/local-stt.md).
Each engine takes 16 kHz mono float32 and answers (text, lang). Chinese is
always simplified (OpenCC t2s, only when the model says zh/yue, so Japanese
kanji are left alone).
"""
from __future__ import annotations

import os
import re

import numpy as np

RATE = 16_000
MODELS = os.path.expanduser(os.environ.get("LIANKI_STT_MODELS", "~/.cache/lianki-stt/models"))

_t2s = None


def simplified(text: str) -> str:
    global _t2s
    if _t2s is None:
        import opencc

        _t2s = opencc.OpenCC("t2s")
    return _t2s.convert(text)


def tidy(text: str, lang: str) -> str:
    t = text.strip()
    if lang in ("zh", "yue"):
        t = simplified(t)
    return re.sub(r"\s+", " ", t)


class SenseVoice:
    """SenseVoice-Small (FunASR) via sherpa-onnx: non-autoregressive, ~10 ms per audio second."""

    name = "sensevoice"

    def __init__(self, model_dir: str | None = None, threads: int = 4):
        import sherpa_onnx

        d = model_dir or os.path.join(MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
        onnx = os.path.join(d, "model.onnx")
        if not os.path.exists(onnx):
            onnx = os.path.join(d, "model.int8.onnx")
        self.model = "sensevoice-small-2024-07-17" + ("" if onnx.endswith("model.onnx") else "-int8")
        self.r = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=onnx,
            tokens=os.path.join(d, "tokens.txt"),
            use_itn=True,  # punctuation and digits
            num_threads=threads,
            language="auto",
        )

        #: Short finals get a second opinion on the language (LangPicker); off when
        #: its model or onnxruntime is missing.
        self.picker = None
        if os.environ.get("LIANKI_STT_LANG_PICK", "1") != "0":
            try:
                picker = LangPicker(d)
                picker.score(np.zeros(RATE, dtype=np.float32))  # warm up
                self.picker = picker
            except Exception as e:  # the auto decode alone, as before
                print(f"lang picker off: {e}", flush=True)
        if self.picker:
            from concurrent.futures import ThreadPoolExecutor

            self.side = ThreadPoolExecutor(max_workers=2)

    def transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        s = self.r.create_stream()
        s.accept_waveform(RATE, audio)
        self.r.decode_stream(s)
        lang = (s.result.lang or "").strip("<|>")
        return tidy(s.result.text, lang), lang

    def final(self, audio: np.ndarray) -> tuple[str, str, str | None]:
        """
        The whole utterance: (text, lang, the auto language it replaced or None).
        A short one is also scored with ja and zh forced, alongside the auto decode,
        and the forced reading wins when it is clearly the better fit (LangPicker).
        """
        if not self.picker or len(audio) > LangPicker.SHORT_S * RATE:
            return (*self.transcribe(audio), None)
        side = self.side.submit(self.picker.score, audio)
        text, lang = self.transcribe(audio)
        try:
            cands = side.result()
        except Exception as e:
            print(f"lang picker failed: {e}", flush=True)
            return text, lang, None
        won = choose(lang, cands)
        if won is None:
            return text, lang, None
        return tidy(cands[won].text, won), won, lang


# ── Language second opinion for short utterances ────────────────────────────
#
# SenseVoice's language ID misreads short Japanese (1.5–3 s): 「もしもし」 three
# times came out as English ("Mice mouse.") and Chinese, while the same audio with
# ja forced reads 「もしもし。」. The recognizer only reports the argmax, no
# scores, so the second opinion runs the same model (int8, ~240 MB) through
# onnxruntime once, batched as [auto, ja, zh], and compares how sure the CTC
# head is of each reading. Measured on the owner's clips (docs/local-stt.md,
# "Short utterances and the language").


class Reading:
    __slots__ = ("text", "frame_lp", "token_lp")

    def __init__(self, text: str, frame_lp: float, token_lp: float):
        #: The greedy CTC reading, its mean best log-prob per frame (blanks
        #: included, so every language is scored over the same frames) and per
        #: emitted token.
        self.text, self.frame_lp, self.token_lp = text, frame_lp, token_lp


_KANA = re.compile(r"[぀-ヿ]")
_HAN = re.compile(r"[一-鿿]")

#: A forced reading must beat the auto one by this much per frame…
MIN_FRAME_GAIN = 0.02
#: …and by this much per emitted token.
MIN_TOKEN_GAIN = 0.4


def _family(lang: str) -> str:
    return "zh" if lang in ("zh", "yue") else lang


def choose(auto_lang: str, cands: dict[str, Reading]) -> str | None:
    """
    The forced language to use instead of the auto one, or None to keep it.
    `cands` holds "auto" and the forced readings ("ja", "zh"). A forced reading
    wins only if it is in its own script (kana for ja; Han without kana for zh)
    and beats the auto reading by both margins; of two winners, the larger
    per-frame gain.
    """
    a = cands.get("auto")
    if a is None:
        return None
    best, gain = None, 0.0
    for lang in ("ja", "zh"):
        c = cands.get(lang)
        if c is None or lang == _family(auto_lang):
            continue
        if lang == "ja":
            scripted = bool(_KANA.search(c.text))
        else:
            scripted = bool(_HAN.search(c.text)) and not _KANA.search(c.text)
        g = c.frame_lp - a.frame_lp
        if scripted and g >= MIN_FRAME_GAIN and c.token_lp - a.token_lp >= MIN_TOKEN_GAIN and (best is None or g > gain):
            best, gain = lang, g
    return best


def fbank(audio: np.ndarray) -> np.ndarray:
    """
    80-bin Kaldi log-mel filterbank (25 ms hamming frames every 10 ms, snip
    edges, DC removed, 0.97 pre-emphasis, 20 Hz to Nyquist − 400 Hz), on 16 kHz
    float audio in [-1, 1]; matches kaldi-native-fbank to float precision.
    """
    x = audio.astype(np.float64) * 32768.0
    flen, fshift, nfft = 400, 160, 512
    n = 1 + (len(x) - flen) // fshift if len(x) >= flen else 0
    if n <= 0:
        return np.zeros((0, 80), dtype=np.float32)
    idx = np.arange(flen)[None, :] + fshift * np.arange(n)[:, None]
    fr = x[idx]
    fr = fr - fr.mean(1, keepdims=True)
    fr = np.concatenate([fr[:, :1] * (1 - 0.97), fr[:, 1:] - 0.97 * fr[:, :-1]], axis=1)
    fr = fr * (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(flen) / (flen - 1)))
    p = np.abs(np.fft.rfft(fr, nfft)) ** 2
    return np.log(np.maximum(p[:, : nfft // 2] @ _mel_banks().T, np.finfo(np.float32).eps)).astype(np.float32)


_MEL = None


def _mel_banks() -> np.ndarray:
    global _MEL
    if _MEL is None:
        nbins, nfft = 80, 512
        mel = lambda f: 1127.0 * np.log(1.0 + f / 700.0)  # noqa: E731
        lo, hi = mel(20.0), mel(RATE / 2 - 400.0)
        d = (hi - lo) / (nbins + 1)
        f = mel(np.arange(nfft // 2) * RATE / nfft)
        b = np.arange(nbins)[:, None]
        left, center, right = lo + b * d, lo + (b + 1) * d, lo + (b + 2) * d
        up = (f - left) / (center - left)
        down = (right - f) / (right - center)
        _MEL = np.where((f > left) & (f < right), np.where(f <= center, up, down), 0.0)
    return _MEL


class LangPicker:
    """SenseVoice-Small int8 straight through onnxruntime: one batched run, a reading per language."""

    #: Only utterances up to this long get the second opinion (the misreads are 1.5–3 s).
    SHORT_S = 4.0
    LANGS = ("auto", "ja", "zh")

    def __init__(self, model_dir: str, threads: int = 4):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(os.path.join(model_dir, "model.int8.onnx"), so,
                                         providers=["CPUExecutionProvider"])
        meta = self.sess.get_modelmeta().custom_metadata_map
        self.neg_mean = np.array(meta["neg_mean"].split(","), dtype=np.float32)
        self.inv_std = np.array(meta["inv_stddev"].split(","), dtype=np.float32)
        self.lfr_m, self.lfr_n = int(meta["lfr_window_size"]), int(meta["lfr_window_shift"])
        self.lid = np.array([int(meta[f"lang_{lang}"]) for lang in self.LANGS], dtype=np.int32)
        self.itn = int(meta["with_itn"])
        with open(os.path.join(model_dir, "tokens.txt"), encoding="utf-8") as f:
            self.tokens = [line.rsplit(" ", 1)[0] for line in f.read().splitlines()]

    def features(self, audio: np.ndarray) -> np.ndarray:
        x = fbank(audio)
        m, n = self.lfr_m, self.lfr_n
        t = (len(x) - m) // n + 1
        if t <= 0:
            return np.zeros((0, 80 * m), dtype=np.float32)
        y = x[np.arange(m)[None, :] + n * np.arange(t)[:, None]].reshape(t, -1)
        return ((y + self.neg_mean) * self.inv_std).astype(np.float32)

    def score(self, audio: np.ndarray) -> dict[str, Reading]:
        x = self.features(audio)
        if len(x) == 0:
            return {}
        k = len(self.LANGS)
        logits = self.sess.run(None, {
            "x": np.repeat(x[None], k, 0),
            "x_length": np.full(k, len(x), np.int32),
            "language": self.lid,
            "text_norm": np.full(k, self.itn, np.int32),
        })[0]
        return {lang: self.reading(logits[i, 4:]) for i, lang in enumerate(self.LANGS)}

    def reading(self, z: np.ndarray) -> Reading:
        z = z - z.max(-1, keepdims=True)
        lp = z - np.log(np.exp(z).sum(-1, keepdims=True))
        ids, best = lp.argmax(-1), lp.max(-1)
        keep = ids != 0  # 0 is the CTC blank
        out = [int(i) for j, i in enumerate(ids) if keep[j] and (j == 0 or i != ids[j - 1])]
        text = "".join(self.tokens[i] for i in out).replace("▁", " ").strip()
        return Reading(text, float(best.mean()), float(best[keep].mean()) if keep.any() else 0.0)


class MlxWhisper:
    """whisper-large-v3-turbo on MLX (Apple GPU). Autoregressive: each decode costs the whole window."""

    name = "mlx-whisper"
    PROMPT = "以下是普通话的句子，使用简体中文和标点。日本語とEnglishも混ざります。"

    def __init__(self, repo: str = "mlx-community/whisper-large-v3-turbo"):
        import mlx_whisper

        self.mw = mlx_whisper
        self.model = repo.split("/")[-1]
        self.repo = repo

    def transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        r = self.mw.transcribe(
            audio,
            path_or_hf_repo=self.repo,
            initial_prompt=self.PROMPT,
            condition_on_previous_text=False,
        )
        lang = r.get("language") or ""
        return tidy(r.get("text", ""), lang), lang


class DeepFilter:
    """
    DeepFilterNet3 speech enhancement (48 kHz, CPU, ~18 ms per audio second):
    noise out before the recognizer. 16 kHz in and out; resampled around it.
    """

    name = "dfn3"

    def __init__(self, atten_lim_db: float | None = None):
        import sys
        import types

        #: Cap on how much noise is taken out (dB); None = all of it. A cap leaves
        #: fewer artifacts for the recognizer.
        self.atten = atten_lim_db

        import torch
        import torchaudio.functional as AF

        # df 0.5.6 imports torchaudio.backend.common, gone from torchaudio 2.x;
        # it only uses the name for a type hint.
        if "torchaudio.backend.common" not in sys.modules:
            common = types.ModuleType("torchaudio.backend.common")
            common.AudioMetaData = object
            sys.modules["torchaudio.backend"] = types.ModuleType("torchaudio.backend")
            sys.modules["torchaudio.backend.common"] = common
        from df.enhance import enhance, init_df

        self.torch, self.AF, self.enhance = torch, AF, enhance
        self.model, self.state, _ = init_df(log_level="ERROR")
        self.sr = self.state.sr()
        import threading

        self.lock = threading.Lock()  # the model keeps state per call

    def __call__(self, audio: np.ndarray) -> np.ndarray:
        if len(audio) < RATE // 10:
            return audio
        t = self.torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))[None]
        up = self.AF.resample(t, RATE, self.sr)
        with self.lock:
            y = self.enhance(self.model, self.state, up, atten_lim_db=self.atten)
        return self.AF.resample(y, self.sr, RATE)[0].numpy().astype(np.float32)


class Enhanced:
    """An engine behind a speech enhancer: same interface, `model` says both."""

    def __init__(self, engine, enhancer):
        self.engine, self.enhancer = engine, enhancer
        self.name = engine.name
        self.model = f"{engine.model}+{enhancer.name}"

    def transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        return self.engine.transcribe(self.enhancer(audio))

    def raw(self, audio: np.ndarray) -> tuple[str, str]:
        return self.engine.transcribe(audio)


def load_engine(name: str, enhance: str = ""):
    e = _load(name)
    if enhance == "dfn3":
        return Enhanced(e, DeepFilter())
    if enhance:
        raise SystemExit(f"unknown enhancer {enhance} (dfn3)")
    return e


class Fake:
    """For tests (unit/local-stt-gate.test.ts): no model, answers the audio length."""

    name = "fake"
    model = "fake"

    def transcribe(self, audio):
        return f"{len(audio) / RATE:.2f}s", "en"


def _load(name: str):
    if name == "fake":
        return Fake()
    if name == "sensevoice":
        return SenseVoice()
    if name == "mlx-whisper":
        return MlxWhisper()
    raise SystemExit(f"unknown engine {name} (sensevoice | mlx-whisper)")
