#!/usr/bin/env python3
"""
Who is speaking: the owner, someone else, or unknown? (docs/speaker-id.md)

Two scorers, on files only (nothing is played):

- simple: pitch (YIN F0 median and p10-p90 range, in semitones) plus spectral
  features (log spectral centroid, MFCC 1-12 means), compared with an
  enrollment profile (per-feature mean and spread) by a diagonal Mahalanobis
  distance. numpy only.
- campp: the CAM++ speaker embedding (3D-Speaker, zh-en, via sherpa-onnx),
  cosine against the mean of the enrollment embeddings.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/speaker-eval.py \
        [--clips ~/lianki-voice-clips] [--voices ~/.cache/lianki-voice/out/voice] \
        [--no-cam] [--json out.json]
    # write the one enrollment file (mode 600) from all labelled owner clips:
    ... speaker-eval.py --enroll
    # delete it:
    ... speaker-eval.py --forget        (or: rm ~/.cache/lianki-stt/speaker-profile.json)

Owner = the clips with a reference (ab-eval.py's refs: <name>.ref.txt or
refs-agent.json), his speech to the agent. The clips without one (captures
not meant for the agent) have no speaker label: only the share each scorer
calls "owner" is reported. Others = the agent's TTS echo set, the word
recordings, and a sample of the page's TTS voices in nine languages, each
clean and "through the room" (a short synthetic reverb, his own room noise
floor, at his speech level -6 dB and -20 dB).

Owner trials are 5-fold: enrol on 16 clips, test on the other 4 (and on their
pink-noise copies at 5 dB SNR from noisy.py when present). Every test clip is
cut into crops of 0.5 / 1 / 2 / 3 s starting at speech, and scored whole.

PRIVACY: features, embeddings and scores stay in memory. Only aggregate
rates are printed or written to --json. The only file holding a voiceprint
is the --enroll profile, mode 600, under ~/.cache/lianki-stt/.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf

RATE = 16_000
HOP = 160  # 10 ms
WIN = 400  # 25 ms
NFFT = 512
YIN_W = 480
TAU_MIN, TAU_MAX = RATE // 400, RATE // 60  # 60-400 Hz
LENGTHS = [0.5, 1.0, 2.0, 3.0, None]  # None = the whole clip
CROPS_PER_CLIP = 3
PROFILE = os.path.expanduser("~/.cache/lianki-stt/speaker-profile.json")
CAM_MODEL = os.path.expanduser("~/.cache/lianki-stt/models/speaker/campplus_zh_en.onnx")
CAM_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
           "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx")
#: CAM++ cosine operating points, fixed in advance (not tuned on his scores).
CAM_ACCEPT = 0.3  # owner at or above
CAM_REJECT = 0.2  # other below; in between = unknown
CAM_SWEEP = (0.15, 0.2, 0.25, 0.3, 0.4, 0.5)


# ---------------------------------------------------------------- audio


def load(path: str) -> np.ndarray:
    a, sr = sf.read(path, dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != RATE:
        t = np.arange(0, len(a) / sr, 1 / RATE)
        a = np.interp(t, np.arange(len(a)) / sr, a).astype(np.float32)
    return a.astype(np.float32)


def frames(x: np.ndarray, width: int) -> np.ndarray:
    n = max(0, 1 + (len(x) - width) // HOP)
    if n == 0:
        return np.zeros((0, width), np.float32)
    idx = np.arange(width)[None, :] + HOP * np.arange(n)[:, None]
    return x[idx]


def rms_db(x: np.ndarray) -> np.ndarray:
    f = frames(x, WIN)
    return 10 * np.log10(np.mean(f * f, axis=1) + 1e-10)


def speech_mask(db: np.ndarray) -> np.ndarray:
    """Energy VAD: within 25 dB of the clip's loud frames."""
    if len(db) == 0:
        return np.zeros(0, bool)
    return db > np.percentile(db, 95) - 25


# ---------------------------------------------------------------- features


def _mel_fb(n_mels=40, fmin=20.0, fmax=7600.0):
    def hz2mel(f):
        return 2595 * np.log10(1 + f / 700)

    def mel2hz(m):
        return 700 * (10 ** (m / 2595) - 1)

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
#: DCT-II (orthonormal) over the 40 log-mel bands, rows 1-12 kept. numpy only:
#: the shared venv pins numpy 1.26, which this scipy refuses (docs/stt-ab.md).
_k, _n = np.arange(40)[:, None], np.arange(40)[None, :]
DCT = (np.sqrt(2 / 40) * np.cos(np.pi * _k * (2 * _n + 1) / 80))[1:13]
FREQS = np.fft.rfftfreq(NFFT, 1 / RATE)


