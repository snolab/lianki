"""
Partials that do not wait (docs/local-stt.md, "Rolling partials").

SenseVoice is not a streaming model: every partial decodes the utterance's
audio again, so a partial costs more the longer the speaker talks (245 ms per
pass at 21 s). The owner's floor is the next feedback within 0.2 s, so the
pass has to stay short whatever the length.

The rolling decode keeps it short. Each partial decodes only the tail: the
audio after what is already settled. A token is settled when two passes in a
row agree on it (their common prefix), up to a punctuation mark well before
the end of the audio heard so far (`keep_s`): a mark sits in a pause, so no
word is cut in two. Its audio is then dropped from the tail; its text joins the
settled text, with the language its pass heard (kept per segment, for a later
pass that re-reads a span in another language and backfills it).

Pure logic, no model: the server hands it each pass's tokens and their
times (sherpa-onnx's `result.tokens` / `result.timestamps`, seconds from the
tail's start). Tests: test_rolling.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field

RATE = 16000
#: Context to the left of the tail that each pass also decodes (s; server.py), and how far
#: before the tail a token may sit and still count as the tail's (a CTC time runs late).
CTX_S = 2.0
CTX_SLACK_S = 0.0
#: A cut at a pause lands this long before the next word's CTC time (s)…
LEAD_S = 0.12
#: …and at least this long after the last settled one's.
PAST_S = 0.15
#: Punctuation SenseVoice writes (use_itn): a settled stretch ends at one.
MARKS = set("，。？！、,.?!；;：:…")


@dataclass
class Segment:
    """Settled text, the language its pass heard, and its audio span (samples in the utterance)."""

    text: str
    lang: str
    start: int
    end: int


def join_tokens(tokens: list[str]) -> str:
    """SenseVoice's tokens as text: "▁" starts a word (a space before it)."""
    return "".join(tokens).replace("▁", " ")


def _lcp(a: list[str], b: list[str]) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def join_spans(texts: list[str]) -> str:
    """Stretches' texts as one line: a space only where a Latin word meets another stretch."""
    out = ""
    for t in texts:
        t = t.strip()
        if out and t and (out[-1].isascii() and out[-1].isalnum() or t[0].isascii() and t[0].isalnum()):
            out += " "
        out += t
    return out


def language_spans(segments: list[Segment], min_s: float = 1.0) -> list[tuple[int, int, str]]:
    """
    The settled part of the utterance cut where the speaker changed language (the owner,
    2026-11-11: re-read the part in the right language, then backfill): (start, end,
    lang) in samples, neighbours of one language merged. A stretch shorter than `min_s`
    (a loanword, a misheard language) joins the one before it, or the next when it is
    first. The unsettled tail is not here: its pass may hold two languages, so it keeps
    the auto-detected reading (a forced one drops the other language's words).
    """
    raw = [(s.start, s.end, s.lang) for s in segments if s.end > s.start]
    spans: list[list] = []
    for a, b, lang in raw:
        lang = lang or (spans[-1][2] if spans else "")
        if spans and spans[-1][2] == lang:
            spans[-1][1] = b
        else:
            spans.append([a, b, lang])
    short = min_s * RATE
    changed = True
    while changed and len(spans) > 1:
        changed = False
        for i, (a, b, _) in enumerate(spans):
            if b - a < short:
                j = i - 1 if i > 0 else i + 1
                lo, hi = min(i, j), max(i, j)
                keep = spans[j][2]
                spans[lo:hi + 1] = [[spans[lo][0], spans[hi][1], keep]]
                changed = True
                break
    merged: list[tuple[int, int, str]] = []
    for a, b, lang in spans:
        if merged and merged[-1][2] == lang:
            merged[-1] = (merged[-1][0], b, lang)
        else:
            merged.append((a, b, lang))
    return merged


@dataclass
class Rolling:
    #: A token settles only when the next one began this long before the end of the heard audio.
    keep_s: float = 0.6
    #: A gap this long between two tokens is a pause: a stretch may end there, as at a mark.
    #: Cut just before the next word, so the tail does not start with silence.
    pause_s: float = 0.3
    #: Settled segments, in order.
    segments: list[Segment] = field(default_factory=list)
    #: The first sample of the tail (everything before it is settled).
    at: int = 0
    #: The previous pass's tokens over the same tail.
    prev: list[str] | None = None
    #: The language the latest pass heard in the tail.
    tail_lang: str = ""

    def update(self, tokens: list[str], times: list[float], lang: str, tail_samples: int,
               ctx_samples: int = 0) -> str:
        """
        One pass over the tail (`tail_samples` long). Settles up to the last punctuation
        mark or pause two passes agree on, well before the end of the heard audio; returns
        the tail's own text. Only there: no word is cut in two (a cut
        between tokens split English words and repeated a syllable: 「持っ持っ」). With no
        mark yet, the tail grows, as the whole decode did before.
        """
        if ctx_samples:
            # The pass also heard `ctx_samples` of settled audio before the tail, as context
            # (a pass that starts cold mid-speech invents words: 「Yeah」「Okay」). Its tokens
            # there are settled already: dropped, and the rest timed from the tail's start.
            ctx_s = ctx_samples / RATE
            kept = [(t, x - ctx_s) for t, x in zip(tokens, times) if x >= ctx_s - CTX_SLACK_S]
            tokens = [t for t, _ in kept]
            times = [max(0.0, x) for _, x in kept]
        tail_s = tail_samples / RATE
        # Silence has no language (SenseVoice names one anyway, often yue).
        self.tail_lang = lang if tokens else ""
        agreed = _lcp(self.prev, tokens) if self.prev is not None else 0
        k = 0
        at_mark = False
        for i in range(agreed):
            if times[i] >= tail_s - self.keep_s:
                break
            if i + 1 >= len(tokens):
                break
            if tokens[i].strip() in MARKS:
                k, at_mark = i + 1, True
            elif self.pause_s and times[i + 1] - times[i] >= self.pause_s:
                k, at_mark = i + 1, False
        if k > 0:
            if at_mark:
                # Halfway from the mark to the next token: inside the pause.
                cut = (times[k - 1] + times[k]) / 2
            else:
                # Just before the next word: the tail must not start with silence (a pass
                # over silence writes 「Yeah」「嗯」), nor keep the last word's end (「今今」).
                cut = max(times[k - 1] + PAST_S, times[k] - LEAD_S)
            cut = max(1, min(int(cut * RATE), tail_samples))
            self.segments.append(Segment(join_tokens(tokens[:k]), lang, self.at, self.at + cut))
            self.at += cut
            tokens = tokens[k:]
        self.prev = tokens
        return join_tokens(tokens)

    def settled(self) -> str:
        return "".join(s.text for s in self.segments)

    def text(self, tail: str) -> str:
        """What the page shows: the settled text and the tail's, without a leading space."""
        return (self.settled() + tail).strip()
