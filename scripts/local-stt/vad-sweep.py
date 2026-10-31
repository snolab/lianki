#!/usr/bin/env python3
"""
How sensitive should the mic's VAD be? (docs/stt-ab.md, "VAD sensitivity")

Replays the owner's saved clips and synthetic mixes (files only, nothing is
played) through Silero v5, the model vad-web 0.0.30 runs on the phone, and
the start/end logic of vad-web plus the mic's streaming endpoint, for a grid
of start thresholds (fixed, or noise-adaptive: floor EMA + delta), minimum
speech lengths and pre-speech pads. Each utterance is decoded by SenseVoice.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/vad-sweep.py \
        [--clips ~/lianki-voice-clips] [--tts ~/.cache/lianki-stt/tts-echo] \
        [--words ~/.cache/lianki-stt/tts-words] [--json out.json]

Sets:
- speech: the clips with a reference (ab-eval.py's refs). Missed = no
  utterance; clipped onset = the reference's first two characters are not
  among the transcript's first four; CER.
- short: single words (the word lists' own recordings, --words) at the
  owner's speech level between 1 s and 1.5 s of faint room noise. Should
  trigger, and the word should come out.
- not-for-agent: the clips without a reference (captures of speech not meant
  for the agent, or noise). Fewer triggers is better.
- echo: the word lists' example sentences (--tts; the voices the page plays)
  at the owner's level −6 dB (no AEC, loud speaker) and −25 dB (what an echo
  canceller leaves). Any non-empty transcript is a false trigger.
- noise: pink, brown, mains hum and clicks, 10 s each, and far babble (three
  example sentences at −15 dB), never speech of his.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("ab_eval", os.path.join(HERE, "ab-eval.py"))
ab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ab)  # type: ignore[union-attr]
from engines import RATE  # noqa: E402

FRAME = ab.FRAME
RED_F = ab.REDEMPTION_MS // 32
#: Endpoint thresholds (mic.ts): unchanged in every config.
EP = dict(margin=0.25, lo=0.35, hi=0.8, alpha=0.05)


def segment(p, n_samples, *, pos, neg, min_ms, pad_ms, endpoint_ms=600, adapt=None):
    """
    vad-web 0.0.30's frame processor plus the mic's endpoint, as in
    ab-eval.segment, with the start threshold either fixed (pos) or
    noise-adaptive: max(lo, min(0.8, floor + delta)) with adapt=(delta, lo),
    the floor the EMA of Silero between utterances (FLOOR_ALPHA 0.05).
    Returns [{start, first, end}] in samples.
    """
    pad_f, min_f = pad_ms // 32, max(1, min_ms // 32)
    ep_f = int(np.ceil(endpoint_ms / 32)) if endpoint_ms else None
    segs, floor, i, restart, n = [], 0.1, 0, 0, len(p)
    while i < n:
        while i < n:
            start_thr = pos if adapt is None else max(adapt[1], min(0.8, floor + adapt[0]))
            if p[i] >= start_thr:
                break
            floor += (p[i] - floor) * EP["alpha"]
            i += 1
        if i >= n:
            break
        s_pos = start_thr
        s_neg = min(neg, s_pos - 0.05) if adapt is None else max(0.05, s_pos - 0.05)
        start_f = max(restart, i - pad_f)
        ep_thr = min(EP["hi"], max(EP["lo"], floor + EP["margin"]))
        heard, quiet, red, speech_f, end_f, j = False, 0, 0, 0, None, i
        while j < n:
            q = p[j]
            if q >= s_pos:
                speech_f += 1
            if ep_f is not None:
                if q >= ep_thr:
                    heard, quiet = True, 0
                else:
                    quiet += 1
                if heard and quiet >= ep_f:
                    end_f = j + 1
                    break
            if q >= s_pos:
                red = 0
            elif q < s_neg:
                red += 1
                if red >= RED_F:
                    end_f = j + 1
                    break
            j += 1
        end_f = n if end_f is None else end_f
        if speech_f >= min_f:
            segs.append({"start": start_f * FRAME, "first": i * FRAME,
                         "end": n_samples if end_f == n else end_f * FRAME})
        restart = i = end_f
    return segs


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)


def scale_to(x, db):
    return x * 10 ** ((db - rms_db(x)) / 20)


def resample(x, sr):
    if sr == RATE:
        return x.astype(np.float32)
    t = np.arange(0, len(x) / sr, 1 / RATE)
    return np.interp(t, np.arange(len(x)) / sr, x).astype(np.float32)


def load(path):
    a, sr = sf.read(path, dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    return resample(a, sr)


def colored(n, kind, rng):
    w = rng.standard_normal(n)
    f = np.fft.rfft(w)
    k = np.arange(len(f)) + 1.0
    f /= np.sqrt(k) if kind == "pink" else k  # pink 1/f, brown 1/f^2
    return np.fft.irfft(f, n).astype(np.float32)


def ticks(n, db):
    """The send tick (mic.ts scheduleTick: 880 Hz, plus 1320 Hz from 30 ms, 80 ms decaying), every second."""
    out = np.zeros(n, dtype=np.float32)
    k = int(0.08 * RATE)
    t = np.arange(k) / RATE
    env = np.exp(-t / 0.012)
    tone = (np.sin(2 * np.pi * 880 * t) + (t >= 0.03) * np.sin(2 * np.pi * 1320 * t)) * env
    for s in range(RATE // 2, n - k, RATE):
        out[s : s + k] = tone
    return scale_to(out, db)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--tts", default=os.path.expanduser("~/.cache/lianki-stt/tts-echo"))
    ap.add_argument("--words", default=os.path.expanduser("~/.cache/lianki-stt/tts-words"))
    ap.add_argument("--json")
    a = ap.parse_args()
    rng = np.random.default_rng(7)

    from engines import SenseVoice

    sv, vad = SenseVoice(), ab.Silero()
    sv.transcribe(np.zeros(RATE, dtype=np.float32))
    clips = ab.load_clips(a.clips)
    scored = [c for c in clips if c["ref"] is not None]
    others = [c for c in clips if c["ref"] is None]

    # the owner's speech level: RMS of the frames Silero calls speech, median over his clips
    lv = []
    for c in scored:
        pr = vad.probs(c["audio"])
        fr = c["audio"][: len(pr) * FRAME].reshape(-1, FRAME)[pr >= 0.5]
        if len(fr):
            lv.append(rms_db(fr))
    speech_db = float(np.median(lv))
    room = lambda n: scale_to(colored(n, "pink", rng), speech_db - 45)  # noqa: E731

    sets: dict[str, list[dict]] = {"speech": [], "short": [], "others": [], "echo": [], "noise": []}
    for c in scored:
        sets["speech"].append({"name": c["name"], "audio": c["audio"], "ref": c["ref"]})
    for c in others:
        sets["others"].append({"name": c["name"], "audio": c["audio"]})
    for f in sorted(os.listdir(a.words)) if os.path.isdir(a.words) else []:
        w = scale_to(load(os.path.join(a.words, f)), speech_db)
        x = np.concatenate([room(RATE), w + room(len(w)), room(int(1.5 * RATE))])
        sets["short"].append({"name": f, "audio": x, "ref": f.split("-", 1)[1].rsplit(".", 1)[0]})
    tts = [load(os.path.join(a.tts, f)) for f in sorted(os.listdir(a.tts))] if os.path.isdir(a.tts) else []
    for k, t in enumerate(tts):
        for rel in (-6, -25):
            e = scale_to(t, speech_db + rel)
            x = np.concatenate([room(RATE), e + room(len(e)), room(RATE)])
            sets["echo"].append({"name": f"tts{k}@{rel}dB", "audio": x})
    n10 = 10 * RATE
    t = np.arange(n10) / RATE
    hum = sum(np.sin(2 * np.pi * 50 * h * t) / h for h in (1, 2, 3, 5)).astype(np.float32)
    clicks = np.zeros(n10, dtype=np.float32)
    for s in rng.integers(0, n10 - 400, 40):
        clicks[s : s + 400] += rng.standard_normal(400).astype(np.float32) * np.exp(-np.arange(400) / 60)
    noises = {
        "pink -35": scale_to(colored(n10, "pink", rng), speech_db - 10),
        "pink -25": scale_to(colored(n10, "pink", rng), speech_db - 20),
        "brown -10": scale_to(colored(n10, "brown", rng), speech_db - 10),
        "hum -10": scale_to(hum, speech_db - 10),
        "clicks": scale_to(clicks, speech_db) + room(n10),
        "send ticks": ticks(n10, speech_db) + room(n10),
    }
    if len(tts) >= 6:
        for b in range(3):
            parts = [tts[(b * 3 + j) % len(tts)] for j in range(3)]
            m = np.zeros(max(len(x) for x in parts) + RATE, dtype=np.float32)
            for j, x in enumerate(parts):
                o = j * RATE // 2
                m[o : o + len(x)] += scale_to(x, speech_db - 15)[: len(m) - o]
            noises[f"babble far {b}"] = m + room(len(m))
    for k, x in noises.items():
        sets["noise"].append({"name": k, "audio": x})

    for s in sets.values():
        for item in s:
            item["p"] = vad.probs(item["audio"])

    starts = [("fixed", x, None) for x in (0.5, 0.45, 0.35, 0.3, 0.25, 0.2)] + [
        ("adaptive", None, (0.15, 0.2)),
        ("adaptive", None, (0.2, 0.25)),
        ("adaptive", None, (0.25, 0.3)),
    ]
    mins, pads = (400, 250, 150), (0, 200, 400, 800)
    dec_cache: dict = {}

    def decode(audio, s):
        key = (id(audio), s["start"], s["end"])
        if key not in dec_cache:
            t0 = time.perf_counter()
            dec_cache[key] = (sv.transcribe(audio[s["start"] : s["end"]])[0], (time.perf_counter() - t0) * 1000)
        return dec_cache[key]

    rows = []
    for kind, pos, adapt in starts:
        for mn in mins:
            for pad in pads:
                cfg = {"start": f"{pos}" if adapt is None else f"floor+{adapt[0]} (≥{adapt[1]})",
                       "minMs": mn, "padMs": pad}
                r = dict(cfg)
                # speech: missed, clipped onset, CER, trigger frame vs the phone's own (0.3)
                cers, clipped, missed, delay = [], 0, 0, []
                for it in sets["speech"]:
                    segs = segment(it["p"], len(it["audio"]), pos=pos or 0.3, neg=0.25, min_ms=mn, pad_ms=pad,
                                   adapt=adapt)
                    if not segs:
                        missed += 1
                        cers.append(1.0)
                        continue
                    hyp = " ".join(decode(it["audio"], s)[0] for s in segs)
                    cers.append(ab.cer(it["ref"], hyp))
                    rn, hn = ab.norm(it["ref"]), ab.norm(hyp)
                    if rn[:2] and rn[:2] not in hn[:4]:
                        clipped += 1
                    base = segment(it["p"], len(it["audio"]), pos=0.3, neg=0.25, min_ms=400, pad_ms=800)
                    if base:
                        delay.append((segs[0]["first"] - base[0]["first"]) / RATE * 1000)
                r.update(speechCER=float(np.mean(cers)), missed=missed, clipped=clipped,
                         n=len(sets["speech"]), startDelayMs=float(np.mean(delay)) if delay else 0.0)
                # short words: caught and right
                got, stx = 0, []
                for it in sets["short"]:
                    segs = segment(it["p"], len(it["audio"]), pos=pos or 0.3, neg=0.25, min_ms=mn, pad_ms=pad,
                                   adapt=adapt)
                    hyp = " ".join(decode(it["audio"], s)[0] for s in segs)
                    if ab.norm(it["ref"]) and ab.norm(it["ref"]) in ab.norm(hyp):
                        got += 1
                    stx.append((it["ref"], len(segs), hyp))
                r.update(shortGot=got, shortN=len(sets["short"]), shortTexts=stx)
                # false triggers: utterances with text, per set (pad 800 for these: text only)
                for name in ("others", "echo", "noise"):
                    trig, texts = 0, []
                    for it in sets[name]:
                        segs = segment(it["p"], len(it["audio"]), pos=pos or 0.3, neg=0.25, min_ms=mn,
                                       pad_ms=800, adapt=adapt)
                        tx = [decode(it["audio"], s)[0] for s in segs]
                        tx = [x for x in tx if ab.norm(x)]
                        if tx:
                            trig += 1
                            texts.append((it["name"], " ".join(tx)[:40]))
                    r[name] = trig
                    r[name + "N"] = len(sets[name])
                    r[name + "Texts"] = texts
                rows.append(r)
    print(f"speech level {speech_db:.1f} dBFS; sets: " + ", ".join(f"{k} {len(v)}" for k, v in sets.items()))
    print("\n| start | min ms | pad ms | speech CER | missed | onset clipped | short words heard / right | "
          "not-for-agent | echo −6 dB · −25 dB | noise (of which babble) |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        echo_hi = sum(1 for nm, _ in r["echoTexts"] if nm.endswith("@-6dB"))
        echo_lo = r["echo"] - echo_hi
        heard = sum(1 for _, k, _ in r["shortTexts"] if k)
        babble = sum(1 for nm, _ in r["noiseTexts"] if nm.startswith("babble"))
        print(f"| {r['start']} | {r['minMs']} | {r['padMs']} | {r['speechCER']:.3f} | {r['missed']}/{r['n']} | "
              f"{r['clipped']}/{r['n']} | {heard}/{r['shortN']} · {r['shortGot']} | "
              f"{r['others']}/{r['othersN']} | {echo_hi}/{r['echoN'] // 2} · {echo_lo}/{r['echoN'] // 2} | "
              f"{r['noise']}/{r['noiseN']} ({babble}) |")
    if a.json:
        json.dump({"speechDb": speech_db, "rows": rows}, open(a.json, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
