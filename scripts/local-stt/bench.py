#!/usr/bin/env python3
"""
A/B the local engines on the owner's saved clips (docs/local-stt.md), next to
the Workers AI transcript each clip's .json already holds. Whole-clip decode:
cold (the first decode after loading) and warm (best of 3), and the real-time
factor (warm decode / audio length). Streaming latency is measured separately
with stream-clip.ts against the running server.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/bench.py \
        [--clips ~/lianki-voice-clips] [--engines sensevoice,mlx-whisper] > bench.md
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engines import load_engine  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--engines", default="sensevoice,mlx-whisper")
    a = ap.parse_args()
    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    clips = []
    for w in wavs:
        x, sr = sf.read(w, dtype="float32")
        if x.ndim > 1:
            x = x.mean(1)
        meta = {}
        j = w[:-4] + ".json"
        if os.path.exists(j):
            meta = json.load(open(j))
        clips.append((os.path.basename(w), x, sr, meta))

    rows = {c[0]: {"s": len(c[1]) / c[2], "workers": c[3].get("transcript", "")} for c in clips}
    load_ms = {}
    for name in a.engines.split(","):
        t = time.perf_counter()
        e = load_engine(name)
        load_ms[name] = int((time.perf_counter() - t) * 1000)
        for i, (n, x, sr, _m) in enumerate(clips):
            t = time.perf_counter()
            text, lang = e.transcribe(x)
            cold = (time.perf_counter() - t) * 1000
            warm = []
            for _ in range(3):
                t = time.perf_counter()
                e.transcribe(x)
                warm.append((time.perf_counter() - t) * 1000)
            w = min(warm)
            rows[n][name] = {"text": text, "lang": lang, "cold": int(cold), "warm": int(w),
                             "rtf": w / 1000 / rows[n]["s"]}
            print(f"{name} {n} {int(cold)}/{int(w)} ms {text}", file=sys.stderr, flush=True)

    names = a.engines.split(",")
    print("| clip | s | Workers AI (today) | " + " | ".join(names) + " |")
    print("| --- | --- | --- | " + " | ".join("---" for _ in names) + " |")
    for n, r in rows.items():
        cells = []
        for e in names:
            x = r[e]
            cells.append(f"{x['text']} <br>`{x['lang']}` {x['cold']}/{x['warm']} ms, RTF {x['rtf']:.3f}")
        print(f"| {n[-10:-4]} | {r['s']:.1f} | {r['workers']} | " + " | ".join(cells) + " |")
    print()
    for e in names:
        warm = [r[e]["warm"] for r in rows.values()]
        rtf = [r[e]["rtf"] for r in rows.values()]
        print(f"- **{e}**: load {load_ms[e]} ms; warm mean {np.mean(warm):.0f} ms, "
              f"max {max(warm)} ms; mean RTF {np.mean(rtf):.3f}")


if __name__ == "__main__":
    main()
