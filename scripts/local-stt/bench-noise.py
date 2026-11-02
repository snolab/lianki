#!/usr/bin/env python3
"""
Does speech enhancement help SenseVoice in noise, and not hurt it in quiet?
(docs/local-stt.md, "Noise".) For each saved clip and its noisy copies
(noisy.py), SenseVoice raw vs behind DeepFilterNet3, scored as character
error rate against a reference: the clip's `.ref.txt` if there is one, else
SenseVoice's own transcript of the clean clip (agreement, not truth).

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/bench-noise.py \
        [--clips ~/lianki-voice-clips] [--noisy ~/.cache/lianki-stt/noisy-clips]
"""
import argparse
import glob
import os
import re
import sys
import time

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engines import DeepFilter, SenseVoice  # noqa: E402


def norm(s: str) -> str:
    return re.sub(r"[\W_]+", "", s.lower())


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (r[i - 1] != h[j - 1]))
    return d[len(h)] / len(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--noisy", default=os.path.expanduser("~/.cache/lianki-stt/noisy-clips"))
    ap.add_argument("--atten", type=float, default=None, help="DFN3 attenuation cap, dB")
    a = ap.parse_args()
    sv, dfn = SenseVoice(), DeepFilter(a.atten)
    load = lambda p: sf.read(p, dtype="float32")[0]  # noqa: E731
    by_kind: dict[str, list[tuple[float, float]]] = {}
    enh_ms = []
    for w in sorted(glob.glob(os.path.join(a.clips, "*.wav"))):
        base = os.path.basename(w)[:-4]
        clean = load(w)
        refp = w[:-4] + ".ref.txt"
        ref = open(refp).read().strip() if os.path.exists(refp) else sv.transcribe(clean)[0]
        variants = [("clean", clean)] + [
            (os.path.basename(p)[len(base) + 1 : -4], load(p))
            for p in sorted(glob.glob(os.path.join(a.noisy, base + ".*.wav")))
        ]
        for kind, x in variants:
            raw = sv.transcribe(x)[0]
            t = time.perf_counter()
            y = dfn(x)
            enh_ms.append((time.perf_counter() - t) * 1000 / (len(x) / 16000))
            en = sv.transcribe(y)[0]
            by_kind.setdefault(kind, []).append((cer(ref, raw), cer(ref, en)))
            print(f"{base[-6:]} {kind:9} raw {cer(ref, raw):.2f} {raw[:40]} | dfn {cer(ref, en):.2f} {en[:40]}",
                  file=sys.stderr, flush=True)
    print("| audio | clips | CER raw | CER with DFN3 |")
    print("| --- | --- | --- | --- |")
    for kind, v in by_kind.items():
        r, e = np.mean([x[0] for x in v]), np.mean([x[1] for x in v])
        print(f"| {kind} | {len(v)} | {r:.3f} | {e:.3f} |")
    print(f"\nDFN3: {np.mean(enh_ms):.1f} ms per audio second (16k→48k→16k included)")


if __name__ == "__main__":
    main()
