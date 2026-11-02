#!/usr/bin/env python3
"""
The wake-word measurement in docs/wake-word.md: sherpa-onnx open-vocabulary
KWS (kws-zipformer-zh-en-3M-2025-12-20, int8) over WAV/MP3 files, never
played. Positives (wake-gen.py's pos/), the same in babble of his own clips
at 10/5/0 dB, and negatives: his clips (~/lianki-voice-clips) with their
noisy copies (noisy.py), the agent's TTS clips, and the adversarial set.
The keywords are the browser's (packages/debug-chat/src/wake.ts LINKY).

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/wake-eval.py \\
        --model ~/.cache/lianki-stt/models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20 \\
        --set OUT_DIR [--clips ~/lianki-voice-clips] [--noisy ~/.cache/lianki-stt/noisy-clips] \\
        [--tts ~/.cache/lianki-voice/out/voice] [--tts-n 600]

The model is the official release tarball (sherpa-onnx kws-models).
"""
import argparse
import glob
import os
import random
import tempfile
import time

import numpy as np
import soundfile as sf
import sherpa_onnx

# packages/debug-chat/src/wake.ts LINKY
KEYWORDS = """L IH1 NG K IY0 @LINKY
L IH1 NG K IY1 @LINKY
L IH1 N K IY1 @LINKY
L EH1 NG K IY0 @LINKY
l ín k ì @LINKY
l ín q í @LINKY
l ín k ī @LINKY
"""


def spotter(model, kw_file, thr, score):
    return sherpa_onnx.KeywordSpotter(
        tokens=f"{model}/tokens.txt",
        encoder=f"{model}/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
        decoder=f"{model}/decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
        joiner=f"{model}/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
        keywords_file=kw_file, num_threads=1, keywords_score=score,
        keywords_threshold=thr, provider="cpu")


_cache = {}


def load(f):
    if f not in _cache:
        x, sr = sf.read(f, dtype="float32", always_2d=True)
        x = x.mean(1)
        if sr != 16000:
            n = int(len(x) * 16000 / sr)
            x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
        _cache[f] = x
    return _cache[f]


def mix(x, noise, snr):
    nz = np.resize(noise, len(x))
    ps, pn = np.mean(x ** 2) + 1e-12, np.mean(nz ** 2) + 1e-12
    return (x + nz * np.sqrt(ps / (pn * 10 ** (snr / 10)))).astype(np.float32)


def run(k, files, noise=None, snr=None):
    hits, secs, t0, names = 0, 0.0, time.time(), []
    for f in files:
        x = np.concatenate([np.zeros(8000, np.float32), load(f), np.zeros(16000, np.float32)])
        if noise is not None:
            x = mix(x, noise, snr)
        secs += len(x) / 16000
        s, found = k.create_stream(), False
        for i in range(0, len(x), 1600):
            s.accept_waveform(16000, x[i:i + 1600])
            while k.is_ready(s):
                k.decode_stream(s)
                if k.get_result(s):
                    found = True
                    k.reset_stream(s)
        hits += found
        if found:
            names.append(os.path.basename(f))
    rtf = (time.time() - t0) / max(secs, 1e-9)
    return f"{hits}/{len(files)} hit · {secs:.0f} s audio · rtf {rtf:.4f}", names


def main():
    home = os.path.expanduser("~")
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--set", required=True, help="wake-gen.py's OUT_DIR")
    ap.add_argument("--clips", default=f"{home}/lianki-voice-clips")
    ap.add_argument("--noisy", default=f"{home}/.cache/lianki-stt/noisy-clips")
    ap.add_argument("--tts", default=f"{home}/.cache/lianki-voice/out/voice")
    ap.add_argument("--tts-n", type=int, default=600)
    a = ap.parse_args()
    kw = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    kw.write(KEYWORDS)
    kw.close()
    pos = sorted(glob.glob(f"{a.set}/pos/*.wav"))
    adv = sorted(glob.glob(f"{a.set}/neg/*.wav"))
    real = sorted(glob.glob(f"{a.clips}/*.wav")) + sorted(glob.glob(f"{a.noisy}/*.wav"))
    tts = sorted(glob.glob(f"{a.tts}/**/*.mp3", recursive=True))
    random.seed(1)
    tts = random.sample(tts, min(a.tts_n, len(tts)))
    own = sorted(glob.glob(f"{a.clips}/*.wav"))[:6]
    babble = np.concatenate([load(f) for f in own]) if own else None
    for thr, score in ((0.25, 1.0), (0.15, 1.5)):
        k = spotter(a.model, kw.name, thr, score)
        print(f"\n## threshold {thr} · score {score}")
        print(" positives          ", run(k, pos)[0])
        if babble is not None:
            for snr in (10, 5, 0):
                print(f" positives {snr:>2} dB    ", run(k, pos, babble, snr)[0])
        r, names = run(k, adv)
        print(" adversarial        ", r, names)
        r, names = run(k, real)
        print(" his clips + noisy  ", r, names)
        r, names = run(k, tts)
        print(" agent TTS          ", r, names)
    os.unlink(kw.name)


if __name__ == "__main__":
    main()
