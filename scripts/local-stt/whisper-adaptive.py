#!/usr/bin/env python3
"""
An automatic whisper mode, validated offline (docs/stt-ab.md, "Whispering").
Files only, nothing is played.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/whisper-adaptive.py \
        [--clips ~/lianki-voice-clips] [--since 2026-10-30T18:40:00Z] [--json out.json]

The policy runs per 32 ms frame, as it would in the page, on what the phone
has: the raw frame's RMS and Silero's probability on the processed frame.

    floor  = EMA (α 0.02, ~1.6 s) of raw RMS dB over frames with p < 0.1    (the room)
    level  = running 90th percentile (step 3 dB) of raw RMS dB over frames with p ≥ 0.5 (his recent speech)
    enter whisper when level < ENTER_LEVEL and floor < QUIET_FLOOR and level − floor ≥ MIN_SNR
    leave whisper when level > EXIT_LEVEL or floor > NOISY_FLOOR (hysteresis: the gaps)
    whisper: gain = clamp(−20 − level, 0, 30) dB, up 0.5 / down 6 dB a frame, then tanh limiter at 0.9;
             VAD 0.2 / 0.15, minSpeechMs 150, endpoint 800 ms at ≥ 0.15 (floor + 0.1)
    normal:  no gain; VAD 0.3 / 0.25, minSpeechMs 250, endpoint 600 ms at ≥ 0.35 (floor + 0.25)

Start threshold and minimum speech are taken at the utterance's onset;
the endpoint follows the current state.

Sets, each a session of clips back to back (the state carries over, the way
it would while the mic is on):
- normal: his 20 scored clips as recorded (a quiet room) — must not lose
  accuracy against today's fixed settings;
- whisper: 2 normal clips, then the 20 whisperized (vad-sweep / whisper-eval
  stand-in, −46 dBFS), then 2 normal ones (the way back); plus his real
  whispered clips (voicing < 0.45) since --since, if any;
- noisy voice: the 20 clips with pink noise at 10 dB SNR (a loud room: the
  policy must stay normal);
- false triggers: room noises (quiet, fan, hum), far babble, others' speech
  (the not-for-agent clips) and the page's voices as echo at −25 dB, each
  after 3 s of quiet room. Counted: utterances with any text.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("whisper_eval", os.path.join(HERE, "whisper-eval.py"))
we = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(we)  # type: ignore[union-attr]
vs, ab = we.vs, we.ab
from engines import RATE  # noqa: E402

F = 512
NORMAL = dict(pos=0.3, neg=0.25, min_ms=250, ep_ms=600, ep_lo=0.35, ep_margin=0.25)
WHISPER = dict(pos=0.2, neg=0.15, min_ms=150, ep_ms=800, ep_lo=0.15, ep_margin=0.1)
POLICY = dict(ENTER_LEVEL=-34.0, EXIT_LEVEL=-30.0, QUIET_FLOOR=-50.0, NOISY_FLOOR=-45.0, MIN_SNR=8.0,
              FLOOR_ALPHA=0.02, LEVEL_P=0.5, LEVEL_Q=0.9, LEVEL_STEP=3.0, SLEW_DB=0.5, RELEASE_DB=6.0, TARGET=-20.0, MAX_GAIN=30.0)


def db(x):
    return 10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-12)


class Run:
    """Frame-by-frame: gain, Silero on the processed frame, the state, the segments."""

    def __init__(self, sil, adaptive: bool, policy=POLICY):
        self.s = sil.s
        self.adaptive, self.P = adaptive, policy

    def __call__(self, audio: np.ndarray):
        P = self.P
        state = np.zeros((2, 1, 128), dtype=np.float32)
        sr = np.array(RATE, dtype=np.int64)
        n = len(audio) // F
        floor, level, whisper, gain = -60.0, -20.0, False, 0.0
        out = np.zeros(n * F, dtype=np.float32)
        probs, modes = np.zeros(n), np.zeros(n, dtype=bool)
        p = 0.0
        for i in range(n):
            raw = audio[i * F : (i + 1) * F]
            r = db(raw)
            # the state from what has been heard so far (the previous frame's probability)
            if p < 0.1:
                floor += (r - floor) * P["FLOOR_ALPHA"]
            if p >= P["LEVEL_P"]:
                level += P["LEVEL_STEP"] * (P["LEVEL_Q"] - (r < level))  # a running 90th percentile
            if self.adaptive:
                if not whisper and level < P["ENTER_LEVEL"] and floor < P["QUIET_FLOOR"] and level - floor >= P["MIN_SNR"]:
                    whisper = True
                elif whisper and (level > P["EXIT_LEVEL"] or floor > P["NOISY_FLOOR"]):
                    whisper = False
            want = min(P["MAX_GAIN"], max(0.0, P["TARGET"] - level)) if whisper else 0.0
            gain += max(-P["RELEASE_DB"], min(P["SLEW_DB"], want - gain))  # rise slowly, fall fast
            fr = raw * 10 ** (gain / 20)
            if gain > 0:
                fr = we.soft_limit(fr)
            out[i * F : (i + 1) * F] = fr
            pr, state = self.s.run(None, {"input": fr[None, :].astype(np.float32), "state": state, "sr": sr})
            p = float(pr[0][0])
            probs[i], modes[i] = p, whisper
        return out, probs, modes


def segment(p, modes, n_samples, fixed=None):
    """vad-sweep.segment with per-frame settings (onset: start/min; live: endpoint)."""
    par = lambda i: fixed or (WHISPER if modes[i] else NORMAL)  # noqa: E731
    pad_f, red_f = 800 // 32, 1400 // 32
    segs, floor, i, restart, n = [], 0.1, 0, 0, len(p)
    while i < n:
        while i < n and p[i] < par(i)["pos"]:
            floor += (p[i] - floor) * 0.05
            i += 1
        if i >= n:
            break
        on = par(i)
        start_f = max(restart, i - pad_f)
        heard, quiet, red, speech, end_f, j = False, 0, 0, 0, None, i
        while j < n:
            q, cur = p[j], par(j)
            ep_thr = min(0.8, max(cur["ep_lo"], floor + cur["ep_margin"]))
            if q >= on["pos"]:
                speech += 1
            if q >= ep_thr:
                heard, quiet = True, 0
            else:
                quiet += 1
            if heard and quiet >= int(np.ceil(cur["ep_ms"] / 32)):
                end_f = j + 1
                break
            if q >= on["pos"]:
                red = 0
            elif q < on["neg"]:
                red += 1
                if red >= red_f:
                    end_f = j + 1
                    break
            j += 1
        end_f = n if end_f is None else end_f
        if speech >= max(1, on["min_ms"] // 32):
            segs.append({"start": start_f * F, "first": i * F, "end": n_samples if end_f == n else end_f * F,
                         "whisper": bool(on is WHISPER)})
        restart = i = end_f
    return segs


def session(items, gap_audio):
    """Clips back to back with a gap of room between; returns audio and each clip's span."""
    parts, spans, t = [], [], 0
    for it in items:
        parts += [it["audio"], gap_audio]
        spans.append((t, t + len(it["audio"])))
        t += len(it["audio"]) + len(gap_audio)
    return np.concatenate(parts).astype(np.float32), spans


