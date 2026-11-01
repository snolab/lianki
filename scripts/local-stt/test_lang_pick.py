"""
engines.choose / fbank / LangPicker (docs/local-stt.md, "Short utterances and
the language"). Run by unit/local-stt-lang-pick.test.ts with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_lang_pick.py

The model test runs only where the SenseVoice model is; the kaldi check only
where kaldi_native_fbank is importable.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engines  # noqa: E402
from engines import RATE, Reading, choose, fbank  # noqa: E402

MODEL = os.path.join(engines.MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")


def r(text: str, frame: float, token: float) -> Reading:
    return Reading(text, frame, token)


class Choose(unittest.TestCase):
    # Scores are made up; the only real lines are the 2026-10-31 bug report's.
    def test_short_japanese_heard_as_english(self):
        # Auto said en ("Mice mouse."); ja forced reads もしもし.
        c = {"auto": r("Mice mouse.", -0.14, -0.99), "ja": r("もしもし。", -0.07, -0.30), "zh": r("你好你好。", -0.13, -0.50)}
        self.assertEqual(choose("en", c), "ja")

    def test_short_japanese_heard_as_chinese(self):
        c = {"auto": r("没关系没关系。", -0.15, -0.95), "ja": r("もしもし。", -0.11, -0.45), "zh": r("没关系没关系。", -0.15, -0.95)}
        self.assertEqual(choose("zh", c), "ja")

    def test_clear_english_stays(self):
        c = {"auto": r("Good morning.", -0.02, -0.13), "ja": r("ぐっも。", -0.11, -0.37), "zh": r("古德。", -0.01, -0.10)}
        self.assertIsNone(choose("en", c))

    def test_clear_chinese_stays(self):
        c = {"auto": r("今天天气很好。", -0.03, -0.15), "ja": r("きょうてんき。", -0.24, -0.60), "zh": r("今天天气很好。", -0.03, -0.18)}
        self.assertIsNone(choose("zh", c))

    def test_both_margins_needed(self):
        a = r("Hi.", -0.10, -0.50)
        self.assertIsNone(choose("en", {"auto": a, "ja": r("はい。", -0.09, 0.0)}))  # frame gain too small
        self.assertIsNone(choose("en", {"auto": a, "ja": r("はい。", -0.0, -0.2)}))  # token gain too small
        self.assertEqual(choose("en", {"auto": a, "ja": r("はい。", -0.05, -0.05)}), "ja")

    def test_reading_must_be_in_its_script(self):
        a = r("Uh.", -0.20, -1.0)
        self.assertIsNone(choose("en", {"auto": a, "ja": r("Uh.", 0.0, 0.0)}))  # ja forced, no kana
        self.assertIsNone(choose("en", {"auto": a, "zh": r("こんにちは", 0.0, 0.0)}))  # zh forced, kana
        self.assertEqual(choose("en", {"auto": a, "zh": r("好的。", 0.0, 0.0)}), "zh")

    def test_never_its_own_language(self):
        a = r("我们走吧。", -0.20, -1.0)
        self.assertIsNone(choose("zh", {"auto": a, "zh": r("我们走了。", 0.0, 0.0)}))
        self.assertIsNone(choose("yue", {"auto": a, "zh": r("我们走了。", 0.0, 0.0)}))

    def test_larger_gain_wins(self):
        a = r("Shay shay.", -0.25, -0.9)
        c = {"auto": a, "ja": r("しえしえ。", -0.20, -0.4), "zh": r("谢谢。", -0.05, -0.1)}
        self.assertEqual(choose("en", c), "zh")

    def test_no_auto_reading(self):
        self.assertIsNone(choose("en", {}))


class Final(unittest.TestCase):
    """SenseVoice.final with the recognizer and the scorer stubbed out (no model)."""

    def engine(self, auto, cands):
        from concurrent.futures import ThreadPoolExecutor

        e = object.__new__(engines.SenseVoice)
        e.side = ThreadPoolExecutor(max_workers=1)
        e.transcribe = lambda audio: auto
        e.picker = type("P", (), {"score": staticmethod(lambda audio: cands)})()
        return e

    def test_short_switches(self):
        c = {"auto": r("Moice, miss.", -0.14, -0.95), "ja": r("もしもし。", -0.05, -0.10)}
        e = self.engine(("Moice, miss.", "en"), c)
        self.assertEqual(e.final(np.zeros(RATE * 2, dtype=np.float32)), ("もしもし。", "ja", "en"))

    def test_long_is_auto_only(self):
        def boom(audio):
            raise AssertionError("scored a long utterance")

        e = self.engine(("长的一句话。", "zh"), {})
        e.picker.score = boom
        self.assertEqual(e.final(np.zeros(RATE * 5, dtype=np.float32)), ("长的一句话。", "zh", None))

    def test_scorer_failure_keeps_auto(self):
        e = self.engine(("Moice, miss.", "en"), {})

        def fail(audio):
            raise RuntimeError("onnx")

        e.picker.score = fail
        self.assertEqual(e.final(np.zeros(RATE, dtype=np.float32)), ("Moice, miss.", "en", None))

    def test_no_picker(self):
        e = self.engine(("Hello.", "en"), {})
        e.picker = None
        self.assertEqual(e.final(np.zeros(RATE, dtype=np.float32)), ("Hello.", "en", None))


class Fbank(unittest.TestCase):
    def test_shape(self):
        self.assertEqual(fbank(np.zeros(RATE, dtype=np.float32)).shape, (98, 80))
        self.assertEqual(fbank(np.zeros(100, dtype=np.float32)).shape, (0, 80))

    def test_matches_kaldi(self):
        try:
            import kaldi_native_fbank as knf
        except ImportError:
            self.skipTest("kaldi_native_fbank not installed")
        rng = np.random.default_rng(0)
        a = (rng.standard_normal(RATE * 2) * 0.05).astype(np.float32)
        op = knf.FbankOptions()
        op.frame_opts.dither = 0
        op.frame_opts.window_type = "hamming"
        op.frame_opts.snip_edges = True
        op.mel_opts.num_bins = 80
        op.mel_opts.high_freq = -400
        f = knf.OnlineFbank(op)
        f.accept_waveform(RATE, (a * 32768).tolist())
        f.input_finished()
        x = np.array([f.get_frame(i) for i in range(f.num_frames_ready)], dtype=np.float32)
        self.assertLess(float(np.abs(x - fbank(a)).max()), 1e-2)


@unittest.skipUnless(os.path.exists(os.path.join(MODEL, "model.int8.onnx")), "SenseVoice model not here")
class Picker(unittest.TestCase):
    def test_scores_three_readings(self):
        p = engines.LangPicker(MODEL, threads=2)
        rng = np.random.default_rng(1)
        c = p.score((rng.standard_normal(RATE * 2) * 0.01).astype(np.float32))
        self.assertEqual(set(c), {"auto", "ja", "zh"})
        for v in c.values():
            self.assertLessEqual(v.frame_lp, 0.0)
            self.assertLessEqual(v.token_lp, 0.0)
        self.assertEqual(p.score(np.zeros(100, dtype=np.float32)), {})


if __name__ == "__main__":
    unittest.main()
