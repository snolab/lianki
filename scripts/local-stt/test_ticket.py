"""
ticket.py's rules (docs/local-stt.md "Off the tailnet"). Run with the STT venv:

    ~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/test_ticket.py

unit/local-stt-gate.test.ts runs it too, where the venv is installed.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from ticket import V2_AUD, Tickets, file_problem, load_public_key, offered  # noqa: E402

NOW = 1_800_000_000


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make(key, **over) -> str:
    p = {"aud": "lianki-stt", "jti": "j1", "iat": NOW, "exp": NOW + 60}
    p.update(over)
    body = b64(json.dumps(p).encode())
    return f"{body}.{b64(key.sign(body.encode()))}"


class TicketTest(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.t = NOW
        self.tickets = Tickets(self.key.public_key(), clock=lambda: self.t)

    def test_good_once(self):
        tk = make(self.key)
        self.assertIsNone(self.tickets.check(tk))
        self.assertEqual(self.tickets.check(tk), "replayed")

    def test_expired(self):
        self.t = NOW + 66
        self.assertEqual(self.tickets.check(make(self.key)), "expired")

    def test_within_skew(self):
        self.t = NOW + 64
        self.assertIsNone(self.tickets.check(make(self.key)))

    def test_wrong_aud(self):
        self.assertEqual(self.tickets.check(make(self.key, aud="lianki-push")), "wrong aud")

    def test_wrong_key(self):
        other = Ed25519PrivateKey.generate()
        self.assertEqual(self.tickets.check(make(other)), "bad signature")

    def test_tampered(self):
        body, sig = make(self.key).split(".")
        p = json.loads(base64.urlsafe_b64decode(body + "=="))
        p["exp"] += 3600
        forged = b64(json.dumps(p).encode())
        self.assertEqual(self.tickets.check(f"{forged}.{sig}"), "bad signature")

    def test_long_lived_refused(self):
        self.assertEqual(self.tickets.check(make(self.key, exp=NOW + 3600)), "bad lifetime")

    def test_from_the_future_refused(self):
        self.assertEqual(self.tickets.check(make(self.key, iat=NOW + 600, exp=NOW + 660)), "bad lifetime")

    def test_malformed(self):
        for bad in ["", "x", "a.b.c", "!!.??", "a" * 600]:
            self.assertEqual(self.tickets.check(bad), "malformed")

    def test_spent_jti_forgotten_after_expiry(self):
        self.assertIsNone(self.tickets.check(make(self.key, jti="a")))
        self.t = NOW + 70
        self.tickets.check("x")  # prunes
        self.assertNotIn("a", self.tickets.seen)

    def test_full_store_recovers_once_the_burst_expires(self):
        small = Tickets(self.key.public_key(), clock=lambda: self.t, max_seen=3)
        for j in "abc":
            self.assertIsNone(small.check(make(self.key, jti=j)))
        # Full of live jtis: refuse rather than forget one early (that would allow a replay).
        self.assertTrue(small.full())
        self.assertEqual(small.check(make(self.key, jti="d")), "store full")
        # Once they expire, full() prunes them itself: no restart needed.
        self.t = NOW + 70
        self.assertFalse(small.full())
        self.assertIsNone(small.check(make(self.key, jti="e", iat=NOW + 70, exp=NOW + 130)))

    def test_offered(self):
        self.assertEqual(offered("lianki-stt, abc.def"), (True, "abc.def"))


def make_v2(key, **over) -> str:
    p = {"aud": V2_AUD, "v": 2, "jti": "v2", "iat": NOW, "exp": NOW + 60,
         "sub": "acct_1", "scope": "stt", "lim": {"utt": 40, "sess": 900}}
    p.update(over)
    return make(key, **p)


class TicketV2Test(unittest.TestCase):
    """Ticket v2 (lib/stt-ticket.ts verifySttTicketV2): its own audience, signed claims."""

    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.t = NOW
        self.v2 = Tickets(self.key.public_key(), clock=lambda: self.t, aud=V2_AUD)
        self.v1 = Tickets(self.key.public_key(), clock=lambda: self.t)

    def test_good_once_with_its_claims(self):
        tk = make_v2(self.key)
        why, p = self.v2.check_payload(tk)
        self.assertIsNone(why)
        self.assertEqual((p["sub"], p["lim"]), ("acct_1", {"utt": 40, "sess": 900}))
        self.assertEqual(self.v2.check_payload(tk), ("replayed", None))

    def test_never_opens_the_owner_listener(self):
        self.assertEqual(self.v1.check(make_v2(self.key)), "wrong aud")

    def test_a_v1_ticket_never_opens_a_public_session(self):
        self.assertEqual(self.v2.check(make(self.key)), "wrong aud")

    def test_bad_claims_refused_and_spend_nothing(self):
        cases = [
            ({"v": 1}, "wrong version"),
            ({"sub": ""}, "bad sub"),
            ({"sub": "a@b.c"}, "bad sub"),
            ({"scope": "voiceprint"}, "wrong scope"),
            ({"lim": {"utt": 0, "sess": 900}}, "bad limits"),
            ({"lim": {"utt": 40, "sess": 99999}}, "bad limits"),
            ({"lim": {"utt": True, "sess": 900}}, "bad limits"),
            ({"lim": "x"}, "bad limits"),
        ]
        for over, why in cases:
            self.assertEqual(self.v2.check(make_v2(self.key, jti="same", **over)), why)
        self.assertEqual(self.v2.seen, {})

    def test_expired(self):
        self.t = NOW + 66
        self.assertEqual(self.v2.check(make_v2(self.key)), "expired")


class FileProblemTest(unittest.TestCase):
    """public.json and the ticket key: a regular file of ours, writable by no one else."""

    def setUp(self):
        import tempfile

        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "ticket.pub")
        key = Ed25519PrivateKey.generate().public_key()
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        with open(self.path, "w") as f:
            f.write(b64(key.public_bytes(Encoding.Raw, PublicFormat.Raw)) + "\n")
        os.chmod(self.path, 0o644)

    def test_ours_and_not_writable_by_others(self):
        self.assertIsNone(file_problem(self.path))
        self.assertIsNotNone(load_public_key(self.path))
        os.chmod(self.path, 0o600)
        self.assertIsNone(file_problem(self.path))

    def test_group_writable(self):
        os.chmod(self.path, 0o664)
        self.assertEqual(file_problem(self.path), "is group- or world-writable")

    def test_world_writable(self):
        os.chmod(self.path, 0o646)
        self.assertEqual(file_problem(self.path), "is group- or world-writable")

    def test_not_ours(self):
        self.assertEqual(file_problem(self.path, uid=os.getuid() + 1), "is not owned by this user")

    def test_symlink(self):
        link = os.path.join(self.dir, "link.pub")
        os.symlink(self.path, link)
        self.assertEqual(file_problem(link), "is a symlink")
        with self.assertRaisesRegex(ValueError, "symlink"):
            load_public_key(link)

    def test_not_a_file(self):
        self.assertEqual(file_problem(self.dir), "is not a regular file")
        self.assertTrue(file_problem(os.path.join(self.dir, "missing")).startswith("cannot read"))


class OfferedTest(unittest.TestCase):
    def test_offered(self):
        self.assertEqual(offered("abc.def"), (False, "abc.def"))
        self.assertEqual(offered("lianki-stt"), (True, None))
        self.assertEqual(offered("lianki-stt, a.b, c.d"), (True, None))
        self.assertEqual(offered(None), (False, None))


if __name__ == "__main__":
    unittest.main()
