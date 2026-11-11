"""
switch.py's rules (docs/local-stt.md, "Language switch"). Run with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_switch.py

With the models downloaded, it also reads the model's own test_wavs joined
(zh then ja, en then zh) and checks each language comes back.
"""
from __future__ import annotations

import os
import sys
import unittest
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from switch import RATE, plan, runs_of  # noqa: E402

S = RATE


class PlanTest(unittest.TestCase):
    def test_one_language_is_one_stretch(self):
        runs = [(0, 2 * S, "zh", 0.99), (3 * S, 5 * S, "zh", 0.97)]
        self.assertEqual(plan(runs), [(0, 5 * S, "zh")])

    def test_a_switch_cuts_in_the_silence_between_runs(self):
        runs = [(S // 2, 5 * S, "zh", 1.0), (6 * S, 12 * S, "ja", 1.0)]
        self.assertEqual(plan(runs), [(S // 2, 5 * S, "zh"), (6 * S, 12 * S, "ja")])

    def test_a_short_run_takes_the_language_before_it(self):
        # A loanword or a short reply the language frame misreads is not a switch.
        runs = [(0, 3 * S, "zh", 0.95), (3 * S + S // 4, 3 * S + S // 2, "en", 0.99), (4 * S, 6 * S, "zh", 0.9)]
        self.assertEqual(plan(runs), [(0, 6 * S, "zh")])

    def test_an_unsure_run_takes_the_language_before_it(self):
        runs = [(0, 3 * S, "zh", 0.95), (4 * S, 6 * S, "en", 0.53)]
        self.assertEqual(plan(runs), [(0, 6 * S, "zh")])

    def test_a_short_first_run_takes_the_first_sure_language(self):
        runs = [(0, S // 2, "en", 0.99), (S, 4 * S, "ja", 0.97)]
        self.assertEqual(plan(runs), [(0, 4 * S, "ja")])

    def test_nothing_sure_is_no_plan(self):
        self.assertEqual(plan([(0, S // 2, "ja", 0.4), (S, 2 * S, "en", 0.47)]), [])
        self.assertEqual(plan([]), [])

    def test_an_english_term_inside_chinese_is_not_a_switch(self):
        # 「语音识别模型是 whisper large v3 turbo，跑在…」: SenseVoice writes the term in place.
        runs = [(0, 2 * S, "zh", 0.99), (2 * S, 4 * S, "en", 0.97), (4 * S, 7 * S, "zh", 0.98)]
        self.assertEqual(plan(runs), [(0, 7 * S, "zh")])

    def test_english_alone_is_one_stretch(self):
        self.assertEqual(plan([(0, 2 * S, "en", 0.99), (3 * S, 5 * S, "en", 0.99)]), [(0, 5 * S, "en")])

    def test_yue_and_zh_read_as_one(self):
        self.assertEqual(plan([(0, 2 * S, "yue", 0.9), (3 * S, 5 * S, "zh", 0.99)]), [(0, 5 * S, "zh")])

    def test_runs_of_takes_the_likeliest_language(self):
        self.assertEqual(runs_of([(0, S, {"zh": 0.2, "ja": 0.8}), (S, 2 * S, {})]), [(0, S, "ja", 0.8)])


MODELS = os.path.expanduser(os.environ.get("LIANKI_STT_MODELS", "~/.cache/lianki-stt/models"))
WAVS = os.path.join(MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "test_wavs")


@unittest.skipUnless(os.path.exists(os.path.join(MODELS, "silero_vad.onnx")) and os.path.isdir(WAVS),
                     "models not downloaded")
class JoinedClipsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np

        from engines import SenseVoice

        cls.np = np
        cls.eng = SenseVoice()

    def wav(self, lang):
        with wave.open(os.path.join(WAVS, f"{lang}.wav")) as w:
            return self.np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(self.np.float32) / 32768

    def read(self, audio):
        """As the server does: fed in 32 ms chunks while 'spoken', then planned and read."""
        tr = self.eng.switch_tracker()
        for i in range(0, len(audio), 512):
            tr.feed(audio[i:i + 512])
        runs = tr.close()
        stretches = plan(runs_of([(a, b, f.result()) for a, b, f in runs]))
        return stretches, self.eng.read_stretches(audio, stretches) if len(stretches) > 1 else []

    def test_zh_then_ja_keeps_both(self):
        stretches, got = self.read(self.np.concatenate([self.wav("zh"), self.wav("ja")]))
        self.assertEqual([lg for _, _, lg in stretches], ["zh", "ja"])
        self.assertIn("早上9点至下午5点", got[0][0])
        self.assertIn("弁当", got[1][0])

    def test_ja_then_ko_keeps_both(self):
        stretches, got = self.read(self.np.concatenate([self.wav("ja"), self.wav("ko")]))
        self.assertEqual([lg for _, _, lg in stretches], ["ja", "ko"])
        self.assertIn("弁当", got[0][0])
        self.assertIn("생각", got[1][0])

    def test_picks_run_while_speaking_and_survive_the_pre_pad(self):
        # The page sends the VAD's head (pre-pad) with `end`, after the frames.
        import time

        audio = self.np.concatenate([self.wav("zh"), self.wav("ja")])
        head = 6 * 512
        tr = self.eng.switch_tracker()
        for i in range(head, len(audio), 512):
            tr.feed(audio[i:i + 512])
        time.sleep(0.5)
        done = [f.done() for _, _, f in tr.runs]
        self.assertTrue(done and all(done))  # the closed runs were picked before the end
        before = [(a, b) for a, b, _ in tr.runs]
        tr.prepend(audio[:head])
        self.assertEqual([(a, b) for a, b, _ in tr.runs], [(a + head, b + head) for a, b in before])
        runs = tr.close()
        stretches = plan(runs_of([(a, b, f.result()) for a, b, f in runs]))
        self.assertEqual([lg for _, _, lg in stretches], ["zh", "ja"])

    def test_one_language_is_not_split(self):
        for lang in ("zh", "en", "ja", "ko", "yue"):
            stretches, _ = self.read(self.wav(lang))
            self.assertLessEqual(len(stretches), 1, lang)


if __name__ == "__main__":
    unittest.main()
