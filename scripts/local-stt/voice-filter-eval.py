#!/usr/bin/env python3
"""
How often would the voiceprint filter eat the owner's own words, and how often
does it stop someone else? Where the filter's line (voiceprint.FILTER_BELOW)
comes from (docs/local-stt.md, "Only my voice").

Files only, read-only: nothing is played, nothing leaves this Mac, ~/lianki-voice-clips
is never written, and no print is saved. Embeddings live in memory for one run
and only aggregate rates are printed or written, never a clip's name, text or score.

    nice -n 20 taskpolicy -b ~/.cache/lianki-stt/grid-venv/bin/python -I \
        scripts/local-stt/voice-filter-eval.py [--clips ~/lianki-voice-clips] [--json out.json]

Owner: the clips with a reference (refs-agent.json: his speech to the agent,
iPhone, by the agent's judgement). Two enrolments, both throwaway and in memory:
5-fold (16 enrol, 4 test), and 30 draws of 10 enrol / 10 test (the smallest
enrolment the panel saves). Each held-out clip is scored whole, as 1.5 / 2 / 3 / 5 s
crops, and through simulated channels: real noise (DEMAND), a lower level, a phone
band, and a dull one. None of those is a whisper or a cold: the clips hold neither.

Others: real people (the sherpa-onnx speaker test set), the page's TTS voices and
a shop PA, each clean and "through the room" 10 dB under him over restaurant noise.

The other 191 clips have no label, and some hold other voices: they are reported
as a mixture, so their share under a line is an upper bound on his false rejects.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import warnings

import numpy as np

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gridlib as G  # noqa: E402
import voiceprint as VP  # noqa: E402

RATE = G.RATE
LINES = [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]
PUBLIC = os.path.join(G.CACHE, "spk-public")
TTS_LANGS = ("zh", "ja", "en", "ko", "de", "es", "fr", "it", "pt")


def bandpass(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x)).astype(np.float32)


def crops(x: np.ndarray, seconds: float, most: int = 3) -> list[np.ndarray]:
    """Up to `most` crops of that length, each starting at speech (the VAD's pad is not in them)."""
    k = int(seconds * RATE)
    if len(x) < k:
        return []
    db = G.frame_db(x)
    top = np.percentile(db, 95)
    on = np.nonzero(db > top - 25)[0] * 160
    out, at = [], 0
    for s in on:
        if s < at or s + k > len(x):
            continue
        out.append(x[s : s + k])
        at = s + k
        if len(out) >= most:
            break
    return out


class Rates:
    """Scores and gates of one set: what share falls under each line, the gates applied."""

    def __init__(self):
        self.rows: list[tuple[float, float, float]] = []

    def add(self, e, x, c):
        if e is None:
            return
        sp, snr = VP.speech_stats(x)
        self.rows.append((float(e @ c), sp, snr))

    def out(self) -> dict:
        if not self.rows:
            return {"n": 0}
        a = np.array(self.rows)
        gated = (a[:, 1] >= VP.MIN_SPEECH_S) & (a[:, 2] >= VP.MIN_SNR_DB)
        return {
            "n": len(a),
            "gated": round(float(gated.mean()), 3),
            "p5": round(float(np.percentile(a[:, 0], 5)), 3),
            "p25": round(float(np.percentile(a[:, 0], 25)), 3),
            "median": round(float(np.median(a[:, 0])), 3),
            "min": round(float(a[:, 0].min()), 3),
            # Share of the whole set that the filter would drop at each line.
            "under": {str(t): round(float(((a[:, 0] < t) & gated).mean()), 4) for t in LINES},
            # The same for other gates: "<seconds of speech>/<SNR dB>".
            "grid": {f"{sp:g}/{snr:g}": {str(t): round(float(((a[:, 0] < t) & (a[:, 1] >= sp) & (a[:, 2] >= snr)).mean()), 4)
                                         for t in LINES}
                     for sp in (1.5, 2.0, 3.0) for snr in (-99.0, 5.0, 8.0, 10.0)},
        }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--json", default="")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--model", default="campp", choices=sorted(VP.MODELS))
    ap.add_argument("--real-print", action="store_true", help="also score the clips against his enrolled prints")
    a = ap.parse_args()

    embed = VP.Embedder(VP.MODELS[a.model], a.threads)
    rng = np.random.default_rng(380)
    refs = G.references(a.clips)
    names = sorted(refs)
    owner = [G.load(os.path.join(a.clips, n + ".wav")) for n in names]
    level = float(np.median([G.level_db(x) for x in owner]))
    emb = [embed(x) for x in owner]
    print(f"owner clips {len(owner)}, speech level {level:.1f} dBFS", file=sys.stderr, flush=True)

    rest = G.demand("restaurant")
    street = G.demand("street")

    def noisy(x, src, snr):
        off = int(rng.integers(0, len(src) - len(x)))
        return G.mix(x, src[off : off + len(x)], snr)

    channels = {
        "clean": lambda x: x,
        "restaurant-20dB": lambda x: noisy(x, rest, 20),
        "restaurant-10dB": lambda x: noisy(x, rest, 10),
        "restaurant-5dB": lambda x: noisy(x, rest, 5),
        "restaurant-0dB": lambda x: noisy(x, rest, 0),
        "street-10dB": lambda x: noisy(x, street, 10),
        "quiet-12dB": lambda x: G.gain(x, -12),
        "quiet-24dB": lambda x: G.gain(x, -24),
        "phone-band": lambda x: bandpass(x, 300, 3400),
        "dull-2500Hz": lambda x: bandpass(x, 60, 2500),
    }
    lengths = {"whole": None, "1.5s": 1.5, "2s": 2.0, "3s": 3.0, "5s": 5.0}

    res: dict = {"owner": {}, "owner10": {}, "others": {}, "unlabelled": {}}

    def fold_eval(store: dict, enrol: list[int], test: list[int]):
        c = VP.unit(np.mean([emb[i] for i in enrol], axis=0))
        for i in test:
            x = owner[i]
            for ch, fn in channels.items():
                y = fn(x)
                store.setdefault(f"{ch}/whole", Rates()).add(embed(y), y, c)
            for ln, s in lengths.items():
                if s is None:
                    continue
                for z in crops(x, s):
                    store.setdefault(f"clean/{ln}", Rates()).add(embed(z), z, c)
                    y = noisy(z, rest, 10)
                    store.setdefault(f"restaurant-10dB/{ln}", Rates()).add(embed(y), y, c)

    order = rng.permutation(len(owner))
    folds = np.array_split(order, 5)
    r5: dict = {}
    for k in range(5):
        test = [int(i) for i in folds[k]]
        fold_eval(r5, [i for i in range(len(owner)) if i not in test], test)
    res["owner"] = {k: v.out() for k, v in r5.items()}
    print("5-fold done", file=sys.stderr, flush=True)
    r10: dict = {}
    for _ in range(30):
        p = rng.permutation(len(owner))
        c = VP.unit(np.mean([emb[int(i)] for i in p[:10]], axis=0))
        for i in p[10:]:
            r10.setdefault("clean/whole", Rates()).add(emb[int(i)], owner[int(i)], c)
    res["owner10"] = {k: v.out() for k, v in r10.items()}

    # Others, against his whole-set mean: discarded with this process.
    centre = VP.unit(np.mean(emb, axis=0))
    real = sorted(glob.glob(os.path.join(PUBLIC, "*.wav")))
    tts = G.tts_voices(TTS_LANGS, 6)
    pa = G.tts_voices(("ja",), 12, min_s=4.0, skip=40)
    sets = {"real-people": [(f, G.load(f)) for f in real],
            "tts": [(f, G.load(f)) for f in tts],
            "pa": [(f, G.pa_chain(G.load(f), rng)) for f in pa]}
    o: dict = {}
    for name, items in sets.items():
        for _f, x in items:
            x = G.normalise(x, level)
            y = G.reverb(x, rng)
            off = int(rng.integers(0, max(1, len(rest) - len(y))))
            room = G.mix(G.gain(y, -10), rest[off : off + len(y)], 10)
            for tag, z in (("clean", x), ("room", room)):
                o.setdefault(f"{name}/{tag}/whole", Rates()).add(embed(z), z, centre)
                for s in (2.0, 3.0):
                    for w in crops(z, s):
                        o.setdefault(f"{name}/{tag}/{s:g}s", Rates()).add(embed(w), w, centre)
    res["others"] = {k: v.out() for k, v in o.items()}
    print("others done", file=sys.stderr, flush=True)

    # The other clips, unlabelled: iPhone against Android (the user agent, never printed).
    def device_of(s: dict) -> str:
        lab = str(s.get("label") or "")
        return "android" if "Android" in lab else "iphone" if "iPhone" in lab else "other"

    un: dict = {}
    droid: list[tuple[np.ndarray, np.ndarray]] = []
    for w in sorted(glob.glob(os.path.join(a.clips, "*.wav"))):
        n = os.path.basename(w)[:-4]
        if n in refs:
            continue
        x = G.load(w)
        e = embed(x)
        dev = device_of(G.sidecar(w))
        un.setdefault(dev, Rates()).add(e, x, centre)
        if e is not None and dev == "android":
            droid.append((e, x))
    res["unlabelled"] = {k: v.out() for k, v in un.items()}

    # A print from that device: the clips very likely his (>= 0.35 to his iPhone mean, 3 s of
    # speech, 10 dB), 5-fold, against the other clips of that device. An approximation of
    # enrolling on the device: how much of the mismatch is the channel.
    if droid:
        sure, rest_d = [], []
        for e, x in droid:
            sp, snr = VP.speech_stats(x)
            (sure if float(e @ centre) >= 0.35 and sp >= 3.0 and snr >= VP.MIN_SNR_DB else rest_d).append((e, x))
        same = Rates()
        mix = Rates()
        if len(sure) >= 5:
            idx = rng.permutation(len(sure))
            for f in np.array_split(idx, 5):
                test = {int(i) for i in f}
                c = VP.unit(np.mean([sure[i][0] for i in range(len(sure)) if i not in test], axis=0))
                for i in test:
                    same.add(sure[i][0], sure[i][1], c)
            c = VP.unit(np.mean([e for e, _x in sure], axis=0))
            for e, x in rest_d:
                mix.add(e, x, c)
        res["android-print"] = {"enrol-pool": len(sure), "held-out": same.out(), "rest-mixture": mix.out()}

    # His real print, once he has enrolled: the clips against it, per device. This is the
    # re-check before the line is trusted (the lines above come from throwaway enrolments on
    # conversational iPhone clips, not sentences read aloud on the device).
    if a.real_print:
        store = VP.Store()
        real: dict = {}
        for p in store.prints():
            if p["model"] != a.model:
                continue
            c = store.load(p["device"], p["model"])["_centroid"]
            own, mix = Rates(), {}
            for x, e in zip(owner, emb):
                own.add(e, x, c)
            for w in sorted(glob.glob(os.path.join(a.clips, "*.wav"))):
                n = os.path.basename(w)[:-4]
                if n not in refs:
                    x = G.load(w)
                    mix.setdefault(device_of(G.sidecar(w)), Rates()).add(embed(x), x, c)
            real[p["device"]] = {"labelled": own.out(), **{k: v.out() for k, v in mix.items()}}
        res["real-print"] = real

    txt = json.dumps(res, indent=1, sort_keys=True)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(txt)
    print(txt)


if __name__ == "__main__":
    main()
