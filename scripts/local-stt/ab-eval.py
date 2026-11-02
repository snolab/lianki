#!/usr/bin/env python3
"""
Offline A/B of the owner's speech-input path (docs/stt-ab.md), on his saved
clips (~/lianki-voice-clips, the clip sink). Files only: nothing is played.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/ab-eval.py \
        [--clips ~/lianki-voice-clips] [--ws ws://127.0.0.1:5193] [--whisper] \
        [--chat /tmp/lianki-chat-fast.jsonl] [--json out.json]

What it measures, per clip and in total:

1. **Endpoint length** (mic.ts ENDPOINT_MS). Silero v5 (the very model
   vad-web 0.0.30 runs on the phone) gives a probability per 32 ms frame; the
   mic's own end-of-speech is replayed on it (threshold = noise floor + 0.25
   within 0.35–0.8, the floor an EMA of the frames before speech), for 400,
   600, 800 and 1000 ms, and vad-web's own end (redemptionMs 1400, under
   0.25) as the non-streaming baseline. An endpoint inside a pause splits the
   utterance: the rest becomes a new utterance (with vad-web's pre-pad since
   the restart, a misfire under minSpeechMs 400 dropped), as on the phone.
   Each piece is decoded by SenseVoice and the texts joined; CER against the
   reference, and how many clips were split.
2. **Streaming vs whole clip.** With --ws, each piece of the 600 ms run is
   streamed to the real server at real-time pace (the phone's frames: pre-pad
   0x02, then 32 ms 0x01 frames, then end): first partial (from the first
   frame), end → final, and the final text, which must equal the whole-clip
   decode of the same audio (SenseVoice is re-decoded whole each time). The
   whole-clip upload costs the same decode plus the upload of the WAV
   (32 KB per second of speech) after the end, and shows nothing while he
   speaks.
3. **Cloud Whisper.** The transcript Workers AI gave at the time (the clip's
   sidecar, `model` @cf/…), and with --whisper the same weights locally
   (mlx-whisper large-v3-turbo) with the route's ?hint=zh prompt
   (lib/stt.ts sttPrompt("zh")), as a stand-in for the hinted route.
4. **AEC on/off.** Grouped by the sidecar's `track` (what noteTrack() saw the
   browser apply: echoCancellation, noiseSuppression, autoGainControl). Clips
   without it are "unknown".
5. **Field metrics** (--chat): from the owner's chat log, how often a spoken
   message is followed within 90 s by a restatement (character-bigram
   overlap) or a correction phrase, per STT path.

References: `<name>.ref.txt` (the owner's, wins) else `refs-agent.json` in
the clips folder (the agent's, `{name: {text, ambiguous?, note?}}`).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engines import MODELS, RATE, simplified  # noqa: E402

FRAME = 512  # 32 ms at 16 kHz, vad-web v5
# vad-web 0.0.30 defaults (frame-processor.js)
POS, NEG = 0.3, 0.25
PRE_PAD_MS, REDEMPTION_MS, MIN_SPEECH_MS = 800, 1400, 400
# mic.ts
ENDPOINT_MARGIN, ENDPOINT_MIN, ENDPOINT_MAX, FLOOR_ALPHA = 0.25, 0.35, 0.8, 0.05
ENDPOINTS = [400, 600, 800, 1000]
HINT_ZH = "我说中文，有时夹杂日本語和English。"  # lib/stt.ts sttPrompt("zh")
VAD_MODEL = os.path.join(MODELS, "vad-web-0.0.30", "silero_vad_v5.onnx")
VAD_URL = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/silero_vad_v5.onnx"


# ---------------------------------------------------------------- scoring
def norm(s: str) -> str:
    s = simplified(unicodedata.normalize("NFKC", s))
    return re.sub(r"[\W_]+", "", s.lower())


def edits(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return d[len(b)]


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0 if not h else 1.0
    return min(1.0, edits(r, h) / len(r))  # a hallucinated paragraph counts as 1, not 20


# ---------------------------------------------------------------- VAD
class Silero:
    def __init__(self):
        import onnxruntime as ort

        if not os.path.exists(VAD_MODEL):
            raise SystemExit(f"missing {VAD_MODEL}: curl -Lo {VAD_MODEL} --create-dirs {VAD_URL}")
        o = ort.SessionOptions()
        o.inter_op_num_threads = o.intra_op_num_threads = 1
        self.s = ort.InferenceSession(VAD_MODEL, o)

    def probs(self, audio: np.ndarray) -> np.ndarray:
        """One probability per whole 32 ms frame, state carried, as vad-web feeds it."""
        state = np.zeros((2, 1, 128), dtype=np.float32)
        sr = np.array(RATE, dtype=np.int64)
        out = []
        for i in range(len(audio) // FRAME):
            x = audio[i * FRAME : (i + 1) * FRAME][None, :].astype(np.float32)
            p, state = self.s.run(None, {"input": x, "state": state, "sr": sr})
            out.append(float(p[0][0]))
        return np.array(out)


def threshold(floor: float) -> float:
    return min(ENDPOINT_MAX, max(ENDPOINT_MIN, floor + ENDPOINT_MARGIN))


def segment(p: np.ndarray, endpoint_ms: int | None, n_samples: int) -> list[dict]:
    """
    The utterances the phone would have sent from this clip: [{start, end}] in
    samples (start includes the pre-pad since the last restart). endpoint_ms
    None = vad-web's own end (redemption), else the mic's streaming endpoint.
    """
    pad_f = PRE_PAD_MS // 32
    min_f = MIN_SPEECH_MS // 32
    red_f = REDEMPTION_MS // 32
    ep_f = int(np.ceil(endpoint_ms / 32)) if endpoint_ms else None
    segs, floor, i, restart = [], 0.1, 0, 0
    n = len(p)
    while i < n:
        # listening: the floor follows Silero until speech starts
        while i < n and p[i] < POS:
            floor += (p[i] - floor) * FLOOR_ALPHA
            i += 1
        if i >= n:
            break
        start_f = max(restart, i - pad_f)
        thr = threshold(floor)
        heard, quiet, red, speech_f, end_f = False, 0, 0, 0, None
        j = i
        while j < n:
            q = p[j]
            if q >= POS:
                speech_f += 1
            if ep_f is not None:
                if q >= thr:
                    heard, quiet = True, 0
                else:
                    quiet += 1
                if heard and quiet >= ep_f:
                    end_f = j + 1
                    break
            # vad-web's own end runs in both modes
            if q >= POS:
                red = 0
            elif q < NEG:
                red += 1
                if red >= red_f:
                    end_f = j + 1
                    break
            j += 1
        end_f = n if end_f is None else end_f
        if speech_f >= min_f:
            end = n_samples if end_f == n else end_f * FRAME
            segs.append({"start": start_f * FRAME, "first": i * FRAME, "end": end, "cut": end_f < n})
        restart = i = end_f
    return segs


# ---------------------------------------------------------------- streaming
def i16(x: np.ndarray) -> bytes:
    """Back to the clip's own int16 samples (exact: soundfile read them as n / 32768)."""
    return np.clip(np.round(x * 32768), -32768, 32767).astype("<i2").tobytes()


