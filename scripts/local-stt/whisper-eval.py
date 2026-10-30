#!/usr/bin/env python3
"""
Whisper mode: can the mic hear the owner whispering at night? (docs/stt-ab.md,
"Whispering"). Files only, nothing is played.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/whisper-eval.py \
        [--clips ~/lianki-voice-clips] [--since 2026-10-30T18:40:00Z] \
        [--kws ~/.cache/lianki-stt/models/kws-dl/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20] \
        [--whisper] [--json out.json]

Two sources of whispers:
- **real**: his clips saved since --since. Each is measured (speech level,
  voicing = the autocorrelation peak at 80–400 Hz pitch over Silero's speech
  frames; whispers have no pitch) and, with --whisper, also transcribed by
  mlx-whisper with the ?hint=zh prompt for a second opinion.
- **synthetic**: the 20 scored clips whisperized (per 32 ms frame, LPC order
  18; the excitation replaced by white noise of the residual's energy, so the
  formants stay and the pitch goes) and set 20 dB under his speech level.
  A stand-in until enough real ones exist; whispered speech also has its
  own timing and articulation, which this does not model.

Each clip goes through input processing (none, +12 dB, +18 dB with a soft
limiter, an AGC-like slow normalizer to −26 dBFS; then optionally
pre-emphasis 0.97 or a low-shelf de-emphasis), then vad-web's Silero v5
start/end logic (vad-sweep.segment) at positive thresholds 0.3 → 0.15
(negative = positive − 0.05), minimum speech 250 / 150 ms, pad 800 ms, the
600 ms endpoint, then SenseVoice. False triggers: the noise and voice sets
of vad-sweep (room noise at quiet-night levels, others' voices and the
page's voices at normal level, so ~20 dB over a whisper) through the same
processing. With --kws, "Linky" is spotted (#350's keywords, threshold 0.25,
score 1.0) on every real clip under each processing.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from datetime import datetime

import numpy as np
from scipy.linalg import solve_toeplitz
from scipy.signal import lfilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("vad_sweep", os.path.join(HERE, "vad-sweep.py"))
vs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vs)  # type: ignore[union-attr]
ab = vs.ab
from engines import RATE  # noqa: E402

LINKY = """L IH1 NG K IY0 @LINKY
L IH1 NG K IY1 @LINKY
L IH1 N K IY1 @LINKY
l ín k ì @LINKY
l ín q í @LINKY
"""


# ---------------------------------------------------------------- signal
def whisperize(x: np.ndarray, order: int = 18, n: int = 512, hop: int = 256, rng=None) -> np.ndarray:
    """LPC re-synthesis with a white-noise excitation: formants kept, pitch gone."""
    rng = rng or np.random.default_rng(1)
    win = np.hanning(n).astype(np.float64)
    out = np.zeros(len(x) + n)
    norm = np.zeros(len(x) + n)
    for s in range(0, len(x) - n, hop):
        f = x[s : s + n].astype(np.float64) * win
        r = np.correlate(f, f, "full")[n - 1 : n + order]
        if r[0] < 1e-10:
            continue
        r[0] *= 1.0001
        a = solve_toeplitz(r[:order], -r[1 : order + 1])
        A = np.concatenate([[1.0], a])
        res = lfilter(A, [1.0], f)
        e = rng.standard_normal(n) * np.sqrt(np.mean(res**2))
        y = lfilter([1.0], A, e) * win
        out[s : s + n] += y
        norm[s : s + n] += win**2
    out = out[: len(x)] / np.maximum(norm[: len(x)], 1e-3)
    return out.astype(np.float32)


def soft_limit(x: np.ndarray, ceiling: float = 0.9) -> np.ndarray:
    return (ceiling * np.tanh(x / ceiling)).astype(np.float32)


def agc_like(x: np.ndarray, target_db: float = -26, max_gain_db: float = 30) -> np.ndarray:
    """A slow AGC: the gain follows a 1 s RMS envelope towards target, capped, then limited."""
    k = RATE // 4
    env = np.sqrt(np.convolve(x**2, np.ones(k) / k, "same") + 1e-12)
    peak = np.maximum.accumulate(env)  # never quieter than the loudest so far: no pumping on pauses
    gain = np.minimum(10 ** (target_db / 20) / np.maximum(peak, 1e-6), 10 ** (max_gain_db / 20))
    return soft_limit(x * gain)


PROC = {
    "none": lambda x: x,
    "+12 dB": lambda x: soft_limit(x * 10 ** (12 / 20)),
    "+18 dB": lambda x: soft_limit(x * 10 ** (18 / 20)),
    "AGC-like": agc_like,
}
TILT = {
    "flat": lambda x: x,
    "pre-emph": lambda x: lfilter([1, -0.97], [1], x).astype(np.float32),
    "low-shelf": lambda x: (lfilter([1], [1, -0.9], x) * 0.1).astype(np.float32),
}


#: Under this median pitch-autocorrelation peak a clip is whispered. His voiced clips sit at
#: 0.67–0.77 (median 0.70); the whisperized copies at about 0.3.
WHISPER_VOICING = 0.45


def voicing(x: np.ndarray, p: np.ndarray) -> float:
    """Median normalized autocorrelation peak at 2.5–12.5 ms lag over Silero's speech frames."""
    vals = []
    for i in np.nonzero(p >= 0.3)[0]:
        f = x[i * 512 : (i + 1) * 512].astype(np.float64)
        f = f - f.mean()
        e = np.dot(f, f)
        if e < 1e-9:
            continue
        ac = np.correlate(f, f, "full")[511:]
        vals.append(ac[40:200].max() / e)
    return float(np.median(vals)) if vals else 0.0


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--since", default="2026-10-30T18:40:00Z", help="clips saved after this are the real whispers")
    ap.add_argument("--kws", help="the KWS model directory (#350's)")
    ap.add_argument("--whisper", action="store_true", help="mlx-whisper + hint on the real clips")
    ap.add_argument("--json")
    a = ap.parse_args()
    rng = np.random.default_rng(3)

    from engines import SenseVoice

    sv, vad = SenseVoice(), ab.Silero()
    sv.transcribe(np.zeros(RATE, dtype=np.float32))
    clips = ab.load_clips(a.clips)
    since = datetime.fromisoformat(a.since.replace("Z", "+00:00"))
    real = [c for c in clips if c["at"] >= since]
    scored = [c for c in clips if c["ref"] is not None and c["at"] < since]

    # his normal speech level
    lv = []
    for c in scored:
        pr = vad.probs(c["audio"])
        fr = c["audio"][: len(pr) * 512].reshape(-1, 512)[pr >= 0.5]
        if len(fr):
            lv.append(vs.rms_db(fr))
    speech_db = float(np.median(lv))

    print(f"his normal speech: {speech_db:.1f} dBFS (median of speech frames, {len(scored)} clips)")
    print("\nreal clips since", a.since)
    mw = None
    if a.whisper and real:
        from engines import MlxWhisper

        mw = MlxWhisper()
        mw.PROMPT = ab.HINT_ZH
    real_info = []
    for c in real:
        p = vad.probs(c["audio"])
        fr = c["audio"][: len(p) * 512].reshape(-1, 512)[p >= 0.3]
        lvl = vs.rms_db(fr) if len(fr) else -99.0
        vo = voicing(c["audio"], p)
        info = {"name": c["name"], "s": round(c["s"], 1), "levelDb": round(lvl, 1), "voicing": round(vo, 2),
                "meanProb": round(float(p.mean()), 2), "maxProb": round(float(p.max()), 2),
                "sink": c["said"], "aec": c.get("aec")}
        if mw:
            info["whisper"] = mw.transcribe(c["audio"])[0]
        real_info.append(info)
        info["whispered"] = vo < WHISPER_VOICING
        print(f"  {c['name'][11:]}  {'WHISPER' if vo < WHISPER_VOICING else 'voiced '}  {c['s']:.1f}s  "
              f"level {lvl:6.1f} dB  voicing {vo:.2f}  Silero mean/max "
              f"{p.mean():.2f}/{p.max():.2f}  sink: {c['said']!r}" + (f"  whisper: {info['whisper']!r}" if mw else ""))
    if scored:
        vo_norm = [voicing(c["audio"], vad.probs(c["audio"])) for c in scored[:8]]
        print(f"  (his normal clips: voicing median {np.median(vo_norm):.2f})")

    # synthetic whispers
    syn = []
    for c in scored:
        w = whisperize(c["audio"], rng=rng)
        pr = vad.probs(c["audio"])
        fr = w[: len(pr) * 512].reshape(-1, 512)[pr >= 0.5]
        g = 10 ** ((speech_db - 20 - vs.rms_db(fr)) / 20) if len(fr) else 1.0
        syn.append({"name": c["name"], "audio": (w * g).astype(np.float32), "ref": c["ref"]})
    sv_vo = [voicing(it["audio"], vad.probs(it["audio"])) for it in syn[:8]]
    print(f"  (whisperized copies: voicing median {np.median(sv_vo):.2f})")
    room = lambda n, db: vs.scale_to(vs.colored(n, "pink", rng), db)  # noqa: E731
    n10 = 10 * RATE
    false_sets = {
        "quiet room (pink, speech −50 dB)": room(n10, speech_db - 50),
        "fan (pink, speech −35 dB)": room(n10, speech_db - 35),
        "hum (speech −40 dB)": vs.scale_to(
            sum(np.sin(2 * np.pi * 50 * h * np.arange(n10) / RATE) / h for h in (1, 2, 3, 5)).astype(np.float32),
            speech_db - 40,
        ) + room(n10, speech_db - 55),
    }
    others = [c for c in clips if c["ref"] is None and c["at"] < since]

    thresholds = (0.3, 0.25, 0.2, 0.15)
    rows = []
    dec: dict = {}

    def decode(key, audio):
        if key not in dec:
            dec[key] = sv.transcribe(audio)[0]
        return dec[key]

    for pname, proc in PROC.items():
        for tname, tilt in TILT.items():
            if tname != "flat" and pname not in ("none", "+18 dB"):
                continue
            s_proc = [(it, tilt(proc(it["audio"]))) for it in syn]
            s_probs = [vad.probs(x) for _, x in s_proc]
            f_proc = {k: tilt(proc(x)) for k, x in false_sets.items()}
            f_probs = {k: vad.probs(x) for k, x in f_proc.items()}
            o_proc = [tilt(proc(c["audio"])) for c in others]
            o_probs = [vad.probs(x) for x in o_proc]
            r_proc = [tilt(proc(c["audio"])) for c in real]
            r_probs = [vad.probs(x) for x in r_proc]
            for thr in thresholds:
                for mn in (250, 150):
                    kw = dict(pos=thr, neg=max(0.05, thr - 0.05), min_ms=mn, pad_ms=800)
                    cers, missed, clipped = [], 0, 0
                    for (it, x), p in zip(s_proc, s_probs):
                        segs = vs.segment(p, len(x), **kw)
                        if not segs:
                            missed += 1
                            cers.append(1.0)
                            continue
                        hyp = " ".join(decode((pname, tname, it["name"], s["start"], s["end"]),
                                              x[s["start"] : s["end"]]) for s in segs)
                        cers.append(ab.cer(it["ref"], hyp))
                        rn, hn = ab.norm(it["ref"]), ab.norm(hyp)
                        if rn[:2] and rn[:2] not in hn[:4]:
                            clipped += 1
                    noise_trig = []
                    for k, x in f_proc.items():
                        segs = vs.segment(f_probs[k], len(x), **kw)
                        tx = [decode((pname, tname, k, s["start"], s["end"]), x[s["start"] : s["end"]]) for s in segs]
                        if any(ab.norm(t) for t in tx):
                            noise_trig.append(k)
                    oth = 0
                    for c, x, p in zip(others, o_proc, o_probs):
                        segs = vs.segment(p, len(x), **kw)
                        if any(ab.norm(decode((pname, tname, c["name"], s["start"], s["end"]),
                                              x[s["start"] : s["end"]])) for s in segs):
                            oth += 1
                    real_rows = []
                    for c, x, p in zip(real, r_proc, r_probs):
                        segs = vs.segment(p, len(x), **kw)
                        real_rows.append(" ".join(decode((pname, tname, c["name"], s["start"], s["end"]),
                                                         x[s["start"] : s["end"]]) for s in segs))
                    rows.append({"proc": pname, "tilt": tname, "pos": thr, "minMs": mn,
                                 "synCER": float(np.mean(cers)), "synMissed": missed, "synClipped": clipped,
                                 "synN": len(syn), "noise": noise_trig, "noiseN": len(false_sets),
                                 "others": oth, "othersN": len(others), "real": real_rows})

    print("\nsynthetic whispers (20 of his clips whisperized, 20 dB under his voice):")
    print("| input | tilt | positive | min ms | CER | missed | onset clipped | room noise triggered | "
          "others' normal speech triggered |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        print(f"| {r['proc']} | {r['tilt']} | {r['pos']} | {r['minMs']} | {r['synCER']:.3f} | "
              f"{r['synMissed']}/{r['synN']} | {r['synClipped']}/{r['synN']} | {len(r['noise'])}/{r['noiseN']}"
              f"{' (' + ', '.join(n.split(' (')[0] for n in r['noise']) + ')' if r['noise'] else ''} | "
              f"{r['others']}/{r['othersN']} |")
    if real:
        print("\nreal clips, transcripts per setting (min 250):")
        for i, c in enumerate(real):
            print(f"  {c['name'][11:]}:")
            for r in rows:
                if r["minMs"] == 250 and r["tilt"] == "flat" and r["pos"] in (0.3, 0.2, 0.15):
                    print(f"    {r['proc']:8s} pos {r['pos']}: {r['real'][i]!r}")

    kws_out = []
    if a.kws and real:
        import tempfile

        import sherpa_onnx

        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(LINKY)
            kw_file = f.name
        m = a.kws
        k = sherpa_onnx.KeywordSpotter(
            tokens=f"{m}/tokens.txt",
            encoder=f"{m}/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
            decoder=f"{m}/decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
            joiner=f"{m}/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
            keywords_file=kw_file, num_threads=1, keywords_score=1.0, keywords_threshold=0.25, provider="cpu")
        print("\nwake word (#350 KWS, threshold 0.25 / score 1.0) on the real clips:")
        for c in real:
            hits = {}
            for pname, proc in PROC.items():
                x = np.concatenate([np.zeros(8000, np.float32), proc(c["audio"]), np.zeros(16000, np.float32)])
                s, found = k.create_stream(), False
                for i in range(0, len(x), 1600):
                    s.accept_waveform(RATE, x[i : i + 1600])
                    while k.is_ready(s):
                        k.decode_stream(s)
                        if k.get_result(s):
                            found = True
                            k.reset_stream(s)
                hits[pname] = found
            kws_out.append({"name": c["name"], **hits})
            print(f"  {c['name'][11:]}  " + "  ".join(f"{p}: {'hit' if h else '-'}" for p, h in hits.items())
                  + f"   ({c['said']!r})")

    if a.json:
        json.dump({"speechDb": speech_db, "real": real_info, "rows": rows, "kws": kws_out},
                  open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=float)


if __name__ == "__main__":
    main()
