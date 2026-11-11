"""
rolling.py's rules (docs/local-stt.md, "Rolling partials"). Run with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_rolling.py
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rolling import RATE, Rolling, join_tokens  # noqa: E402


class RollingTest(unittest.TestCase):
    def test_one_pass_settles_nothing(self):
        r = Rolling()
        tail = r.update(["你", "好"], [0.1, 0.3], "zh", 2 * RATE)
        self.assertEqual(r.segments, [])
        self.assertEqual(r.text(tail), "你好")

    def test_two_agreeing_passes_settle_what_is_well_before_the_end(self):
        r = Rolling(keep_s=0.6)
        r.update(["今", "天", "天"], [0.1, 0.4, 0.8], "zh", int(1.0 * RATE))
        tail = r.update(["今", "天", "天", "气"], [0.1, 0.4, 0.8, 1.6], "zh", int(2.0 * RATE))
        # 今 and 天 agree and the next token began before 2.0 - 0.6 s; the second 天 at 0.8 is
        # followed by 气 at 1.6, inside the last 0.6 s, so it stays in the tail.
        self.assertEqual(r.settled(), "今天")
        self.assertEqual(r.segments[0].lang, "zh")
        self.assertEqual(r.at, int((0.4 + 0.8) / 2 * RATE))
        self.assertEqual(tail, "天气")
        self.assertEqual(r.text(tail), "今天天气")

    def test_a_disagreement_settles_only_the_common_prefix(self):
        r = Rolling(keep_s=0.1)
        r.update(["a", "b", "c"], [0.1, 0.5, 0.9], "en", 2 * RATE)
        r.update(["a", "x", "c"], [0.1, 0.5, 0.9], "en", 2 * RATE)
        self.assertEqual(r.settled(), "a")

    def test_the_next_pass_compares_against_the_shortened_tail(self):
        r = Rolling(keep_s=0.2)
        r.update(["▁hi", "▁there", "▁you"], [0.1, 0.5, 0.9], "en", int(1.5 * RATE))
        r.update(["▁hi", "▁there", "▁you"], [0.1, 0.5, 0.9], "en", int(1.5 * RATE))
        self.assertEqual(r.settled(), " hi there")
        tail = r.update(["▁you", "▁all"], [0.05, 0.5], "en", int(1.2 * RATE))
        self.assertEqual(r.text(tail), "hi there you all")
        r.update(["▁you", "▁all"], [0.05, 0.5], "en", int(1.2 * RATE))
        self.assertEqual(r.settled(), " hi there you")

    def test_segments_keep_their_language_and_span(self):
        r = Rolling(keep_s=0.1)
        r.update(["は", "い"], [0.1, 0.4], "ja", RATE)
        r.update(["は", "い"], [0.1, 0.4], "ja", RATE)
        s = r.segments[0]
        self.assertEqual((s.text, s.lang, s.start), ("は", "ja", 0))
        self.assertEqual(s.end, r.at)

    def test_join_tokens(self):
        self.assertEqual(join_tokens(["▁I", "▁am", "，", "我"]), " I am，我")


if __name__ == "__main__":
    unittest.main()
