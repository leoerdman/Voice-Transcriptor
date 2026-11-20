"""Every remote call passes through the retry helper, and none of it was
recorded.

A retry is invisible latency. A user whose upload took eight seconds
because the provider answered 429 twice sees only that it was slow, and
the support log agreed with them — it had nothing to say about why.

Two paths matter more than the rest. A read timeout on a POST is
abandoned deliberately, because the provider may already have done — and
billed — the work; and a final failure becomes a user-facing error whose
history (how many attempts, how long, against what) existed nowhere.

These tests pin the record, not the retry policy, which
``request_with_retry`` already owned and this change does not touch.
"""

import logging
import unittest
from unittest import mock

import requests

from backend.http_retry import RemoteError, _log_target, request_with_retry


class FakeResponse:
    def __init__(self, status_code: int, headers: dict | None = None):
        self.status_code = status_code
        self.headers = headers or {}
        self.text = ""


class LogTargetTests(unittest.TestCase):
    def test_target_is_method_host_and_path(self) -> None:
        self.assertEqual(
            _log_target("post", "https://api.deepgram.com/v1/listen"),
            "POST api.deepgram.com/v1/listen",
        )

    def test_the_query_string_never_reaches_the_log(self) -> None:
        # Provider URLs carry API keys and signed parameters in the
        # query on some endpoints. Host and path identify the call; the
        # query is exactly the part that must not land in a file.
        target = _log_target(
            "POST", "https://api.deepgram.com/v1/listen?model=nova-3&key=SECRET123"
        )
        self.assertNotIn("SECRET123", target)
        self.assertNotIn("?", target)
        self.assertEqual(target, "POST api.deepgram.com/v1/listen")

    def test_a_malformed_url_degrades_to_the_method(self) -> None:
        # Logging must never be able to fail the request it observes.
        self.assertEqual(_log_target("GET", None), "GET")


class RetryLoggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._sleep = mock.patch("backend.http_retry.time.sleep").start()
        self.addCleanup(mock.patch.stopall)

    def test_a_transient_status_retry_is_recorded(self) -> None:
        responses = [FakeResponse(503), FakeResponse(200)]
        with mock.patch(
            "backend.http_retry._SESSION.request", side_effect=responses
        ), self.assertLogs("backend.http_retry", level="INFO") as captured:
            resp = request_with_retry("GET", "https://x.test/v1/a", attempts=3)
        self.assertEqual(resp.status_code, 200)
        joined = "\n".join(captured.output)
        self.assertIn("HTTP 503, retrying", joined)
        self.assertIn("source=backoff", joined)
        # And the eventual success reports what it cost.
        self.assertIn("HTTP 200 after 1 retry", joined)

    def test_retry_after_is_distinguished_from_our_own_backoff(self) -> None:
        # Which clock won matters: backoff is our guess, Retry-After is
        # the provider stating the answer. A run of Retry-After waits is
        # a rate limit, not a flaky network, and they are fixed very
        # differently.
        responses = [FakeResponse(429, {"Retry-After": "5"}), FakeResponse(200)]
        with mock.patch(
            "backend.http_retry._SESSION.request", side_effect=responses
        ), self.assertLogs("backend.http_retry", level="INFO") as captured:
            request_with_retry("GET", "https://x.test/v1/a", attempts=3)
        joined = "\n".join(captured.output)
        self.assertIn("source=retry-after", joined)
        self.assertIn("HTTP 429", joined)

    def test_a_transport_failure_retry_names_the_exception(self) -> None:
        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=[requests.ConnectionError("reset"), FakeResponse(200)],
        ), self.assertLogs("backend.http_retry", level="INFO") as captured:
            request_with_retry("GET", "https://x.test/v1/a", attempts=3)
        self.assertIn("ConnectionError, retrying", "\n".join(captured.output))

    def test_a_clean_first_attempt_logs_nothing(self) -> None:
        # The overwhelmingly common case must stay silent, or the record
        # becomes the noise it was meant to cut through.
        logger = logging.getLogger("backend.http_retry")
        with mock.patch(
            "backend.http_retry._SESSION.request", return_value=FakeResponse(200)
        ), self.assertNoLogs(logger, level="INFO"):
            request_with_retry("GET", "https://x.test/v1/a", attempts=3)

    def test_a_caller_error_is_returned_without_a_retry_record(self) -> None:
        # 401 is a bad key: no amount of retry fixes it, and it is the
        # caller's line to log, not ours.
        logger = logging.getLogger("backend.http_retry")
        with mock.patch(
            "backend.http_retry._SESSION.request", return_value=FakeResponse(401)
        ), self.assertNoLogs(logger, level="INFO"):
            resp = request_with_retry("POST", "https://x.test/v1/a", attempts=3)
        self.assertEqual(resp.status_code, 401)


class GivingUpTests(unittest.TestCase):
    def setUp(self) -> None:
        mock.patch("backend.http_retry.time.sleep").start()
        self.addCleanup(mock.patch.stopall)

    def test_a_non_idempotent_read_timeout_warns_that_it_may_have_billed(self) -> None:
        # The request was sent and the answer never came. Retrying a paid
        # transcription risks double billing, so it is abandoned — and
        # the user is about to see an error for work that may in fact
        # have succeeded upstream.
        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=requests.ReadTimeout("no answer"),
        ), self.assertLogs("backend.http_retry", level="WARNING") as captured:
            with self.assertRaises(RemoteError):
                request_with_retry("POST", "https://x.test/v1/listen", attempts=3)
        joined = "\n".join(captured.output)
        self.assertIn("read timeout on a non-idempotent request", joined)
        self.assertIn("may already have processed", joined)

    def test_an_idempotent_read_timeout_still_retries(self) -> None:
        # GET is safe to repeat, so the abort above must not apply to it.
        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=[requests.ReadTimeout("slow"), FakeResponse(200)],
        ):
            resp = request_with_retry("GET", "https://x.test/v1/a", attempts=3)
        self.assertEqual(resp.status_code, 200)

    def test_the_final_failure_records_attempts_and_elapsed(self) -> None:
        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=requests.ConnectionError("down"),
        ), self.assertLogs("backend.http_retry", level="WARNING") as captured:
            with self.assertRaises(RemoteError):
                request_with_retry("GET", "https://x.test/v1/a", attempts=3)
        joined = "\n".join(captured.output)
        self.assertIn("giving up after 3 attempts", joined)
        self.assertIn("ConnectionError", joined)


class SupersededResponseIsReleasedTests(unittest.TestCase):
    """BM-24: a transient response the call will not return holds a pool
    slot (``stream=True`` leaves its body unread) until it is closed."""

    def setUp(self) -> None:
        mock.patch("backend.http_retry.time.sleep").start()
        self.addCleanup(mock.patch.stopall)

    def _closable(self, status: int) -> FakeResponse:
        resp = FakeResponse(status)
        resp.close = mock.Mock()
        return resp

    def test_closed_when_a_later_attempt_succeeds(self) -> None:
        transient, ok = self._closable(503), self._closable(200)
        with mock.patch("backend.http_retry._SESSION.request", side_effect=[transient, ok]):
            self.assertIs(request_with_retry("GET", "https://x.test/a", attempts=3), ok)
        transient.close.assert_called_once()
        ok.close.assert_not_called()

    def test_closed_when_the_call_gives_up_on_a_transport_error(self) -> None:
        transient = self._closable(503)
        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=[transient, requests.ConnectionError("down"), requests.ConnectionError("down")],
        ):
            with self.assertRaises(RemoteError):
                request_with_retry("GET", "https://x.test/a", attempts=3)
        transient.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
