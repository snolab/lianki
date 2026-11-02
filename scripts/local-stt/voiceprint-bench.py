#!/usr/bin/env python3
"""
What the speaker check adds to each final (docs/local-stt.md, "Voiceprint"):
the CAM++ embedding + noise gate alone, the SenseVoice final alone, and both
run side by side as server.py does (the final waits for the longer one).

Files only, nothing played. It enrols a throwaway print in a temporary
folder (never ~/.config/lianki-stt/voiceprints) from a COPY of the clips,
prints aggregate numbers only (no text), and deletes the print at the end.
It shares the Mac with the live STT: run it niced, at most 2 threads, and it
waits while he is talking (a clip landing in --yield-dir, or a final in the
live server's log within the last 2 minutes).

    nice -n 20 taskpolicy -b env OMP_NUM_THREADS=2 LIANKI_STT_LANG_PICK=0 \\
      ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/voiceprint-bench.py \\
      --clips <a COPY of ~/lianki-voice-clips> --yield-dir ~/lianki-voice-clips
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import voiceprint as V  # noqa: E402


def last_final_age() -> float:
    """Seconds since the live server's last final (oxmgr's log), or a large number."""
    try:
        out = subprocess.run(["oxmgr", "logs", "lianki-stt", "--lines", "40"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return 1e9
    ts = re.findall(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d): .*final #", out, re.M)
    if not ts:
        return 1e9
    return time.time() - time.mktime(time.strptime(ts[-1], "%Y-%m-%d %H:%M:%S"))


def wait_quiet(yield_dir: str, quiet_s: float = 120.0) -> None:
    while True:
        newest = 0.0
        if yield_dir and os.path.isdir(yield_dir):
            for f in os.listdir(yield_dir):
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(yield_dir, f)))
                except OSError:
                    pass
        age = min(time.time() - newest if newest else 1e9, last_final_age())
        if age >= quiet_s:
            return
        print(f"  he is talking (last activity {age:.0f} s ago): waiting", file=sys.stderr, flush=True)
        time.sleep(min(60.0, quiet_s - age + 1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True, help="a COPY of ~/lianki-voice-clips")
    ap.add_argument("--yield-dir", default="")
    ap.add_argument("--enrol", type=int, default=12, help="clips used for the throwaway print")
    ap.add_argument("--n", type=int, default=40, help="clips timed")
    ap.add_argument("--threads", type=int, default=1, help="CAM++ threads (the server uses 1)")
    ap.add_argument("--asr-threads", type=int, default=1)
    a = ap.parse_args()
    import engines

    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    xs = [(w, V.load_wav(w)) for w in wavs]
    xs = [(w, x) for w, x in xs if 1.5 <= len(x) / V.RATE <= 30]
    if len(xs) < a.enrol + 5:
        raise SystemExit("not enough clips")
    wait_quiet(a.yield_dir)
    t0 = time.perf_counter()
    asr = engines.SenseVoice(threads=a.asr_threads)
    emb = V.Embedder(V.MODELS["campp"], threads=a.threads)
    print(f"loaded in {(time.perf_counter() - t0) * 1000:.0f} ms", file=sys.stderr)
    with tempfile.TemporaryDirectory() as tmp:
        v = V.Verifier(V.Store(os.path.join(tmp, "vp")), ["campp"], embedders={"campp": emb})
        e = V.Enrolment(v, "bench", keep_audio=False)
        for _, x in xs[: a.enrol]:
            e.add(x)
        if e.n < 3:
            raise SystemExit("enrolment failed")
        V.ENROL_MIN = min(V.ENROL_MIN, e.n)  # a throwaway print: whatever passed the checks
        e.commit()
        rows = []
        pool = ThreadPoolExecutor(max_workers=1)
        fin = getattr(asr, "final", None) or (lambda x: (*asr.transcribe(x), None))
        for i, (w, x) in enumerate(xs[a.enrol : a.enrol + a.n]):
            if i % 10 == 0:
                wait_quiet(a.yield_dir)
            fin(x)  # warm caches for this length
            t = time.perf_counter()
            fin(x)
            dec = time.perf_counter() - t
            t = time.perf_counter()
            r = v.verify(x, "bench")
            spk = time.perf_counter() - t
            t = time.perf_counter()
            fut = pool.submit(v.verify, x, "bench")
            fin(x)
            fut.result()
            both = time.perf_counter() - t
            rows.append((len(x) / V.RATE, dec * 1000, spk * 1000, both * 1000, r["decision"]))
        A = np.array([r[:4] for r in rows])
        dec, spk, both = A[:, 1], A[:, 2], A[:, 3]
        added = both - dec
        per_s = spk / A[:, 0]
        print(f"clips timed: {len(rows)}, audio {np.median(A[:, 0]):.1f} s median ({A[:, 0].min():.1f}-{A[:, 0].max():.1f})")
        print(f"decode alone      ms: median {np.median(dec):.0f}, p90 {np.percentile(dec, 90):.0f}, max {dec.max():.0f}")
        print(f"speaker alone     ms: median {np.median(spk):.0f}, p90 {np.percentile(spk, 90):.0f}, max {spk.max():.0f}"
              f"  ({np.median(per_s):.1f} ms per audio second)")
        print(f"side by side      ms: median {np.median(both):.0f}, p90 {np.percentile(both, 90):.0f}, max {both.max():.0f}")
        print(f"added to a final  ms: median {np.median(added):.0f}, p90 {np.percentile(added, 90):.0f}, max {added.max():.0f}")
        ds = {d: sum(1 for r in rows if r[4] == d) for d in ("me", "unknown", "other")}
        print(f"decisions against the throwaway print (not a measurement of accuracy): {ds}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