def yin(x: np.ndarray, n: int) -> np.ndarray:
    """F0 per 10 ms frame (Hz, 0 = unvoiced), YIN with the cumulative-mean normalised difference."""
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
    f0 = np.zeros(len(F), np.float32)
    sub = cmnd[:, TAU_MIN:]
    for i in range(len(F)):
        below = np.nonzero(sub[i] < 0.15)[0]
        if len(below) == 0:
            continue
        t = below[0]
        while t + 1 < len(sub[i]) and sub[i, t + 1] < sub[i, t]:
            t += 1
        f0[i] = RATE / (t + TAU_MIN)
    return f0


class Track:
    """Frame-level features of one recording, computed once; crops are frame ranges."""

    def __init__(self, x: np.ndarray):
        self.x = x
        db = rms_db(x)
        self.n = len(db)
        self.speech = speech_mask(db)
        pre = np.append(x[0], x[1:] - 0.97 * x[:-1]).astype(np.float32)
        fr = frames(pre, WIN)[: self.n] * np.hamming(WIN)
        spec = np.abs(np.fft.rfft(fr, NFFT)) ** 2
        self.centroid = np.log((spec @ FREQS) / (spec.sum(axis=1) + 1e-10) + 1.0)
        self.mfcc = np.log(spec @ MEL.T + 1e-10) @ DCT.T
        self.f0 = yin(x, self.n) * self.speech

    def crops(self, seconds):
        """Frame ranges of `seconds` wall time, each starting at a speech frame, non-overlapping."""
        if seconds is None:
            return [(0, self.n)]
        k = int(seconds * 100)
        out, i = [], 0
        while len(out) < CROPS_PER_CLIP and i + k <= self.n:
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

    def vector(self, a: int, b: int):
        sp = self.speech[a:b]
        f0 = self.f0[a:b]
        f0 = f0[f0 > 0]
        if sp.sum() < 10 or len(f0) < 5:
            return None
        st = 12 * np.log2(f0 / 100.0)
        return np.concatenate([
            [np.median(st), np.percentile(st, 90) - np.percentile(st, 10)],
            [self.centroid[a:b][sp].mean()],
            self.mfcc[a:b][sp].mean(axis=0),
        ])

    def audio(self, a: int, b: int) -> np.ndarray:
        return self.x[a * HOP : b * HOP + WIN]


class Simple:
    PITCH = slice(0, 2)

    def __init__(self, vecs, dims=slice(None)):
        v = np.array(vecs)[:, dims]
        self.dims = dims
        self.mu = v.mean(axis=0)
        self.sd = v.std(axis=0) + 1e-3
        d = [self._dist(x) for x in np.array(vecs)]
        #: accept within the 95th percentile of the enrollment windows' own distances
        self.accept = float(np.percentile(d, 95))

    def _dist(self, x):
        z = (x[self.dims] - self.mu) / self.sd
        return float(np.mean(z * z))

    def score(self, x):
        return -self._dist(x)  # higher = more like him


class Cam:
    def __init__(self, model: str):
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=2)
        if not cfg.validate():
            raise SystemExit(f"bad CAM++ config: {model}")
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def embed(self, audio: np.ndarray):
        st = self.ex.create_stream()
        st.accept_waveform(RATE, audio)
        st.input_finished()
        if not self.ex.is_ready(st):
            return None
        e = np.array(self.ex.compute(st), np.float32)
        return e / (np.linalg.norm(e) + 1e-10)


# ---------------------------------------------------------------- data


def owner_sets(clips: str):
    agent = {}
    p = os.path.join(clips, "refs-agent.json")
    if os.path.exists(p):
        agent = {k: v for k, v in json.load(open(p)).items() if not k.startswith("_")}
    owner, unlabelled = [], []
    for w in sorted(glob.glob(os.path.join(clips, "*.wav"))):
        name = os.path.basename(w)[:-4]
        (owner if name in agent or os.path.exists(os.path.join(clips, name + ".ref.txt")) else unlabelled).append(w)
    return owner, unlabelled


