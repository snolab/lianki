"""Private local recording, bounded writer, and capture-time retention tests."""
import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from recordings import RecordingStore, RecordingWorker, TTL_S
from test_recheck import Socket, FakeEngine
from server import Server, RATE

NOW = 1_800_000_000.0


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'recordings'
        self.now = NOW
        self.store = RecordingStore(str(self.root), clock=lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def test_wave_roundtrip_and_private_modes(self):
        old = os.umask(0)
        try:
            name = self.store.write(np.array([0, .25, -.5, 1, -1], dtype=np.float32), NOW)
        finally:
            os.umask(old)
        path = self.root / name
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        with wave.open(str(path)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, RATE))
            np.testing.assert_array_equal(np.frombuffer(wav.readframes(5), dtype='<i2'), [0, 8192, -16384, 32767, -32768])

    def test_restart_prunes_by_capture_time_not_mtime(self):
        name = self.store.write(np.zeros(10), NOW)
        other = self.root / 'keep.wav'
        other.touch()
        self.now += TTL_S
        os.utime(self.root / name, (self.now, self.now))
        restarted = RecordingStore(str(self.root), clock=lambda: self.now)
        self.assertEqual(restarted.prune(), 1)
        self.assertTrue(other.exists())
        self.assertEqual(restarted.prune(), 0)

    def test_expired_queue_item_not_written_and_new_clip_retained(self):
        self.assertIsNone(self.store.write(np.ones(10), NOW - TTL_S))
        name = self.store.write(np.ones(10), NOW - TTL_S + 1)
        self.assertIsNotNone(name)
        self.assertEqual(self.store.prune(), 0)
        self.now += 1
        self.assertEqual(self.store.prune(), 1)

    def test_no_symlink_or_other_file_deletion(self):
        name = self.store.write(np.zeros(10), NOW)
        (self.root / name).unlink()
        target = Path(self.temp.name) / 'outside.wav'
        target.touch()
        (self.root / name).symlink_to(target)
        self.now += TTL_S
        self.assertEqual(self.store.prune(), 0)
        self.assertTrue(target.exists())

    def test_unsafe_directory_and_invalid_ttl_refused(self):
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            RecordingStore(str(self.root))
        self.root.chmod(0o700)
        link = Path(self.temp.name) / 'link'
        link.symlink_to(self.root)
        with self.assertRaises(ValueError):
            RecordingStore(str(link))
        for ttl in (0, -1, TTL_S + 1):
            with self.assertRaises(ValueError):
                RecordingStore(str(self.root), ttl=ttl)

    def test_empty_audio_and_future_time(self):
        self.assertIsNone(self.store.write(np.zeros(0), NOW))
        with self.assertRaises(ValueError):
            self.store.write(np.ones(2), NOW + 100)

    def test_failed_write_removes_incomplete_segment(self):
        with patch('recordings.wave.open', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.store.write(np.ones(2), NOW)
        self.assertEqual(list(self.root.iterdir()), [])


class WorkerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = NOW
        self.store = RecordingStore(self.temp.name, clock=lambda: self.now)
        self.logs = []
        self.worker = RecordingWorker(self.store, self.logs.append, capacity=1, cleanup_s=.01)
        await self.worker.start()

    async def asyncTearDown(self):
        await self.worker.close()
        self.temp.cleanup()

    async def test_bounded_queue_and_shutdown_flush(self):
        self.assertTrue(self.worker.submit(np.ones(3), NOW))
        self.assertFalse(self.worker.submit(np.ones(3), NOW))
        await self.worker.queue.join()
        self.assertEqual(self.worker.saved, 1)
        self.assertEqual(self.worker.dropped, 1)
        await self.worker.close()
        self.assertFalse(self.worker.submit(np.ones(3), NOW))

    async def test_idle_cleanup_and_disk_errors_do_not_stop_worker(self):
        self.store.write(np.ones(2), NOW)
        self.now += TTL_S
        for _ in range(50):
            if not list(Path(self.temp.name).iterdir()):
                break
            await asyncio.sleep(.01)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        with patch.object(self.store, 'write', side_effect=OSError('disk full')):
            self.worker.submit(np.ones(2), self.now)
            await self.worker.queue.join()
        self.assertEqual(self.worker.errors, 1)
        self.worker.submit(np.ones(2), self.now)
        await self.worker.queue.join()
        self.assertEqual(self.worker.saved, 1)

    async def test_server_only_records_completed_owner_utterances_with_prepad(self):
        server = Server(FakeEngine(), recorder=self.worker)
        server.partial_min_s = 100
        frames = b'\x01' + np.full(100, 16384, dtype='<i2').tobytes()
        pre = b'\x02' + np.full(10, 8192, dtype='<i2').tobytes()
        try:
            with patch('server.time.time', return_value=NOW):
                await server.handler(Socket([{'t': 'begin', 'id': 1}, frames, pre,
                                             {'t': 'end', 'id': 1}, {'t': 'end', 'id': 1}]))
                await server.handler(Socket([{'t': 'begin', 'id': 2}, frames,
                                             {'t': 'end', 'id': 2}]), limits={'utt': 1, 'sess': 10})
                await server.handler(Socket([{'t': 'begin', 'id': 3, 'enrol': 'private'}, frames,
                                             {'t': 'end', 'id': 3}]))
                await server.handler(Socket([{'t': 'begin', 'id': 4}, frames, {'t': 'cancel', 'id': 4}]))
                await server.handler(Socket([{'t': 'begin', 'id': 5}, frames]))
            await self.worker.queue.join()
            self.assertEqual(self.worker.saved, 1)
            paths = list(Path(self.temp.name).glob('*.wav'))
            with wave.open(str(paths[0])) as wav:
                actual = np.frombuffer(wav.readframes(110), dtype='<i2')
                np.testing.assert_array_equal(actual[:10], 8192)
                np.testing.assert_array_equal(actual[10:], 16384)
        finally:
            for pool in (server.pool, server.spk_pool, server.recheck_pool):
                pool.shutdown(wait=True)

    async def test_default_server_does_not_enable_recording(self):
        server = Server(FakeEngine())
        try:
            self.assertIsNone(server.recorder)
            ws = Socket([])
            await server.handler(ws)
            self.assertNotIn('recording', ws.sent[0])
        finally:
            for pool in (server.pool, server.spk_pool, server.recheck_pool):
                pool.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
