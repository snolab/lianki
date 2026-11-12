"""
voiceprint.py and the server's voiceprint protocol (docs/local-stt.md,
"Voiceprint"). Run by unit/local-stt-voiceprint.test.ts with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_voiceprint.py

Everything works in temporary folders with synthetic tones; no model, no clip
of the owner's is read, and nothing is played. The CAM++ test runs only where
the model is.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import voiceprint as V  # noqa: E402

RATE = V.RATE
CAMPP = os.path.join(V.MODELS_DIR, V.MODELS["campp"].file)


def tone(f: float, speech_s: float = 2.5, snr_db: float | None = 40.0, pad_s: float = 0.5, seed: int = 0):
    """A "sentence": pad_s of room noise, speech_s of a tone at f Hz (amplitude 0.3), pad_s of room noise."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(speech_s * RATE)) / RATE
    s = 0.3 * np.sin(2 * np.pi * f * t)
    pad = np.zeros(int(pad_s * RATE))
    x = np.concatenate([pad, s, pad]).astype(np.float32)
    if snr_db is not None:
        ps = float(np.mean(s ** 2))
        n = rng.standard_normal(len(x)).astype(np.float32) * np.sqrt(ps / 10 ** (snr_db / 10))
        x = x + n
    return x.astype(np.float32)


def fake_verifier(root: str) -> V.Verifier:
    return V.Verifier(V.Store(root), ["campp"], embedders={"campp": V.FakeEmbedder()})


def ls(d: str) -> list[str]:
    """A folder's files, without the dotfiles (the store's .lock)."""
    return sorted(f for f in os.listdir(d) if not f.startswith("."))


def mode(p: str) -> int:
    return stat.S_IMODE(os.lstat(p).st_mode)


class Decide(unittest.TestCase):
    M = V.MODELS["campp"]

    def test_bands(self):
        # 2 s of clean speech: the short band (me >= 0.45, other < 0.34).
        self.assertEqual(V.decide(self.M, 0.46, 2.0, 30), ("me", None))
        self.assertEqual(V.decide(self.M, 0.40, 2.0, 30), ("unknown", "between"))
        self.assertEqual(V.decide(self.M, 0.33, 2.0, 30), ("other", None))
        # 3 s and more: the long band (0.46 / 0.36).
        self.assertEqual(V.decide(self.M, 0.45, 4.0, 30), ("unknown", "between"))
        self.assertEqual(V.decide(self.M, 0.46, 4.0, 30), ("me", None))
        self.assertEqual(V.decide(self.M, 0.35, 4.0, 30), ("other", None))

    def test_noise_gate(self):
        # Under 1.5 s of speech, or under 10 dB, never me nor other.
        self.assertEqual(V.decide(self.M, 0.9, 1.4, 30), ("unknown", "short"))
        self.assertEqual(V.decide(self.M, -0.5, 1.4, 30), ("unknown", "short"))
        self.assertEqual(V.decide(self.M, 0.9, 5.0, 9.9), ("unknown", "noise"))
        self.assertEqual(V.decide(self.M, -0.5, 5.0, 9.9), ("unknown", "noise"))
        self.assertEqual(V.decide(self.M, 0.9, 1.5, 10.0), ("me", None))

    def test_thresholds_follow_394(self):
        # Calibrated against real-room multi-speaker speech (owner >= 0.50, other <= 0.35).
        short, long_ = self.M.bands
        self.assertEqual((short.min_s, long_.min_s), (V.MIN_SPEECH_S, 3.0))
        self.assertAlmostEqual(short.accept, 0.45)
        self.assertAlmostEqual(long_.accept, 0.46)
        self.assertAlmostEqual(long_.reject, 0.36)
        for m in V.MODELS.values():
            for b in m.bands:
                self.assertLess(b.reject, b.accept)  # an unknown band always exists
        self.assertTrue(V.MODELS["eres2netv2"].provisional)
        self.assertEqual((V.MIN_SPEECH_S, V.MIN_SNR_DB), (1.5, 10.0))


class SpeechStats(unittest.TestCase):
    def test_clean_and_noisy(self):
        s, snr = V.speech_stats(tone(300, 2.5, 40))
        self.assertAlmostEqual(s, 2.5, delta=0.1)
        self.assertGreater(snr, 25)
        _, snr20 = V.speech_stats(tone(300, 2.5, 20))
        _, snr5 = V.speech_stats(tone(300, 2.5, 5))
        self.assertGreater(snr20, V.MIN_SNR_DB)
        self.assertLess(snr5, V.MIN_SNR_DB)
        self.assertGreater(snr20, snr5)

    def test_short_and_empty(self):
        self.assertLess(V.speech_stats(tone(300, 1.0))[0], V.MIN_SPEECH_S)
        self.assertEqual(V.speech_stats(np.zeros(100, np.float32)), (0.0, 0.0))
        self.assertEqual(V.speech_stats(np.zeros(RATE, np.float32))[0], 0.0)


class StoreFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "config", "voiceprints")
        self.store = V.Store(self.root)
        self.old_umask = os.umask(0)  # the loosest umask: the modes must still be 0700 / 0600

    def tearDown(self):
        os.umask(self.old_umask)
        self.tmp.cleanup()

    def emb(self, k=12):
        return [V.unit(np.eye(16, dtype=np.float32)[3] + 0.01 * i) for i in range(k)]

    def test_modes(self):
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=False)
        self.assertEqual(mode(self.root), 0o700)
        f = os.path.join(self.root, "iphone.campp.json")
        self.assertEqual(mode(f), 0o600)
        self.assertEqual(ls(self.root), ["iphone.campp.json"])  # no temp file left
        p = json.load(open(f))
        self.assertEqual((p["device"], p["model"], p["n"], p["audio"]), ("iphone", "campp", 12, False))
        self.assertIn("embeddings", p)
        self.assertNotIn("text", json.dumps(p))  # embeddings and numbers only
        self.store.keep_audio("iphone", 0, tone(300))
        d = self.store.audio_dir("iphone")
        self.assertEqual(mode(d), 0o700)
        self.assertEqual(mode(os.path.join(d, "00.wav")), 0o600)

    def test_refuses_loose_or_linked_files(self):
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=False)
        f = os.path.join(self.root, "iphone.campp.json")
        os.chmod(f, 0o644)
        with self.assertRaises(V.StoreError):
            self.store.load("iphone", "campp")
        self.assertEqual(self.store.prints(), [])  # skipped, not used
        os.chmod(f, 0o600)
        self.assertIsNotNone(self.store.load("iphone", "campp"))
        # A symlink in place of a print is never followed.
        os.rename(f, os.path.join(self.tmp.name, "elsewhere.json"))
        os.symlink(os.path.join(self.tmp.name, "elsewhere.json"), f)
        with self.assertRaises(V.StoreError):
            self.store.load("iphone", "campp")
        # Nor a folder others can read.
        os.unlink(f)
        os.chmod(self.root, 0o755)
        with self.assertRaises(V.StoreError):
            self.store.prints()
        with self.assertRaises(V.StoreError):
            self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=False)

    def test_symlinked_folder_refused(self):
        real = os.path.join(self.tmp.name, "real")
        os.mkdir(real, 0o700)
        os.makedirs(os.path.dirname(self.root), exist_ok=True)
        os.symlink(real, self.root)
        with self.assertRaises(V.StoreError):
            self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=False)
        self.assertEqual(os.listdir(real), [])

    def test_delete_one_device_or_all_never_the_clips(self):
        clips = os.path.join(self.tmp.name, "lianki-voice-clips")  # a stand-in for ~/lianki-voice-clips
        os.mkdir(clips)
        with open(os.path.join(clips, "2026-11-01T00-00-00-000Z-0.wav"), "wb") as fh:
            fh.write(V.wav_bytes(tone(300)))
        before = sorted(os.listdir(clips))
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=True)
        self.store.save("iphone", "eres2netv2", self.emb(), [2.0] * 12, audio=True)
        self.store.keep_audio("iphone", 0, tone(300))
        self.store.save("android", "campp", self.emb(), [2.0] * 12, audio=False)
        self.assertEqual(self.store.delete("iphone", audio=True), 3)  # two prints and one kept sentence
        self.assertEqual(sorted(ls(self.root)), ["android.campp.json", V.GENERATIONS])
        self.assertEqual(self.store.delete(None), 1)
        self.assertEqual(ls(self.root), [V.GENERATIONS])
        self.assertEqual(sorted(os.listdir(clips)), before)
        self.assertEqual(self.store.delete(None), 0)

    def test_deleting_the_print_keeps_the_recordings(self):
        """Owner, 2026-11-11: a print delete never deletes the kept recordings; delete_audio does, alone."""
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=True)
        self.store.keep_audio("iphone", 0, tone(300))
        self.store.keep_audio("iphone", 1, tone(300))
        self.store.save("android", "campp", self.emb(), [2.0] * 12, audio=True)
        self.store.keep_audio("android", 0, tone(300))
        self.assertEqual(self.store.audio_count(), 3)
        self.assertEqual(self.store.delete(None), 2)  # the two prints only
        self.assertEqual(sorted(ls(self.root)), sorted(["android.audio", "iphone.audio", V.GENERATIONS]))
        self.assertEqual(self.store.audio_count("iphone"), 2)
        self.assertEqual(self.store.delete_audio("android"), 1)
        self.assertEqual(sorted(ls(self.root)), sorted(["iphone.audio", V.GENERATIONS]))
        self.assertEqual(self.store.delete_audio(None), 2)
        self.assertEqual(ls(self.root), [V.GENERATIONS])
        self.assertEqual(self.store.audio_count(), 0)
        with self.assertRaises(V.StoreError):
            self.store.delete_audio("../x")

    def test_cli(self):
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=False)
        py = sys.executable
        cli = os.path.join(HERE, "voiceprint.py")
        r = subprocess.run([py, "-I", cli, "--store", self.root, "list"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("iphone\tcampp\t12 sentences", r.stdout)
        r = subprocess.run([py, "-I", cli, "--store", self.root, "delete", "--device", "../x"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        r = subprocess.run([py, "-I", cli, "--store", self.root, "delete", "--device", "iphone"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("deleted 1 file", r.stdout)
        self.assertEqual(ls(self.root), [V.GENERATIONS])
        # Recordings: kept by delete, removed by delete-audio (or delete --audio).
        self.store.save("iphone", "campp", self.emb(), [2.0] * 12, audio=True)
        self.store.keep_audio("iphone", 0, tone(300))
        r = subprocess.run([py, "-I", cli, "--store", self.root, "delete", "--all"], capture_output=True, text=True)
        self.assertIn("1 kept recording(s) left", r.stdout)
        self.assertEqual(sorted(ls(self.root)), sorted(["iphone.audio", V.GENERATIONS]))
        r = subprocess.run([py, "-I", cli, "--store", self.root, "delete-audio", "--all"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("deleted 1 recording", r.stdout)
        self.assertEqual(ls(self.root), [V.GENERATIONS])
        self.assertEqual(mode(os.path.join(self.root, V.GENERATIONS)), 0o600)
        self.assertEqual(V.Store(self.root).generation("iphone"), 1)

    def test_bad_names(self):
        for d in ("", "../etc", "iPhone", "a/b", "x" * 40, None, 3):
            self.assertFalse(V.valid_device(d))
        with self.assertRaises(V.StoreError):
            self.store.save("../x", "campp", self.emb(), [2.0] * 12, audio=False)
        with self.assertRaises(V.StoreError):
            self.store.save("iphone", "nope", self.emb(), [2.0] * 12, audio=False)


class Scoring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "vp")
        self.v = fake_verifier(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def enrol(self, device, f, n=10, keep=False):
        e = V.Enrolment(self.v, device, keep_audio=keep)
        for i in range(n):
            self.assertTrue(e.add(tone(f, seed=i))["ok"])
        return e.commit()

    def test_no_print_is_unknown(self):
        r = self.v.verify(tone(300), "iphone")
        self.assertEqual((r["decision"], r["reason"], r["score"]), ("unknown", "no-print", None))

    def test_me_other_and_the_gate(self):
        self.enrol("iphone", 300)
        me = self.v.verify(tone(310), "iphone")
        self.assertEqual((me["decision"], me["score"], me["model"], me["device"]), ("me", 1.0, "campp", "iphone"))
        other = self.v.verify(tone(900), "iphone")
        self.assertEqual((other["decision"], other["score"]), ("other", 0.0))
        self.assertEqual(self.v.verify(tone(300, speech_s=1.0), "iphone")["decision"], "unknown")
        noisy = self.v.verify(tone(300, snr_db=7), "iphone")
        self.assertEqual((noisy["decision"], noisy["reason"]), ("unknown", "noise"))
        for k in ("score", "decision", "model", "device", "speechS", "snrDb"):
            self.assertIn(k, me)

    def test_own_device_first_then_any(self):
        self.enrol("iphone", 300)
        self.enrol("android", 600)
        self.assertEqual(self.v.verify(tone(600), "iphone")["decision"], "other")  # only its own print
        self.assertEqual(self.v.verify(tone(600), "android")["decision"], "me")
        r = self.v.verify(tone(600), "ipad")  # not enrolled: the best of the others
        self.assertEqual((r["decision"], r["device"]), ("me", "android"))
        r = self.v.verify(tone(600), None)
        self.assertEqual(r["device"], "android")

    def test_deleted_on_disk_is_seen(self):
        self.enrol("iphone", 300)
        self.assertEqual(self.v.verify(tone(300), "iphone")["decision"], "me")
        time.sleep(0.01)
        V.Store(self.root).delete("iphone")  # the CLI, while the server runs
        self.assertEqual(self.v.verify(tone(300), "iphone")["reason"], "no-print")


class Enrolling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "vp")
        self.v = fake_verifier(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_checks_each_sentence(self):
        e = V.Enrolment(self.v, "iphone", keep_audio=False)
        self.assertEqual(e.add(tone(300, speech_s=1.0))["reason"], "short")
        self.assertEqual(e.add(tone(300, snr_db=7))["reason"], "noise")
        for i in range(3):
            self.assertTrue(e.add(tone(300, seed=i))["ok"])
        r = e.add(tone(900))  # someone else read this one
        self.assertEqual((r["ok"], r["reason"], r["n"]), (False, "mismatch", 3))

    def test_nothing_written_before_commit_and_min_sentences(self):
        e = V.Enrolment(self.v, "iphone", keep_audio=True)
        for i in range(V.ENROL_MIN - 1):
            e.add(tone(300, seed=i))
        self.assertFalse(os.path.exists(self.root))
        with self.assertRaises(V.StoreError):
            e.commit()
        e.add(tone(300, seed=99))
        res = e.commit()
        self.assertEqual(res["n"], V.ENROL_MIN)
        self.assertEqual(len(os.listdir(V.Store(self.root).audio_dir("iphone"))), V.ENROL_MIN)

    def test_audio_only_when_opted_in(self):
        e = V.Enrolment(self.v, "iphone", keep_audio=False)
        for i in range(V.ENROL_MIN):
            e.add(tone(300, seed=i))
        e.commit()
        self.assertEqual(ls(self.root), ["iphone.campp.json"])

    def test_at_most_max(self):
        e = V.Enrolment(self.v, "iphone", keep_audio=False)
        for i in range(V.ENROL_MAX):
            self.assertTrue(e.add(tone(300, seed=i))["ok"])
        self.assertEqual(e.add(tone(300))["reason"], "full")


class AccountCopy(unittest.TestCase):
    """Store.export / restore (docs/local-stt.md, "Voiceprint in your account"): features only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "vp")
        self.v = fake_verifier(self.root)
        e = V.Enrolment(self.v, "iphone", keep_audio=True)
        for i in range(V.ENROL_MIN):
            e.add(tone(300, seed=i))
        e.commit()

    def tearDown(self):
        self.tmp.cleanup()

    def test_export_is_features_only(self):
        out = V.Store(self.root).export(None)
        self.assertEqual(len(out), 1)
        p = out[0]
        self.assertEqual(set(p), set(V.EXPORT_KEYS))
        self.assertNotIn("audio", p)  # not even the flag; never a wav, never a path
        self.assertEqual((p["device"], p["model"], p["n"], len(p["embeddings"])), ("iphone", "campp", V.ENROL_MIN, V.ENROL_MIN))
        self.assertEqual(json.loads(json.dumps(p)), p)  # plain JSON numbers
        self.assertEqual(V.Store(self.root).export("android"), [])

    def test_restore_round_trip_into_a_new_mac(self):
        p = V.Store(self.root).export("iphone")[0]
        other = os.path.join(self.tmp.name, "new-mac")
        r = V.Store(other).restore(p)
        self.assertEqual(r, {"device": "iphone", "model": "campp", "n": V.ENROL_MIN})
        q = V.Store(other).load("iphone", "campp")
        self.assertEqual((q["audio"], q["created"]), (False, p["created"]))
        self.assertTrue(np.allclose(q["centroid"], p["centroid"], atol=1e-5))
        self.assertEqual(mode(os.path.join(other, "iphone.campp.json")), 0o600)
        # Restoring over a print that kept audio leaves that audio and its flag alone.
        V.Store(self.root).restore(p)
        self.assertTrue(V.Store(self.root).load("iphone", "campp")["audio"])
        self.assertEqual(len(os.listdir(V.Store(self.root).audio_dir("iphone"))), V.ENROL_MIN)

    def test_recordings_are_read_never_moved(self):
        import base64

        st = V.Store(self.root)
        recs = st.recordings(None)
        self.assertEqual(len(recs), V.ENROL_MIN)
        self.assertEqual(set(recs[0]), {"device", "name", "created", "wav"})
        self.assertEqual((recs[0]["device"], recs[0]["name"]), ("iphone", "00.wav"))
        self.assertTrue(base64.b64decode(recs[0]["wav"]).startswith(b"RIFF"))
        self.assertEqual(st.recordings("android"), [])
        # Still all there, untouched.
        self.assertEqual(len(os.listdir(st.audio_dir("iphone"))), V.ENROL_MIN)
        # A linked file is skipped, not followed.
        os.symlink("/etc/hosts", os.path.join(st.audio_dir("iphone"), "99.wav"))
        self.assertEqual(len(st.recordings("iphone")), V.ENROL_MIN)

    def test_restore_refuses_anything_but_features(self):
        p = V.Store(self.root).export("iphone")[0]
        bad = [
            {**p, "audio": True},
            {**p, "wav": "UklGRg=="},
            {**p, "device": "../x"},
            {**p, "model": "other"},
            {**p, "n": p["n"] + 1},
            {**p, "dim": 3},
            {**p, "centroid": [float("nan")] * p["dim"]},
            {**p, "embeddings": p["embeddings"][:-1]},
            {k: v for k, v in p.items() if k != "embeddings"},
            "not a print",
        ]
        for b in bad:
            with self.assertRaises(V.StoreError, msg=str(b)[:60]):
                V.Store(os.path.join(self.tmp.name, "x")).restore(b)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "x", "iphone.campp.json")))


class Generations(unittest.TestCase):
    """A delete (server or CLI) makes an enrolment begun before it unable to save."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "vp")
        self.v = fake_verifier(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def filled(self, device="iphone"):
        e = V.Enrolment(self.v, device, keep_audio=False)
        for i in range(V.ENROL_MIN):
            e.add(tone(300, seed=i))
        return e

    def test_delete_of_that_device_invalidates(self):
        e = self.filled()
        V.Store(self.root).delete("iphone")  # the CLI, say
        with self.assertRaises(V.StoreError):
            e.commit()
        self.assertEqual(ls(self.root), [V.GENERATIONS])  # nothing saved
        self.assertEqual(e.add(tone(300))["reason"], "dropped")

    def test_delete_all_invalidates_every_device(self):
        a, b = self.filled("iphone"), self.filled("android")
        V.Store(self.root).delete(None)
        for e in (a, b):
            with self.assertRaises(V.StoreError):
                e.commit()

    def test_other_device_delete_leaves_it(self):
        e = self.filled("iphone")
        V.Store(self.root).delete("android")
        self.assertEqual(e.commit()["n"], V.ENROL_MIN)

    def test_generations_file_is_private_and_checked(self):
        st = V.Store(self.root)
        st.delete("iphone")
        f = os.path.join(self.root, V.GENERATIONS)
        self.assertEqual(mode(f), 0o600)
        os.chmod(f, 0o644)
        with self.assertRaises(V.StoreError):
            st.generation("iphone")


class Attesting(unittest.TestCase):
    def test_sign_and_verify(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cfg", "speaker-attest.key")
            a = V.Attestor(path)
            self.assertEqual(mode(path), 0o600)
            self.assertEqual(mode(os.path.dirname(path)), 0o700)
            self.assertEqual(V.Attestor(path).public(), a.public())  # kept, not remade
            tok = a.sign({"decision": "me", "score": 0.5, "model": "campp", "device": "iphone"}, "下一个")
            body, sig = tok.split(".")
            pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
            import base64

            pub = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(pad(a.public())))
            pub.verify(base64.urlsafe_b64decode(pad(sig)), body.encode())
            p = json.loads(base64.urlsafe_b64decode(pad(body)))
            self.assertEqual((p["v"], p["decision"], p["text"], p["device"]), (1, "me", "下一个", "iphone"))
            self.assertIn("uid", p)


class SpentTickets(unittest.TestCase):
    """The Mac remembers spent voiceprint tickets on disk (0600) until they expire: a restart forgets none."""

    def test_survives_a_restart_and_fails_closed(self):
        import ticket as T

        sg = Signer()
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        import base64

        key = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(sg.pub + "=" * (-len(sg.pub) % 4)))
        with tempfile.TemporaryDirectory() as tmp:
            f = os.path.join(tmp, "used-tickets.json")
            t = sg.vp("delete", "*")
            a = T.Tickets(key, aud=T.VOICEPRINT_AUD, persist=f)
            self.assertIsNone(a.check(t, {"op": "delete"}))
            self.assertEqual(mode(f), 0o600)
            b = T.Tickets(key, aud=T.VOICEPRINT_AUD, persist=f)  # the server restarted
            self.assertEqual(b.check(t, {"op": "delete"}), "replayed")
            os.chmod(f, 0o644)
            c = T.Tickets(key, aud=T.VOICEPRINT_AUD, persist=f)
            self.assertTrue(c.check(sg.vp("status"), {"op": "status"}).startswith("store"))


class Locking(unittest.TestCase):
    """The store's flock: a CLI delete never interleaves with a commit's check and writes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "vp")
        self.v = fake_verifier(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def cli_delete(self, device):
        return subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "voiceprint.py"), "--store", self.root,
                                 "delete", "--device", device, "--audio"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_cli_delete_waits_for_the_lock(self):
        st = V.Store(self.root)
        with st.lock():
            p = self.cli_delete("iphone")
            time.sleep(0.8)
            self.assertIsNone(p.poll())  # blocked on the lock
        self.assertEqual(p.wait(20), 0)

    def test_delete_during_a_commit_runs_after_its_writes(self):
        e = V.Enrolment(self.v, "iphone", keep_audio=True)
        for i in range(V.ENROL_MIN):
            e.add(tone(300, seed=i))
        procs = []
        save = self.v.store.save

        def slow_save(*a, **k):
            # Another process deletes in the middle of the commit's writes.
            procs.append(self.cli_delete("iphone"))
            time.sleep(0.8)
            return save(*a, **k)

        self.v.store.save = slow_save
        e.commit()
        self.assertEqual(procs[0].wait(20), 0)
        # The delete ran after the whole commit: nothing of it survives.
        self.assertEqual(ls(self.root), [V.GENERATIONS])
        self.assertEqual(V.Store(self.root).generation("iphone"), 1)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def b64u(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class Signer:
    """lianki.com's side in the tests: the same wire form as lib/stt-ticket.ts and lib/voiceprint-ticket.ts."""

    def __init__(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization as ser

        self.k = Ed25519PrivateKey.generate()
        self.pub = b64u(self.k.public_key().public_bytes(ser.Encoding.Raw, ser.PublicFormat.Raw))

    def ticket(self, **fields) -> str:
        now = int(time.time())
        p = {"jti": b64u(os.urandom(12)), "iat": now, "exp": now + 60, **fields}
        body = b64u(json.dumps(p).encode())
        return f"{body}.{b64u(self.k.sign(body.encode()))}"

    def vp(self, op, device="*", uv=True, keep_audio=False):
        extra = {"keepAudio": keep_audio} if op == "enrol" else {}
        return self.ticket(aud="lianki-voiceprint", op=op, device=device, uv=uv, **extra)


class FilterLineTest(unittest.TestCase):
    """The filter's rule: in doubt it never stops anything."""

    TAG = {"score": 0.01, "model": "campp", "device": "iphone", "speechS": 4.0, "snrDb": 20.0}

    def test_stops_a_clear_mismatch_on_this_devices_print(self):
        self.assertEqual(V.filter_reason(self.TAG, "iphone"), "no-match")

    def test_never_in_doubt(self):
        line = V.FILTER_BELOW["campp"]
        for tag, device in (
            (None, "iphone"),
            ({**self.TAG, "score": None}, "iphone"),  # no print, or no embedding
            ({**self.TAG, "score": line.below}, "iphone"),
            (self.TAG, None),  # no hello
            (self.TAG, "android"),  # another device's print: the channel, not the voice
            ({**self.TAG, "speechS": line.min_speech_s - 0.01}, "iphone"),
            ({**self.TAG, "snrDb": line.min_snr_db - 0.1}, "iphone"),
            ({**self.TAG, "model": "eres2netv2"}, "iphone"),  # no line measured for it
        ):
            self.assertIsNone(V.filter_reason(tag, device), (tag, device))


class ServerProtocol(unittest.TestCase):
    """
    The real server.py (--engine fake --speaker fake): voiceprint ops only with a
    voiceprint ticket for that op and device, over any socket; enrolment by id;
    a delete dropping open enrolments; signed speaker tags.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = os.path.join(cls.tmp.name, "vp")
        cls.signer = Signer()
        cls.pubfile = os.path.join(cls.tmp.name, "ticket.pub")
        fd = os.open(cls.pubfile, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, (cls.signer.pub + "\n").encode())
        os.close(fd)
        cls.attest = os.path.join(cls.tmp.name, "cfg", "speaker-attest.key")
        V.Attestor(cls.attest)  # as `voiceprint.py attest-key` would
        cls.port = free_port()
        cls.public = free_port()
        cls.proc = subprocess.Popen(
            [sys.executable, "-I", os.path.join(HERE, "server.py"), "--engine", "fake", "--port", str(cls.port),
             "--speaker", "fake", "--voiceprints", cls.root, "--public-config", "",
             "--public-port", str(cls.public), "--ticket-pubkey", cls.pubfile, "--attest-key", cls.attest],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        cls.lines: list[str] = []
        deadline = time.time() + 30
        while time.time() < deadline:
            line = cls.proc.stdout.readline()
            if not line:
                break
            cls.lines.append(line)
            if "listening on" in line:
                return
        raise RuntimeError("server did not start: " + "".join(cls.lines))

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        cls.proc.stdout.close()
        cls.tmp.cleanup()

    def run_ws(self, fn, public=False):
        from websockets.asyncio.client import connect

        async def go():
            kw = {"origin": "https://lianki.com"}
            url = f"ws://127.0.0.1:{self.port}"
            if public:
                # The tunnel listener, with a good STT ticket: a plain STT socket.
                url = f"ws://127.0.0.1:{self.public}"
                kw["subprotocols"] = ["lianki-stt", self.signer.ticket(aud="lianki-stt")]
            async with connect(url, **kw) as ws:
                ready = json.loads(await ws.recv())
                self.assertEqual(ready["t"], "ready")
                return await fn(ws)

        return asyncio.run(go())

    @staticmethod
    async def ask(ws, msg):
        msg = {"rid": b64u(os.urandom(6)), **msg}
        await ws.send(json.dumps(msg))
        while True:
            m = json.loads(await ws.recv())
            if m.get("rid") == msg["rid"]:
                return m

    @staticmethod
    async def utter(ws, uid, audio, enrol=None, text_from=None, page_uid=None):
        await ws.send(json.dumps({"t": "begin", "id": uid, **({"enrol": enrol} if enrol else {}),
                                  **({"uid": page_uid} if page_uid else {})}))
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        await ws.send(b"\x01" + pcm)
        await ws.send(json.dumps({"t": "end", "id": uid, **({"textFrom": text_from} if text_from else {})}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("t") == "final" and m.get("id") == uid:
                return m

    def refused_everywhere(self, public: bool):
        sg = self.signer

        async def flow(ws):
            out = []
            for msg in (
                {"t": "voiceprint", "op": "status"},
                {"t": "voiceprint", "op": "delete", "device": "*"},
                {"t": "enrol", "op": "start", "device": "iphone", "consent": True},
                # An STT ticket is not a voiceprint ticket.
                {"t": "voiceprint", "op": "delete", "device": "*", "ticket": sg.ticket(aud="lianki-stt")},
                # A ticket for another op or device.
                {"t": "voiceprint", "op": "delete", "device": "*", "ticket": sg.vp("status")},
                {"t": "enrol", "op": "start", "device": "iphone", "ticket": sg.vp("enrol", "android")},
                # Enrol and delete need the passkey (uv) behind the ticket.
                {"t": "enrol", "op": "start", "device": "iphone", "ticket": sg.vp("enrol", "iphone", uv=False)},
                # Approved without keeping audio: a start asking to keep it is refused.
                {"t": "enrol", "op": "start", "device": "iphone", "keepAudio": True,
                 "ticket": sg.vp("enrol", "iphone", keep_audio=False)},
                # Another key's ticket.
                {"t": "voiceprint", "op": "status", "ticket": Signer().vp("status")},
                # The account copy: export and restore need their own passkey ticket.
                {"t": "voiceprint", "op": "export", "device": "*"},
                {"t": "voiceprint", "op": "export", "device": "*", "ticket": sg.vp("delete", "*")},
                {"t": "voiceprint", "op": "export", "device": "*", "ticket": sg.vp("export", "*", uv=False)},
                {"t": "voiceprint", "op": "restore", "device": "*", "prints": [], "ticket": sg.vp("export", "*")},
                # The kept recordings: only their own passkey ticket, never a print delete's.
                {"t": "voiceprint", "op": "delete-audio", "device": "*"},
                {"t": "voiceprint", "op": "delete-audio", "device": "*", "ticket": sg.vp("delete", "*")},
                {"t": "voiceprint", "op": "delete-audio", "device": "*", "ticket": sg.vp("delete-audio", "*", uv=False)},
            ):
                r = await self.ask(ws, msg)
                out.append((r["ok"], r.get("error", "")))
            return out

        res = self.run_ws(flow, public=public)
        self.assertTrue(all(not ok for ok, _ in res), res)
        self.assertTrue(all(e.startswith("ticket") for _, e in res), res)

    def test_delete_keeps_recordings_until_asked(self):
        """Owner, 2026-11-11: the print delete leaves the kept recordings; delete-audio, its own ticket, removes them."""
        sg = self.signer

        async def flow(ws):
            await ws.send(json.dumps({"t": "hello", "device": "iphone", "thread": "owner"}))
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "consent": True, "keepAudio": True,
                                    "ticket": sg.vp("enrol", "iphone", keep_audio=True)})
            eid = r["enrolment"]
            for i in range(V.ENROL_MIN):
                await self.utter(ws, 700 + i, tone(300, seed=i), enrol=eid)
            self.assertTrue((await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": eid}))["ok"])
            st = await self.ask(ws, {"t": "voiceprint", "op": "status", "ticket": sg.vp("status")})
            d = await self.ask(ws, {"t": "voiceprint", "op": "delete", "device": "*", "ticket": sg.vp("delete", "*")})
            after = sorted(os.listdir(self.root))
            st2 = await self.ask(ws, {"t": "voiceprint", "op": "status", "ticket": sg.vp("status")})
            da = await self.ask(ws, {"t": "voiceprint", "op": "delete-audio", "device": "*",
                                     "ticket": sg.vp("delete-audio", "*")})
            st3 = await self.ask(ws, {"t": "voiceprint", "op": "status", "ticket": sg.vp("status")})
            return st, d, after, st2, da, st3

        st, d, after, st2, da, st3 = self.run_ws(flow)
        # The test mode's thresholds come with the status (the decision table).
        self.assertEqual(st["bands"]["campp"]["bands"], [{"minS": 1.5, "me": 0.45, "other": 0.34},
                                                       {"minS": 3.0, "me": 0.46, "other": 0.36}])
        self.assertEqual((st["bands"]["campp"]["minSpeechS"], st["bands"]["campp"]["minSnrDb"]), (1.5, 10.0))
        self.assertEqual(st["recordings"], V.ENROL_MIN)
        self.assertTrue(d["ok"], d)
        self.assertEqual(d["recordings"], V.ENROL_MIN)  # still on the Mac
        self.assertIn("iphone.audio", after)
        self.assertEqual((st2["prints"], st2["recordings"]), ([], V.ENROL_MIN))
        self.assertEqual((da["ok"], da["deleted"]), (True, V.ENROL_MIN))
        self.assertEqual(st3["recordings"], 0)

    def test_plain_socket_gets_no_voiceprint_ops(self):
        # A lianki.com page (a friend's included) on the tailnet port: no ticket, no op.
        self.refused_everywhere(public=False)

    def test_stt_ticket_socket_gets_no_voiceprint_ops(self):
        self.refused_everywhere(public=True)

    def filter_flow(self, device):
        """A print for iphone (440 Hz); the same device hears it, and someone else (1000 Hz)."""
        sg = self.signer

        async def flow(ws):
            await ws.send(json.dumps({"t": "hello", "device": device, "thread": "owner"}))
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "keepAudio": False, "ticket": sg.vp("enrol", "iphone")})
            eid = r["enrolment"]
            for i in range(V.ENROL_MIN):
                await self.utter(ws, 500 + i, tone(440, seed=i), enrol=eid)
            self.assertTrue((await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": eid}))["ok"])
            st = await self.ask(ws, {"t": "voiceprint", "op": "status", "ticket": sg.vp("status")})
            off_me = await self.utter(ws, 1, tone(440))
            off_other = await self.utter(ws, 2, tone(1000))
            await ws.send(json.dumps({"t": "filter", "on": True}))
            self.assertEqual(json.loads(await ws.recv()), {"t": "filter", "on": True})
            on_me = await self.utter(ws, 3, tone(440))
            on_other = await self.utter(ws, 4, tone(1000))
            short = await self.utter(ws, 5, tone(1000, speech_s=1.0))
            noisy = await self.utter(ws, 6, tone(1000, snr_db=3.0))
            await ws.send(json.dumps({"t": "filter", "on": False}))
            await ws.recv()
            again = await self.utter(ws, 7, tone(1000))
            await self.ask(ws, {"t": "voiceprint", "op": "delete", "device": "*", "ticket": sg.vp("delete", "*")})
            await ws.send(json.dumps({"t": "filter", "on": True}))
            await ws.recv()
            gone = await self.utter(ws, 8, tone(1000))
            return st, off_me, off_other, on_me, on_other, short, noisy, again, gone

        return self.run_ws(flow)

    def test_filter_stops_only_what_clearly_is_not_him(self):
        st, off_me, off_other, on_me, on_other, short, noisy, again, gone = self.filter_flow("iphone")
        self.assertEqual(st["filter"], "on")
        # Off: nothing changes, it only counts what it would have stopped.
        self.assertTrue(off_me["text"])
        self.assertNotIn("wouldFilter", off_me)
        self.assertTrue(off_other["text"])
        self.assertEqual(off_other["wouldFilter"], "no-match")
        self.assertNotIn("filtered", off_other)
        # On: his voice as ever, with its proof; someone else's not decoded, no text, no proof.
        self.assertTrue(on_me["text"])
        self.assertEqual(on_me["speaker"]["decision"], "me")
        self.assertIn("speakerProof", on_me)
        self.assertEqual(on_other["text"], "")
        self.assertEqual(on_other["filtered"]["reason"], "no-match")
        self.assertNotIn("speakerProof", on_other)
        # Not enough to judge: it passes (a filter that eats his words is worse than none).
        self.assertTrue(short["text"])
        self.assertNotIn("filtered", short)
        self.assertTrue(noisy["text"])
        self.assertNotIn("filtered", noisy)
        # The off switch, and no print: exactly as before.
        self.assertTrue(again["text"])
        self.assertNotIn("filtered", again)
        self.assertTrue(gone["text"])
        self.assertNotIn("filtered", gone)

    def test_filter_needs_this_devices_own_print(self):
        st, _m, off_other, _on, on_other, *_ = self.filter_flow("android")
        self.assertEqual(st["filter"], "no-print")
        self.assertNotIn("wouldFilter", off_other)
        self.assertTrue(on_other["text"])
        self.assertNotIn("filtered", on_other)

    def test_filter_holds_partials_until_checked(self):
        sg = self.signer

        async def flow(ws):
            await ws.send(json.dumps({"t": "hello", "device": "iphone"}))
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "keepAudio": False, "ticket": sg.vp("enrol", "iphone")})
            eid = r["enrolment"]
            for i in range(V.ENROL_MIN):
                await self.utter(ws, 700 + i, tone(440, seed=i), enrol=eid)
            await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": eid})
            await ws.send(json.dumps({"t": "filter", "on": True}))
            await ws.recv()

            async def partials(uid, audio):
                await ws.send(json.dumps({"t": "begin", "id": uid}))
                got = []
                step = int(0.05 * V.RATE)
                for k in range(0, len(audio), step):
                    x = audio[k : k + step]
                    await ws.send(b"\x01" + (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
                    await asyncio.sleep(0.005)
                await ws.send(json.dumps({"t": "end", "id": uid}))
                while True:
                    m = json.loads(await ws.recv())
                    if m.get("t") == "partial" and m.get("id") == uid:
                        got.append(m["audioMs"])
                    if m.get("t") == "final" and m.get("id") == uid:
                        return got, m

            other, of = await partials(21, tone(1000, speech_s=3.0))
            me, mf = await partials(22, tone(440, speech_s=3.0))
            await self.ask(ws, {"t": "voiceprint", "op": "delete", "device": "*", "ticket": sg.vp("delete", "*")})
            return other, of, me, mf

        other, of, me, mf = self.run_ws(flow)
        self.assertEqual(other, [])  # nothing of someone else's was ever decoded
        self.assertEqual(of["text"], "")
        self.assertTrue(mf["text"])
        self.assertTrue(me)
        # His first partial waits for the check: enough speech heard to judge.
        self.assertGreaterEqual(me[0], int(V.FILTER_BELOW["campp"].min_speech_s * 1000))

    def test_flow(self):
        sg = self.signer

        async def flow(ws):
            await ws.send(json.dumps({"t": "hello", "device": "iphone", "thread": "owner"}))
            f = await self.utter(ws, 1, tone(300))
            self.assertEqual(f["speaker"]["reason"], "no-print")
            r = await self.ask(ws, {"t": "voiceprint", "op": "status", "ticket": sg.vp("status")})
            self.assertEqual((r["ok"], r["prints"]), (True, []))
            # An enrol sentence for an enrolment that does not exist: not kept.
            f = await self.utter(ws, 2, tone(300), enrol="nope")
            self.assertEqual(f["enrol"]["reason"], "no-enrolment")
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "consent": True,
                                    "ticket": sg.vp("enrol", "iphone")})
            self.assertTrue(r["ok"], r)
            eid = r["enrolment"]
            # The same ticket twice: single use.
            t = sg.vp("enrol", "iphone")
            r1 = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "ticket": t})
            r2 = await self.ask(ws, {"t": "enrol", "op": "start", "device": "iphone", "ticket": t})
            self.assertTrue(r1["ok"])
            self.assertEqual(r2["error"], "ticket replayed")
            await self.ask(ws, {"t": "enrol", "op": "cancel", "enrolment": r1["enrolment"]})
            for i in range(10):
                f = await self.utter(ws, 10 + i, tone(300, seed=i), enrol=eid)
                self.assertTrue(f["enrol"]["ok"], f)
            self.assertFalse(os.path.exists(os.path.join(self.root, "iphone.campp.json")))
            r = await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": eid})
            self.assertTrue(r["ok"], r)
            self.assertEqual(mode(os.path.join(self.root, "iphone.campp.json")), 0o600)
            # Verified finals carry a proof the Mac signed over the text.
            f = await self.utter(ws, 30, tone(300), page_uid="U" * 22)
            self.assertEqual(f["speaker"]["decision"], "me")
            self.assertIn("speakerProof", f)
            body = f["speakerProof"].split(".")[0]
            import base64

            p = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            self.assertEqual((p["text"], p["decision"], p["device"]), (f["text"], "me", "iphone"))
            # Bound to the page's utterance id and its thread (the hub checks both and burns the uid).
            self.assertEqual((p["uid"], p["thread"]), ("U" * 22, "owner"))
            f = await self.utter(ws, 31, tone(900))
            self.assertEqual(f["speaker"]["decision"], "other")
            # The account copy: export hands over features only, once per ticket.
            t = sg.vp("export", "*")
            r = await self.ask(ws, {"t": "voiceprint", "op": "export", "device": "*", "ticket": t})
            self.assertTrue(r["ok"], r)
            self.assertEqual([set(p) for p in r["prints"]], [set(V.EXPORT_KEYS)])
            r2 = await self.ask(ws, {"t": "voiceprint", "op": "export", "device": "*", "ticket": t})
            self.assertEqual(r2["error"], "ticket replayed")
            printed = r["prints"]
            r = await self.ask(ws, {"t": "voiceprint", "op": "export", "device": "*", "recordings": True,
                                    "ticket": sg.vp("export", "*")})
            self.assertEqual((r["ok"], r["recordings"]), (True, []))  # nothing kept: none handed over
            # Restore: an extra key anywhere refuses the whole request, nothing written.
            r = await self.ask(ws, {"t": "voiceprint", "op": "restore", "device": "*",
                                    "prints": [{**printed[0], "audio": True}], "ticket": sg.vp("restore", "*")})
            self.assertFalse(r["ok"])
            r = await self.ask(ws, {"t": "voiceprint", "op": "restore", "device": "android",
                                    "prints": printed, "ticket": sg.vp("restore", "android")})
            self.assertEqual(r["error"], "wrong device")
            r = await self.ask(ws, {"t": "voiceprint", "op": "restore", "device": "*",
                                    "prints": printed, "ticket": sg.vp("restore", "*")})
            self.assertEqual((r["ok"], r["restored"]), (True, [{"device": "iphone", "model": "campp", "n": 10}]))
            f = await self.utter(ws, 32, tone(300))
            self.assertEqual(f["speaker"]["decision"], "me")
            # Delete with its ticket.
            r = await self.ask(ws, {"t": "voiceprint", "op": "delete", "device": "iphone",
                                    "ticket": sg.vp("delete", "iphone")})
            self.assertEqual((r["ok"], r["deleted"]), (True, 1))
            f = await self.utter(ws, 33, tone(300))
            self.assertEqual(f["speaker"]["reason"], "no-print")
            return True

        self.assertTrue(self.run_ws(flow))

    def test_delete_drops_a_pending_enrolment(self):
        """Page A enrols; page B deletes; A can neither add nor commit."""
        sg = self.signer

        async def page_a_start(ws):
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "ipad", "consent": True,
                                    "ticket": sg.vp("enrol", "ipad")})
            for i in range(10):
                f = await self.utter(ws, 50 + i, tone(300, seed=i), enrol=r["enrolment"])
                self.assertTrue(f["enrol"]["ok"])
            return r["enrolment"]

        eid = self.run_ws(page_a_start)

        async def page_b(ws):
            return await self.ask(ws, {"t": "voiceprint", "op": "delete", "device": "*",
                                       "ticket": sg.vp("delete", "*")})

        self.assertTrue(self.run_ws(page_b)["ok"])

        async def page_a_after(ws):
            f = await self.utter(ws, 70, tone(300), enrol=eid)
            r = await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": eid})
            return f["enrol"], r

        sentence, commit = self.run_ws(page_a_after)
        self.assertFalse(sentence["ok"])
        self.assertEqual(commit["error"], "no enrolment")
        self.assertFalse(os.path.exists(os.path.join(self.root, "ipad.campp.json")))

    def test_cli_delete_refuses_a_later_commit(self):
        sg = self.signer

        async def flow(ws):
            r = await self.ask(ws, {"t": "enrol", "op": "start", "device": "mac", "consent": True,
                                    "ticket": sg.vp("enrol", "mac")})
            for i in range(10):
                await self.utter(ws, 80 + i, tone(300, seed=i), enrol=r["enrolment"])
            # The CLI, from another process, while the enrolment is open.
            subprocess.run([sys.executable, "-I", os.path.join(HERE, "voiceprint.py"), "--store", self.root,
                            "delete", "--device", "mac"], check=True, capture_output=True)
            return await self.ask(ws, {"t": "enrol", "op": "commit", "enrolment": r["enrolment"]})

        r = self.run_ws(flow)
        self.assertFalse(r["ok"])
        self.assertIn("deleted meanwhile", r["error"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "mac.campp.json")))


@unittest.skipUnless(os.path.exists(CAMPP), "CAM++ model not here")
class RealCampp(unittest.TestCase):
    def test_loads_and_embeds(self):
        e = V.Embedder(V.MODELS["campp"], threads=1)
        v = e(tone(300, speech_s=2.0))
        self.assertEqual(v.shape, (192,))
        self.assertAlmostEqual(float(np.linalg.norm(v)), 1.0, places=4)


if __name__ == "__main__":
    unittest.main()
