#!/usr/bin/env python3
"""
Render the clips listed by texts.ts to MP3, offline, with open voices:
VOICEVOX (Japanese, its engine on :50021) and Kokoro (en es fr it pt zh).
Resumable: a clip already on disk is skipped.

  python scripts/voice/render.py texts.jsonl out/ [lang ...]

Writes out/<key> (the R2 key, voice/<lang>/<sha>.mp3). Needs kokoro,
misaki[zh,ja], lameenc, numpy, soundfile — see docs/workers-ai.md.
"""
import io, json, os, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np, soundfile as sf, lameenc

VV = "http://127.0.0.1:50021"
VV_SPEAKER = 30  # No.7 アナウンス: clear standard Japanese. Credit "VOICEVOX:No.7".
KOKORO = {"en": ("a", "af_heart"), "es": ("e", "ef_dora"), "fr": ("f", "ff_siwis"),
          "it": ("i", "if_sara"), "pt": ("p", "pf_dora"), "zh": ("z", "zf_xiaobei")}


def mp3(pcm: np.ndarray, rate: int) -> bytes:
    e = lameenc.Encoder()
    e.set_bit_rate(48)
    e.set_in_sample_rate(rate)
    e.set_channels(1)
    e.set_quality(2)
    return bytes(e.encode((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes()) + e.flush())


def vv(path: str, body=None, **q):
    url = f"{VV}{path}?{urllib.parse.urlencode(q)}"
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def kata(s: str) -> str:
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)


def moras(query) -> str:
    return "".join(m["text"] for p in query["accent_phrases"] for m in p["moras"])


def japanese(item) -> bytes:
    query = None
    if item.get("kanji"):
        # Accent from the written word, but only if the engine reads it as the
        # list does — 何 is なに or なん.
        q = json.loads(vv("/audio_query", text=item["kanji"], speaker=VV_SPEAKER))
        want = kata(item["text"]).replace("ー", "")
        if moras(q).replace("ー", "") == want:
            query = q
    if query is None:
        query = json.loads(vv("/audio_query", text=item["text"], speaker=VV_SPEAKER))
    query["prePhonemeLength"] = 0.05
    query["postPhonemeLength"] = 0.1
    pcm, rate = sf.read(io.BytesIO(vv("/synthesis", query, speaker=VV_SPEAKER)), dtype="float32")
    return mp3(pcm, rate)


pipes = {}


def kokoro(item) -> bytes:
    from kokoro import KPipeline
    code, voice = KOKORO[item["lang"]]
    if code not in pipes:
        pipes[code] = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M")
    parts = [r.audio.numpy() for r in pipes[code](item["text"], voice=voice) if r.audio is not None]
    if not parts:
        raise ValueError("no audio")
    return mp3(np.concatenate(parts), 24000)


def main():
    src, out, *langs = sys.argv[1:]
    items = [json.loads(l) for l in open(src)]
    todo = [i for i in items
            if (not langs or i["lang"] in langs)
            and (i["lang"] == "ja" or i["lang"] in KOKORO)
            and not os.path.exists(os.path.join(out, i["key"]))]
    print(f"{len(todo)} clips to render", flush=True)

    def save(item, data):
        path = os.path.join(out, item["key"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "wb") as f:
            f.write(data)
        os.replace(path + ".tmp", path)

    done = 0
    def one(item, fn):
        nonlocal done
        try:
            save(item, fn(item))
        except Exception as e:
            print(f"FAIL {item['lang']} {item['text']!r}: {e}", flush=True)
        done += 1
        if done % 500 == 0:
            print(f"{done}/{len(todo)}", flush=True)

    ja = [i for i in todo if i["lang"] == "ja"]
    with ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(one, i, japanese) for i in ja]
        # Kokoro runs on this thread meanwhile (one model, not thread-safe).
        for i in todo:
            if i["lang"] != "ja":
                one(i, kokoro)
        for f in futures:
            f.result()


if __name__ == "__main__":
    main()
