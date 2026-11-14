"""RAM ring and WebSocket recheck protocol, without loading speech models."""
import asyncio
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import AudioRingBuffer, Segment, Server, RATE, run_audio, run_window


class RingTest(unittest.TestCase):
    def test_wrap_oversize_snapshot_and_clear(self):
        ring = AudioRingBuffer(1)
        ring.append(np.arange(RATE - 2, dtype=np.float32))
        ring.append(np.arange(10, dtype=np.float32))
        np.testing.assert_array_equal(ring.tail(10), np.arange(10))
        ring.append(np.arange(RATE + 5, dtype=np.float32))
        np.testing.assert_array_equal(ring.tail(RATE * 2), np.arange(5, RATE + 5))
        snap = ring.tail(3)
        ring.clear()
        self.assertEqual(ring.size, 0)
        self.assertFalse(ring.data.any())
        np.testing.assert_array_equal(snap, np.arange(RATE + 2, RATE + 5))

    def test_prepad_precedes_current_frames(self):
        ring = AudioRingBuffer(1)
        ring.append(np.array([1, 2, 5, 6], dtype=np.float32))
        ring.prepend_current(np.array([3, 4], dtype=np.float32), 2)
        np.testing.assert_array_equal(ring.tail(99), [1, 2, 3, 4, 5, 6])


