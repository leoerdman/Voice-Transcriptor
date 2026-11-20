"""Short-lived, single-recording capabilities for streaming audio (S-15).

Why this exists
---------------
History plays a recording through an ``<audio>`` element. A media element
issues its own requests (the first one, then a Range request on every
seek) and cannot send the ``X-API-Token`` header every other route
requires, so the renderer used to GET the whole file with the header and
play it from a Blob: an uploaded video's audio — hundreds of MB — held in
renderer memory before the first sample played, and again on every open.

Putting the API token in the ``src`` instead is not an option (BM-01): it
opens every route, and a URL is copied into places a header is not.

What it is
----------
One narrow capability, not a second auth system: a token that lets its
holder GET one recording's audio file, until an expiry minutes away. It is
minted only through an authenticated route (renderer token; the CLI token
cannot reach it — it is not on ``cli_access._CLI_ROUTES``) and accepted
only by the streaming audio route, which accepts nothing else.

    token = "v1." + expires_at + "." + b64url(HMAC-SHA256(secret, scope))
    scope = "v1\\n" + expires_at + "\\n" + <resolved absolute audio path>

* The secret is 32 random bytes made at process start and never stored, so
  every token dies with the backend process; there is nothing to revoke,
  rotate or persist.
* The scope is the RESOLVED file, not the request's spelling of it: the
  route resolves ``name`` + ``archive_dir`` exactly as the minting route
  did and the signature must match that path. A token for one recording
  opens no other recording, folder or route.
* Verification is constant-time (``hmac.compare_digest``) and the expiry is
  part of the signed scope, so it cannot be extended by editing the token.

Threat model
------------
In scope — where a URL travels that a header does not:
  * the access log: recording routes are logged without their query
    string (``_log_safe_access_path``), so the token never reaches
    ``main.log``;
  * the HTTP disk cache: the streaming route answers ``Cache-Control:
    no-store``;
  * anything that does capture the URL (a devtools HAR, a crash dump) gets
    read access to ONE recording's audio, for at most ``MEDIA_TOKEN_TTL_SEC``,
    and only while this backend process lives.
Out of scope — the token adds nothing here:
  * the renderer itself: it already holds the full API token;
  * another process running as the user: it can read the archive files
    directly.
The usual guards still apply to the route: the Host allowlist (DNS
rebinding), the per-client rate limit, and the archive path checks.

A seek after the expiry gets 401; the renderer mints a fresh URL and
resumes at the same position (``frontend/src/media-url.ts``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Callable

#: How long a minted URL opens its file. Long enough for the element's own
#: follow-up requests while a recording is being listened to; a seek after
#: it re-mints (see the module docstring).
MEDIA_TOKEN_TTL_SEC = 600

_VERSION = "v1"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class MediaTokens:
    """Mint and check single-file, expiring read capabilities."""

    def __init__(
        self,
        secret: bytes | None = None,
        ttl_sec: int = MEDIA_TOKEN_TTL_SEC,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if ttl_sec <= 0:
            raise ValueError("ttl_sec must be positive")
        self._secret = secret if secret is not None else secrets.token_bytes(32)
        if len(self._secret) < 32:
            raise ValueError("secret must be at least 32 bytes")
        self._ttl = int(ttl_sec)
        self._clock = clock

    def _signature(self, expires_at: int, scope: str) -> str:
        message = f"{_VERSION}\n{expires_at}\n{scope}".encode("utf-8", errors="surrogatepass")
        return _b64url(hmac.new(self._secret, message, hashlib.sha256).digest())

    def mint(self, scope: str) -> tuple[str, int]:
        """A token for *scope* (the resolved audio path) and its expiry (epoch s)."""
        if not scope:
            raise ValueError("empty scope")
        expires_at = int(self._clock()) + self._ttl
        return f"{_VERSION}.{expires_at}.{self._signature(expires_at, scope)}", expires_at

    def verify(self, token: str, scope: str) -> bool:
        """True when *token* was minted here for exactly *scope* and is unexpired."""
        if not token or not scope:
            return False
        parts = str(token).split(".")
        if len(parts) != 3 or parts[0] != _VERSION or not parts[1].isdigit():
            return False
        expires_at = int(parts[1])
        if expires_at < self._clock():
            return False
        # Never trust a token claiming more lifetime than this process grants.
        if expires_at > self._clock() + self._ttl + 1:
            return False
        expected = self._signature(expires_at, scope)
        return hmac.compare_digest(expected.encode("ascii"), parts[2].encode("ascii", errors="replace"))
