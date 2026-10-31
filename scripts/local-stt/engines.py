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

    def transcribe(self, audio: np.ndarray) -> tuple[str, str]:
        s = self.r.create_stream()
        s.accept_waveform(RATE, audio)
        self.r.decode_stream(s)
        lang = (s.result.lang or "").strip("<|>")
        return tidy(s.result.text, lang), lang


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
