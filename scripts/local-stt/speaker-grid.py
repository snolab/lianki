#!/usr/bin/env python3
"""
Speaker check under noise (docs/stt-ab.md, "Noise and speaker grid"; the
"start simple" experiment of #380 / docs/speaker-id.md, continued): can a
score accept only the owner in a noisy place, with family voices in the
background? Files only: nothing is played, nothing leaves this Mac, and only
aggregate rates are printed or written. No voiceprint is saved.

    ~/.cache/lianki-stt/grid-venv/bin/python -I scripts/local-stt/speaker-grid.py \
        --clips <a COPY of ~/lianki-voice-clips> [--batches start=label,…] [--yield-dir ~/lianki-voice-clips] \
        [--denoise none] [--md out.md] [--json out.json]

Scorers
- pitch: YIN F0 median and p10-p90 range (semitones), diagonal Mahalanobis
  to his enrollment windows (as in #380);
- simple: pitch + log spectral centroid + MFCC 1-12 means (as in #380);
- campp: CAM++ (3D-Speaker zh-en, sherpa-onnx, 28 MB), cosine to his mean;
- eres2netv2: ERes2NetV2 (3D-Speaker zh-cn, sherpa-onnx, 71 MB), the same way.
  (No ECAPA export is published for sherpa-onnx; ERes2NetV2 is the stronger
  3D-Speaker model it ships.)

Owner: the clips with a reference (his speech to the agent), 5-fold: enrol on
the clean audio of 4/5, test the rest clean, with DEMAND restaurant /
cafeteria / street at 10/5/0 dB, babble at 5/0 dB, and one background voice
(a Chinese TTS talker through a short reverb, the family member at the table)
at 10/5/0 dB under him. Live clips (--real-after; noisy / quiet batches split at his spoken
吵了 / 安静了) are scored as his too, with the whole-set enrollment (an assumption: he recorded them).

Others (should be rejected): real people from public samples (the
sherpa-onnx speaker-recognition test set: three Chinese men; and the model
packages' own test recordings), and the page's TTS voices in nine
languages. Each clean, with restaurant noise at 10/5/0 dB, and "family in
the background": the other voice alone, through the room, 10 dB under his
level, over restaurant noise at his level -10 dB.

Each item is cut into crops of 1 s and 2 s starting at speech (up to three
per item), and scored whole. EER pools every condition; FR is per condition
at the threshold that gives 1 % FA over all other-voice trials of the same
length (fixed per scorer and length, the same for every condition), and for
CAM++ also at #380's fixed 0.3 / 0.2.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import warnings

import numpy as np

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gridlib as G  # noqa: E402

RATE = G.RATE
HOP, WIN, NFFT, YIN_W = 160, 400, 512, 480
TAU_MIN, TAU_MAX = RATE // 400, RATE // 60
LENGTHS = [1.0, 2.0, None]
CROPS = 3
SPK = os.path.join(G.MODELS, "speaker")
EMBEDDERS = {
    "campp": os.path.join(SPK, "campplus_zh_en.onnx"),
    "eres2netv2": os.path.join(SPK, "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"),
}
MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
PUBLIC = os.path.join(G.CACHE, "spk-public")
CAM_ACCEPT, CAM_REJECT = 0.3, 0.2


# ---------------------------------------------------------------- features (#380's, numpy only)
def frames(x, width):
    n = max(0, 1 + (len(x) - width) // HOP)
    if n == 0:
        return np.zeros((0, width), np.float32)
    idx = np.arange(width)[None, :] + HOP * np.arange(n)[:, None]
    return x[idx]


def _mel_fb(n_mels=40, fmin=20.0, fmax=7600.0):
    hz2mel = lambda f: 2595 * np.log10(1 + f / 700)  # noqa: E731
    mel2hz = lambda m: 700 * (10 ** (m / 2595) - 1)  # noqa: E731
    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    bins = np.floor((NFFT + 1) * pts / RATE).astype(int)
    fb = np.zeros((n_mels, NFFT // 2 + 1))
    for m in range(1, n_mels + 1):
        a, b, c = bins[m - 1], bins[m], bins[m + 1]
        for k in range(a, b):
            fb[m - 1, k] = (k - a) / max(1, b - a)
        for k in range(b, c):
            fb[m - 1, k] = (c - k) / max(1, c - b)
    return fb


MEL = _mel_fb()
_k, _n = np.arange(40)[:, None], np.arange(40)[None, :]
DCT = (np.sqrt(2 / 40) * np.cos(np.pi * _k * (2 * _n + 1) / 80))[1:13]
FREQS = np.fft.rfftfreq(NFFT, 1 / RATE)


def yin(x, n):
    pad = np.pad(x, (0, YIN_W + TAU_MAX + WIN))
    F = frames(pad, YIN_W + TAU_MAX + 1)[:n]
    d = np.empty((len(F), TAU_MAX + 1), np.float32)
    d[:, 0] = 0
    base = F[:, :YIN_W]
    for tau in range(1, TAU_MAX + 1):
        diff = base - F[:, tau : tau + YIN_W]
        d[:, tau] = np.einsum("ij,ij->i", diff, diff)
    cum = np.cumsum(d[:, 1:], axis=1) / np.arange(1, TAU_MAX + 1)
    cmnd = np.ones_like(d)
    cmnd[:, 1:] = d[:, 1:] / (cum + 1e-10)
    sub = cmnd[:, TAU_MIN:] < 0.15
    f0 = np.zeros(len(F), np.float32)
    first = np.where(sub.any(axis=1), sub.argmax(axis=1), -1)
    for i in np.nonzero(first >= 0)[0]:
        t, row = first[i], cmnd[i, TAU_MIN:]
        while t + 1 < len(row) and row[t + 1] < row[t]:
            t += 1
        f0[i] = RATE / (t + TAU_MIN)
    return f0


class Track:
    def __init__(self, x):
        self.x = x
        f = frames(x, WIN)
        db = 10 * np.log10(np.mean(f * f, axis=1) + 1e-10) if len(f) else np.zeros(0)
        self.n = len(db)
        self.speech = db > (np.percentile(db, 95) - 25 if len(db) else 0)
        pre = np.append(x[0], x[1:] - 0.97 * x[:-1]).astype(np.float32)
        fr = frames(pre, WIN)[: self.n] * np.hamming(WIN)
        spec = np.abs(np.fft.rfft(fr, NFFT)) ** 2
        self.centroid = np.log((spec @ FREQS) / (spec.sum(axis=1) + 1e-10) + 1.0)
        self.mfcc = np.log(spec @ MEL.T + 1e-10) @ DCT.T
        self.f0 = yin(x, self.n) * self.speech

    def crops(self, seconds):
        if seconds is None:
            return [(0, self.n)]
        k = int(seconds * 100)
        out, i = [], 0
        while len(out) < CROPS and i + k <= self.n:
            s = np.nonzero(self.speech[i:])[0]
            if len(s) == 0 or i + s[0] + k > self.n:
                break
            a = i + s[0]
            if self.speech[a : a + k].mean() >= 0.4:
                out.append((a, a + k))
                i = a + k
            else:
                i = a + 1
        return out

    def vector(self, a, b):
        sp = self.speech[a:b]
        f0 = self.f0[a:b]
        f0 = f0[f0 > 0]
        if sp.sum() < 10 or len(f0) < 5:
            return None
        st = 12 * np.log2(f0 / 100.0)
        return np.concatenate([[np.median(st), np.percentile(st, 90) - np.percentile(st, 10)],
                               [self.centroid[a:b][sp].mean()], self.mfcc[a:b][sp].mean(axis=0)])

    def audio(self, a, b):
        return self.x[a * HOP : b * HOP + WIN]


class Simple:
    def __init__(self, vecs, dims=slice(None)):
        v = np.array(vecs)[:, dims]
        self.dims, self.mu, self.sd = dims, v.mean(axis=0), v.std(axis=0) + 1e-3

    def score(self, x):
        z = (x[self.dims] - self.mu) / self.sd
        return -float(np.mean(z * z))


class Embedder:
    def __init__(self, path, threads=2):
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=threads)
        if not cfg.validate():
            raise SystemExit(f"bad speaker model {path}")
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def __call__(self, audio):
        st = self.ex.create_stream()
        st.accept_waveform(RATE, audio)
        st.input_finished()
        if not self.ex.is_ready(st):
            return None
        e = np.array(self.ex.compute(st), np.float32)
        return e / (np.linalg.norm(e) + 1e-10)


# ---------------------------------------------------------------- data
def owner_clips(clips, batches):
    """Referenced clips; live clips by batch (gridlib.live_labels)."""
    refs = G.references(clips)
    wavs = sorted(glob.glob(os.path.join(clips, "*.wav")))
    live = G.live_labels(wavs, batches)
    owner, real = [], {}
    for w in wavs:
        if w in live:
            real.setdefault(live[w][0], []).append(w)
        elif os.path.basename(w)[:-4] in refs:
            owner.append(w)
    return owner, real


def public_voices():
    files = sorted(glob.glob(os.path.join(PUBLIC, "*.wav")))
    for d in glob.glob(os.path.join(G.MODELS, "*", "test_wavs")) + glob.glob(os.path.join(G.MODELS, "*", "*", "test_wavs")):
        files += [f for f in sorted(glob.glob(os.path.join(d, "*.wav"))) if "8k" not in f]
    return files


def eer(pos, neg):
    if not pos or not neg:
        return None
    pos, neg = np.sort(pos), np.sort(neg)
    ts = np.unique(np.concatenate([pos, neg]))
    fr = np.searchsorted(pos, ts, side="left") / len(pos)
    fa = 1 - np.searchsorted(neg, ts, side="left") / len(neg)
    i = int(np.argmin(np.abs(fr - fa)))
    return float((fr[i] + fa[i]) / 2)


def thr_at_fa(neg, fa=0.01):
    if not neg:
        return None
    return float(np.quantile(neg, 1 - fa, method="higher")) + 1e-9


def pc(v):
    return "–" if v is None else f"{100 * v:.1f}%"


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True, help="a COPY of ~/lianki-voice-clips")
    ap.add_argument("--batches", default="", help="live clips: start=label,… (see grid-eval.py)")
    ap.add_argument("--yield-dir", default="", help="pause while clips are arriving here (he is talking)")
    ap.add_argument("--snr", default="10,5,0")
    ap.add_argument("--per-lang", type=int, default=6)
    ap.add_argument("--denoise", default="none", help="what the embedders hear, e.g. none,dfn3 (pitch: raw)")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--md")
    ap.add_argument("--json")
    a = ap.parse_args()
    for name, p in EMBEDDERS.items():
        if not os.path.exists(p):
            raise SystemExit(f"{name} missing: curl -fsSL -o {p} {MODEL_URL}{os.path.basename(p)}")
    rng = np.random.default_rng(23)
    snrs = [float(s) for s in a.snr.split(",")]
    bank = G.Bank(rng, ("restaurant", "street", "babble", "voice", "pa"))
    emb = {k: Embedder(p) for k, p in EMBEDDERS.items()}
    dens = {d.name: d for d in G.denoisers(a.denoise.split(","))}
    owner, real = owner_clips(a.clips, a.batches)
    if len(owner) < a.folds * 2:
        raise SystemExit(f"need {a.folds * 2} referenced owner clips, have {len(owner)}")
    t0 = time.time()

    def items(x):
        """[(length, simple vector, {embedder@denoiser: embedding})] for every crop of x."""
        G.wait_quiet(a.yield_dir)
        out = []
        variants = {dn: (x if dn == "none" else d(x)) for dn, d in dens.items()}
        tr = Track(x)
        for L in LENGTHS:
            for (s, e) in tr.crops(L):
                v = tr.vector(s, e)
                es = {}
                for dn, y in variants.items():
                    seg = y[s * HOP : e * HOP + WIN]
                    for en, f in emb.items():
                        es[f"{en}@{dn}"] = f(seg)
                out.append((L, v, es))
        return out

    # owner: clean + synthetic conditions
    O = []  # per clip: {cond: items}
    for i, w in enumerate(owner):
        x = G.load(w)
        conds = {"clean": items(x)}
        r = np.random.default_rng(100 + i)
        for kind, ss in (("restaurant", snrs), ("voice", snrs), ("pa", (5.0, 0.0)), ("street", (5.0,)),
                         ("babble", (0.0,))):
            for s in ss:
                nz, _ = bank.get(kind, len(x), r)
                conds[f"{kind}{s:g}"] = items(G.mix(x, nz, s))
        O.append(conds)
        print(f"  owner {i + 1}/{len(owner)} {time.time() - t0:.0f} s", file=sys.stderr, flush=True)
    R = {b: [items(G.load(w)) for w in ws] for b, ws in real.items()}
    his_level = float(np.median([G.level_db(G.load(w)) for w in owner]))

    # others
    others: dict[str, list] = {}
    srcs = [("public", f) for f in public_voices()] + [("tts", f) for f in G.tts_voices(
        ("de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh"), a.per_lang, min_s=3.2, skip=80)]
    rest = G.demand("restaurant")
    for j, (kind, f) in enumerate(srcs):
        x = G.load(f)
        x = G.gain(x, his_level - G.level_db(x))
        r = np.random.default_rng(5000 + j)
        others.setdefault(f"{kind}/clean", []).append(items(x))
        for s in snrs:
            nz, _ = bank.get("restaurant", len(x), r)
            others.setdefault(f"{kind}/restaurant{s:g}", []).append(items(G.mix(x, nz, s)))
        # family in the background: the other voice through the room, 10 dB under him, over restaurant noise
        far = G.gain(G.reverb(x, r), -10.0)
        off = int(r.integers(0, len(rest) - len(far)))
        nz = rest[off : off + len(far)]
        nz = nz * 10 ** ((his_level - 10 - G.level_db(nz)) / 20)
        others.setdefault(f"{kind}/background", []).append(items(np.clip(far + nz, -1, 1).astype(np.float32)))
        if j % 10 == 0:
            print(f"  others {j + 1}/{len(srcs)} {time.time() - t0:.0f} s", file=sys.stderr, flush=True)
    # the shop's PA alone (no owner): at his level and 10 dB under, over a restaurant bed 10 dB under it
    for j, (f, x) in enumerate(bank.pa_src):
        r = np.random.default_rng(7000 + j)
        for lv in (0.0, -10.0):
            y = G.gain(x, his_level + lv - G.level_db(x))
            nz, _ = bank.get("restaurant", len(y), r)
            others.setdefault(f"pa/level{lv:+g}", []).append(items(G.mix(y, nz, 10.0)))

    scorers = ["pitch", "simple"] + list(f"{e}@{d}" for e in emb for d in dens)
    # scores[scorer][group][L] -> list of float
    S: dict = {s: {} for s in scorers}

    def add(sc, group, L, v):
        S[sc].setdefault(group, {}).setdefault(str(L), []).append(v)

    def models_from(idxs):
        vecs = [v for i in idxs for (L, v, _) in O[i]["clean"] if L == 2.0 and v is not None]
        m = {"pitch": Simple(vecs, slice(0, 2)), "simple": Simple(vecs)}
        for sc in scorers[2:]:
            es = [e[sc] for i in idxs for (L, _, e) in O[i]["clean"] if L is None and e.get(sc) is not None]
            mu = np.mean(es, axis=0)
            m[sc] = mu / np.linalg.norm(mu)
        return m

    def score_items(models, group, its):
        for (L, v, es) in its:
            for sc in scorers:
                if sc in ("pitch", "simple"):
                    if v is not None:
                        add(sc, group, L, models[sc].score(v))
                elif es.get(sc) is not None:
                    add(sc, group, L, float(es[sc] @ models[sc]))

    idx = np.arange(len(owner))
    np.random.default_rng(11).shuffle(idx)
    for test in np.array_split(idx, a.folds):
        models = models_from([i for i in idx if i not in set(test)])
        for i in test:
            for cond, its in O[i].items():
                score_items(models, f"owner/{cond}", its)
        for g, lst in others.items():
            for its in lst:
                score_items(models, g, its)
    if R:
        models = models_from(list(idx))
        for b, lst in R.items():
            for its in lst:
                score_items(models, f"owner/real-{b}", its)
        # others against the whole-set model too, for the real set's threshold
        for g, lst in others.items():
            for its in lst:
                score_items(models, "all:" + g, its)

    # ---------------------------------------------------------------- report
    lens = [str(L) for L in LENGTHS]
    lname = {"1.0": "1 s", "2.0": "2 s", "None": "whole"}
    ogroups = sorted({g for sc in S for g in S[sc] if g.startswith("owner/")},
                     key=lambda g: (g != "owner/clean", g))
    negs = [g for g in others]
    rep: dict = {"owner_clips": len(owner), "real_clips": {b: len(v) for b, v in real.items()}, "other_items": len(srcs),
                 "public_real_people": sum(1 for k, _ in srcs if k == "public"), "scorers": {}}
    L: list[str] = []
    L.append(f"Owner: {len(owner)} referenced clips (5-fold), live clips {rep['real_clips']} (assumed his). Others: "
             f"{rep['public_real_people']} public recordings of real people, "
             f"{sum(1 for k, _ in srcs if k == 'tts')} TTS voices; each clean, + restaurant 10/5/0 dB, "
             f"and alone in the background (through the room, −10 dB, over restaurant noise).\n")
    L.append("\n### EER over all conditions (owner trials: clean + every noise; others: every set)\n")
    L.append("| scorer | " + " | ".join(lname[x] for x in lens) + " | EER, clean owner vs clean others (whole) |")
    L.append("|" + " --- |" * (len(lens) + 2))
    for sc in scorers:
        row, r = [], {}
        for x in lens:
            pos = [v for g in ogroups if not g.startswith("owner/real") for v in S[sc].get(g, {}).get(x, [])]
            neg = [v for g in negs for v in S[sc].get(g, {}).get(x, [])]
            r[x] = {"eer": eer(pos, neg), "thr_fa1": thr_at_fa(neg)}
            row.append(pc(r[x]["eer"]))
        cl = eer(S[sc].get("owner/clean", {}).get("None", []),
                 [v for g in negs if g.endswith("/clean") for v in S[sc].get(g, {}).get("None", [])])
        rep["scorers"][sc] = r
        L.append(f"| {sc} | " + " | ".join(row) + f" | {pc(cl)} |")

    L.append("\n### His speech rejected (FR) per condition, at 1 % FA over all other voices (2 s crops · whole)\n")
    show = [sc for sc in scorers]
    L.append("| owner condition | " + " | ".join(show) + " |")
    L.append("|" + " --- |" * (len(show) + 1))
    for g in ogroups:
        cells = []
        for sc in show:
            vals = []
            for x in ("2.0", "None"):
                pos = S[sc].get(g, {}).get(x, [])
                if g.startswith("owner/real"):
                    neg = [v for n in negs for v in S[sc].get("all:" + n, {}).get(x, [])]
                    t = thr_at_fa(neg)
                else:
                    t = rep["scorers"][sc][x]["thr_fa1"]
                vals.append(None if not pos or t is None else float(np.mean(np.array(pos) < t)))
            cells.append(" · ".join(pc(v) for v in vals))
        L.append(f"| {g[6:]} | " + " | ".join(cells) + " |")

    L.append("\n### Other voices accepted (FA) per set at the same threshold (2 s crops · whole)\n")
    L.append("| other set | " + " | ".join(show) + " |")
    L.append("|" + " --- |" * (len(show) + 1))
    for g in negs:
        cells = []
        for sc in show:
            vals = []
            for x in ("2.0", "None"):
                neg = S[sc].get(g, {}).get(x, [])
                t = rep["scorers"][sc][x]["thr_fa1"]
                vals.append(None if not neg or t is None else float(np.mean(np.array(neg) >= t)))
            cells.append(" · ".join(pc(v) for v in vals))
        L.append(f"| {g} | " + " | ".join(cells) + " |")

    cam = [sc for sc in scorers if sc.startswith("campp@")]
    if cam:
        L.append(f"\n### CAM++ at #380's fixed thresholds: owner ≥ {CAM_ACCEPT}, other < {CAM_REJECT} (2 s · whole)\n")
        L.append("| scorer | set | → owner | → unknown | → other |")
        L.append("| --- | --- | --- | --- | --- |")
        for sc in cam:
            for label, gs in (("his, clean", ["owner/clean"]),
                              ("his, noise 10 dB", [g for g in ogroups if g.endswith("10")]),
                              ("his, noise 5 dB", [g for g in ogroups if g.endswith("5")]),
                              ("his, noise 0 dB", [g for g in ogroups if g.endswith("0") and not g.endswith("10")]),
                              ("his, family voice under him", [g for g in ogroups if "/voice" in g]),
                              *[(f"live {b} (assumed his)", [f"owner/real-{b}"]) for b in real],
                              ("others, clean", [g for g in negs if g.endswith("/clean")]),
                              ("others, restaurant", [g for g in negs if "/restaurant" in g]),
                              ("others, in the background", [g for g in negs if g.endswith("/background")]),
                              ("shop PA alone", [g for g in negs if g.startswith("pa/")])):
                cells = []
                for band in ("o", "u", "x"):
                    vals = []
                    for x in ("2.0", "None"):
                        v = np.array([s for g in gs for s in S[sc].get(g, {}).get(x, [])])
                        if not len(v):
                            vals.append(None)
                            continue
                        vals.append(float(np.mean(v >= CAM_ACCEPT) if band == "o" else np.mean(
                            (v >= CAM_REJECT) & (v < CAM_ACCEPT)) if band == "u" else np.mean(v < CAM_REJECT)))
                    cells.append(" · ".join(pc(q) for q in vals))
                L.append(f"| {sc} | {label} | " + " | ".join(cells) + " |")
    L.append(f"\n{time.time() - t0:.0f} s on this Mac.")
    md = "\n".join(L) + "\n"
    print(md)
    if a.md:
        open(a.md, "w").write(md)
    if a.json:
        json.dump(rep, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
