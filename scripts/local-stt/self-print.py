#!/usr/bin/env python3
"""
Build the self print: the voices Lianki itself reads aloud with, so a mic that
hears our own playback can tell it is not him (docs/echo-suppression.md,
layer (c), M4; voiceprint.py SELF_*).

Generated speech only. For each voice it asks our own TTS routes for a set of
neutral sentences (or renders a macOS voice with `say -o FILE`, which writes a
file and plays nothing), writes the clips to a private temporary folder, embeds
each clean and through three simulated channels (phone band, a dull speaker, a
room with noise), and writes the embeddings only (no audio, no text) to
`<store>/self.<model>.json`, 0600. The clips are deleted with the folder. It
never records anyone, never reads ~/lianki-voice-clips, and refuses his clone
voice (it would match him) and any recorded clip a route answers with.

    PY=~/.cache/lianki-stt/venv/bin/python
    # what it would do, and what it would cost (nothing fetched):
    $PY -I scripts/local-stt/self-print.py --voices melo:en,melo:zh,melo:ja --dry-run
    # fetch, embed, measure against his print, write nothing:
    LIANKI_COOKIE='<the lianki.com session cookie>' $PY -I scripts/local-stt/self-print.py \\
        --voices melo:en,melo:zh,melo:ja,aura:luna@en,google:cmn-TW-Wavenet-A --eval
    # the same, and write self.campp.json (an existing one only with --replace, kept as .bak):
    LIANKI_COOKIE=... $PY -I scripts/local-stt/self-print.py --voices ... [--mac-voices Tingting,Samantha]

Auth: `LIANKI_COOKIE` (the Cookie header of a signed-in lianki.com tab), or
`LIANKI_DEV_BRIDGE` (the dev bridge secret, x-lianki-dev-bridge; /api/words/tts
only). Cloud voices are paid from credits (`voice.cloud`): a few cents per voice.

Voice ids, as voice-out.ts plays them:
  melo:<lang>            the route's MeloTTS voice (/api/words/tts)
  aura:<speaker>@<lang>  a Workers AI Aura-2 speaker of the lane table (/api/words/tts&speaker=)
  google:<voice> | azure:<voice>[/<locale>]   a provider voice (/api/voice/tts), as in voice.langVoices
  --mac-voices NAME[@lang],...  macOS voices rendered silently (`say -v NAME -o`): device-voice twins;
                         kept only when --eval shows they score close (docs, open question 5)

Turn it off: rename or delete self.<model>.json (the server sees it on the next final), or the
flag stt.self-voice.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402

import voiceprint as VP  # noqa: E402

#: Neutral sentences per language: no names, nothing personal, long enough for the noise
#: gate (MIN_SPEECH_S) once spoken. Any language not here reads the English ones.
SENTENCES: dict[str, list[str]] = {
    "en": [
        "The weather today is mild, with a light wind from the west.",
        "Please remember to water the plants before the end of the week.",
        "The train leaves the station at a quarter past nine every morning.",
        "A cup of warm tea can be a pleasant way to start the afternoon.",
        "The library on the corner opens a little later on Sundays.",
        "This new chapter explains how the seasons change across the year.",
        "Most of the work is finished, and the rest can wait until tomorrow.",
        "The river runs quietly past the old bridge at the edge of town.",
        "Let us review the list once more before we decide on the order.",
        "A short walk after dinner is good for both body and mind.",
        "The market sells fresh bread, fruit and vegetables every Saturday.",
        "Each lesson begins with a few minutes of quiet reading.",
    ],
    "zh": [
        "今天的天气比较温和，西边吹来一阵微风。",
        "请记得在周末之前给花草浇一次水。",
        "这趟列车每天早上九点一刻从车站出发。",
        "下午喝一杯热茶，是一个很舒服的开始。",
        "街角的图书馆星期天会晚一点开门。",
        "这一章讲的是一年四季是怎样变化的。",
        "大部分工作已经完成了，剩下的可以明天再做。",
        "小河静静地流过城边的那座老桥。",
        "我们再把清单看一遍，然后决定先后顺序。",
        "晚饭后散散步，对身体和心情都有好处。",
        "每个星期六，市场上都有新鲜的面包和水果。",
        "每节课都从几分钟的安静阅读开始。",
    ],
    "ja": [
        "今日は穏やかな天気で、西から弱い風が吹いています。",
        "週末までに植物に水をあげるのを忘れないでください。",
        "この電車は毎朝九時十五分に駅を出発します。",
        "午後に温かいお茶を飲むのは、気持ちのいい始まりです。",
        "角の図書館は日曜日だけ少し遅く開きます。",
        "この章では、一年の季節の移り変わりを説明します。",
        "仕事はほとんど終わったので、残りは明日でも大丈夫です。",
        "川は町のはずれの古い橋の下を静かに流れています。",
        "順番を決める前に、もう一度リストを見直しましょう。",
        "夕食のあとの短い散歩は、体にも心にもいいです。",
        "毎週土曜日、市場では新鮮なパンと果物が売られています。",
        "どの授業も、数分間の静かな読書から始まります。",
    ],
    "es": [
        "Hoy el tiempo es suave, con un poco de viento del oeste.",
        "Recuerda regar las plantas antes del fin de semana.",
        "El tren sale de la estación a las nueve y cuarto cada mañana.",
        "Una taza de té caliente es una buena forma de empezar la tarde.",
        "La biblioteca de la esquina abre un poco más tarde los domingos.",
        "Este capítulo explica cómo cambian las estaciones durante el año.",
        "Casi todo el trabajo está hecho, y el resto puede esperar a mañana.",
        "El río pasa tranquilo bajo el puente viejo al borde del pueblo.",
        "Revisemos la lista una vez más antes de decidir el orden.",
        "Un paseo corto después de cenar es bueno para el cuerpo y la mente.",
    ],
}

#: What /api/words/tts may answer for a clip we keep: generated speech only. "recorded" is a
#: person's recording (the lianki-voice Worker's word clips): never enrolled.
GENERATED = {"melotts", "melotts-cached", "aura-2"}
#: The price per character the route books (lib/payments/prices.ts speechUsd, roughly), for --dry-run.
USD_PER_CHAR = {"melo": 0.0, "aura": 0.00003, "google": 0.000016, "azure": 0.000016}

_VOICE = re.compile(
    r"^(?:melo:(?P<melo>[a-z]{2,3}(?:-[A-Za-z]{2,4})?)"
    r"|aura:(?P<aura>[a-z][a-z0-9-]{0,31})@(?P<alang>[a-z]{2,3})"
    r"|(?P<prov>google|azure):(?P<pvoice>[A-Za-z0-9-]{2,64}(?:/[A-Za-z]{2,3}-[A-Za-z]{2,4})?)"
    r"|mac:(?P<mac>[A-Za-z][A-Za-z0-9 ()-]{0,40})(?:@(?P<mlang>[a-z]{2,3}))?)$"
)


class Refused(ValueError):
    pass


def parse_voice(v: str) -> dict:
    """A voice id: {kind, id (the self print's), lang, speaker?, provider?, name?}. Never the clone."""
    v = v.strip()
    if "clone" in v.lower():
        raise Refused("his clone voice is never a self voice (it would match him)")
    m = _VOICE.match(v)
    if not m:
        raise Refused(f"not a voice id: {v!r}")
    slug = lambda s: re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48]  # noqa: E731
    if m["melo"]:
        return {"kind": "melo", "id": slug(f"melo-{m['melo']}"), "lang": m["melo"].split("-")[0].lower(),
                "route_lang": m["melo"]}
    if m["aura"]:
        return {"kind": "aura", "id": slug(f"aura-{m['aura']}"), "lang": m["alang"], "speaker": m["aura"]}
    if m["prov"]:
        loc = m["pvoice"].split("/")[-1] if "/" in m["pvoice"] else m["pvoice"]
        lang = loc.split("-")[0].lower()
        lang = {"cmn": "zh", "yue": "zh", "nan": "zh"}.get(lang, lang)
        return {"kind": m["prov"], "id": slug(f"{m['prov']}-{m['pvoice']}"), "lang": lang,
                "provider": f"{m['prov']}:{m['pvoice']}"}
    return {"kind": "mac", "id": slug(f"mac-{m['mac']}"), "lang": m["mlang"] or "en", "name": m["mac"]}


def sentences_for(lang: str, n: int) -> list[str]:
    base = SENTENCES.get(lang) or SENTENCES["en"]
    return [base[i % len(base)] for i in range(min(n, len(base)))]


def request_url(base: str, voice: dict, text: str) -> str:
    q = urllib.parse.quote
    if voice["kind"] == "melo":
        return f"{base}/api/words/tts?lang={q(voice['route_lang'])}&text={q(text)}&store=0"
    if voice["kind"] == "aura":
        return f"{base}/api/words/tts?lang={q(voice['lang'])}&text={q(text)}&store=0&speaker={q(voice['speaker'])}"
    return f"{base}/api/voice/tts?voice={q(voice['provider'])}&text={q(text)}"


def auth_headers(env=os.environ) -> dict:
    if env.get("LIANKI_COOKIE"):
        return {"cookie": env["LIANKI_COOKIE"]}
    if env.get("LIANKI_DEV_BRIDGE"):
        return {"x-lianki-dev-bridge": env["LIANKI_DEV_BRIDGE"]}
    return {}


def fetch_clip(url: str, headers: dict, want_aura: bool, opener=urllib.request.urlopen) -> bytes:
    """The clip's bytes; Refused for a recorded clip, a fallback voice or an error."""
    req = urllib.request.Request(url, headers={"accept": "audio/*", "user-agent": "lianki-self-print", **headers})
    with opener(req, timeout=60) as r:
        said = (r.headers.get("x-voice") or "").lower()
        body = r.read()
    if "/api/words/tts" in url:
        if said not in GENERATED:
            raise Refused(f"the route answered {said or 'no voice'}: not generated speech, skipped")
        if want_aura and said != "aura-2":
            raise Refused("the route fell back to another voice, skipped")
    if len(body) < 512:
        raise Refused("empty clip")
    return body


def to_wav(src: str, dst: str) -> None:
    """Any clip to 16 kHz mono WAV, by file (ffmpeg, else macOS afconvert); nothing is played."""
    ff = shutil.which("ffmpeg")
    if ff:
        cmd = [ff, "-nostdin", "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", dst]
    elif shutil.which("afconvert"):
        cmd = ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst]
    else:
        raise RuntimeError("ffmpeg or afconvert is needed to read the clips")
    subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)