async def stream(url: str, pieces: list[np.ndarray], pace: float) -> list[dict]:
    import websockets

    out = []
    async with websockets.connect(url, origin="http://localhost:3000", max_size=None) as ws:
        hello = json.loads(await ws.recv())
        assert hello.get("t") == "ready", hello
        for uid, (pre, body) in enumerate(pieces, start=int(time.time()) % 100000 * 100):
            await ws.send(json.dumps({"t": "begin", "id": uid}))
            if len(pre):
                await ws.send(b"\x02" + i16(pre))
            t0 = time.perf_counter()
            first, partials = None, 0
            got: dict = {}

            async def reader():
                nonlocal first, partials
                async for m in ws:
                    if isinstance(m, bytes):
                        continue
                    d = json.loads(m)
                    if d.get("id") != uid:
                        continue
                    if d["t"] == "partial":
                        partials += 1
                        if first is None:
                            first = (time.perf_counter() - t0) * 1000
                    elif d["t"] in ("final", "error"):
                        got.update(d, t_final=time.perf_counter())
                        return

            task = asyncio.create_task(reader())
            for k in range(0, len(body), FRAME):
                fr = body[k : k + FRAME]
                await ws.send(b"\x01" + i16(fr))
                if pace:
                    await asyncio.sleep(len(fr) / RATE / pace)
            t_end = time.perf_counter()
            await ws.send(json.dumps({"t": "end", "id": uid}))
            await asyncio.wait_for(task, 10)
            out.append(
                {
                    "text": got.get("text", ""),
                    "partials": partials,
                    "firstPartialMs": None if first is None else round(first),
                    "endToFinalMs": round((got["t_final"] - t_end) * 1000),
                    "decodeMs": got.get("ms"),
                }
            )
    return out


