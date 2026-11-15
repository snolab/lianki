#!/usr/bin/env python3
"""
Build a household print: another voice in the owner's home (his wife's, first),
scored against so that the margin, not one print alone, tells them apart
(docs/local-stt.md, "Household voices"; voiceprint.py ME_MARGIN / OTHER_MARGIN).

It reads the clips you name, in place (never copies, moves or deletes them),
embeds each with the speaker model, and writes the embeddings only (no audio,
no text) to `<store>/<device>.<model>.other.json` (or `.other-<name>.json`),
0600, the same format as his print. An existing file is kept unless
`--replace`, which first saves it as `<file>.bak-<epoch>`.

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/household-print.py \\
        --device android --model campp --list clips.txt          # one wav path per line
    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/household-print.py --device iphone a.wav b.wav

Turn it off: delete or rename the .other.json (the server sees it on the next final).
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import voiceprint as VP  # noqa: E402


def build(store: VP.Store, embed, device: str, model: str, wavs: list[str], name: str | None = None,
          replace: bool = False, min_speech_s: float = 1.0) -> dict:
    """Embed each clip (skipping those with too little speech) and save: {n, skipped, self, file}."""
    E, S, skipped = [], [], 0
    for w in wavs:
        a = VP.load_wav(w)
        sp, _snr = VP.speech_stats(a)
        e = embed(a) if sp >= min_speech_s else None
        if e is None:
            skipped += 1
            continue
        E.append(e)
        S.append(sp)
    if not E:
        raise VP.StoreError("no clip had enough speech")
    p = store.save_household(device, model, E, S, name=name, replace=replace)
    return {"n": p["n"], "skipped": skipped, "self": p["self"], "file": store.household_file(device, model, name)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build a household print (docs/local-stt.md, 'Household voices').")
    ap.add_argument("--store", default=VP.STORE_DIR)
    ap.add_argument("--device", required=True)
    ap.add_argument("--model", default="campp", choices=sorted(VP.MODELS))
    ap.add_argument("--name", default=None, help="a second household voice: .other-<name>.json (a-z0-9, up to 16)")
    ap.add_argument("--list", default=None, help="a file with one wav path per line")
    ap.add_argument("--replace", action="store_true", help="replace an existing one (a .bak copy is kept)")
    ap.add_argument("--min-speech", type=float, default=1.0, help="seconds of speech a clip needs (default 1.0)")
    ap.add_argument("wavs", nargs="*")
    a = ap.parse_args(argv)
    if not VP.valid_device(a.device):
        print("bad device name", file=sys.stderr)
        return 2
    wavs = list(a.wavs)
    if a.list:
        with open(a.list, encoding="utf-8") as fh:
            wavs += [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    if not wavs:
        print("no clips given", file=sys.stderr)
        return 2
    store = VP.Store(a.store)
    try:
        r = build(store, VP.Embedder(VP.MODELS[a.model], threads=4), a.device, a.model, wavs, a.name, a.replace,
                  a.min_speech)
        mine = store.load(a.device, a.model)
    except VP.StoreError as e:
        print(f"household print: {e}", file=sys.stderr)
        return 1
    print(f"wrote {r['file']}: {r['n']} samples ({r['skipped']} skipped), self {r['self']}")
    if mine is None:
        print(f"note: {a.device} has no {a.model} print of his own yet; the margin needs one", file=sys.stderr)
    else:
        import numpy as np

        h = store.load_households(a.device, a.model)
        c = [x for x in h if x["_name"] == (a.name or VP.HOUSEHOLD)][0]["_centroid"]
        print(f"his print vs this one: cosine {float(np.dot(mine['_centroid'], c)):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