def score(sv, audio, segs, items, spans):
    """Each utterance goes to the clip its onset falls in; CER per clip with a reference."""
    texts = {k: [] for k in range(len(items))}
    for s in segs:
        for k, (a, b) in enumerate(spans):
            if a <= s["first"] < b:
                texts[k].append(sv.transcribe(audio[s["start"] : s["end"]])[0])
                break
    cers = [ab.cer(it["ref"], " ".join(texts[k])) for k, it in enumerate(items) if it.get("ref")]
    return float(np.mean(cers)) if cers else float("nan"), texts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--since", default="2026-10-30T18:40:00Z")
    ap.add_argument("--json")
    a = ap.parse_args()
    rng = np.random.default_rng(5)

    from engines import SenseVoice

    sv, sil = SenseVoice(), ab.Silero()
    sv.transcribe(np.zeros(RATE, dtype=np.float32))
    clips = ab.load_clips(a.clips)
    since = datetime.fromisoformat(a.since.replace("Z", "+00:00"))
    scored = [c for c in clips if c["ref"] is not None and c["at"] < since]
    others = [c for c in clips if c["ref"] is None and c["at"] < since]
    real = [c for c in clips if c["at"] >= since]
    real_wh = [c for c in real if we.voicing(c["audio"], sil.probs(c["audio"])) < we.WHISPER_VOICING]

    speech_db = -26.0
    room = lambda n, d: vs.scale_to(vs.colored(n, "pink", rng), d)  # noqa: E731
    quiet = room(int(1.5 * RATE), speech_db - 50)
    normal = [{"audio": c["audio"], "ref": c["ref"]} for c in scored]
    wh = []
    for c in scored:
        w = we.whisperize(c["audio"], rng=rng)
        pr = sil.probs(c["audio"])
        fr = w[: len(pr) * F].reshape(-1, F)[pr >= 0.5]
        wh.append({"audio": (w * 10 ** ((speech_db - 20 - vs.rms_db(fr)) / 20)).astype(np.float32), "ref": c["ref"]})
    noisy = [{"audio": (c["audio"] + vs.scale_to(vs.colored(len(c["audio"]), "pink", rng), speech_db - 10)).astype(np.float32),
              "ref": c["ref"]} for c in scored]
    n10 = 10 * RATE
    tts_dir = os.path.expanduser("~/.cache/lianki-stt/tts-echo")
    tts = [vs.load(os.path.join(tts_dir, f)) for f in sorted(os.listdir(tts_dir))] if os.path.isdir(tts_dir) else []
    falses = {
        "quiet room": room(n10, speech_db - 50),
        "fan": room(n10, speech_db - 35),
        "hum": vs.scale_to(sum(np.sin(2 * np.pi * 50 * h * np.arange(n10) / RATE) / h for h in (1, 2, 3, 5)).astype(np.float32),
                           speech_db - 40) + room(n10, speech_db - 55),
    }
    for b in range(3):
        if len(tts) >= 9:
            parts = [tts[b * 3 + j] for j in range(3)]
            m = np.zeros(max(len(x) for x in parts) + RATE, dtype=np.float32)
            for j, x in enumerate(parts):
                m[j * RATE // 2 : j * RATE // 2 + len(x)] += vs.scale_to(x, speech_db - 15)[: len(m) - j * RATE // 2]
            falses[f"far babble {b}"] = m + room(len(m), speech_db - 50)
    for k, t in enumerate(tts[:12]):
        falses[f"echo −25 dB {k}"] = vs.scale_to(t, speech_db - 25) + room(len(t), speech_db - 50)
    for c in others:
        falses[f"not-for-agent {c['name'][11:19]}"] = c["audio"]

    runs = {"today": Run(sil, adaptive=False), "adaptive": Run(sil, adaptive=True)}
    res = {}
    sets = {
        "(a) normal voice, quiet room": normal,
        "(b) whispers (synthetic), between normal clips": normal[:2] + wh + normal[2:4],
        "(c1) normal voice in a loud room (pink, 10 dB SNR)": noisy,
    }
    if real_wh:
        sets["(b) whispers (real)"] = [{"audio": c["audio"], "ref": None} for c in real_wh]
    for name, items in sets.items():
        audio, spans = session(items, quiet)
        for rn, run in runs.items():
            proc, p, modes = run(audio)
            segs = segment(p, modes, len(proc), fixed=NORMAL if rn == "today" else None)
            c, texts = score(sv, proc, segs, items, spans)
            whisper_frac = float(modes.mean())
            res[(name, rn)] = {"cer": c, "utterances": len(segs), "whisperFrames": whisper_frac, "switches": int(np.sum(modes[1:] != modes[:-1])),
                               "texts": {k: v for k, v in texts.items()}}
            # whisper-only CER for the mixed session
            if name.startswith("(b) whispers (synthetic)"):
                cw = [ab.cer(items[k]["ref"], " ".join(texts[k])) for k in range(2, 2 + len(wh))]
                cn = [ab.cer(items[k]["ref"], " ".join(texts[k])) for k in list(range(2)) + list(range(2 + len(wh), len(items)))]
                res[(name, rn)].update(cerWhisper=float(np.mean(cw)), cerNormalAround=float(np.mean(cn)))
    ft = {}
    for rn, run in runs.items():
        trig, names = 0, []
        for k, x in falses.items():
            audio = np.concatenate([room(3 * RATE, speech_db - 50), x, room(RATE, speech_db - 50)]).astype(np.float32)
            proc, p, modes = run(audio)
            segs = segment(p, modes, len(proc), fixed=NORMAL if rn == "today" else None)
            tx = [sv.transcribe(proc[s["start"] : s["end"]])[0] for s in segs]
            if any(ab.norm(t) for t in tx):
                trig += 1
                names.append(k)
        ft[rn] = (trig, names)

    print(f"policy: {POLICY}")
    print("\n| set | today: CER, utterances | adaptive: CER, utterances, frames in whisper mode, mode switches |")
    print("| --- | --- | --- |")
    for name in sets:
        t, d = res[(name, "today")], res[(name, "adaptive")]
        extra = ""
        if "cerWhisper" in t:
            extra = (f" — whispers only {t['cerWhisper']:.3f} → {d['cerWhisper']:.3f}; normal clips around them "
                     f"{t['cerNormalAround']:.3f} → {d['cerNormalAround']:.3f}")
        print(f"| {name} | {t['cer']:.3f}, {t['utterances']} | {d['cer']:.3f}, {d['utterances']}, "
              f"{d['whisperFrames'] * 100:.0f}%, {d['switches']} switches |{extra}")
    for name in sets:
        if "(real)" in name:
            for rn in runs:
                print(f"  real whispers, {rn}: {res[(name, rn)]['texts']}")
    print(f"  real whispered clips: {[c['name'] for c in real_wh]}")
    print(f"\nfalse triggers ({len(falses)} sets): today {ft['today'][0]}, adaptive {ft['adaptive'][0]}")
    only = sorted(set(ft["adaptive"][1]) - set(ft["today"][1]))
    gone = sorted(set(ft["today"][1]) - set(ft["adaptive"][1]))
    print(f"  only adaptive: {only}\n  only today: {gone}")
    if a.json:
        json.dump({"policy": POLICY, "sets": {f"{k[0]} | {k[1]}": v for k, v in res.items()},
                   "falseTriggers": ft}, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1,
                  default=str)


if __name__ == "__main__":
    main()
