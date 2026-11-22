"""What the live engine writes to main.log (Ultra-Audit 2026-11-20).

main.log is a plain file users attach to support requests. It used to
hold what they dictated, verbatim (BL-02); an 850-byte parameter line with
their personal vocabulary on every connection (BL-07); two parallel
readings that could not be told apart (BL-08); and the pool's own idle
retirements logged as Deepgram outages (BL-05). Pinned here.
"""

from __future__ import annotations

import asyncio
import unittest

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

import backend.remote_deepgram_live as rdl
from backend.remote_deepgram_live import DeepgramLiveConfig, DeepgramLiveSession

SECRET_WORDS = "секретная диктовка пользователя"


def _final(start: float, end: float, text: str) -> dict:
    words = text.split()
    step = (end - start) / len(words)
    return {
        "type": "Results",
        "is_final": True,
        "speech_final": True,
        "start": start,
        "duration": end - start,
        "channel": {
            "alternatives": [
                {
                    "transcript": text,
                    "words": [
                        {"word": w, "start": start + i * step, "end": start + (i + 1) * step}
                        for i, w in enumerate(words)
                    ],
                }
            ]
        },
    }


class DictatedTextNeverReachesTheLogTests(unittest.TestCase):
    def test_a_final_is_logged_by_its_size_and_tagged_with_its_reading(self):
        session = DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language="ru"))
        with self.assertLogs("backend.remote_deepgram_live", level="DEBUG") as logs:
            session._process_deepgram_message(_final(0.0, 1.5, SECRET_WORDS))
        line = next(m for m in logs.output if "is_final" in m)
        for word in SECRET_WORDS.split():
            self.assertNotIn(word, line)
        self.assertIn("textLen=%d" % len(SECRET_WORDS), line)
        self.assertIn("words=3", line)
        self.assertIn("[ru] ", line)

    def test_the_multilingual_reading_is_tagged_multi(self):
        session = DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language="auto"))
        with self.assertLogs("backend.remote_deepgram_live", level="DEBUG") as logs:
            session._process_deepgram_message(_final(0.0, 1.0, "hello there"))
        self.assertTrue(all("[multi] " in m for m in logs.output), logs.output)

    def test_per_segment_traces_stay_out_of_the_info_journal(self):
        # One line per Deepgram final and per sampled interim, per reading,
        # was ~24% of main.log; the session summary carries their counts.
        session = DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language="ru"))
        interim = _final(0.0, 1.0, "hello there")
        interim["is_final"] = False
        interim["speech_final"] = False
        with self.assertNoLogs("backend.remote_deepgram_live", level="INFO"):
            session._process_deepgram_message(interim)
            session._process_deepgram_message(_final(0.0, 1.5, SECRET_WORDS))


class ParamsLineTests(unittest.TestCase):
    def setUp(self):
        rdl._PARAMS_LOGGED.clear()

    def test_the_full_line_is_written_once_per_configuration_without_keyterms(self):
        cfg = DeepgramLiveConfig(language="ru", keyterms=("Sonnet", "single source of truth"))
        log = rdl._StreamLog(rdl.logger, {"stream": "ru"})
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            rdl._log_params_once(log, cfg)
            rdl._log_params_once(log, cfg)
        self.assertEqual(len(logs.output), 2)
        first, second = logs.output
        self.assertIn("language=ru", first)
        self.assertIn("keyterms=2", first)
        for line in logs.output:
            self.assertNotIn("Sonnet", line)
            self.assertNotIn("single", line)
        digest = first.split("params=#", 1)[1][:8]
        self.assertTrue(second.endswith("params=#" + digest), second)
        self.assertLess(len(second), 100)


class _ClosingSocket:
    """A socket whose receive loop ends with the close code Deepgram sends."""

    def __init__(self, code: int, reason: str) -> None:
        self._exc = ConnectionClosedError(Close(code, reason), None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise self._exc


class RetiredSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_socket_retired_on_purpose_is_not_logged_as_an_upstream_close(self):
        session = DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language="ru"))
        session._ws = _ClosingSocket(1011, "Deepgram did not receive audio data")
        session._discarded = True
        with self.assertLogs("backend.remote_deepgram_live", level="DEBUG") as logs:
            await session._recv_loop()
        self.assertFalse(
            [m for m in logs.output if m.startswith("INFO") or m.startswith("WARNING")],
            logs.output,
        )
        self.assertIsNone(session.last_error)

    async def test_an_unexpected_close_is_still_reported(self):
        session = DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language="ru"))
        session._ws = _ClosingSocket(1011, "Deepgram did not receive audio data")
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            await session._recv_loop()
        self.assertTrue(any("upstream closed code=1011" in m for m in logs.output))
        self.assertTrue(session.last_fatal)


if __name__ == "__main__":
    unittest.main()
