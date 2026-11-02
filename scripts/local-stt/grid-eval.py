#!/usr/bin/env python3
"""
Noise grid for the owner's speech input (docs/stt-ab.md, "Noise and speaker
grid"): which denoiser, VAD setting, gain and recogniser give the best text
in a noisy place, and what lets a shop's PA or a family voice in. Files
only: nothing is played, nothing leaves this Mac, and no transcript is
printed or written, only aggregate numbers.

    nice -n 20 taskpolicy -b env OMP_NUM_THREADS=2 \
      ~/.cache/lianki-stt/grid-venv/bin/python -I scripts/local-stt/grid-eval.py \
        --clips <a COPY of ~/lianki-voice-clips> \
        [--batches 2026-10-31T09-35=quiet-outdoor,2026-10-31T09-37=noisy-pharmacy] \
        [--yield-dir ~/lianki-voice-clips] [--workers 1] [--md out.md] [--json out.json]

It shares the Mac with the live STT server: run it niced, with one or two
workers, and --yield-dir makes it wait while new clips are arriving (he is
talking) before it starts the next clip.

Inputs
- the clips with a reference (`<name>.ref.txt`, the owner's, or
  `refs-agent.json`, the agent's); --pseudo adds the others, with
  SenseVoice on the clean clip as a pseudo reference (clean = 0 by
  construction);
- live clips: those named at or after the first --batches start, labelled by
  the latest start before them; a clip whose sidecar transcript says 吵了
  starts a "noisy" batch and 安静了 a "quiet" one (his spoken markers; the
  transcript is only tested for them). No noise is added to live clips; their
  reference is `.ref.txt` if present, else the medoid of their own
  transcripts (agreement, not truth);
- synthetic noise on the referenced clips: DEMAND restaurant and street
  (CC BY 4.0), babble (six TTS talkers), one background voice (a Chinese TTS
  talker through a short reverb: family at the table) and a shop PA (a
  Japanese TTS announcement, telephone band, limited, long hall), at --snr dB
  over his speech frames.

Axes
- A: denoiser (none, RNNoise, DeepFilterNet3, DFN3 capped at 12 dB,
  noisereduce, spectral subtraction) with SenseVoice, and none / --pick /
  DFN3 with streaming Paraformer; the phone's VAD as today (start 0.3,
  pre-pad 800 ms, min 250 ms, endpoint 600 ms) on the noisy audio, the
  pieces decoded from the denoised audio (a server-side denoiser);
- B: VAD start threshold / pre-pad, and no VAD, with none and --pick (VAD on
  the noisy or the denoised audio: a denoiser in the browser, before VAD);
- C: input gain (-12 / 0 / +12 dB with the int16 ceiling, and an AGC to
  -26 dBFS) with none and --pick;
- F: false triggers: the PA alone and the family voice alone (no owner),
  over a shop bed, at his level and 10 dB under: does the VAD fire, and how
  many characters come out, per denoiser;
- browser noiseSuppression: by the sidecar's `track` where a clip has one.

Metrics: CER (capped at 1 per clip); dropped (deletions) and added
(insertions) characters per reference character; leakage = the share of the
background talker's text (TTS, so its text is not private) found in the
transcript beyond what the reference shares with it; each denoiser's added
latency (algorithmic delay when streamed, and whole-utterance time).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import warnings
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait

import numpy as np

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gridlib as G  # noqa: E402

DENOISERS = ["none", "rnnoise", "dfn3", "dfn3-cap12", "noisereduce", "specsub"]
NOISES = ["restaurant", "street", "babble", "voice", "pa"]
VAD_GRID = [(0.3, 800), (0.3, 200), (0.5, 800), (0.7, 800), (None, None)]  # None = no VAD, whole clip
GAINS = [-12, 0, 12, "agc"]
DEFAULT_VAD = dict(pos=0.3, pad_ms=800, min_ms=250, endpoint_ms=600)
BC_CONDS = ["clean", "restaurant5", "pa5", "pa0", "voice5", "voice0"]
DELAY = {"none": (True, 0), "rnnoise": (True, 20), "dfn3": (True, 40), "dfn3-cap12": (True, 40),
         "noisereduce": (False, None), "specsub": (True, 32)}

_W: dict = {}


def _init(opts):
    warnings.filterwarnings("ignore")
    try:
        os.nice(20)
    except OSError:
        pass
    _W["opts"] = opts
    try:
        import torch

        torch.set_num_threads(opts["threads"])
    except ImportError:
        pass
    _W["den"] = {d.name: d for d in G.denoisers(opts["denoisers"])}
    _W["rec"] = {r.name: r for r in G.recognisers(["sensevoice"] + (["paraformer"] if opts["paraformer"] else []),
                                                     opts["threads"])}
    _W["vad"] = G.Silero()
    _W["bank"] = G.Bank(np.random.default_rng(5), tuple(opts["noises"]))
    _W["bgtext"] = {}


def _decode(rec, audio, segs):
    t0 = time.perf_counter()
    text = " ".join(rec.transcribe(audio[a:b])[0] for a, b in segs if b - a > 1600)
    return text, (time.perf_counter() - t0) * 1000


def _bg_text(f):
    if f not in _W["bgtext"]:
        _W["bgtext"][f] = _W["rec"]["sensevoice"].transcribe(G.load(f))[0]
    return _W["bgtext"][f]


def _heard(text: str, frac: float) -> str:
    t = G.norm(text)
    if not t:
        return ""
    return (t * (int(np.ceil(frac)) or 1))[: max(1, round(len(t) * frac))]


def run_clip(job):
    """Stages A-C for one clip. Returns numeric records only (no text)."""
    opts = _W["opts"]
    idx, ref, ref_src, live = job["idx"], job["ref"], job["ref_src"], job["live"]
    rng = np.random.default_rng(1000 + idx)
    clean = G.load(job["wav"])
    dur = len(clean) / G.RATE
    sv, pf = _W["rec"]["sensevoice"], _W["rec"].get("paraformer")
    if ref is None and not live:
        ref, ref_src = sv.transcribe(clean)[0], "pseudo-clean"
    variants = []  # (cond, noise, snr, audio, background)
    if live:
        variants.append((f"live:{live}", "live", None, clean, []))
    else:
        variants.append(("clean", "clean", None, clean, []))
        for kind in opts["noises"]:
            for snr in opts["snr"]:
                nz, bg = _W["bank"].get(kind, len(clean), rng)
                variants.append((f"{kind}{snr:g}", kind, snr, G.mix(clean, nz, snr), bg))
    recs = []

    def row(stage, cond, noise, snr, den, recname, hyp, den_ms, dec_ms, bg, **kw):
        r = dict(stage=stage, idx=idx, live=live, path=job["path"], ref_src=ref_src, cond=cond, noise=noise, snr=snr,
                 den=den, rec=recname, dur=dur, den_ms=den_ms, dec_ms=dec_ms, chars=len(G.norm(hyp)), **kw)
        r["_hyp"], r["_bg"] = hyp, bg
        recs.append(r)

    for cond, noise, snr, x, bg in variants:
        p_raw = _W["vad"].probs(x)
        segs = G.segment(p_raw, len(x), **DEFAULT_VAD)
        den_out = {}
        for dname, d in _W["den"].items():
            y, ms = G.timed(d, x)
            den_out[dname] = (y, ms)
            hyp, dec = _decode(sv, y, segs)
            row("A", cond, noise, snr, dname, "sensevoice", hyp, ms, dec, bg, segs=len(segs))
            if pf and dname in ("none", opts["pick"], "dfn3"):
                hyp, dec = _decode(pf, y, segs)
                row("A", cond, noise, snr, dname, "paraformer", hyp, ms, dec, bg, segs=len(segs))
        if not (live or cond in BC_CONDS):
            continue
        for dname in dict.fromkeys(("none", opts["pick"])):
            y, ms = den_out[dname]
            p_den = p_raw if dname == "none" else _W["vad"].probs(y)
            for where, probs in (("noisy", p_raw), ("denoised", p_den)):
                if dname == "none" and where == "denoised":
                    continue
                for pos, pad in VAD_GRID:
                    if pos is None and where == "denoised":
                        continue
                    sg = [(0, len(y))] if pos is None else G.segment(probs, len(y), pos=pos, pad_ms=pad,
                                                                      min_ms=250, endpoint_ms=600)
                    hyp, dec = _decode(sv, y, sg)
                    row("B", cond, noise, snr, dname, "sensevoice", hyp, ms, dec, bg,
                        vad="whole" if pos is None else f"{pos}/{pad}", vad_on=where, segs=len(sg))
        for g in GAINS:
            xg = G.normalise(x) if g == "agc" else G.gain(x, float(g))
            sg = G.segment(_W["vad"].probs(xg), len(xg), **DEFAULT_VAD)
            for dname in dict.fromkeys(("none", opts["pick"])):
                y, ms = G.timed(_W["den"][dname], xg)
                hyp, dec = _decode(sv, y, sg)
                row("C", cond, noise, snr, dname, "sensevoice", hyp, ms, dec, bg, gain=str(g), segs=len(sg))

    if live and ref is None:
        # medoid of the A transcripts: the one nearest all the others (agreement, said so in the report)
        normed = [G.norm(r["_hyp"]) for r in recs if r["stage"] == "A"]
        best, best_d = "", None
        for i, h in enumerate(normed):
            d = sum(G.score(o, h)["cer"] if o else 1.0 for j, o in enumerate(normed) if j != i)
            if best_d is None or d < best_d:
                best, best_d = h, d
        ref, ref_src = best, "pseudo-medoid"
    for r in recs:
        hyp, bgf = r.pop("_hyp"), r.pop("_bg")
        s = G.score(ref or "", hyp)
        r.update(ref_src=ref_src, n=s["n"], cer=s["cer"], sub=s["sub"], dele=s["del"], ins=s["ins"])
        if bgf:
            got = [G.leakage(ref or "", hyp, _heard(_bg_text(f), frac)) for f, frac in bgf]
            r["leak"], r["leak_n"] = sum(g[0] for g in got), sum(g[1] for g in got)
    return recs


def run_false(job):
    """Stage F: one background-only trial (PA or family voice, no owner) through every denoiser."""
    opts = _W["opts"]
    rng = np.random.default_rng(9000 + job["k"])
    src = _W["bank"].pa_src if job["kind"] == "pa" else _W["bank"].voice_src
    f, x = src[job["k"] % len(src)]
    x = np.resize(x, int(6 * G.RATE))
    x = G.gain(x, job["his"] + job["level"] - G.level_db(x))
    bed = _W["bank"].get("restaurant", len(x), rng)[0]
    y0 = G.mix(x, bed, 10.0)  # the shop's bed 10 dB under the talker
    p_raw = _W["vad"].probs(y0)
    segs = G.segment(p_raw, len(y0), **DEFAULT_VAD)
    out = []
    for dname, d in _W["den"].items():
        y, ms = G.timed(d, y0)
        sg_den = segs if dname == "none" else G.segment(_W["vad"].probs(y), len(y), **DEFAULT_VAD)
        for where, sg in (("noisy", segs), ("denoised", sg_den)):
            if dname == "none" and where == "denoised":
                continue
            hyp, _ = _decode(_W["rec"]["sensevoice"], y, sg)
            n = len(G.norm(hyp))
            out.append(dict(stage="F", kind=job["kind"], level=job["level"], den=dname, vad_on=where,
                            fired=bool(sg), segs=len(sg), chars=n, dur=len(y) / G.RATE))
    return out


# ---------------------------------------------------------------- report
def _set(r):
    if r.get("live"):
        return "live:" + r["live"]
    return "scored" if r["ref_src"] in ("agent", "owner") else "pseudo"


def agg(rs):
    if not rs:
        return None
    n = sum(r["n"] for r in rs) or 1
    lk = [r for r in rs if r.get("leak_n")]
    return dict(k=len(rs), cer=float(np.mean([r["cer"] for r in rs])), dele=sum(r["dele"] for r in rs) / n,
                ins=sum(r["ins"] for r in rs) / n,
                leak=(sum(r["leak"] for r in lk) / max(1, sum(r["leak_n"] for r in lk))) if lk else None,
                dec=float(np.mean([r["dec_ms"] for r in rs])), segs=float(np.mean([r["segs"] for r in rs])),
                chars=float(np.mean([r["chars"] for r in rs])))


def f3(v):
    return "–" if v is None else f"{v:.3f}"


def pc(v):
    return "–" if v is None else f"{100 * v:.0f}%"


def report(rows, opts) -> str:
    L = []
    A = [r for r in rows if r["stage"] in "ABC"]
    F = [r for r in rows if r["stage"] == "F"]
    clips = {}
    for r in A:
        clips.setdefault(_set(r), set()).add(r["idx"])
    lives = sorted(k for k in clips if k.startswith("live:"))
    snrs = opts["snr"]
    dens = opts["denoisers"]

    def cell(rs, key="cer"):
        a = agg(rs)
        if a is None:
            return "–"
        return pc(a[key]) if key == "leak" else f3(a[key]) if key != "chars" else f"{a[key]:.0f}"

    def sel(rs, **kw):
        return [r for r in rs if all((_set(r) == v) if k == "set" else r.get(k) == v for k, v in kw.items())]

    L.append(f"Clips: {len(clips.get('scored', ()))} with a reference"
             + (f", {len(clips['pseudo'])} with a pseudo reference (SenseVoice on the clean clip)" if "pseudo" in clips else "")
             + "".join(f", {len(clips[b])} live `{b[5:]}`" for b in lives)
             + ". Synthetic noise on the referenced clips: " + ", ".join(opts["noises"])
             + f" at {' / '.join(f'{s:g}' for s in snrs)} dB SNR.\n")

    L.append("\n#### A. Denoiser (SenseVoice; CER, then dropped · added chars per ref char at 5 dB, leakage at 5 dB)\n")
    hdr = ["denoiser", "clean"] + [f"{s:g} dB" for s in snrs] + ["dropped · added @5", "family voice leak @5",
                                                                  "PA leak @5"] + [b[5:] + " (live)" for b in lives]
    L.append("| " + " | ".join(hdr) + " |")
    L.append("|" + " --- |" * len(hdr))
    for d in dens:
        base = sel(A, stage="A", rec="sensevoice", den=d)
        sc = sel(base, set="scored")
        c = [cell(sel(sc, cond="clean"))] + [cell([r for r in sc if r["snr"] == s]) for s in snrs]
        a5 = agg([r for r in sc if r["snr"] == 5])
        c.append("–" if a5 is None else f"{f3(a5['dele'])} · {f3(a5['ins'])}")
        c.append(cell(sel(sc, noise="voice", snr=5.0), "leak"))
        c.append(cell(sel(sc, noise="pa", snr=5.0), "leak"))
        c += [cell(sel(base, cond=b)) for b in lives]
        L.append(f"| {d} | " + " | ".join(c) + " |")
    if "pseudo" in clips:
        L.append("\nPseudo-referenced clips (clean = 0 by construction): " + "; ".join(
            f"{d} " + " / ".join(cell([r for r in sel(A, stage='A', rec='sensevoice', den=d, set='pseudo')
                                       if r['snr'] == s]) for s in snrs) for d in dens) + ".")

    L.append("\n#### A by noise type (SenseVoice, CER, referenced clips)\n")
    hdr = ["noise", "SNR"] + dens
    L.append("| " + " | ".join(hdr) + " |")
    L.append("|" + " --- |" * len(hdr))
    for kind in opts["noises"]:
        for s in snrs:
            L.append(f"| {kind} | {s:g} | " + " | ".join(
                cell(sel(A, stage="A", rec="sensevoice", den=d, noise=kind, snr=s, set="scored")) for d in dens) + " |")

    L.append("\n#### Added latency per denoiser (median clip; this Mac, niced)\n")
    L.append("| denoiser | ms per audio second | whole utterance at the end (mean · max) | streams | added at the end if streamed |")
    L.append("| --- | --- | --- | --- | --- |")
    for d in dens:
        rs = [r for r in sel(A, stage="A", rec="sensevoice", den=d) if r["cond"] == "clean" or r["live"]]
        if not rs:
            continue
        rtf = float(np.median([r["den_ms"] / r["dur"] for r in rs]))
        whole = [r["den_ms"] for r in rs]
        can, delay = DELAY.get(d, (False, None))
        L.append(f"| {d} | {rtf:.1f} | {np.mean(whole):.0f} · {np.max(whole):.0f} ms | {'yes' if can else 'no'} | "
                 + (f"≈ {delay + rtf * 0.032:.0f} ms (its delay + one 32 ms frame)" if can
                    else f"{np.mean(whole):.0f} ms (needs the whole utterance)") + " |")

    L.append("\n#### A. Recogniser (CER, referenced clips)\n")
    hdr = ["recogniser", "denoiser", "clean"] + [f"{s:g} dB" for s in snrs] + [b[5:] for b in lives] + ["decode ms"]
    L.append("| " + " | ".join(hdr) + " |")
    L.append("|" + " --- |" * len(hdr))
    for rn in ("sensevoice", "paraformer"):
        for d in dict.fromkeys(["none", opts["pick"], "dfn3"]):
            base = sel(A, stage="A", rec=rn, den=d)
            if not base:
                continue
            sc = sel(base, set="scored")
            c = [cell(sel(sc, cond="clean"))] + [cell([r for r in sc if r["snr"] == s]) for s in snrs]
            c += [cell(sel(base, cond=b)) for b in lives]
            c.append(f"{agg(base)['dec']:.0f}")
            L.append(f"| {rn} | {d} | " + " | ".join(c) + " |")

    cols = BC_CONDS + lives

    def grid(stage, key, values, label):
        hdr = [label, "denoiser", "VAD on"] + cols + ["PA leak @5", "pieces / clip"]
        L.append("| " + " | ".join(hdr) + " |")
        L.append("|" + " --- |" * len(hdr))
        combos = sorted({(r["den"], r.get("vad_on", "noisy")) for r in A if r["stage"] == stage},
                        key=lambda t: (t[0] != "none", t))
        for v in values:
            for d, on in combos:
                base = [r for r in A if r["stage"] == stage and r.get(key) == v and r["den"] == d
                        and r.get("vad_on", "noisy") == on and (_set(r) == "scored" or r["live"])]
                if not base:
                    continue
                c = [cell(sel(base, cond=k)) for k in cols]
                c.append(cell(sel(base, cond="pa5"), "leak"))
                c.append(f"{agg(base)['segs']:.2f}")
                L.append(f"| {v} | {d} | {on} | " + " | ".join(c) + " |")

    L.append("\n#### B. VAD start threshold / pre-pad ms (SenseVoice, CER)\n")
    grid("B", "vad", ["whole" if p is None else f"{p}/{q}" for p, q in VAD_GRID], "start / pad")
    L.append("\n#### C. Input gain dB (SenseVoice, CER; agc = speech to −26 dBFS)\n")
    grid("C", "gain", [str(g) for g in GAINS], "gain")

    if F:
        L.append("\n#### F. False triggers: background alone, no owner (VAD fired · chars out per trial)\n")
        kinds = sorted({(r["kind"], r["level"]) for r in F})
        hdr = ["denoiser", "VAD on"] + [f"{'PA' if k == 'pa' else 'family voice'} {lv:+g} dB" for k, lv in kinds]
        L.append("| " + " | ".join(hdr) + " |")
        L.append("|" + " --- |" * len(hdr))
        for d in dens:
            for on in ("noisy", "denoised"):
                rs = [r for r in F if r["den"] == d and r["vad_on"] == on]
                if not rs:
                    continue
                c = []
                for k, lv in kinds:
                    b = [r for r in rs if r["kind"] == k and r["level"] == lv]
                    c.append(f"{pc(np.mean([r['fired'] for r in b]))} · {np.mean([r['chars'] for r in b]):.0f}")
                L.append(f"| {d} | {on} | " + " | ".join(c) + " |")
        n = len({(r['kind'], r['level']) for r in F})
        L.append(f"\n({len(F) // max(1, len(dens) * 2 - 1)} trials of 6 s over {n} sets; level relative to his "
                 "speech level; a restaurant bed 10 dB under the talker.)")

    if opts.get("live_paths"):
        L.append("\n#### Live batches: clips by STT path at the time (sidecar `model`)\n")
        L.append("| batch | local SenseVoice | cloud Whisper | unknown | chars out per clip (none) | pieces per clip |")
        L.append("| --- | --- | --- | --- | --- | --- |")
        for b, ps in opts["live_paths"].items():
            rs = sel(A, stage="A", rec="sensevoice", den="none", cond=f"live:{b}")
            a = agg(rs)
            chars = "–" if a is None else f"{a['chars']:.0f}"
            pieces = "–" if a is None else f"{a['segs']:.2f}"
            L.append(f"| {b} | {ps.get('local', 0)} | {ps.get('cloud', 0)} | {ps.get('unknown', 0)} | {chars} | {pieces} |")

    tr = sorted({r["track"] for r in A})
    L.append("\n#### Browser noiseSuppression (sidecar `track`)\n")
    if tr == ["unknown"]:
        L.append("No clip carries `track` yet, so on/off cannot be compared (both constraint sets in "
                 "voice-out.ts have noiseSuppression on).")
    else:
        L.append("| track | clips | CER none | CER " + opts["pick"] + " |")
        L.append("| --- | --- | --- | --- |")
        for t in tr:
            b = [r for r in A if r["stage"] == "A" and r["rec"] == "sensevoice" and r["track"] == t
                 and (r["cond"] == "clean" or r["live"])]
            L.append(f"| {t} | {len({r['idx'] for r in b})} | {cell(sel(b, den='none'))} | "
                     f"{cell(sel(b, den=opts['pick']))} |")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- main
def wait_quiet(d: str, quiet_s: float = 120.0):
    """While a clip landed in d within quiet_s, he is talking: wait before starting heavy work."""
    if not d:
        return
    said = False
    while True:
        try:
            newest = max((os.path.getmtime(p) for p in glob.glob(os.path.join(d, "*"))), default=0)
        except OSError:
            newest = 0
        left = quiet_s - (time.time() - newest)
        if left <= 0:
            return
        if not said:
            print(f"  he is talking (a clip {quiet_s - left:.0f} s ago): waiting", file=sys.stderr, flush=True)
            said = True
        time.sleep(min(left + 1, 30))


class Freezer:
    """
    Pauses the workers (SIGSTOP) while clips are arriving in the watched
    folder (he is talking, and the live STT server needs the CPU), and resumes
    them (SIGCONT) once nothing there is newer than 2 minutes.
    """

    def __init__(self, ex, d: str, quiet_s: float = 120.0):
        import signal
        import threading

        self.ex, self.d, self.q, self.sig = ex, d, quiet_s, signal
        self.frozen, self.done = False, threading.Event()
        if d:
            threading.Thread(target=self._run, daemon=True).start()

    def _pids(self):
        return list(getattr(self.ex, "_processes", {}) or {})

    def _run(self):
        while not self.done.wait(10):
            try:
                newest = max((os.path.getmtime(p) for p in glob.glob(os.path.join(self.d, "*"))), default=0)
            except OSError:
                continue
            talking = time.time() - newest < self.q
            if talking != self.frozen:
                for pid in self._pids():
                    try:
                        os.kill(pid, self.sig.SIGSTOP if talking else self.sig.SIGCONT)
                    except OSError:
                        pass
                self.frozen = talking
                print(f"  {'paused: he is talking' if talking else 'resumed'} ({time.strftime('%H:%M')})",
                      file=sys.stderr, flush=True)

    def close(self):
        self.done.set()
        for pid in self._pids():
            try:
                os.kill(pid, self.sig.SIGCONT)
            except OSError:
                pass


def latency(jobs, opts):
    """Each denoiser on each clean clip, warm, one process: ms per audio second and per utterance."""
    dens = G.denoisers(opts["denoisers"])
    print("| denoiser | ms per audio second | whole utterance, mean · p90 · max | delay | streams |")
    print("| --- | --- | --- | --- | --- |")
    clips = [G.load(j["wav"]) for j in jobs if not j["live"]]
    for d in dens:
        d(clips[0])
        ms = [G.timed(d, x)[1] for x in clips]
        per_s = [m / (len(x) / G.RATE) for m, x in zip(ms, clips)]
        print(f"| {d.name} | {np.mean(per_s):.1f} | {np.mean(ms):.0f} · {np.percentile(ms, 90):.0f} · {np.max(ms):.0f} ms "
              f"| {d.delay_ms:g} ms | {'yes' if d.streaming else 'no (whole clip)'} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True, help="a COPY of ~/lianki-voice-clips")
    ap.add_argument("--batches", default="", help="start=label,…; clip-name prefixes (UTC, '-' for ':')")
    ap.add_argument("--pseudo", action="store_true", help="also the clips without a reference")
    ap.add_argument("--snr", default="10,5,0")
    ap.add_argument("--noises", default=",".join(NOISES))
    ap.add_argument("--denoisers", default=",".join(DENOISERS))
    ap.add_argument("--pick", default="rnnoise", help="the denoiser B and C compare with none")
    ap.add_argument("--false-trials", type=int, default=12, help="per set in F; 0 = skip F")
    ap.add_argument("--paraformer", action="store_true", help="also streaming Paraformer (more memory)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--yield-dir", default="", help="wait while clips are arriving here (he is talking)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--latency", action="store_true")
    ap.add_argument("--only", default="all", choices=["all", "scored", "live", "false"],
                    help="run part of the work (e.g. two processes side by side), merge with --report")
    ap.add_argument("--ckpt", help="append each finished job's rows here (JSON lines); a rerun skips them")
    ap.add_argument("--reverse", action="store_true",
                    help="last job first: a second process on the same work, with its own --ckpt")
    ap.add_argument("--report",help="comma-separated --ckpt files: only write the report from them")
    ap.add_argument("--md")
    ap.add_argument("--json")
    a = ap.parse_args()
    opts = dict(snr=[float(s) for s in a.snr.split(",")], noises=a.noises.split(","),
                denoisers=a.denoisers.split(","), pick=a.pick, threads=a.threads, paraformer=a.paraformer)
    refs = G.references(a.clips)
    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    labels = G.live_labels(wavs, a.batches)
    jobs, tracks = [], {}
    for i, w in enumerate(wavs):
        name = os.path.basename(w)[:-4]
        live, path = labels.get(w, ("", "unknown"))
        ref, src = refs.get(name, (None, None))
        if not live and ref is None and not a.pseudo:
            continue
        jobs.append(dict(idx=i, wav=w, ref=ref, ref_src=src, live=live, path=path))
        t = G.sidecar(w).get("track")
        tracks[i] = "unknown" if not isinstance(t, dict) else ("ns-on" if t.get("noiseSuppression") else "ns-off")
    if a.limit:
        jobs = jobs[: a.limit]
    by = {}
    for j in jobs:
        by[j["live"] or ("scored" if j["ref"] else "pseudo")] = by.get(j["live"] or ("scored" if j["ref"] else "pseudo"), 0) + 1
    print(f"clips {by}", file=sys.stderr, flush=True)
    live_paths: dict = {}
    for j in jobs:
        if j["live"]:
            live_paths.setdefault(j["live"], {}).setdefault(j["path"], 0)
            live_paths[j["live"]][j["path"]] += 1
    opts["live_paths"] = live_paths
    if a.latency:
        return latency(jobs, opts)
    if a.report:
        rows = [json.loads(line) for f in a.report.split(",") for line in open(f) if line.strip()]
        uniq = {}
        for r in rows:  # two processes may both have finished a job: keep one copy
            if not r.get("_job"):
                k = tuple(str(r.get(f)) for f in ("stage", "idx", "cond", "den", "rec", "vad", "vad_on", "gain",
                                                  "kind", "level", "fired", "chars", "segs"))
                uniq.setdefault(k, r) if r["stage"] != "F" else uniq.setdefault((k, len(uniq)), r)
        rows = list(uniq.values())
        return finish(rows, opts, a)
    his = float(np.median([G.level_db(G.load(j["wav"])) for j in jobs if j["ref"]]))
    work = ([("clip", j) for j in jobs if a.only in ("all", "scored") and not j["live"]]
            + [("clip", j) for j in jobs if a.only in ("all", "live") and j["live"]]
            + [("false", dict(kind=k, level=lv, his=his, k=t)) for k in ("pa", "voice") for lv in (0.0, -10.0)
               for t in range(a.false_trials) if a.only in ("all", "false", "live")])
    key = lambda w: json.dumps([w[0], w[1].get("wav") or [w[1]["kind"], w[1]["level"], w[1]["k"]]])  # noqa: E731
    rows, seen = [], set()
    if a.ckpt and os.path.exists(a.ckpt):
        for line in open(a.ckpt):
            r = json.loads(line)
            (seen.add(r["_job"]) if r.get("_job") else rows.append(r))
    work = [w for w in work if key(w) not in seen][:: -1 if a.reverse else 1]
    print(f"{len(work)} jobs to run, {len(seen)} already in the checkpoint", file=sys.stderr, flush=True)
    t0, done = time.time(), 0
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(opts,)) as ex:
        stop = Freezer(ex, a.yield_dir)
        pending, it = set(), iter(work)
        while True:
            while len(pending) < a.workers:
                nxt = next(it, None)
                if nxt is None:
                    break
                wait_quiet(a.yield_dir)
                fut = ex.submit(run_clip if nxt[0] == "clip" else run_false, nxt[1])
                fut.key = key(nxt)
                pending.add(fut)
            if not pending:
                break
            fin, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in fin:
                got = f.result()
                rows.extend(got)
                if a.ckpt:
                    with open(a.ckpt, "a") as ck:
                        for r in got:
                            ck.write(json.dumps({**r, "track": tracks.get(r.get("idx"), "unknown")}) + "\n")
                        ck.write(json.dumps({"_job": f.key}) + "\n")
                done += 1
                print(f"  {done}/{len(work)} jobs, {time.time() - t0:.0f} s", file=sys.stderr, flush=True)
        stop.close()
    for r in rows:
        if "idx" in r:
            r["track"] = tracks[r["idx"]]
    finish(rows, opts, a)


def finish(rows, opts, a):
    md = report(rows, opts)
    print(md)
    if a.md:
        open(a.md, "w").write(md)
    if a.json:
        json.dump(rows, open(a.json, "w"))


if __name__ == "__main__":
    main()
