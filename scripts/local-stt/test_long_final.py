"""
Long finals (docs/local-stt.md, "Long finals in chunks", "A final shorter than its
partials"): chunked at silences, and the last partial kept when the final still
reads much less. Stub engines, no model. Run with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_long_final.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import RATE, Server, keep_partial  # noqa: E402
from switch import chunk_spans  # noqa: E402
from test_recheck import Socket  # noqa: E402

S = RATE


class ChunkSpansTest(unittest.TestCase):
    def test_short_is_one_chunk(self):
        self.assertEqual(chunk_spans([(0, 3 * S), (4 * S, 8 * S)], 9 * S, 12), [(0, 9 * S)])

    def test_cut_in_the_middle_of_a_silence(self):
        # The 2026-11-16 clip's runs: 0.39-2.98, 3.37-9.67, 10.41-16.55 s of 17.2 s.
        runs = [(int(.39 * S), int(2.98 * S)), (int(3.37 * S), int(9.67 * S)), (int(10.41 * S), int(16.55 * S))]
        total = int(17.216 * S)
        mid = (int(9.67 * S) + int(10.41 * S)) // 2
        self.assertEqual(chunk_spans(runs, total, 12), [(0, mid), (mid, total)])
        # Smaller chunks: every silence is a cut, and the chunks cover the clip with no gap.
        got = chunk_spans(runs, total, 4)
        self.assertEqual(len(got), 3)
        self.assertEqual(got[0][0], 0)
        self.assertEqual(got[-1][1], total)
        self.assertTrue(all(a[1] == b[0] for a, b in zip(got, got[1:])))

    def test_never_cuts_inside_a_run(self):
        # One 20 s run: no silence to cut at, the whole decode stands.
        self.assertEqual(chunk_spans([(S, 21 * S)], 22 * S, 12), [(0, 22 * S)])
        # A long run then a short one: one cut, after the long run.
        self.assertEqual(chunk_spans([(0, 15 * S), (16 * S, 18 * S)], 19 * S, 12),
                         [(0, 15 * S + S // 2), (15 * S + S // 2, 19 * S)])

    def test_unordered_and_empty_runs(self):
        self.assertEqual(chunk_spans([], 20 * S, 12), [(0, 20 * S)])
        self.assertEqual(chunk_spans([(0, 0)], 20 * S, 12), [(0, 20 * S)])
        self.assertEqual(chunk_spans([(14 * S, 20 * S), (0, 10 * S)], 20 * S, 12), [(0, 12 * S), (12 * S, 20 * S)])
        self.assertEqual(chunk_spans([(0, S)], 0, 12), [])


class KeepPartialTest(unittest.TestCase):
    def test_much_shorter_final_of_a_long_utterance_keeps_the_partial(self):
        self.assertTrue(keep_partial("x" * 17, "y" * 67, 17.2, 0.6, 6))

    def test_close_enough_or_short_audio_keeps_the_final(self):
        self.assertFalse(keep_partial("x" * 45, "y" * 67, 17.2, 0.6, 6))  # 45 >= 0.6 * 67
        self.assertFalse(keep_partial("x", "y" * 67, 5.9, 0.6, 6))  # under 6 s: a correction
        self.assertFalse(keep_partial("x", "", 17.2, 0.6, 6))  # no partial
        self.assertFalse(keep_partial("x", "y" * 67, 17.2, 0, 6))  # off
        self.assertFalse(keep_partial("  " + "x" * 41, "y" * 67 + "   ", 17.2, 0.6, 6))  # spaces do not count


def pcm(seconds: float, value: int = 8192) -> bytes:
    return b"\x01" + np.full(int(seconds * S), value, dtype="<i2").tobytes()


class LongEngine:
    """SenseVoice's failure, stubbed: a pass over more than 16 s reads almost nothing."""

    name = "fake"
    model = "fake"

    def __init__(self, runs=None):
        self.passes: list[int] = []
        self._runs = runs

    def transcribe(self, audio):
        self.passes.append(len(audio))
        n = len(audio) / S
        return ("短" if n > 16 else "字" * int(n * 4)), "zh"

    def speech_runs(self, audio):
        return self._runs


