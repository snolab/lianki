"""
rolling.py's rules (docs/local-stt.md, "Rolling partials"). Run with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_rolling.py
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rolling import RATE, Rolling, Segment, join_tokens, language_spans  # noqa: E402


class RollingTest(unittest.TestCase):
    def test_one_pass_settles_nothing(self):
        r = Rolling()
        tail = r.update(["你", "好"], [0.1, 0.3], "zh", 2 * RATE)
        self.assertEqual(r.segments, [])
        self.assertEqual(r.text(tail), "你好")

    def test_two_agreeing_passes_settle_up_to_a_mark_well_before_the_end(self):
        r = Rolling(keep_s=0.6)
        r.update(["今", "天", "，", "天"], [0.1, 0.3, 0.5, 0.7], "zh", int(1.0 * RATE))
        tail = r.update(["今", "天", "，", "天", "气"], [0.1, 0.3, 0.5, 0.7, 0.9], "zh", int(2.0 * RATE))
        # 「今天，」 agree and the mark is before 2.0 - 0.6 s: settled, cut inside the pause.
        # (No gap reaches pause_s, so the mark is the only place it may end.)
        self.assertEqual(r.settled(), "今天，")
        self.assertEqual(r.segments[0].lang, "zh")
        self.assertEqual(r.at, int((0.5 + 0.7) / 2 * RATE))
        self.assertEqual(tail, "天气")
        self.assertEqual(r.text(tail), "今天，天气")

    def test_a_pause_settles_like_a_mark(self):
        r = Rolling(keep_s=0.3, pause_s=0.4)
        r.update(["好", "は", "い"], [0.1, 0.9, 1.1], "ja", 2 * RATE)
        r.update(["好", "は", "い"], [0.1, 0.9, 1.1], "zh", 2 * RATE)
        self.assertEqual(r.settled(), "好")
        self.assertEqual(r.at, int((0.9 - 0.12) * RATE))  # just before the next word

    def test_no_mark_settles_nothing(self):
        # Between two tokens a cut would split a word or repeat a syllable (「持っ持っ」).
        r = Rolling(keep_s=0.1)
        r.update(["持", "っ", "て"], [0.1, 0.3, 0.5], "ja", 2 * RATE)
        r.update(["持", "っ", "て"], [0.1, 0.3, 0.5], "ja", 2 * RATE)
        self.assertEqual(r.segments, [])
        self.assertEqual(r.at, 0)

    def test_a_mark_inside_the_last_keep_s_waits(self):
        r = Rolling(keep_s=0.6)
        r.update(["好", "。", "我"], [1.25, 1.45, 1.6], "zh", 2 * RATE)
        r.update(["好", "。", "我"], [1.25, 1.45, 1.6], "zh", 2 * RATE)
        self.assertEqual(r.segments, [])

    def test_a_disagreement_settles_only_the_common_prefix(self):
        r = Rolling(keep_s=0.1)
        r.update(["a", ".", "b", ".", "c"], [0.1, 0.2, 0.4, 0.6, 0.8], "en", 2 * RATE)
        r.update(["a", ".", "x", ".", "c"], [0.1, 0.2, 0.4, 0.6, 0.8], "en", 2 * RATE)
        self.assertEqual(r.settled(), "a.")

    def test_the_next_pass_compares_against_the_shortened_tail(self):
        r = Rolling(keep_s=0.2)
        r.update(["▁hi", ",", "▁there", "▁you"], [0.1, 0.25, 0.45, 0.7], "en", int(1.5 * RATE))
        r.update(["▁hi", ",", "▁there", "▁you"], [0.1, 0.25, 0.45, 0.7], "en", int(1.5 * RATE))
        self.assertEqual(r.settled(), " hi,")
        tail = r.update(["▁there", "▁you", "."], [0.05, 0.4, 0.6], "en", int(1.2 * RATE))
        self.assertEqual(r.text(tail), "hi, there you.")

    def test_segments_keep_their_language_and_span(self):
        r = Rolling(keep_s=0.1)
        r.update(["は", "い", "。", "え"], [0.1, 0.3, 0.5, 0.7], "ja", RATE)
        r.update(["は", "い", "。", "え"], [0.1, 0.3, 0.5, 0.7], "ja", RATE)
        s = r.segments[0]
        self.assertEqual((s.text, s.lang, s.start), ("はい。", "ja", 0))
        self.assertEqual(s.end, r.at)

    def test_one_language_is_one_span(self):
        segs = [Segment("a", "zh", 0, RATE), Segment("b", "zh", RATE, 2 * RATE)]
        self.assertEqual(language_spans(segs), [(0, 2 * RATE, "zh")])

    def test_a_switch_cuts_where_the_language_changed(self):
        segs = [Segment("a", "zh", 0, 2 * RATE), Segment("b", "ja", 2 * RATE, 4 * RATE)]
        self.assertEqual(language_spans(segs), [(0, 2 * RATE, "zh"), (2 * RATE, 4 * RATE, "ja")])

    def test_a_short_stretch_joins_its_neighbour(self):
        # 0.5 s of "en" inside Chinese (a loanword) is not a switch.
        segs = [Segment("a", "zh", 0, 2 * RATE), Segment("b", "en", 2 * RATE, int(2.5 * RATE)),
                Segment("c", "zh", int(2.5 * RATE), 4 * RATE)]
        self.assertEqual(language_spans(segs), [(0, 4 * RATE, "zh")])
        # A short first stretch joins the next one.
        segs = [Segment("a", "en", 0, RATE // 2), Segment("b", "ja", RATE // 2, 3 * RATE)]
        self.assertEqual(language_spans(segs), [(0, 3 * RATE, "ja")])

    def test_an_unknown_language_takes_the_one_before(self):
        segs = [Segment("a", "zh", 0, 2 * RATE), Segment("b", "", 2 * RATE, 4 * RATE)]
        self.assertEqual(language_spans(segs), [(0, 4 * RATE, "zh")])

    def test_silence_has_no_language(self):
        r = Rolling()
        r.update([], [], "yue", RATE)
        self.assertEqual(r.tail_lang, "")

    def test_join_tokens(self):
        self.assertEqual(join_tokens(["▁I", "▁am", "，", "我"]), " I am，我")


if __name__ == "__main__":
    unittest.main()