def room_noise(owner_tracks) -> np.ndarray:
    """His room's own floor: the quiet frames of his clips, joined."""
    parts = []
    for t in owner_tracks:
        db = rms_db(t.x)
        quiet = db < np.percentile(db, 30)
        for i in np.nonzero(quiet)[0]:
            parts.append(t.x[i * HOP : i * HOP + HOP])
    return np.concatenate(parts) if parts else np.zeros(RATE, np.float32)


def speech_level(x: np.ndarray) -> float:
    db = rms_db(x)
    return float(np.median(db[speech_mask(db)])) if len(db) else -30.0


def through_room(x, noise, level_db, rng):
    """Played on a speaker in his room: short reverb, at level_db, over his noise floor."""
    n = int(0.25 * RATE)
    rir = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.05 * RATE))
    rir[0] = 4.0
    m = len(x) + n - 1
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(rir, m), m)[: len(x) + n // 2]
    y *= 10 ** ((level_db - speech_level(y)) / 20)
    off = rng.integers(0, max(1, len(noise) - len(y)))
    nz = np.resize(noise[off:], len(y))
    return (y + nz).astype(np.float32)


def voice_sample(root: str, per_lang: int):
    out = []
    for lang in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        files = sorted(glob.glob(os.path.join(root, lang, "*.mp3")))
        got = 0
        for f in files:
            try:
                if sf.info(f).duration >= 3.2:
                    out.append((lang, f))
                    got += 1
            except Exception:
                continue
            if got >= per_lang:
                break
    return out


# ---------------------------------------------------------------- metrics


def eer(pos, neg):
    if not pos or not neg:
        return None
    pos, neg = np.array(pos), np.array(neg)
    best = (2.0, None)
    for t in np.unique(np.concatenate([pos, neg])):
        fr = np.mean(pos < t)
        fa = np.mean(neg >= t)
        if abs(fr - fa) < best[0]:
            best = (abs(fr - fa), (fr + fa) / 2)
    return float(best[1])


def at(pos, neg, accept):
    """FR, FA and accuracy when 'owner' means score >= accept (thresholds per fold already applied: pos/neg are margins)."""
    pos, neg = np.array(pos), np.array(neg)
    fr = float(np.mean(pos < accept)) if len(pos) else None
    fa = float(np.mean(neg >= accept)) if len(neg) else None
    acc = float((np.sum(pos >= accept) + np.sum(neg < accept)) / max(1, len(pos) + len(neg)))
    return fr, fa, acc


def pct(v):
    return "–" if v is None else f"{100 * v:.1f}%"


# ---------------------------------------------------------------- main


def enroll(owner, use_cam: bool, cam_model: str):
    tracks = [Track(load(w)) for w in owner]
    vecs = [v for t in tracks for (a, b) in t.crops(2.0) for v in [t.vector(a, b)] if v is not None]
    s = Simple(vecs)
    prof = {"about": "Lianki speaker profile (docs/speaker-id.md). Local only. Delete: rm this file.",
            "clips": len(owner), "simple": {"mu": s.mu.tolist(), "sd": s.sd.tolist(), "accept": s.accept}}
    if use_cam:
        cam = Cam(cam_model)
        es = [e for t in tracks for e in [cam.embed(t.x)] if e is not None]
        m = np.mean(es, axis=0)
        prof["campp"] = {"model": os.path.basename(cam_model), "mean": (m / np.linalg.norm(m)).tolist(),
                         "accept": CAM_ACCEPT, "reject": CAM_REJECT}
    os.makedirs(os.path.dirname(PROFILE), exist_ok=True)
    fd = os.open(PROFILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(prof, f)
    os.chmod(PROFILE, 0o600)
    print(f"wrote {PROFILE} (mode 600) from {len(owner)} clips. Delete with: rm {PROFILE}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--noisy", default=os.path.expanduser("~/.cache/lianki-stt/noisy-clips"))
    ap.add_argument("--echo", default=os.path.expanduser("~/.cache/lianki-stt/tts-echo"))
    ap.add_argument("--words", default=os.path.expanduser("~/.cache/lianki-stt/tts-words"))
    ap.add_argument("--voices", default=os.path.expanduser("~/.cache/lianki-voice/out/voice"))
    ap.add_argument("--per-lang", type=int, default=12)
    ap.add_argument("--cam-model", default=CAM_MODEL)
    ap.add_argument("--no-cam", action="store_true")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--json")
    ap.add_argument("--enroll", action="store_true", help=f"write {PROFILE} (mode 600) and exit")
    ap.add_argument("--forget", action="store_true", help=f"delete {PROFILE} and exit")
    a = ap.parse_args()

    if a.forget:
        if os.path.exists(PROFILE):
            os.remove(PROFILE)
            print(f"deleted {PROFILE}")
        else:
            print("no profile")
        return

    use_cam = not a.no_cam
    if use_cam and not os.path.exists(a.cam_model):
        print(f"CAM++ missing: mkdir -p {os.path.dirname(a.cam_model)} && curl -fsSL -o {a.cam_model} {CAM_URL}",
              file=sys.stderr)
        use_cam = False

    owner, unlabelled = owner_sets(a.clips)
    if a.enroll:
        return enroll(owner, use_cam, a.cam_model)
    if len(owner) < a.folds * 2:
        raise SystemExit(f"need at least {a.folds * 2} labelled owner clips, have {len(owner)}")
    rng = np.random.default_rng(11)
    cam = Cam(a.cam_model) if use_cam else None

    def items(track):
        """(length, simple vector, CAM++ embedding) for every crop."""
        out = []
        for L in LENGTHS:
            for (s, e) in track.crops(L):
                v = track.vector(s, e)
                emb = cam.embed(track.audio(s, e)) if cam else None
                out.append((L, v, emb))
        return out

    print(f"owner clips {len(owner)}, unlabelled {len(unlabelled)}", file=sys.stderr)
    otracks = [Track(load(w)) for w in owner]
    oitems = [items(t) for t in otracks]
    noisy_items = {}
    for i, w in enumerate(owner):
        p = os.path.join(a.noisy, os.path.basename(w)[:-4] + ".pink5.wav")
        if os.path.exists(p):
            noisy_items[i] = items(Track(load(p)))
    uitems = [items(Track(load(w))) for w in unlabelled]

    his_level = float(np.median([speech_level(t.x) for t in otracks]))
    noise = room_noise(otracks)
    others = {}  # set -> list of item lists
    src = ([("echo", f) for f in sorted(glob.glob(os.path.join(a.echo, "*.mp3")))]
           + [("words", f) for f in sorted(glob.glob(os.path.join(a.words, "*.mp3")))]
           + [("voices", f) for _, f in voice_sample(a.voices, a.per_lang)])
    print(f"other recordings {len(src)}", file=sys.stderr)
    for kind, f in src:
        x = load(f)
        others.setdefault(f"{kind}/clean", []).append(items(Track(x)))
        for lv in (-6, -20):
            others.setdefault(f"{kind}/room{lv}", []).append(items(Track(through_room(x, noise, his_level + lv, rng))))

    # folds: margins (score - that fold's accept threshold), so folds pool cleanly
    idx = np.arange(len(owner))
    rng.shuffle(idx)
    folds = np.array_split(idx, a.folds)
    scorers = ["simple", "pitch"] + (["campp"] if cam else [])
    raw = {s: {"owner": {}, "owner_pink5": {}, "unlabelled": {}, **{k: {} for k in others}} for s in scorers}

    def add(sc, group, L, val):
        raw[sc][group].setdefault(str(L), []).append(val)

    for test in folds:
        enrol = [i for i in idx if i not in set(test)]
        vecs = [v for i in enrol for (L, v, _) in oitems[i] if L == 2.0 and v is not None]
        models = {"simple": Simple(vecs), "pitch": Simple(vecs, Simple.PITCH)}
        if cam:
            m = np.mean([e for i in enrol for (L, _, e) in oitems[i] if L is None and e is not None], axis=0)
            m = m / np.linalg.norm(m)

        def score_all(group, item_lists, weight=1.0):
            for its in item_lists:
                for (L, v, e) in its:
                    for name, mdl in models.items():
                        if v is not None:
                            add(name, group, L, (mdl.score(v), -mdl.accept))
                    if cam and e is not None:
                        add("campp", group, L, (float(e @ m), CAM_ACCEPT))

        score_all("owner", [oitems[i] for i in test])
        score_all("owner_pink5", [noisy_items[i] for i in test if i in noisy_items])
        score_all("unlabelled", uitems)
        for k, v in others.items():
            score_all(k, v)

    # report
    report = {"owner_clips": len(owner), "unlabelled_clips": len(unlabelled),
              "other_recordings": len(src), "folds": a.folds, "scorers": {}}
    lens = [str(L) for L in LENGTHS]
    other_groups = list(others)
    for sc in scorers:
        r = raw[sc]
        rep = {}
        for L in lens:
            pos = r["owner"].get(L, [])
            neg = [p for g in other_groups for p in r[g].get(L, [])]
            negroom = [p for g in other_groups if "room" in g for p in r[g].get(L, [])]
            pm = [s - t for s, t in pos]
            nm = [s - t for s, t in neg]
            fr, fa, acc = at(pm, nm, 0.0)
            row = {"owner_n": len(pos), "other_n": len(neg),
                   "eer": eer([s for s, _ in pos], [s for s, _ in neg]),
                   "eer_room_only": eer([s for s, _ in pos], [s for s, _ in negroom]),
                   "fr": fr, "fa": fa, "acc": acc}
            noisy = r["owner_pink5"].get(L, [])
            row["fr_pink5"] = at([s - t for s, t in noisy], [], 0.0)[0] if noisy else None
            un = r["unlabelled"].get(L, [])
            row["unlabelled_called_owner"] = float(np.mean([s >= t for s, t in un])) if un else None
            row["fa_by_set"] = {g: (float(np.mean([s >= t for s, t in r[g][L]])) if r[g].get(L) else None)
                                for g in other_groups}
            if sc == "campp":
                row["unknown_band"] = {
                    "owner_owner": float(np.mean([s >= CAM_ACCEPT for s, _ in pos])) if pos else None,
                    "owner_unknown": float(np.mean([CAM_REJECT <= s < CAM_ACCEPT for s, _ in pos])) if pos else None,
                    "other_owner": float(np.mean([s >= CAM_ACCEPT for s, _ in neg])) if neg else None,
                    "other_unknown": float(np.mean([CAM_REJECT <= s < CAM_ACCEPT for s, _ in neg])) if neg else None,
                }
                echo = [p for g in other_groups if g.startswith("echo/room") for p in r[g].get(L, [])]
                row["sweep"] = {f"{t:.2f}": {
                    "fr": float(np.mean([s < t for s, _ in pos])) if pos else None,
                    "fr_pink5": float(np.mean([s < t for s, _ in noisy])) if noisy else None,
                    "fa": float(np.mean([s >= t for s, _ in neg])) if neg else None,
                    "fa_echo_room": float(np.mean([s >= t for s, _ in echo])) if echo else None,
                    "unlabelled_called_owner": float(np.mean([s >= t for s, _ in un])) if un else None,
                } for t in CAM_SWEEP}
            rep[L] = row
        report["scorers"][sc] = rep

    name = {"0.5": "0.5 s", "1.0": "1 s", "2.0": "2 s", "3.0": "3 s", "None": "whole clip"}
    for sc in scorers:
        print(f"\n## {sc}\n")
        print("| length | owner trials | other trials | EER | EER vs room only | FR | FA | accuracy | FR, his clips + pink 5 dB | unlabelled called owner |")
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for L in lens:
            x = report["scorers"][sc][L]
            print(f"| {name[L]} | {x['owner_n']} | {x['other_n']} | {pct(x['eer'])} | {pct(x['eer_room_only'])} | "
                  f"{pct(x['fr'])} | {pct(x['fa'])} | {pct(x['acc'])} | {pct(x['fr_pink5'])} | {pct(x['unlabelled_called_owner'])} |")
        print("\nFA by set (" + ", ".join(name[L] for L in lens) + "):\n")
        for g in other_groups:
            print(f"- {g}: " + " · ".join(pct(report["scorers"][sc][L]["fa_by_set"][g]) for L in lens))
        if sc == "campp":
            print(f"\nthree-way at {CAM_REJECT} / {CAM_ACCEPT} (owner ≥ accept, unknown between, other < reject):\n")
            for L in lens:
                u = report["scorers"][sc][L]["unknown_band"]
                print(f"- {name[L]}: owner → owner {pct(u['owner_owner'])}, unknown {pct(u['owner_unknown'])}; "
                      f"other → owner {pct(u['other_owner'])}, unknown {pct(u['other_unknown'])}")
            print("\n| length | cosine ≥ | FR | FR + pink 5 dB | FA (all others) | FA (echo through the room) | unlabelled called owner |")
            print("| --- | --- | --- | --- | --- | --- | --- |")
            for L in lens:
                for t, x in report["scorers"][sc][L]["sweep"].items():
                    print(f"| {name[L]} | {t} | {pct(x['fr'])} | {pct(x['fr_pink5'])} | {pct(x['fa'])} | "
                          f"{pct(x['fa_echo_room'])} | {pct(x['unlabelled_called_owner'])} |")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
