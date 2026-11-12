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
from server import AudioRingBuffer, Server, RATE


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
