import unittest
import asyncio
import base64
import importlib
import io
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.live import LiveConfig, LiveSession

REPO_ROOT = Path(__file__).resolve().parents[2]
LIVE_DEFAULTS_FIXTURE_PATH = REPO_ROOT / "contracts" / "live-defaults.json"


class IsolatedBackendMainImportMixin:
    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp_data_dir = tempfile.TemporaryDirectory()
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp_data_dir.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp_data_dir.cleanup()


class WebSocketAuthTokenTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    def test_websocket_token_comes_from_subprotocol_not_query(self):
        token = "tok value/with unicode ью"
        encoded = base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii").rstrip("=")

        class FakeWebSocket:
            headers = {
                "sec-websocket-protocol": (
                    f"{self.main.WS_AUTH_SUBPROTOCOL}, "
                    f"{self.main.WS_AUTH_TOKEN_PREFIX}{encoded}"
                )
            }
            query_params = {"token": "query-token-must-not-win"}

        ws = FakeWebSocket()

        self.assertEqual(self.main._websocket_api_token(ws), token)
        self.assertEqual(
            self.main._websocket_accept_subprotocol(ws),
            self.main.WS_AUTH_SUBPROTOCOL,
        )

    def test_websocket_query_token_is_ignored(self):
        class FakeWebSocket:
            headers = {}
            query_params = {"token": self.main.API_TOKEN}

        self.assertEqual(self.main._websocket_api_token(FakeWebSocket()), "")

    def test_websocket_header_token_still_supports_non_browser_clients(self):
        class FakeWebSocket:
            headers = {"x-api-token": "header-token"}
            query_params = {}

        self.assertEqual(self.main._websocket_api_token(FakeWebSocket()), "header-token")

    def test_http_query_token_is_ignored(self):
        request = type("FakeRequest", (), {})()
        request.url = type("FakeURL", (), {"path": "/api/config"})()
        request.headers = {}
        request.query_params = {"token": self.main.API_TOKEN}
        request.method = "GET"
        request.client = type("FakeClient", (), {"host": "127.0.0.1"})()

        with self.assertRaises(self.main.HTTPException) as raised:
            asyncio.run(self.main._require_api_auth(request))

        self.assertEqual(raised.exception.status_code, 401)

    def test_http_header_token_authenticates(self):
        # The positive case, asserted rather than merely executed: the
        # test used to call the dependency and check nothing, so a
        # short-circuit before the comparison — or an accept of the
        # WRONG token — would have passed exactly the same way.
        def _request(token: str):
            request = type("FakeRequest", (), {})()
            request.url = type("FakeURL", (), {"path": "/api/config"})()
            request.headers = {"x-api-token": token}
            request.query_params = {}
            request.method = "GET"
            request.client = type("FakeClient", (), {"host": "127.0.0.1"})()
            request.state = type("FakeState", (), {})()
            return request

        self.assertIsNone(
            asyncio.run(self.main._require_api_auth(_request(self.main.API_TOKEN)))
        )

        with self.assertRaises(self.main.HTTPException) as raised:
            asyncio.run(
                self.main._require_api_auth(_request(self.main.API_TOKEN + "x"))
            )
        self.assertEqual(raised.exception.status_code, 401)

    def test_network_probe_requires_token_but_health_does_not(self):
        # Asserted where the rule LIVES — on the route declarations.
        # ``_require_api_auth`` also carried a path check exempting
        # /api/health, which was unreachable (that route declares no
        # dependency) and would have silently exempted the endpoint the
        # day someone added one (B-075). Testing that branch tested the
        # copy, not the rule.
        deps = {}
        for route in self.main.app.routes:
            path = getattr(route, "path", None)
            if path in ("/api/health", "/api/network"):
                deps[path] = [
                    dep.call for dep in route.dependant.dependencies
                ]
        self.assertIn(self.main._require_api_auth, deps["/api/network"])
        self.assertNotIn(self.main._require_api_auth, deps["/api/health"])

        # And the dependency itself refuses an unauthenticated request,
        # whatever path it is asked about.
        request = type("FakeRequest", (), {})()
        request.url = type("FakeURL", (), {"path": "/api/network"})()
        request.headers = {}
        request.query_params = {}
        request.method = "GET"
        request.client = type("FakeClient", (), {"host": "127.0.0.1"})()

        with self.assertRaises(self.main.HTTPException) as raised:
            asyncio.run(self.main._require_api_auth(request))

        self.assertEqual(raised.exception.status_code, 401)

    def test_health_exposes_upload_extension_ssot(self):
        payload = self.main.health()
        self.assertEqual(payload["max_upload_bytes"], self.main.MAX_UPLOAD_BYTES)
        self.assertIn("accepted_audio_exts", payload)
        self.assertIn("wav", payload["accepted_audio_exts"])
        self.assertIn("opus", payload["accepted_audio_exts"])
        self.assertIn("mp4", payload["accepted_audio_exts"])
        self.assertNotIn(".wav", payload["accepted_audio_exts"])
        self.assertEqual(payload["live_sample_rate_hz"], LIVE_SAMPLE_RATE_HZ)
        self.assertEqual(
            payload["model_catalog"],
            self.main.health_model_catalog(),
        )
        self.assertEqual(
            payload["runtime_limits"]["upload_queue_max_parallel"],
            self.main.jobs.max_workers,
        )

    def test_runtime_limits_publish_what_the_renderer_used_to_copy(self):
        # FU-13a/b, FG-10: the renderer reads these instead of its own 3,
        # 1 MiB and 13 s.
        from backend import remote_deepgram

        limits = self.main.health()["runtime_limits"]
        self.assertEqual(limits["upscale_custom_preset_limit"], self.main.UPSCALE_MAX_CUSTOM_PRESETS)
        self.assertEqual(limits["deepgram_small_audio_bytes"], remote_deepgram.DEEPGRAM_SMALL_AUDIO_BYTES)
        # The published read timeout is the one the client actually uses
        # for a small body.
        (_, read_timeout), _attempts = remote_deepgram._deepgram_http_policy(
            limits["deepgram_small_audio_bytes"]
        )
        self.assertEqual(limits["deepgram_small_audio_read_timeout_ms"], read_timeout * 1000)
        (_, bigger_read), _ = remote_deepgram._deepgram_http_policy(limits["deepgram_small_audio_bytes"] + 1)
        self.assertNotEqual(bigger_read, read_timeout)

    def test_frontend_bootstrap_uses_health_runtime_ssot(self):
        health_payload = self.main.health()
        bootstrap_payload = self.main._frontend_runtime_payload()

        for key in (
            "max_upload_bytes",
            "accepted_audio_exts",
            "live_sample_rate_hz",
            "model_catalog",
            "runtime_limits",
        ):
            self.assertEqual(bootstrap_payload[key], health_payload[key])

    def test_bootstrap_live_defaults_match_the_model_catalog_ssot(self):
        # B-027 / R-016: the renderer has no copy of these values left.
        # It reads them from the bootstrap payload, so the payload has to
        # actually be built from the same constants deepgram_dual.py
        # validates a stored preference against — otherwise Settings and
        # the live path could still disagree, just one hop further away.
        payload = self.main._frontend_runtime_payload()
        live_defaults = payload["live_defaults"]
        self.assertEqual(live_defaults["languages"], list(self.main.LIVE_LANGUAGE_OPTIONS))
        self.assertEqual(live_defaults["dual_stream"], self.main.DUAL_STREAM_DEFAULT)
        self.assertEqual(
            live_defaults["dual_secondary_language"],
            self.main.DUAL_SECONDARY_LANGUAGE_DEFAULT,
        )
        self.assertEqual(
            live_defaults["dual_secondary_languages"],
            list(self.main.DUAL_SECONDARY_LANGUAGE_OPTIONS),
        )
        self.assertEqual(live_defaults["keyterm_token_budget"], self.main.MAX_KEYTERM_TOKENS)
        # Every accepted extension has a MIME, and the map's key order —
        # ``audio_ext_to_mime`` is what the renderer inverts, first
        # extension wins on a shared MIME (S-04).
        self.assertEqual(
            set(payload["audio_ext_to_mime"].keys()),
            {ext.lstrip(".") for ext in self.main.ALLOWED_AUDIO_EXTS},
        )


class LiveRecoverySpoolWriterTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    """BW-13: the spool is written through a buffer (not one syscall per
    renderer frame on the event loop), and every reader that looks at the
    file while the session still holds it sees every accepted chunk."""

    def _open(self):
        from datetime import datetime

        self.main.LIVE_RECOVERY_DIR.mkdir(parents=True, exist_ok=True)
        recovery = self.main._open_live_recovery(
            session_id="bw13",
            started_at=datetime(2026, 11, 20, 12, 0, 0),
            provider="deepgram",
            model="nova-3",
            language="auto",
            archive_dir="",
            recording_collection="live",
        )
        self.addCleanup(lambda: recovery["pcm_file"].closed or recovery["pcm_file"].close())
        return recovery

    def test_small_frames_are_buffered_not_written_one_by_one(self):
        recovery = self._open()
        frame = b"\x01\x00" * 1600  # 100 ms of 16 kHz mono PCM16
        for _ in range(4):
            self.main._record_recovery_chunk(recovery, frame)
        self.assertEqual(recovery["bytes"], 4 * len(frame))
        self.assertLess(recovery["pcm_path"].stat().st_size, recovery["bytes"])

    def test_readers_during_the_session_see_every_accepted_chunk(self):
        recovery = self._open()
        frame = b"\x02\x00" * 1600
        for _ in range(3):
            self.main._record_recovery_chunk(recovery, frame)
        self.assertEqual(self.main._recovery_spool_bytes(recovery), frame * 3)
        self.assertAlmostEqual(
            self.main._recovery_spool_seconds(recovery),
            3 * len(frame) / float(self.main.LIVE_PCM_BYTES_PER_SEC),
        )
        self.assertFalse(recovery["had_error"])

    def test_finalize_lands_the_buffer_on_disk(self):
        recovery = self._open()
        frame = b"\x03\x00" * 16000  # 1 s, above the 1 s keep floor with the next
        self.main._record_recovery_chunk(recovery, frame)
        self.main._record_recovery_chunk(recovery, frame)
        self.main._finalize_live_recovery(recovery)
        self.assertEqual(recovery["pcm_path"].read_bytes(), frame * 2)


class EnvIntParserTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    """BE-22: one integer-env parser for the backend, shared by main."""

    def test_main_uses_the_shared_parser(self):
        from backend import transcribe

        self.assertIs(self.main._env_int, transcribe._env_int)

    def test_a_malformed_value_degrades_to_the_default(self):
        with mock.patch.dict(os.environ, {"TRANSCRIPTOR_TEST_INT": " 1h "}):
            self.assertEqual(self.main._env_int("TRANSCRIPTOR_TEST_INT", 7), 7)
        with mock.patch.dict(os.environ, {"TRANSCRIPTOR_TEST_INT": " 42 "}):
            self.assertEqual(self.main._env_int("TRANSCRIPTOR_TEST_INT", 7), 42)


class FrontendLiveDefaultsFixtureTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    """Produces the fixture ``frontend/tests/deepgram-dual.test.ts`` reads.

    Same pattern as ``backend/tests/test_live_envelope.py`` /
    ``contracts/live-final-envelope.json``: the fixture is written here,
    by the backend's own bootstrap payload builder, and committed. The
    frontend suite parses it rather than restating the defaults, so a
    changed default or a changed live-language list turns the frontend
    suite red instead of leaving it silently stale.

    Regenerate after an intentional change:

        UPDATE_CONTRACT_FIXTURES=1 python -m unittest \
            backend.tests.test_live.FrontendLiveDefaultsFixtureTests
    """

    def test_fixture_matches_the_bootstrap_payload(self):
        payload = self.main._frontend_runtime_payload()
        expected = {
            "languages": payload["live_defaults"]["languages"],
            "dual_stream": payload["live_defaults"]["dual_stream"],
            "dual_secondary_language": payload["live_defaults"]["dual_secondary_language"],
            "dual_secondary_languages": payload["live_defaults"]["dual_secondary_languages"],
            "keyterm_token_budget": payload["live_defaults"]["keyterm_token_budget"],
            "audio_ext_to_mime": payload["audio_ext_to_mime"],
        }
        if os.environ.get("UPDATE_CONTRACT_FIXTURES") == "1":
            LIVE_DEFAULTS_FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
            LIVE_DEFAULTS_FIXTURE_PATH.write_text(
                json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        self.assertTrue(
            LIVE_DEFAULTS_FIXTURE_PATH.exists(),
            f"{LIVE_DEFAULTS_FIXTURE_PATH} is missing — regenerate with "
            "UPDATE_CONTRACT_FIXTURES=1",
        )
        actual = json.loads(LIVE_DEFAULTS_FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            actual,
            expected,
            "contracts/live-defaults.json is stale. frontend/tests/"
            "deepgram-dual.test.ts parses this file, so regenerate it "
            "(UPDATE_CONTRACT_FIXTURES=1) and teach the renderer the new "
            "shape in the SAME commit.",
        )


class LiveSessionTailTests(unittest.IsolatedAsyncioTestCase):
    async def test_force_transcribe_bypasses_min_step_for_stop_tail(self):
        sr = LIVE_SAMPLE_RATE_HZ
        session = LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(
                sample_rate=sr,
                window_sec=8.0,
                min_step_sec=10.0,
                min_audio_sec=0.1,
            ),
        )
        await session.append_pcm16le(b"\x01\x00" * sr)

        calls = []

        def fake_transcribe(audio, *_args, **_kwargs):
            calls.append(audio.shape[0])
            return {
                "segments": [
                    {
                        "start": 0.0,
                        "end": audio.shape[0] / sr,
                        "text": "tail words",
                    }
                ]
            }

        with mock.patch("backend.live.transcribe_audio", side_effect=fake_transcribe):
            self.assertIsNone(await session.maybe_transcribe())

            forced = await session.maybe_transcribe(force=True)
            self.assertIsNotNone(forced)
            self.assertEqual(forced["segments"][0]["text"], "tail words")

            self.assertIsNone(await session.maybe_transcribe(force=True))

        self.assertEqual(calls, [sr])


class DeepgramLiveSessionTailTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    async def test_deepgram_upstream_close_keeps_receiving_tail_pcm_until_finalize(self):
        class FakeStats:
            bytes_sent = 0
            chunks_sent = 0
            segments_final = 1
            segments_interim = 0
            connect_ms = 1.0
            finalize_ms = 1.0

            def as_dict(self):
                return {}

        class FakeDeepgramSession:
            def __init__(self, *_args, **_kwargs):
                self.stats = FakeStats()
                self._closed = True
                self.last_error = "upstream closed early"
                self.last_fatal = False

            async def connect(self):
                return None

            async def send_pcm(self, _chunk):
                raise AssertionError("closed upstream must not receive PCM")

            async def events(self):
                if False:
                    yield {}
                return

            async def drain_transcript(self, on_budget=None):
                return {
                    "text": "partial",
                    "segments": [],
                    "durationSec": 0.0,
                    "stats": {},
                    "uncoveredSpeechSec": 0.0,
                    "streamedSec": 0.0,
                    "coveredEndSec": 0.0,
                }

            async def shutdown(self, wait_timeout=3.0):
                self._closed = True

            async def finalize(self, wait_timeout=3.0):
                result = await self.drain_transcript()
                await self.shutdown(wait_timeout=wait_timeout)
                return result

            def final_text(self):
                return "partial"

            async def close(self):
                self._closed = True

            @property
            def is_closed(self):
                return self._closed

        class FakeWebSocket:
            def __init__(self):
                self.messages: asyncio.Queue[dict] = asyncio.Queue()
                self.sent: list[dict] = []

            async def receive(self):
                return await self.messages.get()

            async def send_text(self, text):
                self.sent.append(json.loads(text))

        ws = FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(self.main, "DeepgramLiveSession", FakeDeepgramSession):
            task = asyncio.create_task(self.main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            await ws.messages.put({"type": "websocket.receive", "bytes": b"tail-pcm"})
            await ws.messages.put({"type": "websocket.receive", "text": json.dumps({"type": "finalize"})})
            await asyncio.wait_for(task, timeout=1.0)

        self.assertTrue(recovery["had_error"])
        self.assertEqual(recovery["bytes"], len(b"tail-pcm"))
        self.assertEqual(recovery["chunks"], 1)
        self.assertEqual(recovery["pcm_file"].getvalue(), b"tail-pcm")


class _FakeWebSocket:
    def __init__(self):
        self.messages: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list[dict] = []

    async def receive(self):
        return await self.messages.get()

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class _FakeStats:
    bytes_sent = 0
    chunks_sent = 0
    segments_final = 0
    segments_interim = 0
    connect_ms = None
    finalize_ms = None

    def as_dict(self):
        return {}


class DeepgramLivePreconnectBufferTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    """B2 (audit §3.7): frames that arrive while ``connect()`` is still
    in flight must reach the recovery spool even if connect() then
    fails — previously the receiver task did not exist yet, so a slow
    or failing connect (observed up to 12s) meant the spool held 0
    bytes for a session the user spoke real audio into.
    """

    async def test_frames_arriving_during_a_failed_connect_reach_the_recovery_spool(self):
        main = self.main
        release_connect = asyncio.Event()

        class FailingConnectSession:
            def __init__(self, *_a, **_kw):
                self.stats = _FakeStats()

            async def connect(self):
                # Simulates a slow connect: frames arrive on the wire
                # before this resolves, and here it resolves to failure.
                await release_connect.wait()
                raise main.DeepgramLiveError("simulated connect failure")

        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(main, "DeepgramLiveSession", FailingConnectSession):
            task = asyncio.create_task(main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            # Three frames land on the wire while connect() is still
            # pending. Before this fix nothing was reading them yet.
            await ws.messages.put({"type": "websocket.receive", "bytes": b"AAAA"})
            await ws.messages.put({"type": "websocket.receive", "bytes": b"BBBB"})
            await ws.messages.put({"type": "websocket.receive", "bytes": b"CCCC"})
            await asyncio.sleep(0.01)
            release_connect.set()
            # The upstream is dead but the microphone is not: the
            # handler keeps reading (and spooling) until the renderer
            # finalizes, because the envelope it will send is now the
            # only transcript this recording can get — the renderer's
            # own REST recovery is gone. Before that, this returned an
            # EMPTY envelope here while the user was still talking.
            await asyncio.sleep(0.05)
            self.assertFalse(task.done())
            await ws.messages.put({
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize"}),
            })
            await asyncio.wait_for(task, timeout=2.0)

        self.assertTrue(recovery["had_error"])
        self.assertEqual(recovery["bytes"], 12)
        self.assertEqual(recovery["chunks"], 3)
        self.assertEqual(recovery["pcm_file"].getvalue(), b"AAAABBBBCCCC")
        # The renderer still gets its error + final envelope. (This
        # spool has no path on disk, so the recovery pass finds no audio
        # to re-decode and the envelope is delivered unrepaired — the
        # recovery itself is covered end to end in
        # ``test_deepgram_recovery.LiveSessionRecoveryWiringTests``.)
        self.assertEqual([m["type"] for m in ws.sent], ["error", "final"])

    async def test_frames_buffered_during_connect_are_replayed_in_order_on_success(self):
        main = self.main
        release_connect = asyncio.Event()
        created_sessions: list["SlowConnectSession"] = []

        class SlowConnectSession:
            def __init__(self, *_a, **_kw):
                self.stats = _FakeStats()
                self.stats.segments_final = 1
                self._closed = False
                self.last_error = None
                self.last_fatal = False
                self.sent_pcm: list[bytes] = []
                created_sessions.append(self)

            async def connect(self):
                await release_connect.wait()

            async def send_pcm(self, chunk):
                self.sent_pcm.append(chunk)

            async def events(self):
                # A real session's events() only completes once close()
                # enqueues its sentinel. Returning immediately here (as
                # if Deepgram produced nothing at all and hung up) makes
                # the WS handler's ``asyncio.wait(..., FIRST_COMPLETED)``
                # treat the forwarder as "done first" and short-circuit
                # the whole session before the test can feed it any
                # frames — block instead, like the real thing does.
                await asyncio.Event().wait()
                if False:
                    yield {}

            async def drain_transcript(self, on_budget=None):
                if on_budget:
                    on_budget(0.05, False)
                return {
                    "text": "ok", "segments": [], "durationSec": 0.0,
                    "stats": {}, "uncoveredSpeechSec": 0.0,
                    "streamedSec": 0.0, "coveredEndSec": 0.0,
                }

            async def shutdown(self, wait_timeout=3.0):
                self._closed = True

            async def close(self):
                self._closed = True

            @property
            def is_closed(self):
                return self._closed

        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(main, "DeepgramLiveSession", SlowConnectSession):
            task = asyncio.create_task(main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.01)
            await ws.messages.put({"type": "websocket.receive", "bytes": b"AAAA"})
            await ws.messages.put({"type": "websocket.receive", "bytes": b"BBBB"})
            await asyncio.sleep(0.01)
            release_connect.set()
            await asyncio.sleep(0.01)
            await ws.messages.put({
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize"}),
            })
            await asyncio.wait_for(task, timeout=1.0)

        self.assertEqual(recovery["pcm_file"].getvalue(), b"AAAABBBB")
        self.assertEqual(len(created_sessions), 1)
        # Buffered-during-connect frames must reach Deepgram in the same
        # order the renderer sent them — replaying out of order would
        # shift every word timing that follows. The sender batches
        # frames into ~50 ms writes (audit §3.6), so what is pinned is
        # the byte stream, not the framing: a stream this short goes out
        # as one partial batch.
        self.assertEqual(b"".join(created_sessions[0].sent_pcm), b"AAAABBBB")


class DeepgramLiveFinalizeDrainTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    """C1/C2: the post-``finalize`` drain waits for the renderer's own
    frame/byte counts instead of always spending the full 250ms ceiling.
    """

    def _fake_session_class(self):
        class FakeSession:
            def __init__(self, *_a, **_kw):
                self.stats = _FakeStats()
                self.stats.segments_final = 1
                self._closed = False
                self.last_error = None
                self.last_fatal = False
                self.sent_pcm: list[bytes] = []

            async def connect(self):
                return None

            async def send_pcm(self, chunk):
                self.sent_pcm.append(chunk)

            async def events(self):
                # A real session's events() only completes once close()
                # enqueues its sentinel. Returning immediately here (as
                # if Deepgram produced nothing at all and hung up) makes
                # the WS handler's ``asyncio.wait(..., FIRST_COMPLETED)``
                # treat the forwarder as "done first" and short-circuit
                # the whole session before the test can feed it any
                # frames — block instead, like the real thing does.
                await asyncio.Event().wait()
                if False:
                    yield {}

            async def drain_transcript(self, on_budget=None):
                if on_budget:
                    on_budget(0.05, False)
                return {
                    "text": "ok", "segments": [], "durationSec": 0.0,
                    "stats": {}, "uncoveredSpeechSec": 0.0,
                    "streamedSec": 0.0, "coveredEndSec": 0.0,
                }

            async def shutdown(self, wait_timeout=3.0):
                self._closed = True

            async def close(self):
                self._closed = True

            @property
            def is_closed(self):
                return self._closed

        return FakeSession

    async def test_finalize_with_matched_counts_does_not_pay_the_full_ceiling(self):
        main = self.main
        FakeSession = self._fake_session_class()
        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        # Measured directly off the "finalize drain: ..." log line (C2)
        # rather than end-to-end task wall time: the task also pays a
        # fixed ~250ms forwarder-cleanup wait unrelated to the drain
        # itself (this fake session's events() blocks like a real idle
        # connection would), which would swamp a wall-clock assertion.
        with self.assertLogs("backend.main", level="INFO") as log_ctx:
            with mock.patch.object(main, "DeepgramLiveSession", FakeSession):
                task = asyncio.create_task(main._run_deepgram_live_session(
                    websocket=ws,
                    api_key="dg",
                    model="nova-3",
                    language="auto",
                    diarize=False,
                    recovery=recovery,
                ))
                await asyncio.sleep(0.005)
                await ws.messages.put({"type": "websocket.receive", "bytes": b"AAAA"})
                await ws.messages.put({"type": "websocket.receive", "bytes": b"BBBB"})
                await asyncio.sleep(0.02)
                # The renderer reports exactly what it already sent — the
                # backend has already received all of it, so the drain
                # must resolve immediately rather than waiting the 250ms
                # ceiling.
                await ws.messages.put({
                    "type": "websocket.receive",
                    "text": json.dumps({"type": "finalize", "framesSent": 2, "bytesSent": 8}),
                })
                await asyncio.wait_for(task, timeout=1.0)

        self.assertEqual(recovery["bytes"], 8)
        self.assertEqual(recovery["chunks"], 2)
        drain_lines = [m for m in log_ctx.output if "finalize drain:" in m]
        self.assertEqual(len(drain_lines), 1)
        match = re.search(r"matched after (\d+) ms", drain_lines[0])
        self.assertIsNotNone(match, drain_lines[0])
        self.assertLess(
            int(match.group(1)), 200,
            f"drain took too long despite counts already matching: {drain_lines[0]}",
        )

    async def test_finalize_waits_for_one_more_frame_the_counts_promise(self):
        main = self.main
        FakeSession = self._fake_session_class()
        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(main, "DeepgramLiveSession", FakeSession):
            task = asyncio.create_task(main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.005)
            await ws.messages.put({"type": "websocket.receive", "bytes": b"AAAA"})
            await asyncio.sleep(0.005)
            # finalize declares 2 frames/8 bytes total — one more frame
            # (e.g. the 200ms tail-hold) is still in flight.
            await ws.messages.put({
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize", "framesSent": 2, "bytesSent": 8}),
            })
            await asyncio.sleep(0.02)
            await ws.messages.put({"type": "websocket.receive", "bytes": b"BBBB"})
            await asyncio.wait_for(task, timeout=1.0)

        self.assertEqual(recovery["bytes"], 8)
        self.assertEqual(recovery["chunks"], 2)

    async def test_finalize_without_counts_keeps_the_old_timed_drain(self):
        """Backward compatibility: an older renderer's bare
        ``{"type":"finalize"}`` still gets the unconditional timed
        drain, unchanged."""
        main = self.main
        FakeSession = self._fake_session_class()
        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(main, "DeepgramLiveSession", FakeSession):
            task = asyncio.create_task(main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.005)
            started = time.perf_counter()
            await ws.messages.put({
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize"}),
            })
            await asyncio.wait_for(task, timeout=1.0)
            elapsed = time.perf_counter() - started

        # Read from the constant, not remembered as a literal: 0.24 was
        # ``_FINALIZE_DRAIN_CEILING_SEC`` minus a hair, so lowering the
        # ceiling would have failed this test for no reason and raising
        # it would have made the test assert nothing (B-040).
        self.assertGreaterEqual(
            elapsed, self.main._FINALIZE_DRAIN_CEILING_SEC - 0.01
        )


if __name__ == "__main__":
    unittest.main()
