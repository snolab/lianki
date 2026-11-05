#!/usr/bin/env python3
"""
Would a second reading improve the owner's lines? SenseVoice (what he has today)
against a re-check by Whisper, and whether SenseVoice can say when it is unsure
(docs/stt-ab.md, "Re-check by a second engine").

Files only, read-only on the clips. Nothing is played. **The default is fully
local:** mlx-whisper large-v3-turbo, the weights Workers AI runs, with
HF_HUB_OFFLINE=1, as a stand-in for the cloud route. `--cloud` is the one way out
of this Mac and it will not start without his real voiceprint: only a clip the
Mac's own check scores as `me` is sent (voiceprint.py; a clip may hold other
voices, and those people have not agreed to cloud processing).

    # 1. read every clip with both engines; texts go to a private file, never the repo
    HF_HUB_OFFLINE=1 nice -n 20 ~/.cache/lianki-stt/recheck-venv/bin/python -I \
        scripts/local-stt/recheck-eval.py run --out <private dir>/readings.json
    # 2. aggregate numbers only
    ~/.cache/lianki-stt/recheck-venv/bin/python -I scripts/local-stt/recheck-eval.py \
        report --readings <private dir>/readings.json [--extra-refs <private>.json] [--json out.json]

The private file holds the clips' transcripts: keep it out of the repo, delete it
when done. The report prints no clip name and no text.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import random
import re
import sys
import time
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gridlib as G  # noqa: E402
import voiceprint as VP  # noqa: E402

RATE = G.RATE
#: lib/stt.ts: sttPrompt("zh"), and turbo's STT_ANTI_HALLUCINATION.
HINT_ZH = "我说中文，有时夹杂日本語和English。"
WHISPER_REPO = "mlx-community/whisper-large-v3-turbo"
#: docs/workers-ai.md: USD per audio minute.
TURBO_USD_PER_MIN = 0.000513
#: A change of at least this much CER on a clip counts as fixed or broken.
DELTA = 0.02


def write_private(path: str, data: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)


class Confidence:
    """SenseVoice's CTC head through onnxruntime (sherpa-onnx returns no scores for it)."""

    def __init__(self, model_dir: str):
        from engines import LangPicker

        self.p = LangPicker(model_dir)

    def __call__(self, audio: np.ndarray) -> dict:
        p = self.p
        x = p.features(audio)
        if len(x) == 0:
            return {}
        z = p.sess.run(None, {
            "x": x[None],
            "x_length": np.array([len(x)], np.int32),
            "language": p.lid[:1],
            "text_norm": np.array([p.itn], np.int32),
        })[0][0, 4:]
        z = z - z.max(-1, keepdims=True)
        lp = z - np.log(np.exp(z).sum(-1, keepdims=True))
        ids, best = lp.argmax(-1), lp.max(-1)
        keep = ids != 0
        toks = best[keep]
        return {
            "frameLp": round(float(best.mean()), 4),
            "tokenLp": round(float(toks.mean()), 4) if len(toks) else None,
            "tokenP10": round(float(np.percentile(toks, 10)), 4) if len(toks) else None,
            "tokenMin": round(float(toks.min()), 4) if len(toks) else None,
            "blank": round(float((~keep).mean()), 4),
            "tokens": int(keep.sum()),
        }


def sherpa_scores(engine, audio: np.ndarray) -> int:
    """How many per-token scores sherpa-onnx gives for SenseVoice today (expected: none)."""
    s = engine.r.create_stream()
    s.accept_waveform(RATE, audio)
    engine.r.decode_stream(s)
    r = s.result
    return len(getattr(r, "ys_log_probs", []) or [])


