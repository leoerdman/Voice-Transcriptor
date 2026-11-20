"""Shared HTTP request helpers for remote transcription providers.

Centralised retry logic with exponential backoff — used by both
``remote_openrouter`` and ``remote_deepgram`` modules.
"""

import datetime as _dt
import logging
import random
import time
from email.utils import parsedate_to_datetime
from typing import Optional, Tuple

import requests
from requests import RequestException
from requests.adapters import HTTPAdapter

logger = logging.getLogger(__name__)

# ── Why this module logs ────────────────────────────────────────────────
#
# Every remote transcription and upscale call passes through here, and
# none of it was recorded. A retry is invisible latency: a user whose
# upload took eight seconds because the provider returned 429 twice sees
# only that it was slow, and the support log agreed with them — it had
# nothing to say about why.
#
# Worse, the two paths that give up have real consequences the log never
# mentioned. A read timeout on a POST is abandoned deliberately, because
# the provider may already have done (and billed) the work; and a final
# failure after N attempts becomes a user-facing error whose history —
# how many attempts, how long, against which status — existed nowhere.
#
# Retries are logged at INFO (they are normal, and bounded). Giving up is
# WARNING, because that is what a support reader is looking for.


def _log_target(method: str, url: str) -> str:
    """``METHOD host/path`` — never the query string.

    Provider URLs carry API keys and signed parameters in the query for
    some endpoints. The host and path are what identify the call; the
    query is exactly the part that must not reach a log file.
    """
    verb = str(method or "GET").upper()
    if not isinstance(url, str) or not url:
        return verb
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(url)
        # ``urlsplit`` does not raise on nonsense — it returns empty
        # components — so an unusable result has to be recognised rather
        # than caught. A target with no host and no path is not a target.
        located = f"{parts.netloc}{parts.path}".strip()
        return f"{verb} {located}" if located else verb
    except Exception:
        return verb


def _close_quietly(resp: object) -> None:
    """Release a response nobody will read. Never raises."""
    try:
        close = getattr(resp, "close", None)
        if callable(close):
            close()
    except Exception as e:  # pragma: no cover - teardown is best-effort
        logger.debug("closing a superseded response failed: %s", e)


def _exponential_backoff(attempt: int, base: float) -> float:
    """Return the wait-time for retry attempt N with jitter.

    1.1.25: previous logic was ``base if attempt == 0 else base *
    (attempt + 1)`` which produced LINEAR backoff (base, 2·base,
    3·base, ...) despite the docstring promising exponential. Linear
    retries under sustained throttling continue hammering the
    provider; exponential gives the upstream time to recover.

    Adds 10% jitter so concurrent clients don't synchronise their
    retry waves into a thundering herd.
    """
    delay = base * (2 ** attempt)
    return delay + random.uniform(0, delay * 0.1)


class RemoteError(RuntimeError):
    """Raised when a remote API call fails irrecoverably."""
    pass


_SESSION = requests.Session()
# pool_maxsize=64 comfortably covers FastAPI's default 40-thread executor
# plus burst.
#
# pool_block=False (non-blocking overflow): when all 64 slots are in use
# a new request transparently opens a fresh short-lived connection
# rather than WAITING for a slot to free. The previous ``block=True``
# stance looked reasonable ("avoid TLS re-handshake overhead") but had
# a pathological failure mode: if a remote provider stalls (Deepgram
# cloud freeze, OpenRouter slow chunk, corporate proxy holding a
# read), each stalled call pins its pool slot for the full ``timeout``
# (60 s) while holding one of FastAPI's 40 executor threads. 64 stalled
# provider calls therefore FREEZE the whole backend threadpool — new
# requests for /api/health, /api/recordings etc. cannot schedule and
# users see the UI hang. The 100–300 ms TLS-handshake cost for overflow
# connections is orders of magnitude cheaper than the minute-long
# backend stall we trade it for, and in practice urllib3 does not emit
# warnings for non-blocking overflow.
_SESSION.mount("https://", HTTPAdapter(pool_connections=8, pool_maxsize=64, max_retries=0, pool_block=False))
_SESSION.mount("http://", HTTPAdapter(pool_connections=8, pool_maxsize=64, max_retries=0, pool_block=False))


# Max seconds we will honour from a Retry-After header before capping.
# A hostile or buggy upstream could otherwise stall a user request for
# hours with a malicious Retry-After value.
_RETRY_AFTER_CAP_SEC = 30.0


