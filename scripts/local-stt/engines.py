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


def load_engine(name: str):
    if name == "sensevoice":
        return SenseVoice()
    if name == "mlx-whisper":
        return MlxWhisper()
    raise SystemExit(f"unknown engine {name} (sensevoice | mlx-whisper)")