def run(a) -> None:
    import mlx_whisper

    from engines import MODELS, SenseVoice

    sv = SenseVoice(threads=2)
    conf = Confidence(os.path.join(MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"))
    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    out: dict = {"clips": {}, "whisper": WHISPER_REPO}
    done = {}
    if os.path.exists(a.out):
        with open(a.out, encoding="utf-8") as f:
            done = json.load(f).get("clips", {})
    out["clips"] = done
    sherpa = None
    for i, w in enumerate(wavs):
        n = os.path.basename(w)[:-4]
        if n in done:
            continue
        x = G.load(w)
        s = G.sidecar(w)
        if sherpa is None:
            sherpa = sherpa_scores(sv, x)
            out["sherpaScores"] = sherpa
        t0 = time.perf_counter()
        text, lang, auto = sv.final(x)
        sv_ms = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        c = conf(x)
        conf_ms = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        r = mlx_whisper.transcribe(
            x,
            path_or_hf_repo=WHISPER_REPO,
            initial_prompt=HINT_ZH,
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
            word_timestamps=False,
            verbose=None,
        )
        wh_ms = (time.perf_counter() - t0) * 1000
        segs = r.get("segments") or []
        sp, snr = VP.speech_stats(x)
        out["clips"][n] = {
            "s": round(len(x) / RATE, 2),
            "speechS": round(sp, 2),
            "snrDb": round(snr, 1),
            "device": "android" if "Android" in str(s.get("label")) else "iphone" if "iPhone" in str(s.get("label")) else "other",
            "asRecorded": s.get("transcript") if str(s.get("model") or "").startswith("@cf/") else None,
            "sv": text,
            "svLang": lang,
            "svMs": round(sv_ms),
            "conf": c,
            "confMs": round(conf_ms),
            "wh": (r.get("text") or "").strip(),
            "whLang": r.get("language"),
            "whMs": round(wh_ms),
            "whNoSpeech": max((float(q.get("no_speech_prob", 0)) for q in segs), default=None),
            "whLogprob": min((float(q.get("avg_logprob", 0)) for q in segs), default=None),
            "whCompress": max((float(q.get("compression_ratio", 0)) for q in segs), default=None),
        }
        if i % 10 == 0:
            write_private(a.out, json.dumps(out, ensure_ascii=False))
            print(f"{i + 1}/{len(wavs)}", file=sys.stderr, flush=True)
    write_private(a.out, json.dumps(out, ensure_ascii=False))
    print("done", file=sys.stderr)


def cer(ref: str, hyp: str) -> float:
    s = G.score(ref, hyp)
    return min(1.0, float(s["cer"]))


def spearman(x: list[float], y: list[float]) -> float:
    rank = lambda v: np.argsort(np.argsort(v)).astype(float)  # noqa: E731
    if len(x) < 3 or np.std(x) == 0 or np.std(y) == 0:
        return float("nan")
    return float(np.corrcoef(rank(np.array(x)), rank(np.array(y)))[0, 1])


def auc(score: list[float], bad: list[bool]) -> float:
    """Chance that a wrong clip scores lower than a right one (0.5 = useless, 1 = perfect)."""
    pos = [s for s, b in zip(score, bad) if b]
    neg = [s for s, b in zip(score, bad) if not b]
    if not pos or not neg:
        return float("nan")
    wins = sum((p < n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


#: Stock Whisper additions: a scoring aid here (the mic's own guard is mic.ts cleanTranscript).
STOCK = re.compile(r"感谢观看|感謝觀看|字幕志愿者|字幕志願者|李宗盛|中文字幕|请不吝|點贊|点赞|订阅|thanks for watching|subtitles by", re.I)


def hallucinated(text: str, seconds: float) -> dict:
    t = text.strip()
    letters = re.sub(r"[\W_]+", "", t)
    echo = "夹杂日本語" in t or "我说中文" in t
    stock = bool(STOCK.search(t))
    loop = bool(re.search(r"(.{2,12}?)\1{3,}", letters))
    dense = len(letters) / max(seconds, 0.5) > 14  # faster than anyone speaks
    return {"echo": echo, "stock": stock, "loop": loop, "dense": dense, "any": echo or stock or loop or dense}


def report(a) -> None:
    with open(a.readings, encoding="utf-8") as f:
        R = json.load(f)
    C = R["clips"]
    refs = {k: v for k, v in G.references(a.clips).items()}
    amb = set()
    p = os.path.join(a.clips, "refs-agent.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            amb = {k for k, v in json.load(f).items() if isinstance(v, dict) and v.get("ambiguous")}
    sets = {"refs20": {k: refs[k][0] for k in refs if k in C}}
    sets["clear14"] = {k: v for k, v in sets["refs20"].items() if k not in amb}
    if a.extra_refs:
        with open(a.extra_refs, encoding="utf-8") as f:
            extra = {k: v["text"] for k, v in json.load(f).items() if not k.startswith("_") and k in C}
        sets["extra"] = extra
        sets["all"] = {**sets["refs20"], **extra}
    out: dict = {"n": len(C), "sherpaScores": R.get("sherpaScores"), "sets": {}}

    def good(k: str) -> str:
        """Whisper's text after the guards the mic would apply: a hallucinated line is dropped."""
        c = C[k]
        return "" if hallucinated(c["wh"], c["s"])["any"] else c["wh"]

    for name, S in sets.items():
        keys = sorted(S)
        sv = [cer(S[k], C[k]["sv"]) for k in keys]
        wh = [cer(S[k], C[k]["wh"]) for k in keys]
        rec = [(k, cer(S[k], C[k]["asRecorded"])) for k in keys if C[k].get("asRecorded")]
        row: dict = {
            "n": len(keys),
            "cerSense": round(float(np.mean(sv)), 3),
            "cerWhisper": round(float(np.mean(wh)), 3),
            "exactSense": sum(x == 0 for x in sv),
            "exactWhisper": sum(x == 0 for x in wh),
            "asRecordedN": len(rec),
        }
        if rec:
            d = dict(zip(keys, sv))
            row["cerAsRecorded"] = round(float(np.mean([v for _k, v in rec])), 3)
            row["cerSenseOnThose"] = round(float(np.mean([d[k] for k, _v in rec])), 3)

        # Confidence against SenseVoice's own errors.
        with_conf = [k for k in keys if C[k]["conf"].get("tokenLp") is not None]
        y = [cer(S[k], C[k]["sv"]) for k in with_conf]
        bad = [v > DELTA for v in y]
        row["errors"] = sum(bad)
        feats = {
            "tokenLp": lambda c: c["conf"]["tokenLp"],
            "frameLp": lambda c: c["conf"]["frameLp"],
            "tokenP10": lambda c: c["conf"]["tokenP10"],
            "tokenMin": lambda c: c["conf"]["tokenMin"],
            "snrDb": lambda c: c["snrDb"],
            "speechS": lambda c: c["speechS"],
            "whLogprob": lambda c: c["whLogprob"] if c["whLogprob"] is not None else -9,
        }
        row["conf"] = {f: {"spearmanToCer": round(spearman([g(C[k]) for k in with_conf], y), 2),
                           "auc": round(auc([g(C[k]) for k in with_conf], bad), 2)} for f, g in feats.items()}
        # A stand-in with no model score: how unlike each other the two engines read.
        dis = [cer(C[k]["sv"], C[k]["wh"]) for k in keys]
        row["conf"]["disagreement"] = {"spearmanToCer": round(spearman(dis, sv), 2),
                                       "auc": round(auc([-v for v in dis], [v > DELTA for v in sv]), 2)}

        # Policies: swap in Whisper's reading when the policy says so; count against the reference.
        def policy(name2, send):
            fixed = broke = sent = 0
            after = []
            for k, s0 in zip(keys, sv):
                if not send(k):
                    after.append(s0)
                    continue
                sent += 1
                g = good(k)
                # An empty re-check keeps SenseVoice's line: it never deletes one.
                s1 = cer(S[k], g) if g else s0
                after.append(s1)
                fixed += s1 <= s0 - DELTA
                broke += s1 >= s0 + DELTA
            row.setdefault("policies", {})[name2] = {
                "sent": sent, "fixed": fixed, "broke": broke, "cerAfter": round(float(np.mean(after)), 3)}

        policy("always", lambda k: True)
        tp = sorted(C[k]["conf"].get("tokenLp") if C[k]["conf"].get("tokenLp") is not None else 0 for k in keys)
        for q in (0.25, 0.5):
            cut = tp[max(0, int(len(tp) * q) - 1)]
            policy(f"lowest-{int(q * 100)}pct-tokenLp", lambda k, c=cut: (C[k]["conf"].get("tokenLp") or 0) <= c)
        policy("snr-under-15dB", lambda k: C[k]["snrDb"] < 15)
        policy("under-3s-speech", lambda k: C[k]["speechS"] < 3)
        # A fair test of the confidence: its line is picked with each clip left out.
        fixed = broke = sent = 0
        after = []
        for k, s0 in zip(keys, sv):
            others = [(C[o]["conf"].get("tokenLp") or 0, o) for o in keys if o != k]
            best, cut = None, -9.0
            for lp, _o in others:
                gain = 0.0
                for lp2, o2 in others:
                    if lp2 <= lp and good(o2):
                        gain += cer(S[o2], C[o2]["sv"]) - cer(S[o2], good(o2))
                if best is None or gain > best:
                    best, cut = gain, lp
            if (C[k]["conf"].get("tokenLp") or 0) <= cut and good(k):
                s1 = cer(S[k], good(k))
                sent += 1
                fixed += s1 <= s0 - DELTA
                broke += s1 >= s0 + DELTA
                after.append(s1)
            else:
                after.append(s0)
        row["policies"]["tokenLp-line-picked-leave-one-out"] = {
            "sent": sent, "fixed": fixed, "broke": broke, "cerAfter": round(float(np.mean(after)), 3)}
        out["sets"][name] = row

    # Everything, unreferenced: engines' behaviour, hallucination rate, disagreement, time.
    keys = sorted(C)
    long_enough = [k for k in keys if C[k]["s"] > 0]
    for eng, field in (("sense", "sv"), ("whisper", "wh")):
        hs = [hallucinated(C[k][field], C[k]["s"]) for k in long_enough]
        out[f"hallucination-{eng}"] = {
            "n": len(hs),
            **{t: sum(h[t] for h in hs) for t in ("echo", "stock", "loop", "dense", "any")},
            "emptyOut": sum(not C[k][field].strip() for k in long_enough),
        }
    short = [k for k in keys if C[k]["speechS"] < 1.5]
    out["hallucination-under-1.5s-speech"] = {
        "n": len(short),
        "whisper": sum(hallucinated(C[k]["wh"], C[k]["s"])["any"] for k in short),
        "sense": sum(hallucinated(C[k]["sv"], C[k]["s"])["any"] for k in short),
    }
    d = [cer(C[k]["sv"], C[k]["wh"]) for k in keys]
    out["disagreement"] = {"n": len(d), "median": round(float(np.median(d)), 3), "over0.5": sum(v > 0.5 for v in d)}
    pct = lambda v, q: round(float(np.percentile(v, q)))  # noqa: E731
    for f in ("svMs", "confMs", "whMs"):
        v = [C[k][f] for k in keys]
        out[f] = {"median": pct(v, 50), "p90": pct(v, 90), "max": max(v)}
    total_s = sum(C[k]["s"] for k in keys)
    out["seconds"] = round(total_s, 1)
    out["usd-all-clips-if-cloud"] = round(total_s / 60 * TURBO_USD_PER_MIN, 5)

    txt = json.dumps(out, indent=1, sort_keys=True)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(txt)
    print(txt)


def cloud(a) -> None:
    """
    The real route, for clips the Mac's own check scores as him. It refuses to start
    without his voiceprint, and it never sends a clip that is not `me`.
    """
    token, acct = os.environ.get("CLOUDFLARE_AI_TOKEN"), os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not acct:
        raise SystemExit("cloud: needs CLOUDFLARE_AI_TOKEN and CLOUDFLARE_ACCOUNT_ID")
    store = VP.Store()
    v = VP.Verifier(store, ["campp"])
    if not store.prints():
        raise SystemExit("cloud: no voiceprint enrolled: nothing is sent (run the local comparison instead)")
    wavs = sorted(glob.glob(os.path.join(a.clips, "*.wav")))
    random.Random(380).shuffle(wavs)
    sent, out, seconds = 0, {}, 0.0
    for w in wavs:
        if sent >= a.limit:
            break
        x = G.load(w)
        s = v.verify(x, None)
        if s["decision"] != "me":
            continue
        import base64

        import mimetypes  # noqa: F401

        body = json.dumps({"audio": base64.b64encode(open(w, "rb").read()).decode(), "initial_prompt": HINT_ZH,
                           "condition_on_previous_text": False, "no_speech_threshold": 0.5}).encode()
        req = urllib.request.Request(
            f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/openai/whisper-large-v3-turbo",
            data=body, headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode())
        out[os.path.basename(w)[:-4]] = {"text": (j.get("result") or {}).get("text", ""), "ms": round((time.perf_counter() - t0) * 1000)}
        sent += 1
        seconds += len(x) / RATE
    write_private(a.out, json.dumps(out, ensure_ascii=False))
    print(json.dumps({"sent": sent, "seconds": round(seconds, 1), "usd": round(seconds / 60 * TURBO_USD_PER_MIN, 5)}))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    home = os.path.expanduser("~/lianki-voice-clips")
    r = sub.add_parser("run")
    r.add_argument("--clips", default=home)
    r.add_argument("--out", required=True)
    q = sub.add_parser("report")
    q.add_argument("--clips", default=home)
    q.add_argument("--readings", required=True)
    q.add_argument("--extra-refs", default="")
    q.add_argument("--json", default="")
    c = sub.add_parser("cloud")
    c.add_argument("--clips", default=home)
    c.add_argument("--limit", type=int, default=30)
    c.add_argument("--out", required=True)
    a = ap.parse_args()
    {"run": run, "report": report, "cloud": cloud}[a.cmd](a)


if __name__ == "__main__":
    main()