class Whisper:
    def transcribe(self, audio):
        return "整句重听", "zh"


class LongFinalTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        for pool in (self.server.pool, self.server.spk_pool, self.server.recheck_pool):
            pool.shutdown(wait=True)

    def make(self, engine):
        self.server = Server(engine)
        self.server.partial_min_s = 100  # no partials unless a test asks
        return self.server

    async def test_long_final_is_read_in_chunks(self):
        engine = LongEngine(runs=[(0, 9 * S), (10 * S, 16 * S)])
        self.make(engine)
        ws = Socket([{"t": "begin", "id": 1}, pcm(17), {"t": "end", "id": 1}])
        await self.server.handler(ws)
        fin = next(m for m in ws.sent if m["t"] == "final")
        # Two chunks, cut at 9.5 s: 38 + 30 characters, not the whole pass's one.
        self.assertEqual(fin["chunks"], 2)
        self.assertEqual(len(fin["text"]), 38 + 30)
        self.assertNotIn("partialKept", fin)
        self.assertEqual(sorted(engine.passes), [int(7.5 * S), int(9.5 * S)])

    async def test_no_runs_means_the_whole_pass(self):
        engine = LongEngine(runs=None)
        self.make(engine)
        ws = Socket([{"t": "begin", "id": 1}, pcm(17), {"t": "end", "id": 1}])
        await self.server.handler(ws)
        fin = next(m for m in ws.sent if m["t"] == "final")
        self.assertEqual(fin["text"], "短")
        self.assertNotIn("chunks", fin)

    async def test_short_final_is_never_chunked(self):
        engine = LongEngine(runs=[(0, 3 * S), (4 * S, 8 * S)])
        self.make(engine)
        ws = Socket([{"t": "begin", "id": 1}, pcm(9), {"t": "end", "id": 1}])
        await self.server.handler(ws)
        fin = next(m for m in ws.sent if m["t"] == "final")
        self.assertNotIn("chunks", fin)
        self.assertEqual(engine.passes, [9 * S])

    def spoken(self):
        """17 s, a partial after each second up to 16 s (the last second gets none)."""
        def stop():
            self.server.partial_step_s = 1000
        return [{"t": "begin", "id": 1}, *[pcm(1) for _ in range(16)], stop, pcm(1), {"t": "end", "id": 1}]

    async def test_much_shorter_final_keeps_the_last_partial_and_rechecks(self):
        # No runs to cut at: the whole pass reads one character after partials read 60.
        engine = LongEngine(runs=None)
        self.make(engine).partial_min_s = 0
        self.server.partial_step_s = 0.5
        with patch("server.load_engine", return_value=Whisper()):
            ws = Socket(self.spoken())
            await self.server.handler(ws)
            await asyncio.sleep(.05)
        partials = [m for m in ws.sent if m["t"] == "partial"]
        fin = next(m for m in ws.sent if m["t"] == "final")
        self.assertTrue(partials)
        self.assertTrue(fin["partialKept"])
        self.assertEqual(fin["text"], partials[-1]["text"])
        rr = next(m for m in ws.sent if m["t"] == "recheck_result")
        self.assertEqual({k: rr[k] for k in ("rid", "final", "partialKept", "ok", "text")},
                         {"rid": "final-1", "final": 1, "partialKept": True, "ok": True, "text": "整句重听"})

    async def test_guard_respects_ratio_and_minimum(self):
        engine = LongEngine(runs=None)
        self.make(engine).partial_min_s = 0
        self.server.partial_step_s = 0.5
        self.server.final_min_ratio = 0  # off
        ws = Socket(self.spoken())
        await self.server.handler(ws)
        fin = next(m for m in ws.sent if m["t"] == "final")
        self.assertNotIn("partialKept", fin)
        self.assertEqual(fin["text"], "短")
        self.assertFalse(any(m["t"] == "recheck_result" for m in ws.sent))


if __name__ == "__main__":
    unittest.main()