def _parse_retry_after(raw: Optional[str]) -> float:
    """Parse a ``Retry-After`` header to delta-seconds.

    RFC 7231 allows either an integer delta-seconds or an HTTP-date.
    Returns 0.0 for missing / unparseable values.
    """
    if not raw:
        return 0.0
    raw = raw.strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(raw)
        if dt is None:
            return 0.0
        now = _dt.datetime.now(dt.tzinfo) if dt.tzinfo else _dt.datetime.now()
        return max(0.0, (dt - now).total_seconds())
    except (TypeError, ValueError):
        return 0.0


# HTTP status codes that indicate a transient upstream condition where
# retrying after a short delay is the correct behaviour.  4xx codes are
# excluded — they are caller errors (bad API key, malformed body, etc.)
# that no amount of retry will fix.
_TRANSIENT_HTTP_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def request_with_retry(
    method: str,
    url: str,
    *,
    retries: int = 3,
    backoff_base: float = 0.3,
    timeout: Optional["Tuple[float, float] | float"] = 60.0,
    **kwargs,
) -> requests.Response:
    """Send an HTTP request with automatic retry on transient failures.

    Retries use exponential backoff: first retry at *backoff_base* seconds,
    subsequent retries multiply the backoff.  Retries fire on:

    * ``RequestException`` — transport-level failures (connection reset,
      DNS error, read timeout).
    * HTTP status codes in :data:`_TRANSIENT_HTTP_STATUS` (408, 425, 429,
      500, 502, 503, 504) — upstream indicated a transient condition.
      Deepgram cloud returns 502/503/504 during edge restarts, and
      OpenRouter returns 429/503 during provider throttling; failing
      without retry surfaces a hard error to the user when the next
      attempt would have succeeded.

    4xx codes other than 408/425/429 are returned as-is — they are caller
    errors (bad API key, malformed body, unsupported audio) that no
    amount of retry will fix.
    """
    last_err: Optional[Exception] = None
    last_resp: Optional[requests.Response] = None
    # A caller passing retries<=0 would skip the loop entirely and trip
    # the `assert last_resp is not None` below with an AssertionError —
    # an opaque HTTP 500 with no provider context. Treat it as "one
    # attempt, no retry", which is what such a caller means.
    attempts = max(1, int(retries or 0))
    # Idempotency gate (BUG-53): a read timeout on a POST means the
    # provider MAY have already processed (and billed) the request —
    # blind retrying double-charges the user. Non-idempotent methods
    # retry only on connect-phase failures, where the request provably
    # never reached the server; read timeouts are terminal for them.
    _http_method = str(method or "GET").upper()
    _idempotent = _http_method in {"GET", "HEAD", "OPTIONS", "PUT", "DELETE"}
    target = _log_target(method, url)
    started = time.monotonic()
    retried = 0
    for attempt in range(attempts):
        try:
            resp = _SESSION.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in _TRANSIENT_HTTP_STATUS and attempt < attempts - 1:
                if last_resp is not None:
                    # The previous transient response is superseded and
                    # will never be returned. With ``stream=True`` its
                    # body is unread, so it holds a connection-pool slot
                    # for the whole backoff.
                    _close_quietly(last_resp)
                last_resp = resp
                delay = _exponential_backoff(attempt, backoff_base)
                # Honour Retry-After per RFC 7231. Providers
                # (OpenRouter, Deepgram) emit this on 429/503 to signal
                # the correct wait time; ignoring it hammers the
                # provider, gets throttled harder, and reports a false
                # hard failure when 5 seconds would have recovered.
                ra_sec = _parse_retry_after(resp.headers.get("Retry-After"))
                honoured_retry_after = False
                if ra_sec > 0:
                    honoured = max(delay, min(ra_sec, _RETRY_AFTER_CAP_SEC))
                    honoured_retry_after = honoured > delay
                    delay = honoured
                retried += 1
                # Which of the two clocks won matters: our backoff is a
                # guess, Retry-After is the provider telling us the
                # answer. A run of Retry-After-driven waits is a rate
                # limit, not a flaky network, and they are fixed very
                # differently.
                logger.info(
                    "%s: HTTP %d, retrying in %.2fs (attempt %d/%d, source=%s)",
                    target, resp.status_code, delay, attempt + 1, attempts,
                    "retry-after" if honoured_retry_after else "backoff",
                )
                time.sleep(delay)
                continue
            if last_resp is not None and last_resp is not resp:
                # An earlier transient response this call will not return
                # (BM-24): released on every exit, not only when a newer
                # transient one replaces it.
                _close_quietly(last_resp)
                last_resp = None
            if retried:
                logger.info(
                    "%s: HTTP %d after %d retr%s in %.2fs",
                    target, resp.status_code, retried,
                    "y" if retried == 1 else "ies",
                    time.monotonic() - started,
                )
            return resp
        except RequestException as e:
            last_err = e
            if not _idempotent and isinstance(e, requests.ReadTimeout):
                # The request was sent and the response never came back:
                # the provider may have completed the work. Retrying a
                # paid transcription risks double billing — fail loudly
                # instead (BUG-53). ConnectTimeout is NOT here: it fires
                # before the request reaches the server, so a retry is
                # safe even for POST.
                #
                # Deliberately abandoned, and the user is about to see an
                # error for a request that may in fact have succeeded
                # upstream. That is worth a line of its own.
                logger.warning(
                    "%s: read timeout on a non-idempotent request after %.2fs — "
                    "not retrying, the provider may already have processed it",
                    target, time.monotonic() - started,
                )
                break
            if attempt == attempts - 1:
                break
            retry_delay = _exponential_backoff(attempt, backoff_base)
            retried += 1
            logger.info(
                "%s: %s, retrying in %.2fs (attempt %d/%d)",
                target, type(e).__name__, retry_delay, attempt + 1, attempts,
            )
            time.sleep(retry_delay)
    if last_err is not None:
        if last_resp is not None:
            _close_quietly(last_resp)
            last_resp = None
        # The end of the road: the user is about to see an error. Record
        # what it cost to get here, because "the upload failed" with no
        # history behind it is the report that cannot be diagnosed.
        logger.warning(
            "%s: giving up after %d attempt%s in %.2fs — %s: %s",
            target, retried + 1, "" if retried == 0 else "s",
            time.monotonic() - started,
            type(last_err).__name__, last_err,
        )
        # Translate common low-level error patterns into actionable
        # messages. The raw form the user previously saw —
        #   "network error after 3 attempts: ('Connection aborted.',
        #    TimeoutError('The write operation timed out'))"
        # — is unhelpful: it doesn't explain what to DO. Map the most
        # common patterns to a one-liner that names the likely cause
        # (slow upload, DNS unreachable, TLS issue) so the user can
        # decide between retry, smaller file, VPN, or local Whisper.
        err_text = str(last_err)
        err_lower = err_text.lower()
        hint = ""
        if (
            "write operation timed out" in err_lower
            or "writetimeout" in err_lower
            or ("connection aborted" in err_lower and "timed out" in err_lower)
        ):
            hint = (
                " — upload timed out. Audio file likely too large for the current "
                "upload speed; try a smaller file, a faster connection, or switch "
                'Provider to "local" in Settings.'
            )
        elif "name resolution" in err_lower or "nodename nor servname" in err_lower or "name or service not known" in err_lower:
            hint = (
                " — DNS could not resolve the provider's hostname. Check internet "
                "connection or DNS settings."
            )
        elif "ssl" in err_lower or "certificate" in err_lower or "tls" in err_lower:
            hint = (
                " — TLS handshake failed. Check system clock, corporate proxy, "
                "or antivirus that intercepts HTTPS."
            )
        elif "connection refused" in err_lower:
            hint = " — provider refused the connection (maintenance / region block)."
        elif "read timed out" in err_lower:
            hint = (
                " — provider took too long to respond. Retry, or switch Provider "
                'to "local" in Settings if the link is consistently slow.'
            )
        # ``retried + 1``, not the configured ceiling: the
        # non-idempotent read-timeout branch breaks out after ONE
        # attempt, and the log line above already prints the honest
        # number. Two different counts for one event, and the user saw
        # the wrong one.
        raise RemoteError(
            f"network error after {retried + 1} attempt"
            f"{'' if retried == 0 else 's'}: {err_text}{hint}"
        )
    # All attempts returned a transient HTTP status — return the last
    # response so the caller surfaces the exact upstream error.
    assert last_resp is not None
    return last_resp