# ---------------------------------------------------------------- field metrics
CORRECTIONS = re.compile(
    r"(不是[，,。 ]|^不是|我说的是|我是说|我刚才说|我刚说|不对|说错|听错|识别错|no,? i said|i meant|"
    r"that's not what|違う|ちがう|そうじゃな|じゃなくて)",
    re.I,
)


def grams(s: str, n: int = 2) -> set[str]:
    t = norm(s)
    return {t[i : i + n] for i in range(max(1, len(t) - n + 1))} if t else set()


def overlap(a: str, b: str) -> float:
    """Bigram overlap over the shorter message (a restatement repeats most of itself)."""
    x, y = grams(a), grams(b)
    return len(x & y) / min(len(x), len(y)) if x and y else 0.0


#: Whisper's stock hallucinations and the route's own prompt read back (lib/stt.ts
#: sttPrompt); mic.ts HALLUCINATIONS knows only some of the first group.
HALLU = re.compile(
    r"(字幕志愿者|字幕由|李宗盛|谢谢观看|感谢观看|明镜与点点|请不吝点赞|ご視聴|thanks ?for ?watching|"
    r"thank ?you ?for ?watching|我说中文有时夹杂|日本語english中文)",
    re.I,
)

#: When no clip sidecar says, the path in use by device and time (UTC), from the
#: session history (docs/stt-ab.md, "Field metrics"). Add a row when a setting
#: changes; the first match wins.
WINDOWS = [
    # Android until 01:41 JST: no lk:agent-local-stt, so the route: Whisper turbo +
    # ?hint= (#321), vad-web's own end (1400 ms), lk:voice-aec on (the default).
    ("android", "2026-10-30T00:00:00Z", "2026-10-30T16:41:00Z", "cloud whisper+hint, vad 1400, aec on"),
    # from 01:41 JST on its dev page: the local SenseVoice (full-width punctuation,
    # the dev bridge), endpoint 600; the sink posted no clips, so AEC is the default.
    ("android", "2026-10-30T16:41:00Z", "2026-11-01T00:00:00Z", "local sensevoice, endpoint 600, aec on"),
    ("iphone", "2026-10-30T11:28:00Z", "2026-10-30T13:00:00Z", "local sensevoice, endpoint 600, aec on"),
]


#: A message that is one short Latin word (「Yeah.」「The.」「Don.」) or 嗯/呃 alone: what
#: SenseVoice makes of a cough, a click or a far voice. 好/对/是/行 alone are real replies.
BLIP = re.compile(r"^(?:[a-z]{1,8}|[嗯呃啊哦额]+)$")

#: Two spoken messages this close (send to send) are one sentence the endpoint cut.
SPLIT_S = 8


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def path_of(msg: dict, clips: list[dict]) -> str:
    """The STT path: the clip sidecar sent within 3 s of the message, else the time window."""
    at = utc(msg["at"])
    lab = msg.get("label", "")
    dev = "android" if "Android" in lab else "iphone" if "iPhone" in lab else "other"
    for c in clips:
        if abs((c["at"] - at).total_seconds()) < 3 and c.get("model"):
            local = c["model"].startswith("local:")
            base = "local sensevoice, endpoint 600" if local else "cloud whisper+hint, vad 1400"
            tr = c.get("track") or {}
            if "echoCancellation" in tr:
                return f"{base}, aec {'on' if tr['echoCancellation'] else 'off'}"
            return f"{base}, aec on"  # lk:voice-aec defaults on; no sidecar has said otherwise yet
    for d, t0, t1, path in WINDOWS:
        if d == dev and utc(t0) <= at < utc(t1):
            # SenseVoice writes the full-width ，; Whisper an ASCII comma between Han characters:
            # a local window's message in Whisper's style came through the cloud fallback
            if path.startswith("local") and re.search(r"[一-鿿][,?]", msg["text"]):
                return "cloud whisper+hint (fallback), vad 1400, aec on"
            return path
    return f"{dev}, unknown"


