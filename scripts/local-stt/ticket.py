"""
Ticket check for the local STT server's public listener (wss://stt.lianki.com
through the cloudflared tunnel; docs/local-stt.md "Off the tailnet").

lianki.com (/api/dev/stt-ticket, lib/stt-ticket.ts) signs a 60 s, single-use
ticket with an Ed25519 private key that lives only in the Worker secret
STT_TICKET_KEY. This Mac holds only the public key. The page offers the ticket
as a WebSocket subprotocol beside "lianki-stt"; the server checks it in
process_request, before any upgrade, and answers 401 without one.

Wire form: `<payload>.<signature>`, base64url without padding; the signature
covers the ASCII bytes of `<payload>`; the payload is JSON
`{aud:"lianki-stt", jti, iat, exp}` in seconds. Mirrors verifySttTicket in
lib/stt-ticket.ts rule for rule.
"""
from __future__ import annotations

import base64
import json
import re
import time

AUD = "lianki-stt"
SUBPROTOCOL = "lianki-stt"
TTL_S = 60
SKEW_S = 5
MAX_LEN = 512
#: Live jtis remembered at most (each for 60 s; owner-only, so never near in use).
MAX_SEEN = 1000
_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")


def b64url_decode(s: str) -> bytes:
    if not _B64URL.match(s):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_public_key(path: str):
    """The raw 32-byte Ed25519 public key, base64url, one line (scripts/local-stt/ticket-key.ts writes it)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    with open(path, encoding="ascii") as f:
        raw = b64url_decode(f.read().strip())
    if len(raw) != 32:
        raise ValueError("not an Ed25519 public key")
    return Ed25519PublicKey.from_public_bytes(raw)


class Tickets:
    """Verifies tickets against one public key and remembers each jti until it expires."""

    def __init__(self, public_key, clock=time.time, max_seen: int = MAX_SEEN):
        self.key = public_key
        self.clock = clock
        self.max_seen = max_seen
        self.seen: dict[str, int] = {}

    def prune(self) -> None:
        """Forget the jtis of tickets that have expired (they can no longer verify anyway)."""
        now = int(self.clock())
        for j in [j for j, e in self.seen.items() if e + SKEW_S < now]:
            del self.seen[j]

    def full(self) -> bool:
        """Too many live jtis to remember another: refuse rather than forget one early."""
        self.prune()
        return len(self.seen) >= self.max_seen

    def check(self, ticket: str) -> str | None:
        """None when the ticket is good (and now spent); else why not. Never logs the ticket."""
        from cryptography.exceptions import InvalidSignature

        now = int(self.clock())
        if self.full():
            return "store full"
        if not ticket or len(ticket) > MAX_LEN:
            return "malformed"
        parts = ticket.split(".")
        if len(parts) != 2:
            return "malformed"
        try:
            sig = b64url_decode(parts[1])
            self.key.verify(sig, parts[0].encode("ascii"))
        except InvalidSignature:
            return "bad signature"
        except (ValueError, UnicodeEncodeError):
            return "malformed"
        try:
            p = json.loads(b64url_decode(parts[0]))
        except ValueError:
            return "malformed"
        if not isinstance(p, dict):
            return "malformed"
        if p.get("aud") != AUD:
            return "wrong aud"
        exp, iat, jti = p.get("exp"), p.get("iat"), p.get("jti")
        if not isinstance(exp, int) or not isinstance(iat, int) or not isinstance(jti, str) or not jti:
            return "malformed"
        if exp - iat > TTL_S or iat > now + SKEW_S:
            return "bad lifetime"
        if exp + SKEW_S < now:
            return "expired"
        if jti in self.seen:
            return "replayed"
        self.seen[jti] = exp
        return None


def offered(header: str | None) -> tuple[bool, str | None]:
    """From Sec-WebSocket-Protocol: was "lianki-stt" offered, and the ticket beside it (if any)."""
    names = [s.strip() for s in (header or "").split(",") if s.strip()]
    others = [n for n in names if n != SUBPROTOCOL]
    return SUBPROTOCOL in names, (others[0] if len(others) == 1 else None)
