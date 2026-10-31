#!/usr/bin/env python3
"""
Synthetic "Linky" utterances and near-misses for the wake-word evaluation
(docs/wake-word.md), written as WAV files, never played. Kokoro voices:
English (US/UK) and es/fr/hi accents saying "Linky", Chinese voices saying
林琪/林基 (Kokoro's zh voices mangle a Latin "Linky", so those are in hanzi),
and adversarial phrases (Lianki, Lincoln, link, lean key, 林肯, 临期, …).

    ~/.cache/lianki-voice/kokoro/.venv/bin/python -I scripts/local-stt/wake-gen.py OUT_DIR

Writes OUT_DIR/pos/*.wav and OUT_DIR/neg/*.wav (24 kHz). Japanese voices need
the unidic dictionary (python -m unidic download); without it they are skipped.
"""
import os
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

POS = [
    ("a", "af_heart", ["Linky.", "Hey Linky.", "Linky, what's next?", "Linky, stop."]),
    ("a", "am_adam", ["Linky.", "Linky, read it again."]),
    ("a", "am_michael", ["Linky.", "Okay Linky."]),
    ("a", "af_bella", ["Linky.", "Linky, are you there?"]),
    ("b", "bf_emma", ["Linky.", "Linky, next word."]),
    ("b", "bm_george", ["Linky.", "Hey Linky."]),
    ("e", "ef_dora", ["Linky."]),
    ("f", "ff_siwis", ["Linky."]),
    ("h", "hf_alpha", ["Linky."]),
    ("z", "zf_xiaobei", ["林琪。", "林琪，下一个。", "林基，再读一遍。", "林琪，停一下。"]),
    ("z", "zm_yunxi", ["林琪。", "林琪，下一个。", "林基，再读一遍。", "林琪，停一下。"]),
    ("z", "zf_xiaoxiao", ["林琪。", "林琪，下一个。", "林基，再读一遍。", "林琪，停一下。"]),
    ("j", "jf_alpha", ["リンキー。", "リンキー、次は？"]),
    ("j", "jm_kumo", ["リンキー、もう一回。", "リンキー。"]),
]
NEG_EN = [
    "Open Lianki and study.", "Lianki is a spaced repetition app.", "Abraham Lincoln.",
    "Click the link here.", "I'm linking the cards.", "My pinky hurts.", "That room is dinky.",
    "Lean key points first.", "Let me think.", "Lucky you.", "Lanky guy.", "Blinking lights.",
]
NEG_ZH = [
    "林肯是美国总统。", "请领取你的奖励。", "这个牛奶临期了。", "大汗淋漓。", "零件坏了。",
    "打开Lianki学习。", "林老师，你好。", "灵气很足。",
]
NEG = [("a", v, NEG_EN) for v in ("af_heart", "am_adam", "bf_emma")] + [
    ("z", v, NEG_ZH) for v in ("zf_xiaobei", "zm_yunxi")
]


def render(plan, out, speeds):
    os.makedirs(out, exist_ok=True)
    pipes = {}
    for lc, voice, texts in plan:
        try:
            p = pipes.setdefault(lc, KPipeline(lang_code=lc, repo_id="hexgrad/Kokoro-82M"))
        except Exception as e:  # e.g. Japanese without unidic
            print(f"skip {lc}/{voice}: {str(e).splitlines()[0]}", file=sys.stderr)
            continue
        for i, t in enumerate(texts):
            for s in speeds:
                a = np.concatenate([np.asarray(x) for _, _, x in p(t, voice=voice, speed=s)])
                fn = f"{out}/{voice}-{i:02d}-{s}.wav"
                sf.write(fn, a, 24000)
                print(fn, repr(t))


if __name__ == "__main__":
    root = sys.argv[1]
    render(POS, f"{root}/pos", (0.9, 1.15))
    render(NEG, f"{root}/neg", (1.0,))
