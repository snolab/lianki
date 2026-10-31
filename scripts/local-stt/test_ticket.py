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

from ticket import Tickets, offered  # noqa: E402

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

    def test_offered(self):
        self.assertEqual(offered("lianki-stt, abc.def"), (True, "abc.def"))
        self.assertEqual(offered("abc.def"), (False, "abc.def"))
        self.assertEqual(offered("lianki-stt"), (True, None))
        self.assertEqual(offered("lianki-stt, a.b, c.d"), (True, None))
        self.assertEqual(offered(None), (False, None))


if __name__ == "__main__":
    unittest.main()