class RunTest(unittest.TestCase):
    """A continuous-speech run: found by when its utterances began, read whole."""

    def ring_of(self, *lengths):
        ring, segs, t = AudioRingBuffer(1), [], 0.0
        for i, n in enumerate(lengths):
            seg = Segment(i, ring.total, t)
            ring.append(np.full(n, i + 1, dtype=np.float32))
            seg.stop, seg.t1 = ring.total, t + .1
            segs.append(seg)
            t += 1
        return ring, segs

    def test_absolute_positions_and_span(self):
        ring = AudioRingBuffer(1)
        ring.append(np.arange(RATE - 2, dtype=np.float32))
        self.assertEqual((ring.total, ring.oldest), (RATE - 2, 0))
        ring.append(np.arange(10, dtype=np.float32))
        self.assertEqual(ring.oldest, 8)
        np.testing.assert_array_equal(ring.span(RATE - 2, RATE + 1), [0, 1, 2])
        self.assertIsNone(ring.span(7, 9))  # sample 7 left the ring
        self.assertIsNone(ring.span(RATE, RATE + 9))  # not received yet
        ring.append(np.ones(2 * RATE, dtype=np.float32))  # longer than the ring: total counts it all
        self.assertEqual(ring.total, 3 * RATE + 8)
        ring.prepend_current(np.zeros(3, dtype=np.float32), 5)
        self.assertEqual(ring.total, 3 * RATE + 11)

    def test_picks_the_run_only(self):
        ring, segs = self.ring_of(100, 200, 300, 50)
        audio, why = run_audio(ring, segs, 1, 2.2)  # utterances 1 and 2 began at 1 s and 2 s
        self.assertIsNone(why)
        np.testing.assert_array_equal(audio, [2] * 200 + [3] * 300)
        self.assertEqual(run_audio(ring, segs, 10, 12), (None, "no audio"))
        # Its first utterance is not in this socket's ring (a replay on a new socket).
        self.assertEqual(run_audio(ring, segs[2:], 1, 2.2), (None, "run incomplete"))
        self.assertEqual(run_audio(ring, segs[:2], 1, 3.2), (None, "run incomplete"))
        segs[2].t1 = None
        self.assertEqual(run_audio(ring, segs, 1, 2.2), (None, "still speaking"))

    def test_a_run_longer_than_the_ring_is_refused(self):
        ring, segs = self.ring_of(RATE // 2, RATE // 2, RATE // 2)
        self.assertEqual(run_audio(ring, segs, 0, 2.2), (None, "run too long"))
        audio, _ = run_audio(ring, segs, 1, 2.2)
        self.assertEqual(len(audio), RATE)

    def test_window(self):
        self.assertEqual(run_window({"fromAgoMs": 9000, "toAgoMs": 2500}, 60), (9, 2.5))
        self.assertEqual(run_window({"fromAgoMs": 9000}, 60), (9, 0))
        for bad in [{}, {"fromAgoMs": 1, "toAgoMs": 2}, {"fromAgoMs": -1}, {"fromAgoMs": True},
                    {"fromAgoMs": float("inf")}, {"fromAgoMs": "9"}, {"fromAgoMs": 200_000}]:
            self.assertIsNone(run_window(bad, 60), bad)


class FakeEngine:
    name = 'fake'
    model = 'fake'

    def transcribe(self, audio):
        return '友邦惊诧', 'zh'


class Socket:
    request = SimpleNamespace(headers={})

    def __init__(self, messages):
        self.messages = messages
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    def __aiter__(self):
        return self.stream()

    async def stream(self):
        for message in self.messages:
            if callable(message):  # a step of the test's clock, not a message
                message()
                continue
            yield json.dumps(message) if isinstance(message, dict) else message
            await asyncio.sleep(.01)
        await asyncio.sleep(.05)


class RecheckTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = Server(FakeEngine())
        self.server.partial_min_s = 100

    async def asyncTearDown(self):
        for pool in (self.server.pool, self.server.spk_pool, self.server.recheck_pool):
            pool.shutdown(wait=True)

    async def test_recheck_snapshot_and_connection_isolation(self):
        calls = []
        engine = FakeEngine()
        original = engine.transcribe

        def read(audio):
            calls.append(audio.copy())
            return original(audio)

        engine.transcribe = read
        with patch('server.load_engine', return_value=engine) as load:
            ws = Socket([
                {'t': 'begin', 'id': 1},
                b'\x01' + np.full(RATE, 16384, dtype='<i2').tobytes(),
                b'\x02' + np.full(RATE // 2, 8192, dtype='<i2').tobytes(),
                {'t': 'end', 'id': 1},
                {'t': 'recheck', 'rid': 'r1', 'seconds': 1.5},
                {'t': 'ping'},
            ])
            await self.server.handler(ws)
            result = next(m for m in ws.sent if m['t'] == 'recheck_result')
            self.assertEqual(result['text'], '友邦惊诧')
            self.assertEqual(result['rid'], 'r1')
            self.assertEqual(result['audioMs'], 1500)
            np.testing.assert_array_equal(calls[-1][:RATE // 2], .25)
            np.testing.assert_array_equal(calls[-1][RATE // 2:], .5)
            load.assert_called_once_with('mlx-whisper')
            other = Socket([{'t': 'recheck'}])
            await self.server.handler(other)
            self.assertEqual(other.sent[-1]['error'], 'no audio')

    async def test_busy_does_not_block_ping_and_disconnect_cancels(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow(request, audio):
            started.set()
            await release.wait()
            return {"t": "recheck_result", "text": "late"}

        self.server.recheck = slow
        ws = Socket([
            {'t': 'begin', 'id': 1},
            b'\x01' + np.ones(100, dtype='<i2').tobytes(),
            {'t': 'recheck'}, {'t': 'recheck'}, {'t': 'ping'},
        ])
        await self.server.handler(ws)
        self.assertTrue(started.is_set())
        self.assertTrue(any(m.get('error') == 'recheck busy' for m in ws.sent))
        self.assertTrue(any(m['t'] == 'pong' for m in ws.sent))
        release.set()
        await asyncio.sleep(.01)
        self.assertFalse(any(m.get('text') == 'late' for m in ws.sent))

    async def test_enrolment_audio_is_never_cached(self):
        ws = Socket([
            {'t': 'begin', 'id': 1},
            b'\x01' + np.ones(100, dtype='<i2').tobytes(),
            {'t': 'begin', 'id': 2, 'enrol': 'private'},
            b'\x01' + np.ones(100, dtype='<i2').tobytes(),
            {'t': 'recheck'},
            {'t': 'begin', 'id': 3}, {'t': 'recheck'},
        ])
        await self.server.handler(ws)
        answers = [m for m in ws.sent if m['t'] == 'recheck_result']
        self.assertIn('enrolling', answers[0]['error'])
        self.assertEqual(answers[1]['error'], 'no audio')

    async def test_auto_recheck_reads_the_whole_run(self):
        clock = [100.0]
        calls = []
        engine = FakeEngine()
        engine.transcribe = lambda audio: calls.append(audio.copy()) or ('整段重听', 'zh')

        def at(t):
            return lambda: clock.__setitem__(0, t)

        utt = lambda i, v: [{'t': 'begin', 'id': i}, b'\x01' + np.full(800, v, dtype='<i2').tobytes(),
                            {'t': 'end', 'id': i}]
        with patch('server.load_engine', return_value=engine), patch('server.now_s', lambda: clock[0]):
            ws = Socket([
                at(100), *utt(1, 4096),  # the line before: not part of the run
                at(104), *utt(2, 8192),
                at(106), *utt(3, 16384),
                at(110),
                {'t': 'recheck', 'rid': 'a1', 'auto': True, 'run': 'm-7', 'fromAgoMs': 6000, 'toAgoMs': 3500},
                {'t': 'recheck', 'rid': 'a2', 'auto': True, 'run': 'm/7', 'fromAgoMs': 1},
            ])
            await self.server.handler(ws)
        got = [m for m in ws.sent if m['t'] == 'recheck_result']
        bad = next(m for m in got if m['rid'] == 'a2')
        self.assertEqual((bad['ok'], bad['error'], bad['run']), (False, 'bad run', None))
        ok = next(m for m in got if m['rid'] == 'a1')
        self.assertEqual({k: ok[k] for k in ('auto', 'run', 'ok', 'text', 'lang', 'engine', 'audioMs')},
                         {'auto': True, 'run': 'm-7', 'ok': True, 'text': '整段重听', 'lang': 'zh',
                          'engine': 'mlx-whisper', 'audioMs': 100})
        np.testing.assert_array_equal(calls[-1], [.25] * 800 + [.5] * 800)

    async def test_auto_recheck_failures_keep_the_line(self):
        clock = [50.0]
        with patch('server.now_s', lambda: clock[0]):
            ws = Socket([
                {'t': 'begin', 'id': 1}, b'\x01' + np.ones(100, dtype='<i2').tobytes(),
                {'t': 'recheck', 'rid': 'b1', 'auto': True, 'run': 'r', 'fromAgoMs': 1000},
                {'t': 'recheck', 'rid': 'b2', 'auto': True, 'run': 'r', 'fromAgoMs': 1, 'toAgoMs': 5},
                {'t': 'recheck', 'rid': 'b3', 'auto': True, 'run': 'r', 'fromAgoMs': 900_000},
            ])
            await self.server.handler(ws)
        errors = {m['rid']: m['error'] for m in ws.sent if m['t'] == 'recheck_result'}
        self.assertEqual(errors, {'b1': 'still speaking', 'b2': 'bad window', 'b3': 'bad window'})
        with patch('server.load_engine', side_effect=RuntimeError('x')):
            result = await self.server.recheck({'rid': 'c', 'auto': True, 'run': 'm1'}, np.ones(10))
        self.assertEqual((result['ok'], result['auto'], result['run']), (False, True, 'm1'))

    async def test_ring_follows_the_configured_seconds(self):
        self.server.recheck_max_s = 2
        ws = Socket([{'t': 'begin', 'id': 1}, b'\x01' + np.ones(100, dtype='<i2').tobytes(),
                     {'t': 'end', 'id': 1}, {'t': 'recheck', 'seconds': 3}])
        await self.server.handler(ws)
        self.assertEqual(ws.sent[-1]['error'], 'seconds must be within (0, 2]')

    async def test_invalid_requests_and_failure(self):
        ws = Socket([{'t': 'recheck', 'seconds': s} for s in [0, -1, 61, True, '15', float('nan')]])
        await self.server.handler(ws)
        self.assertEqual(len([m for m in ws.sent if m.get('ok') is False]), 6)
        with patch('server.load_engine', side_effect=RuntimeError('private detail')):
            result = await self.server.recheck({'rid': 'fail'}, np.ones(100))
        self.assertEqual(result['error'], 'recheck unavailable')
        self.assertNotIn('private detail', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
