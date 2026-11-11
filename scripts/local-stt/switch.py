"""
A language switch inside one utterance, cut where the VAD hears silence
(docs/local-stt.md, "Language switch").

The whole-utterance decode reads one language: a Chinese sentence then a
Japanese one comes back as the Japanese and 「开饭9」. The owner's design
(2026-11-11): notice the switch, re-read the missed part in the right
language, backfill it. The rolling decode's stretches ended at CTC gaps, so a
stretch could be silence alone, and silence read with a language forced writes
「Yeah」「嗯」. Here the cuts are where Silero hears no speech: every stretch
holds speech, and silence is never read on its own.

Pure logic in `plan()` (tests: test_switch.py); the server hands it the speech
runs (Silero) and each run's language and how sure the model is of it
(SenseVoice's language frame, `LangPicker.lang_probs`).
"""
from __future__ import annotations

import numpy as np

RATE = 16000
#: A run shorter than this has no language of its own: it joins its neighbour (a
#: loanword, a short reply the language frame misreads).
MIN_RUN_S = 1.0
#: A run switches the language only when the model is this sure of it.
MIN_PROB = 0.8
#: Languages SenseVoice writes inside another language's reading (English terms in
#: Chinese, Japanese or Korean speech: 「whisper本身就是多语言模型」). A run in one of them
#: never starts a switch while the utterance holds another language: on the owner's
#: clips such a run was a term, and reading it alone mangled it.
CARRIED = frozenset({"en"})
#: Languages read as one (the model's yue and zh share the script and mix freely).
SAME = {"yue": "zh"}


def plan(runs: list[tuple[int, int, str, float]], min_run_s: float = MIN_RUN_S,
         min_prob: float = MIN_PROB) -> list[tuple[int, int, str]]:
    """
    Speech runs (start, end in samples, language, its probability) as stretches to
    read, (start, end, lang), neighbours of one language merged (the silence between
    them stays inside, as context). A run is trusted for its language only when it is
    long and sure, and not in a CARRIED language while another one is trusted; the
    rest take the language of the trusted run before them (or the first trusted one
    after, at the start). One stretch back means no switch: the whole decode stands.
    No trusted run at all: none either.
    """
    short = min_run_s * RATE
    langs = [SAME.get(lang, lang) for _, _, lang, _ in runs]
    sure = [b - a >= short and p >= min_prob for a, b, _, p in runs]
    own = {lang for lang, t in zip(langs, sure) if t and lang not in CARRIED}
    trusted = [t and (lang not in CARRIED or not own) for lang, t in zip(langs, sure)]
    if not any(trusted):
        return []
    cur = next(lang for lang, t in zip(langs, trusted) if t)
    out: list[list] = []
    for (a, b, _, _), lang, t in zip(runs, langs, trusted):
        if t:
            cur = lang
        if out and out[-1][2] == cur:
            out[-1][1] = b
        else:
            out.append([a, b, cur])
    return [tuple(s) for s in out]


def _vad(model: str, min_silence_s: float, min_speech_s: float, threshold: float):
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = model
    cfg.silero_vad.threshold = threshold
    cfg.silero_vad.min_silence_duration = min_silence_s
    cfg.silero_vad.min_speech_duration = min_speech_s
    cfg.silero_vad.max_speech_duration = 60
    cfg.sample_rate = RATE
    cfg.num_threads = 1
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60), cfg.silero_vad.window_size


class Tracker:
    """
    One utterance's speech runs and their languages, found while the speaker talks:
    Silero hears each chunk as it comes (~3 ms per audio second), and a run's language
    is picked on `pool` from its first PICK_S as soon as the run is that long, while the
    speaker is still in it, so the final seldom waits for a pick (only a last run shorter
    than PICK_S, picked beside the final's decode). `lang_probs(samples) -> {lang: p}`:
    LangPicker.lang_probs.
    """

    #: A run's language is picked from its first this many seconds (1 s already gives
    #: p > 0.99 on clear speech; a pick costs ~55 ms per second of audio).
    PICK_S = 1.5
    #: Silero says "speech" this long after it began (its min speech and window, roughly).
    LAG_S = 0.3

    def __init__(self, vad_model: str, lang_probs, pool, min_silence_s: float = 0.25,
                 min_speech_s: float = 0.25, threshold: float = 0.5):
        self.vad, self.win = _vad(vad_model, min_silence_s, min_speech_s, threshold)
        self.min_speech_s = min_speech_s
        self.lang_probs, self.pool = lang_probs, pool
        self.left = np.zeros(0, dtype=np.float32)
        self.heard: list[np.ndarray] = []
        #: Samples heard, in the utterance's own positions (see prepend), and where Silero's begin.
        self.n = 0
        self.base = 0
        #: The open run: where it began (about) and its early pick.
        self.open_from: int | None = None
        self.open_pick = None
        #: (start, end, future of {lang: p}), in order.
        self.runs: list[tuple[int, int, object]] = []
        self.closed = False

    def feed(self, x: np.ndarray) -> None:
        if self.closed:
            return
        x = np.concatenate([self.left, x]) if len(self.left) else x
        n = len(x) - len(x) % self.win
        for i in range(0, n, self.win):
            w = x[i:i + self.win]
            self.vad.accept_waveform(w)
            self.heard.append(w)
            self.n += len(w)
            self._drain()
            if self.vad.is_speech_detected():
                if self.open_from is None:
                    self.open_from = max(0, self.n - int((self.LAG_S + self.min_speech_s) * RATE))
                if self.open_pick is None and self.n - self.open_from >= self.PICK_S * RATE:
                    self.open_pick = self._pick(self.open_from, self.open_from + int(self.PICK_S * RATE))
        self.left = x[n:]

    def _pick(self, a: int, b: int):
        audio = np.concatenate(self.heard)[a:b]
        return self.pool.submit(self.lang_probs, audio)

    def _drain(self) -> None:
        while not self.vad.empty():
            s = self.vad.front
            a = s.start + self.base
            b = a + len(s.samples)
            pick = self.open_pick
            if pick is None:
                pick = self.pool.submit(self.lang_probs, np.array(s.samples[: int(self.PICK_S * RATE)], dtype=np.float32))
            self.runs.append((a, b, pick))
            self.open_from, self.open_pick = None, None
            self.vad.pop()

    def prepend(self, pre: np.ndarray) -> None:
        """
        The page's pre-pad came (it is sent with `end`: the VAD's head, before the first
        frame): every position moves by its length. Silero never hears it; the picks made
        so far stand.
        """
        k = len(pre)
        if not k or self.base:  # one pre-pad per utterance
            return
        self.runs = [(a + k, b + k, f) for a, b, f in self.runs]
        if self.open_from is not None:
            self.open_from += k
        self.heard.insert(0, np.asarray(pre, dtype=np.float32))
        self.n += k
        self.base += k

    def close(self) -> list[tuple[int, int, object]]:
        """The utterance ended: the last run closed too. Its runs, each with its pick's future."""
        if not self.closed:
            if len(self.left):
                self.vad.accept_waveform(self.left)
            self.vad.flush()
            self._drain()
            self.closed = True
        return self.runs


def runs_of(runs: list[tuple[int, int, dict]]) -> list[tuple[int, int, str, float]]:
    """(start, end, {lang: p}) as (start, end, its likeliest language, that probability); none for an empty pick."""
    out = []
    for a, b, probs in runs:
        if probs:
            lang = max(probs, key=probs.get)
            out.append((a, b, lang, probs[lang]))
    return out
