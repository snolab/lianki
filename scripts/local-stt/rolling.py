"""
Partials that do not wait (docs/local-stt.md, "Rolling partials").

SenseVoice is not a streaming model: every partial decodes the utterance's
audio again, so a partial costs more the longer the speaker talks (245 ms per
pass at 21 s). The owner's floor is the next feedback within 0.2 s, so the
pass has to stay short whatever the length.

The rolling decode keeps it short. Each partial decodes only the tail: the
audio after what is already settled. A token is settled when two passes in a
row agree on it (their common prefix) and the next token began well before
the end of the audio heard so far (`keep_s`), so a word still being said is
never cut. Its audio is then dropped from the tail; its text joins the
settled text, with the language its pass heard (kept per segment, for a later
pass that re-reads a span in another language and backfills it).

Pure logic, no model: the server hands it each pass's tokens and their
times (sherpa-onnx's `result.tokens` / `result.timestamps`, seconds from the
tail's start). Tests: test_rolling.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field

RATE = 16000


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


@dataclass
class Rolling:
    #: A token settles only when the next one began this long before the end of the heard audio.
    keep_s: float = 0.6
    #: Settled segments, in order.
    segments: list[Segment] = field(default_factory=list)
    #: The first sample of the tail (everything before it is settled).
    at: int = 0
    #: The previous pass's tokens over the same tail.
    prev: list[str] | None = None

    def update(self, tokens: list[str], times: list[float], lang: str, tail_samples: int) -> str:
        """One pass over the tail (`tail_samples` long). Settles what two passes agree on; returns the tail's own text."""
        tail_s = tail_samples / RATE
        agreed = _lcp(self.prev, tokens) if self.prev is not None else 0
        k = 0
        while k < agreed and k + 1 < len(times) and times[k + 1] < tail_s - self.keep_s:
            k += 1
        if k > 0:
            # Cut halfway between the last settled token and the next one: neither is split.
            cut = int((times[k - 1] + times[k]) / 2 * RATE)
            cut = max(1, min(cut, tail_samples))
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