def render_mac(name: str, text: str, dst: str) -> None:
    """A macOS voice to a file: `say -o` writes the file and plays nothing."""
    subprocess.run(["say", "-v", name, "-o", dst, "--", text], check=True, stdin=subprocess.DEVNULL,
                   capture_output=True, timeout=60)


# ---------------------------------------------------------------- the simulated channel
def _band(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    f = np.fft.rfftfreq(len(a), 1 / VP.RATE)
    s = np.fft.rfft(a)
    s[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(s, len(a)).astype(np.float32)


def channels(a: np.ndarray, seed: int = 0) -> list[tuple[str, np.ndarray]]:
    """
    Our voice as a mic hears it across a room: a phone speaker's band (300-3400 Hz), a dull
    speaker (under 2 kHz), and a room (a short decaying echo and pink noise at 20 dB SNR).
    Deterministic for one seed; all in memory.
    """
    rng = np.random.default_rng(seed)
    x = np.asarray(a, dtype=np.float32)
    out = [("phone", _band(x, 300, 3400)), ("dull", _band(x, 60, 2000))]
    n = int(0.25 * VP.RATE)
    ir = np.exp(-np.arange(n) / (0.05 * VP.RATE)) * rng.standard_normal(n) * 0.3
    ir[0] = 1.0
    wet = np.convolve(x, ir)[: len(x)]
    w = np.fft.rfft(rng.standard_normal(len(x)))
    pink = np.fft.irfft(w / np.sqrt(np.arange(len(w)) + 1.0), len(x))
    pink /= np.std(pink) + 1e-9
    ps = float(np.mean(wet ** 2)) + 1e-12
    room = wet + pink * np.sqrt(ps / 10 ** (20 / 10))
    room = room / max(1.0, float(np.max(np.abs(room))) / 0.99)
    out.append(("room", room.astype(np.float32)))
    return out


# ---------------------------------------------------------------- building it
def clips_for(voices: list[dict], n: int, tmp: str, base: str, headers: dict, opener=urllib.request.urlopen,
              render=render_mac, convert=to_wav, log=print) -> dict[str, list[str]]:
    """Generate each voice's clips into `tmp` (a private folder): {voice id: [wav paths]}."""
    got: dict[str, list[str]] = {}
    for v in voices:
        texts = sentences_for(v["lang"] or "en", n)
        for i, text in enumerate(texts):
            raw = os.path.join(tmp, f"{v['id']}-{i:02d}.raw")
            wav = os.path.join(tmp, f"{v['id']}-{i:02d}.wav")
            try:
                if v["kind"] == "mac":
                    raw += ".aiff"
                    render(v["name"], text, raw)
                else:
                    body = fetch_clip(request_url(base, v, text), headers, v["kind"] == "aura", opener)
                    with open(raw, "wb") as fh:
                        fh.write(body)
                convert(raw, wav)
            except Refused as e:
                log(f"  {v['id']} #{i}: {e}")
                continue
            except Exception as e:  # one clip failing is not the whole voice
                log(f"  {v['id']} #{i}: failed ({type(e).__name__})")
                continue
            finally:
                if os.path.lexists(raw):
                    os.unlink(raw)
            got.setdefault(v["id"], []).append(wav)
    return got


def embed_groups(clips: dict[str, list[str]], embed, with_channels: bool = True,
                 min_speech_s: float = VP.MIN_SPEECH_S) -> tuple[dict[str, list[np.ndarray]], dict[str, list]]:
    """({voice: embeddings}, {voice: [(clip index, "clean"|"channel", embedding)]} for the measure)."""
    groups: dict[str, list[np.ndarray]] = {}
    parts: dict[str, list] = {}
    for vid, wavs in clips.items():
        for k, w in enumerate(wavs):
            a = VP.load_wav(w)
            sp, snr = VP.speech_stats(a)
            if sp < min_speech_s:
                continue
            variants = [("clean", a)] + (channels(a, seed=k) if with_channels else [])
            for name, x in variants:
                e = embed(x)
                if e is None:
                    continue
                e = VP.unit(e)
                groups.setdefault(vid, []).append(e)
                parts.setdefault(vid, []).append((k, "clean" if name == "clean" else "channel", e))
    return groups, parts


def his_centroids(store: VP.Store, model: str) -> list[np.ndarray]:
    """His prints' centroids for this model (read only): what "self" must beat."""
    out = []
    for p in store.prints():
        if p["model"] != model:
            continue
        q = store.load(p["device"], model)
        if q is not None:
            out.append(q["_centroid"])
    return out


def measure(groups: dict[str, list[np.ndarray]], parts: dict[str, list], his: list[np.ndarray],
            accept: float = VP.SELF_ACCEPT, margin: float = VP.SELF_MARGIN) -> list[dict]:
    """
    Per voice, leave one clip out: each of its channel copies (the clean one without channels)
    scored against the self print built without that clip (clean and channel copies alike), and
    against his best print; the share that would be "self" at these lines. Numbers only.
    """
    cents = {o: VP.unit(np.array(g, dtype=np.float32).mean(axis=0)) for o, g in groups.items()}
    out = []
    for vid, ps in parts.items():
        kinds = {kind for _, kind, _ in ps}
        probe = "channel" if "channel" in kinds else "clean"
        selfs, hims, hits, k = [], [], 0, 0
        for i, kind, e in ps:
            if kind != probe:
                continue
            rest = [x for j, _, x in ps if j != i]
            mine = [float(VP.unit(np.array(rest).mean(axis=0)) @ e)] if rest else []
            s = max(mine + [float(c @ e) for o, c in cents.items() if o != vid], default=-1.0)
            h = max((float(e @ m) for m in his), default=None)
            selfs.append(s)
            if h is not None:
                hims.append(h)
            hits += bool(s >= accept and (h is None or s - h >= margin))
            k += 1
        out.append({"voice": vid, "n": len(groups.get(vid, [])), "selfMedian": round(float(np.median(selfs)), 3),
                    "selfMin": round(float(min(selfs)), 3),
                    "hisMax": round(float(max(hims)), 3) if hims else None,
                    "selfShare": round(hits / k, 3) if k else None})
    return out


def main(argv: list[str] | None = None, opener=urllib.request.urlopen, embedder=None) -> int:
    ap = argparse.ArgumentParser(description="Build the self print from our own TTS voices (docs/echo-suppression.md).")
    ap.add_argument("--store", default=VP.STORE_DIR)
    ap.add_argument("--model", default="campp", choices=sorted(VP.MODELS))
    ap.add_argument("--base", default="https://lianki.com", help="where our TTS routes are")
    ap.add_argument("--voices", default="", help="comma-separated voice ids (melo:en, aura:<speaker>@en, google:...)")
    ap.add_argument("--mac-voices", default="", help="comma-separated macOS voice names, rendered with say -o (silent)")
    ap.add_argument("--n", type=int, default=12, help="sentences per voice (default 12, at most the list's)")
    ap.add_argument("--no-channels", action="store_true", help="clean clips only (no simulated room)")
    ap.add_argument("--eval", action="store_true", help="measure and print; write nothing")
    ap.add_argument("--dry-run", action="store_true", help="say what would be fetched and its cost; fetch nothing")
    ap.add_argument("--replace", action="store_true", help="replace an existing self print (a .bak copy is kept)")
    a = ap.parse_args(argv)
    try:
        voices = [parse_voice(v) for v in a.voices.split(",") if v.strip()]
        voices += [parse_voice(f"mac:{n.strip()}") for n in a.mac_voices.split(",") if n.strip()]
    except Refused as e:
        print(f"self print: {e}", file=sys.stderr)
        return 2
    if not voices:
        print("no voices given (--voices / --mac-voices)", file=sys.stderr)
        return 2
    if len({v["id"] for v in voices}) != len(voices):
        print("a voice is named twice", file=sys.stderr)
        return 2
    if a.dry_run:
        usd = 0.0
        for v in voices:
            texts = sentences_for(v["lang"] or "en", a.n)
            chars = sum(len(t) for t in texts)
            usd += chars * USD_PER_CHAR.get(v["kind"], 0.0)
            where = "say -o (silent)" if v["kind"] == "mac" else request_url(a.base, v, "…").split("?")[0]
            print(f"{v['id']}: {len(texts)} sentences, {chars} chars, {where}")
        print(f"about ${usd:.3f} of credits; nothing fetched, nothing written")
        return 0
    cloud = [v for v in voices if v["kind"] != "mac"]
    headers = auth_headers()
    if cloud and not headers:
        print("set LIANKI_COOKIE (or LIANKI_DEV_BRIDGE) to ask our TTS routes", file=sys.stderr)
        return 2
    store = VP.Store(a.store)
    embed = embedder or VP.Embedder(VP.MODELS[a.model], threads=4)
    # The clips live only in this private folder and go with it.
    with tempfile.TemporaryDirectory(prefix="lianki-self-") as tmp:
        os.chmod(tmp, 0o700)
        clips = clips_for(voices, a.n, tmp, a.base.rstrip("/"), headers, opener)
        groups, parts = embed_groups(clips, embed, with_channels=not a.no_channels)
    if not groups:
        print("self print: no clip had enough speech", file=sys.stderr)
        return 1
    try:
        his = his_centroids(store, a.model)
    except VP.StoreError as e:
        print(f"his print not read ({e}); measuring without it", file=sys.stderr)
        his = []
    for r in measure(groups, parts, his):
        print(f"{r['voice']}: {r['n']} samples, self median {r['selfMedian']} min {r['selfMin']}, "
              f"his max {r['hisMax'] if r['hisMax'] is not None else '-'}, "
              f"self at {VP.SELF_ACCEPT}/{VP.SELF_MARGIN}: {r['selfShare']}")
    if not his:
        print(f"note: no {a.model} print of his; the margin needs one", file=sys.stderr)
    if a.eval:
        print("--eval: nothing written")
        return 0
    try:
        r = store.save_self(a.model, groups, replace=a.replace)
    except VP.StoreError as e:
        print(f"self print: {e}", file=sys.stderr)
        return 1
    print(f"wrote {r['file']}: " + ", ".join(f"{v['voice']} {v['n']}" for v in r["voices"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
