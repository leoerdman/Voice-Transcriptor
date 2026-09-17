"""The command-line client: what it sends, what it prints, what it exits with.

``backend/cli.py`` is the only part of this app that runs inside someone
else's shell script, so its contract is not a UI but three observable
things: the JSON it puts on the wire, the bytes it puts on stdout, and
the exit code. Each is pinned here.

The wire half runs against a stub HTTP server rather than a mocked
``_request``, because the mistakes worth catching live in the layer a
mock removes: the header the token travels in, the route a given engine
posts to, and the shape of the body. A stub that answers only what the
real backend answers catches all three.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from backend import cli


# ── a stub of the backend, answering only what the client asks ──────


class _StubState:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict, dict]] = []
        self.defaults = {
            "engine": "local",
            "model": "small",
            "language": "auto",
            "diarize": False,
            "engines": ["local", "openrouter", "deepgram"],
            "local_models": ["small", "medium", "large-v3"],
        }
        self.job = {
            "job_id": "job-1",
            "status": "done",
            "progress": 1.0,
            "error": None,
            "result": {"text": "hello from the app", "segments": [{"text": "hello"}]},
            "result_files": {"txt": "/tmp/job-1.txt", "json": "/tmp/job-1.json"},
        }
        self.statuses: list[dict] = []
        self.token = "cli-token"


class _StubHandler(BaseHTTPRequestHandler):
    state: _StubState

    def log_message(self, *args):  # keep the suite's output clean
        pass

    def _record(self, body: dict) -> None:
        # Lower-cased: urllib title-cases what it puts on the wire
        # ("X-api-token"), and the header NAME is part of the contract
        # being pinned — a dict that remembers the casing would let a
        # rename pass here and 401 against the real backend.
        headers = {k.lower(): v for k, v in self.headers.items()}
        self.state.requests.append((self.command, self.path, headers, body))

    def _send(self, status: int, payload, *, raw: bytes = b"") -> None:
        data = raw if raw else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        return self.headers.get("x-api-token") == self.state.token

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's own naming
        self._record({})
        if not self._authorized():
            return self._send(401, {"detail": "unauthorized"})
        if self.path == "/api/cli":
            return self._send(200, {"enabled": True, "defaults": self.state.defaults})
        if self.path.startswith("/api/jobs/") and self.path.endswith("/download/txt"):
            return self._send(200, None, raw=b"hello from the file")
        if self.path.startswith("/api/jobs/"):
            job = self.state.statuses.pop(0) if self.state.statuses else self.state.job
            return self._send(200, job)
        return self._send(404, {"detail": "not found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        self._record(body)
        if not self._authorized():
            return self._send(401, {"detail": "unauthorized"})
        if self.path in ("/api/jobs/from-path", "/api/remote/jobs/from-path"):
            return self._send(200, {"job_id": "job-1", "audio_source_path": "/snap/job-1.wav"})
        if self.path == "/api/jobs/job-1/cancel":
            return self._send(200, {"job_id": "job-1", "status": "cancelled"})
        if self.path == "/api/recordings/save-from-path":
            return self._send(200, {"ok": True, "name": "hello.txt"})
        return self._send(404, {"detail": "not found"})


class _CapturedStdout(io.TextIOBase):
    """Stdout with a byte ``.buffer``, which ``io.TextIOWrapper`` will not lend."""

    def __init__(self) -> None:
        super().__init__()
        self.buffer = io.BytesIO()

    def write(self, text: str) -> int:
        self.buffer.write(text.encode("utf-8"))
        return len(text)

    def text(self) -> str:
        return self.buffer.getvalue().decode("utf-8")


class _StubBackend:
    """A real socket on loopback — the client's urllib path is under test."""

    def __init__(self) -> None:
        self.state = _StubState()
        handler = type("Handler", (_StubHandler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        # 50 ms, not the 500 ms default: ``shutdown`` waits out one poll
        # interval, and a server started and stopped per test turns that
        # default into ten seconds of suite time doing nothing.
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def bodies(self, method: str, path: str) -> list[dict]:
        return [body for m, p, _h, body in self.state.requests if m == method and p == path]


class _Args:
    """A parsed command line, without going through argparse."""

    def __init__(self, **kwargs) -> None:
        defaults = {
            "file": "", "job_id": "job-1", "connection": "", "base_url": "", "token": "",
            "out": "", "json": False, "quiet": True, "language": "", "engine": "",
            "model": "", "diarize": None, "speakers": "", "no_split_stereo": False,
            "word_timestamps": False, "timeout": 0.0, "save": False, "title": "",
            "wait": False,
        }
        defaults.update(kwargs)
        for key, value in defaults.items():
            setattr(self, key, value)


# ── connection ──────────────────────────────────────────────────────


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_says_where_to_switch_it_on(self):
        with self.assertRaises(cli.CliError) as caught:
            cli.load_connection(str(self.dir / "nothing.json"))
        self.assertEqual(caught.exception.code, cli.EXIT_UNREACHABLE)
        self.assertIn("Settings", str(caught.exception))

    def test_reads_base_url_and_token(self):
        path = self.dir / "connection.json"
        path.write_text(json.dumps({"base_url": "http://127.0.0.1:8321/", "token": "t"}))
        conn = cli.load_connection(str(path))
        # Trailing slash trimmed once, here, so no route has to think about it.
        self.assertEqual(conn.base_url, "http://127.0.0.1:8321")
        self.assertEqual(conn.token, "t")

    def test_broken_and_incomplete_files_are_named_as_such(self):
        path = self.dir / "connection.json"
        path.write_text("{not json")
        with self.assertRaises(cli.CliError) as caught:
            cli.load_connection(str(path))
        self.assertEqual(caught.exception.code, cli.EXIT_UNREACHABLE)

        path.write_text(json.dumps({"base_url": "http://127.0.0.1:8321"}))
        with self.assertRaises(cli.CliError) as caught:
            cli.load_connection(str(path))
        self.assertIn("incomplete", str(caught.exception))

    def test_explicit_flags_do_not_read_the_file_at_all(self):
        conn = cli.load_connection(str(self.dir / "nothing.json"), "http://host:1", "tok")
        self.assertEqual(conn.base_url, "http://host:1")
        self.assertEqual(conn.token, "tok")


# ── options ─────────────────────────────────────────────────────────


class JobOptionTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            "defaults": {
                "engine": "deepgram",
                "model": "nova-3",
                "language": "ru",
                "diarize": True,
                "engines": ["local", "openrouter", "deepgram"],
            }
        }

    def test_a_bare_command_inherits_the_app(self):
        got = cli.resolve_job_options(_Args(), self.settings)
        self.assertEqual(got, {"engine": "deepgram", "model": "nova-3",
                               "language": "ru", "diarize": True})

    def test_the_command_wins_over_the_app(self):
        got = cli.resolve_job_options(
            _Args(engine="local", model="medium", language="en", diarize=False), self.settings
        )
        self.assertEqual(got, {"engine": "local", "model": "medium",
                               "language": "en", "diarize": False})

    def test_switching_engine_does_not_carry_the_other_engine_s_model(self):
        # "nova-3" means nothing to Whisper; inheriting it would produce a
        # 400 the user never asked for. Empty lets the backend default.
        got = cli.resolve_job_options(_Args(engine="local"), self.settings)
        self.assertEqual(got["model"], "")

    def test_an_unknown_engine_is_a_usage_error(self):
        with self.assertRaises(cli.CliError) as caught:
            cli.resolve_job_options(_Args(engine="whisper.cpp"), self.settings)
        self.assertEqual(caught.exception.code, cli.EXIT_USAGE)
        self.assertIn("deepgram", str(caught.exception))

    def test_no_defaults_from_the_app_still_yields_something_runnable(self):
        got = cli.resolve_job_options(_Args(), {})
        self.assertEqual(got, {"engine": "local", "model": "", "language": "auto",
                               "diarize": False})


class SourcePathTests(unittest.TestCase):
    def test_a_missing_file_never_becomes_a_request(self):
        with self.assertRaises(cli.CliError) as caught:
            cli.resolve_source_path("/no/such/file.mp4")
        self.assertEqual(caught.exception.code, cli.EXIT_USAGE)
        self.assertIn("no such file", str(caught.exception))

    def test_a_relative_path_is_made_absolute(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.wav"
            path.write_bytes(b"x")
            resolved = cli.resolve_source_path(str(path))
            self.assertTrue(Path(resolved).is_absolute())
            self.assertEqual(Path(resolved).name, "clip.wav")

    def test_a_directory_is_not_a_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(cli.CliError):
                cli.resolve_source_path(tmp)


# ── the wire ────────────────────────────────────────────────────────


class WireTests(unittest.TestCase):
    def setUp(self):
        self.backend = _StubBackend()
        self.addCleanup(self.backend.close)
        self.conn = cli.Connection(self.backend.base_url, "cli-token", "test")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.media = self.dir / "talk.mp4"
        self.media.write_bytes(b"not really a video")

    def _run(self, handler, args) -> tuple[int, str]:
        # ``cli.emit`` writes the transcript as bytes through
        # ``sys.stdout.buffer`` (the text goes out exactly as the app
        # produced it, whatever the shell's locale claims), so the
        # capture needs a stdout with a real byte sink behind it.
        capture = _CapturedStdout()
        with redirect_stdout(capture), redirect_stderr(io.StringIO()):
            code = handler(self.conn, args)
        return code, capture.text()

    def test_the_token_travels_in_the_x_api_token_header(self):
        cli.fetch_settings(self.conn)
        _method, _path, headers, _body = self.backend.state.requests[-1]
        self.assertEqual(headers.get("x-api-token"), "cli-token")

    def test_a_rejected_token_says_how_to_fix_it(self):
        conn = cli.Connection(self.backend.base_url, "stale", "test")
        with self.assertRaises(cli.CliError) as caught:
            cli.fetch_settings(conn)
        self.assertEqual(caught.exception.code, cli.EXIT_UNREACHABLE)
        self.assertIn("Command line", str(caught.exception))

    def test_an_app_that_is_not_running_is_named_as_such(self):
        self.backend.close()
        with self.assertRaises(cli.CliError) as caught:
            cli.fetch_settings(self.conn)
        self.assertEqual(caught.exception.code, cli.EXIT_UNREACHABLE)
        self.assertIn("cannot reach", str(caught.exception))

    def test_local_engine_posts_the_local_route(self):
        code, out = self._run(cli.cmd_transcribe, _Args(file=str(self.media), engine="local",
                                                        model="medium", language="en"))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out, "hello from the app\n")
        body = self.backend.bodies("POST", "/api/jobs/from-path")[0]
        self.assertEqual(body["model"], "medium")
        self.assertEqual(body["language"], "en")
        self.assertEqual(body["source_path"], str(self.media.resolve()))
        self.assertTrue(body["split_stereo"])
        self.assertFalse(self.backend.bodies("POST", "/api/remote/jobs/from-path"))

    def test_remote_engine_posts_the_remote_route_with_the_provider(self):
        code, _out = self._run(
            cli.cmd_transcribe,
            _Args(file=str(self.media), engine="deepgram", model="nova-3", diarize=True,
                  speakers="2"),
        )
        self.assertEqual(code, cli.EXIT_OK)
        body = self.backend.bodies("POST", "/api/remote/jobs/from-path")[0]
        self.assertEqual(body["provider"], "deepgram")
        self.assertEqual(body["model"], "nova-3")
        self.assertTrue(body["diarize"])
        self.assertEqual(body["num_speakers"], "2")

    def test_json_output_carries_the_whole_result(self):
        code, out = self._run(cli.cmd_transcribe, _Args(file=str(self.media), json=True))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(json.loads(out)["segments"][0]["text"], "hello")

    def test_out_writes_a_file_and_leaves_stdout_empty(self):
        target = self.dir / "nested" / "talk.txt"
        code, out = self._run(cli.cmd_transcribe,
                              _Args(file=str(self.media), out=str(target)))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out, "")
        self.assertEqual(target.read_text(encoding="utf-8"), "hello from the app")

    def test_save_consumes_the_snapshot_the_backend_already_made(self):
        code, _out = self._run(cli.cmd_transcribe,
                               _Args(file=str(self.media), save=True, title="Standup"))
        self.assertEqual(code, cli.EXIT_OK)
        body = self.backend.bodies("POST", "/api/recordings/save-from-path")[0]
        self.assertEqual(body["source_path"], "/snap/job-1.wav")
        self.assertEqual(body["title"], "Standup")
        self.assertEqual(body["transcript_text"], "hello from the app")
        self.assertTrue(body["consume_source_path"])

    def test_a_failed_save_does_not_fail_a_delivered_transcript(self):
        self.backend.state.requests.clear()
        with mock.patch.object(cli, "_request", side_effect=cli.CliError("archive is full")), \
                redirect_stderr(io.StringIO()):
            saved = cli.save_to_archive(
                self.conn, {"audio_source_path": "/snap/job-1.wav"},
                {"engine": "local", "model": "small", "language": "auto"},
                {"text": "t"}, _Args(file=str(self.media), title="x"),
            )
        self.assertEqual(saved, "")

    def test_a_failed_job_exits_one_with_the_reason(self):
        self.backend.state.job = {"job_id": "job-1", "status": "error", "progress": 0.4,
                                  "error": "ffmpeg could not read the file", "result": None}
        with self.assertRaises(cli.CliError) as caught:
            self._run(cli.cmd_transcribe, _Args(file=str(self.media)))
        self.assertEqual(caught.exception.code, cli.EXIT_FAILED)
        self.assertIn("ffmpeg", str(caught.exception))

    def test_a_cancelled_job_has_its_own_exit_code(self):
        self.backend.state.job = {"job_id": "job-1", "status": "cancelled", "progress": 0.2,
                                  "error": None, "result": None}
        with self.assertRaises(cli.CliError) as caught:
            self._run(cli.cmd_transcribe, _Args(file=str(self.media)))
        self.assertEqual(caught.exception.code, cli.EXIT_CANCELLED)

    def test_waiting_polls_until_the_job_finishes(self):
        self.backend.state.statuses = [
            {"job_id": "job-1", "status": "queued", "progress": 0.0},
            {"job_id": "job-1", "status": "running", "progress": 0.5},
        ]
        seen: list[tuple[str, float]] = []
        with mock.patch.object(cli.time, "sleep"):
            job = cli.wait_for_job(self.conn, "job-1", on_progress=lambda s, p: seen.append((s, p)))
        self.assertEqual(job["status"], "done")
        self.assertEqual([s for s, _p in seen], ["queued", "running", "done"])

    def test_a_wait_timeout_leaves_the_job_running_and_says_how_to_return(self):
        self.backend.state.job = {"job_id": "job-1", "status": "running", "progress": 0.5}
        with mock.patch.object(cli.time, "sleep"):
            with self.assertRaises(cli.CliError) as caught:
                cli.wait_for_job(self.conn, "job-1", timeout=0.001)
        self.assertIn("result job-1", str(caught.exception))
        # It must NOT have cancelled the work on the caller's impatience.
        self.assertFalse(self.backend.bodies("POST", "/api/jobs/job-1/cancel"))

    def test_ctrl_c_while_waiting_cancels_the_job(self):
        with mock.patch.object(cli, "wait_for_job", side_effect=KeyboardInterrupt):
            code, _out = self._run(cli.cmd_transcribe, _Args(file=str(self.media)))
        self.assertEqual(code, cli.EXIT_INTERRUPTED)
        self.assertTrue(self.backend.bodies("POST", "/api/jobs/job-1/cancel"))

    def test_submit_prints_only_the_job_id(self):
        code, out = self._run(cli.cmd_submit, _Args(file=str(self.media)))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out, "job-1\n")

    def test_result_returns_the_file_the_app_wrote(self):
        code, out = self._run(cli.cmd_result, _Args(job_id="job-1"))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out, "hello from the file\n")

    def test_result_falls_back_to_the_job_when_the_file_is_gone(self):
        # Results are swept on a retention timer; a job whose text the app
        # still holds must not answer "file not found".
        original = cli._request

        def _no_file(conn, method, path, payload=None, **kwargs):
            if path.endswith("/download/txt"):
                raise cli.CliError("not found (404)", cli.EXIT_FAILED)
            return original(conn, method, path, payload, **kwargs)

        with mock.patch.object(cli, "_request", _no_file):
            code, out = self._run(cli.cmd_result, _Args(job_id="job-1"))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out, "hello from the app\n")

    def test_status_prints_one_readable_line(self):
        self.backend.state.job = {"job_id": "job-1", "status": "running", "progress": 0.42}
        code, out = self._run(cli.cmd_status, _Args(job_id="job-1"))
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(out.strip(), "running 42%")

    def test_info_names_the_app_and_its_defaults(self):
        code, out = self._run(cli.cmd_info, _Args())
        self.assertEqual(code, cli.EXIT_OK)
        self.assertIn(self.backend.base_url, out)
        self.assertIn("small", out)


# ── the process boundary ────────────────────────────────────────────


class ProcessTests(unittest.TestCase):
    def test_no_command_is_a_usage_exit(self):
        with mock.patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(cli.main([]), cli.EXIT_USAGE)

    def test_an_unreachable_app_exits_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(sys, "stderr", io.StringIO()) as err:
                code = cli.main(["info", "--connection", str(Path(tmp) / "none.json")])
        self.assertEqual(code, cli.EXIT_UNREACHABLE)
        self.assertIn("command-line access is off", err.getvalue())

    def test_progress_writes_nothing_into_a_pipe(self):
        stream = io.StringIO()  # not a tty
        with mock.patch.object(sys, "stderr", stream):
            progress = cli.Progress(True)
            progress("running", 0.5)
            progress.done()
        self.assertEqual(stream.getvalue(), "")

    def test_the_parser_offers_every_documented_command(self):
        parser = cli.build_parser()
        for command in ("transcribe", "submit", "status", "result", "cancel", "info"):
            args = parser.parse_args([command] + (["x"] if command != "info" else []))
            self.assertTrue(callable(args.handler), command)


if __name__ == "__main__":
    unittest.main()
