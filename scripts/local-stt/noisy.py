#!/usr/bin/env python3
"""
Make noisy copies of the saved clips for the enhancement A/B (docs/local-stt.md),
written as files, never played. Two noises: babble (three other clips summed,
time-shifted, like a café) and pink noise (traffic / fan), each at a given SNR.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/noisy.py OUT_DIR [--snr 5,0]
"""
import argparse
import glob
import os

import numpy as np
import soundfile as sf


def pink(n: int, rng) -> np.ndarray:
    w = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(w)) + 1.0
    x = np.fft.irfft(w / np.sqrt(f), n)
    return x / (np.std(x) + 1e-9)


def mix(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    ps = np.mean(speech**2) + 1e-12
    pn = np.mean(noise**2) + 1e-12
    y = speech + noise * np.sqrt(ps / (pn * 10 ** (snr_db / 10)))
    return (y / max(1.0, np.max(np.abs(y)) / 0.99)).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--snr", default="5,0")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(7)
    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    audio = [sf.read(w, dtype="float32")[0] for w in wavs]
    for i, (w, x) in enumerate(zip(wavs, audio)):
        others = [audio[(i + k) % len(audio)] for k in (3, 5, 7)]
        babble = np.zeros_like(x)
        for k, o in enumerate(others):
            o = np.roll(np.resize(o, len(x)), 4000 * (k + 1))
            babble += o / (np.std(o) + 1e-9)
        for snr in [float(s) for s in a.snr.split(",")]:
            base = os.path.basename(w)[:-4]
            sf.write(os.path.join(a.out, f"{base}.babble{snr:g}.wav"), mix(x, babble, snr), 16000)
            sf.write(os.path.join(a.out, f"{base}.pink{snr:g}.wav"), mix(x, pink(len(x), rng), snr), 16000)


if __name__ == "__main__":
    main()