def field(chat_path: str, clips: list[dict], window_s: int = 90, sim: float = 0.5) -> dict:
    """
    Per STT path: spoken messages; restated (one of the next two owner
    messages within window_s shares >= sim of the shorter one's character
    bigrams); corrected (one of them carries a correction phrase);
    hallucinated (the message is a stock Whisper phrase or the prompt read back).
    """
    rows = []
    for line in open(chat_path, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") == "chat" and d.get("from") == "owner" and d.get("text"):
            rows.append(d)
    rows.sort(key=lambda d: d["at"])
    t = lambda d: datetime.fromisoformat(d["at"].replace("Z", "+00:00"))  # noqa: E731
    per: dict[str, dict] = {}
    samples = []
    for k, m in enumerate(rows):
        if m.get("source") != "stt":
            continue
        path = path_of(m, clips)
        s = per.setdefault(path, {"spoken": 0, "repeat": 0, "correction": 0, "hallucination": 0})
        s["spoken"] += 1
        if HALLU.search(norm(m["text"])):
            s["hallucination"] += 1
            samples.append(("hallucination", path, m["text"], ""))
        if BLIP.match(norm(m["text"])):
            s["blip"] = s.get("blip", 0) + 1
            samples.append(("blip", path, m["text"], ""))
        nxt = [r for r in rows[k + 1 : k + 3] if t(r) - t(m) <= timedelta(seconds=window_s)]
        # one sentence cut in two: the next spoken message lands within SPLIT_S
        if nxt and nxt[0].get("source") == "stt" and t(nxt[0]) - t(m) <= timedelta(seconds=SPLIT_S):
            s["split"] = s.get("split", 0) + 1
            samples.append(("split", path, m["text"], nxt[0]["text"]))
        rep = next((r for r in nxt if overlap(m["text"], r["text"]) >= sim), None)
        cor = next((r for r in nxt if CORRECTIONS.search(r["text"])), None)
        if rep:
            s["repeat"] += 1
            samples.append(("repeat", path, m["text"], rep["text"]))
        if cor:
            s["correction"] += 1
            samples.append(("correction", path, m["text"], cor["text"]))
    return {"window_s": window_s, "sim": sim, "paths": per, "samples": samples}


# ---------------------------------------------------------------- main
def load_clips(d: str) -> list[dict]:
    agent = {}
    ap = os.path.join(d, "refs-agent.json")
    if os.path.exists(ap):
        agent = json.load(open(ap, encoding="utf-8"))
    out = []
    for f in sorted(os.listdir(d)):
        if not f.endswith(".wav"):
            continue
        name = f[:-4]
        meta = {}
        if os.path.exists(os.path.join(d, name + ".json")):
            meta = json.load(open(os.path.join(d, name + ".json"), encoding="utf-8"))
        ref, by, amb = None, None, False
        rp = os.path.join(d, name + ".ref.txt")
        if os.path.exists(rp):
            ref, by = open(rp, encoding="utf-8").read().strip(), "owner"
        elif name in agent:
            ref, by, amb = agent[name]["text"], "agent", bool(agent[name].get("ambiguous"))
        audio, sr = sf.read(os.path.join(d, f), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != RATE:
            raise SystemExit(f"{f}: {sr} Hz (the sink saves 16 kHz)")
        at = datetime.fromisoformat((meta.get("at") or "1970-01-01T00:00:00Z").replace("Z", "+00:00"))
        lab = meta.get("label", "")
        out.append(
            {
                "name": name,
                "audio": audio,
                "s": len(audio) / RATE,
                "at": at,
                "device": "android" if "Android" in lab else "iphone" if "iPhone" in lab else "other",
                "model": meta.get("model"),
                "said": meta.get("transcript", ""),
                "track": meta.get("track"),
                "ref": ref,
                "refBy": by,
                "ambiguous": amb,
            }
        )
    return out


def short(name: str) -> str:
    return name[11:].replace("-", ":", 2)[:8] + name[name.rfind("-") :]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default=os.path.expanduser("~/lianki-voice-clips"))
    ap.add_argument("--ws", help="stream the 600 ms pieces to this server (ws://127.0.0.1:5193)")
    ap.add_argument("--pace", type=float, default=1.0, help="1 = real time, 0 = as fast as possible")
    ap.add_argument("--whisper", action="store_true", help="also mlx-whisper with the ?hint=zh prompt")
    ap.add_argument("--chat", help="the owner's chat log (jsonl) for the field metrics")
    ap.add_argument("--dump", action="store_true", help="print candidate transcripts (to draft references)")
    ap.add_argument("--json", help="write every number here")
    a = ap.parse_args()

    from engines import SenseVoice

    clips = load_clips(a.clips)
    sv, vad = SenseVoice(), Silero()
    sv.transcribe(np.zeros(RATE, dtype=np.float32))  # warm
    mw = None
    if a.whisper:
        from engines import MlxWhisper

        mw = MlxWhisper()
        mw.PROMPT = HINT_ZH

    res = []
    for c in clips:
        p = vad.probs(c["audio"])
        r = {k: c[k] for k in ("name", "s", "device", "model", "said", "ref", "refBy", "ambiguous")}
        r["track"] = c["track"]
        t0 = time.perf_counter()
        r["whole"] = sv.transcribe(c["audio"])[0]
        r["wholeMs"] = round((time.perf_counter() - t0) * 1000)
        r["modes"] = {}
        for ep in [None] + ENDPOINTS:
            segs = segment(p, ep, len(c["audio"]))
            texts, ms = [], 0
            for s in segs:
                t0 = time.perf_counter()
                texts.append(sv.transcribe(c["audio"][s["start"] : s["end"]])[0])
                ms = round((time.perf_counter() - t0) * 1000)  # the last piece's decode = end → final
            r["modes"][str(ep or "vad1400")] = {
                "pieces": len(segs),
                "segs": segs,
                "text": " ".join(t for t in texts if t),
                "finalDecodeMs": ms,
            }
        if mw:
            t0 = time.perf_counter()
            r["whisperHint"] = mw.transcribe(c["audio"])[0]
            r["whisperMs"] = round((time.perf_counter() - t0) * 1000)
        res.append(r)
        if a.dump:
            print(f"\n{c['name']} {c['s']:.1f}s {c['device']} {c['model']}")
            print("  sink :", c["said"])
            print("  sv   :", r["whole"])
            for k, m in r["modes"].items():
                if m["text"] != r["whole"]:
                    print(f"  ep{k}:", m["pieces"], m["text"])
            if mw:
                print("  wh+h :", r["whisperHint"])

    if a.ws:
        pieces, owners = [], []
        for c, r in zip(clips, res):
            for s in r["modes"]["600"]["segs"]:
                # the pre-pad (0x02) goes at speech start, then the live frames
                a0 = c["audio"]
                pieces.append((a0[s["start"] : s["first"]], a0[s["first"] : s["end"]]))
                owners.append(r)
        st = asyncio.run(stream(a.ws, pieces, a.pace))
        for r in res:
            r["stream"] = []
        for r, s in zip(owners, st):
            r["stream"].append(s)
        for r in res:
            r["streamText"] = " ".join(s["text"] for s in r["stream"] if s["text"])
            r["streamSame"] = r["streamText"] == r["modes"]["600"]["text"]

    report(res, a)
    if a.chat:
        f = field(a.chat, clips)
        print_field(f)
        if a.json:
            res.append({"field": f})
    if a.json:
        for r in res:
            for m in r.get("modes", {}).values():
                m.pop("segs", None)
        json.dump(res, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else float("nan")


def report(res: list[dict], a) -> None:
    scored = [r for r in res if r["ref"] is not None]
    print(f"\n{len(res)} clips, {len(scored)} with a reference "
          f"({sum(r['refBy'] == 'owner' for r in scored)} owner's, "
          f"{sum(r['ambiguous'] for r in scored)} marked ambiguous)")
    print("\n| mode | CER (all) | CER (not ambiguous) | clips split | wait after speech | final decode, mean / max |")
    print("| --- | --- | --- | --- | --- | --- |")
    clear = [r for r in scored if not r["ambiguous"]]
    for k in ["vad1400"] + [str(e) for e in ENDPOINTS]:
        c_all = mean([cer(r["ref"], r["modes"][k]["text"]) for r in scored])
        c_clr = mean([cer(r["ref"], r["modes"][k]["text"]) for r in clear])
        split = sum(r["modes"][k]["pieces"] > 1 for r in res)
        dec = [r["modes"][k]["finalDecodeMs"] for r in res]
        wait = 1400 if k == "vad1400" else int(k)
        print(f"| SenseVoice, endpoint {k} | {c_all:.3f} | {c_clr:.3f} | {split}/{len(res)} | {wait} ms | "
              f"{mean(dec):.0f} / {max(dec)} ms |")
    print(f"| SenseVoice, clip as saved | {mean([cer(r['ref'], r['whole']) for r in scored]):.3f} | "
          f"{mean([cer(r['ref'], r['whole']) for r in clear]):.3f} | – | – | "
          f"{mean([r['wholeMs'] for r in res]):.0f} / {max(r['wholeMs'] for r in res)} ms |")
    if a.whisper:
        print(f"| mlx-whisper turbo + hint zh, clip as saved | "
              f"{mean([cer(r['ref'], r['whisperHint']) for r in scored]):.3f} | "
              f"{mean([cer(r['ref'], r['whisperHint']) for r in clear]):.3f} | – | – | "
              f"{mean([r['whisperMs'] for r in res]):.0f} / {max(r['whisperMs'] for r in res)} ms |")
    cloud = [r for r in scored if (r["model"] or "").startswith("@cf/")]
    if cloud:
        sv_same = mean([cer(r["ref"], r["whole"]) for r in cloud])
        print(f"| Workers AI as recorded ({len(cloud)} clips; SenseVoice on the same: {sv_same:.3f}) | "
              f"{mean([cer(r['ref'], r['said']) for r in cloud]):.3f} | "
              f"{mean([cer(r['ref'], r['said']) for r in cloud if not r['ambiguous']]):.3f} | – | – | – |")

    print("\nper clip (CER; endpoint pieces):")
    print("| clip | s | dev | ref by | 1400 | 1000 | 800 | 600 | 400 | whisper+hint | as recorded |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in res:
        if r["ref"] is None:
            continue
        cell = lambda k: f"{cer(r['ref'], r['modes'][k]['text']):.2f}" + (  # noqa: E731
            f" ({r['modes'][k]['pieces']})" if r["modes"][k]["pieces"] != 1 else "")
        wh = f"{cer(r['ref'], r['whisperHint']):.2f}" if "whisperHint" in r else "–"
        print(f"| {short(r['name'])} | {r['s']:.1f} | {r['device']} | {r['refBy']}{'?' if r['ambiguous'] else ''} | "
              f"{cell('vad1400')} | {cell('1000')} | {cell('800')} | {cell('600')} | {cell('400')} | {wh} | "
              f"{cer(r['ref'], r['said']):.2f} |")

    if a.ws:
        st = [s for r in res for s in r["stream"]]
        same = sum(r["streamSame"] for r in res)
        print(f"\nstreaming (600 ms pieces, pace {a.pace}): {len(st)} utterances; "
              f"first partial mean {mean([s['firstPartialMs'] for s in st]):.0f} ms "
              f"(max {max((s['firstPartialMs'] or 0) for s in st)}); end → final mean "
              f"{mean([s['endToFinalMs'] for s in st]):.0f} ms (max {max(s['endToFinalMs'] for s in st)}); "
              f"final == whole-clip decode on {same}/{len(res)} clips")

    groups: dict[str, list] = {}
    for r in res:
        t = r["track"] or {}
        k = "unknown" if "echoCancellation" not in t else ("aec on" if t["echoCancellation"] else "aec off")
        groups.setdefault(f"{r['device']}, {k}", []).append(r)
    print("\nAEC groups (from the sidecar's track):")
    for k, rs in sorted(groups.items()):
        sc = [r for r in rs if r["ref"] is not None]
        c = mean([cer(r["ref"], r["modes"]["600"]["text"]) for r in sc]) if sc else float("nan")
        print(f"  {k}: {len(rs)} clips, {len(sc)} scored, CER@600 {c:.3f}")
    known = {k: v for k, v in groups.items() if "unknown" not in k}
    if not known:
        print("  (no clip records its track settings yet: AEC on vs off cannot be compared)")


def print_field(f: dict) -> None:
    print(f"\nfield metrics (owner chat; next ≤3 messages within {f['window_s']} s; restatement = "
          f"bigram overlap ≥ {f['sim']}):")
    print("| STT path | spoken messages | restated | corrected | hallucinated | one-word blips | "
          "split (next spoken ≤ 8 s) |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for k, s in sorted(f["paths"].items()):
        n = s["spoken"]
        pc = lambda x: f"{x} ({x / n:.0%})"  # noqa: E731
        print(f"| {k} | {n} | {pc(s['repeat'])} | {pc(s['correction'])} | {pc(s['hallucination'])} | "
              f"{pc(s.get('blip', 0))} | {pc(s.get('split', 0))} |")
    print("\nflagged pairs (hand-check):")
    for kind, path, a, b in f["samples"]:
        print(f"  [{kind}] {path}: {a[:50]!r} → {b[:50]!r}")


if __name__ == "__main__":
    main()
