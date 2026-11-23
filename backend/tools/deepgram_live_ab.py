"""Deepgram live A/B tool — reproduce the 2026-09-03 multi-vs-ru measurement.

``--dual`` additionally runs the shipped two-reading merge
(``backend.deepgram_dual.DualLiveSession``): a second session in the
given language on the same audio, merged by word timestamps into one
transcript. The row then reads ``lang=multi+ru``.

Streams saved WAV recordings through a
``backend.remote_deepgram_live.DeepgramLiveSession`` (opened by
``DeepgramWarmPool.acquire``, the same entry point the app uses) at
real-time
pacing, for one or more ``--language`` values and an optional shared
keyterms list, ``--runs`` times each, and prints one row per run: file,
language, keyterms count, connect ms, finalize ms, final segment count,
word count, char count, and the transcript text.

This is the tool ``BUGS_AUDIT_2026-09-03.md`` §1 and
``backend.remote_deepgram_live.DeepgramLiveConfig.to_query_string``
point at as the way to re-run the measurement that found
``language=multi`` silently dropping Russian clauses
non-deterministically, while ``language=ru`` on the same audio did not.

Usage::

    python -m backend.tools.deepgram_live_ab FILE.wav [FILE2.wav ...] \\
        --language ru --language multi \\
        --keyterms "Sonnet,Opus,Claude,Deepgram,субагент,субагенты" \\
        --runs 2

The Deepgram API key is read from the app's own config
(``backend.config.load_config()``) under ``providers.deepgram.key`` —
never printed or logged. The profile is the app's own
(``backend.data_dir.default_data_dir``); set ``TRANSCRIPTOR_DATA_DIR`` to
point at a different one.

``--dump-readings DIR`` (with ``--dual``) writes both readings each run
merged, exactly as the two sessions delivered them, to one JSON file per
run; ``python -m backend.tools.dual_replay FILE.json`` re-merges such a
file offline with the merge rules in the working tree. A change to the
merge is then compared against real readings for free instead of paying
Deepgram once per variant.

Exit codes: 0 all runs succeeded, 1 at least one run errored (see the
per-row ``ERROR:`` text), 2 no Deepgram API key configured, 3 an input
WAV was missing or not 16 kHz mono, or ``--dual`` was asked for a
language that does not run the app's dual reading.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import soundfile as sf  # noqa: E402

from backend.async_tasks import cancel_and_await  # noqa: E402
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ  # noqa: E402
from backend.config import load_config  # noqa: E402
from backend.deepgram_keyterms import normalize_keyterms  # noqa: E402
from backend.deepgram_language import LANGUAGE_HINT_OPTIONS, normalize_language_hints  # noqa: E402
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL  # noqa: E402
from backend.deepgram_dual import (  # noqa: E402
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DualLiveSession,
    dual_applies,
    secondary_config,
)
from backend.deepgram_recovery import (  # noqa: E402
    evidence_from_session,
    run_recovery,
)
from backend.deepgram_warm import DeepgramWarmPool  # noqa: E402
from backend.remote_deepgram_live import (  # noqa: E402
    DeepgramLiveError,
    DeepgramLiveSession,
    live_config,
    resolve_live_language,
)
from backend.tools.dual_dump import build_dump, write_dump  # noqa: E402

# One code path for opening a live session, in the app and here alike:
# ``acquire()`` adopts a warm socket when the pool is armed and connects
# a fresh one when it is not. This pool is deliberately NOT armed — a
# measurement tool must not hold a Deepgram connection open between
# runs, and each run is meant to pay and REPORT its own connect time —
# so every run here takes the un-armed branch, which is exactly the
# plain ``connect()`` this tool did before the pool existed. Going
# through it anyway is what keeps the measured path the shipped path.
_POOL = DeepgramWarmPool()


class _MessageCaptureSession(DeepgramLiveSession):
    def __init__(self, *args, captured: dict[str, list[dict]], **kwargs):
        super().__init__(*args, **kwargs)
        self._captured_messages = captured

    def _process_deepgram_message(self, msg: dict):
        self._captured_messages.setdefault(self._cfg.language, []).append(dict(msg))
        return super()._process_deepgram_message(msg)

DEFAULT_CHUNK_MS = 100
_TEXT_TRUNCATE_CHARS = 200


@dataclass
class RunResult:
    file: str
    language: str
    run: int
    keyterms_count: int
    connect_ms: "float | None"
    finalize_ms: "float | None"
    segments: int
    words: int
    chars: int
    text: str
    # What the finalize-time REST recovery pass did — the second half of
    # the stop the app performs (``backend.deepgram_recovery``). A row
    # with ``rec=0/0`` is a recording the live reading covered on its own.
    recovery_spans: int = 0
    recovery_words: int = 0
    recovery_ms: float = 0.0
    uncovered_sec: float = 0.0
    error: "str | None" = None
    # (start, end, confidence, language, source, word) per delivered word,
    # printed with ``--words``.
    word_rows: list = field(default_factory=list)


def _load_api_key() -> str:
    cfg = load_config()
    return str(((cfg.get("providers") or {}).get("deepgram") or {}).get("key") or "").strip()


def _load_pcm16_mono(path: Path) -> bytes:
    """Read *path* as 16 kHz mono PCM16, matching what the live WS sends.

    Multi-channel WAVs are downmixed to the first channel (with a
    warning), not averaged — this app's own recordings carry mic audio
    on one channel. A sample rate other than ``LIVE_SAMPLE_RATE_HZ`` is
    a hard error: the real-time pacing below assumes it, and silently
    mis-pacing the wrong rate would make the measurement unfaithful to
    the live capture path rather than merely slower.
    """
    data, sr = sf.read(str(path), dtype="int16", always_2d=False)
    if getattr(data, "ndim", 1) > 1:
        print(
            f"warning: {path.name} has {data.shape[1]} channels; using channel 0",
            file=sys.stderr,
        )
        data = data[:, 0]
    if sr != LIVE_SAMPLE_RATE_HZ:
        raise ValueError(
            f"{path.name}: sample rate {sr} Hz != required {LIVE_SAMPLE_RATE_HZ} Hz "
            "(this tool paces chunks assuming the live capture rate; "
            "resample the file first)"
        )
    return data.tobytes()


async def _run_one(
    *,
    api_key: str,
    model: str,
    pcm: bytes,
    language: str,
    keyterms: "tuple[str, ...]",
    chunk_ms: int,
    speed: float,
    file_label: str,
    run_index: int,
    dual_language: str = "",
    dump_dir: "Path | None" = None,
    language_hints: "tuple[str, ...]" = (),
    dump_messages: bool = False,
) -> RunResult:
    # The app's own builder. Constructing a ``DeepgramLiveConfig``
    # directly here meant this tool measured a socket opened with
    # slightly different parameters than the app opens — and the warm
    # pool keys on exactly that query string.
    cfg = live_config(model=model, language=language, keyterms=keyterms, language_hints=language_hints)
    try:
        captured: dict[str, list[dict]] = {}
        pool = _POOL
        if dump_messages:
            pool = DeepgramWarmPool(
                session_factory=lambda key, config: _MessageCaptureSession(
                    key, config, captured=captured,
                ),
            )
        session = (await pool.acquire(api_key, cfg)).session
        if dual_language:
            # The same facade the app runs, so what is measured here is
            # the merge that ships — not a second implementation of it.
            secondary = (
                await pool.acquire(api_key, secondary_config(cfg, dual_language))
            ).session
            session = DualLiveSession(
                primary=session,
                secondary=secondary,
                secondary_language=dual_language,
                # The label the app passes (``backend.main``): the
                # language actually on the wire, never "auto".
                primary_language=resolve_live_language(language),
                expected_languages=language_hints,
            )
    except DeepgramLiveError as e:
        return RunResult(
            file=file_label, language=language, run=run_index,
            keyterms_count=len(keyterms), connect_ms=None, finalize_ms=None,
            segments=0, words=0, chars=0, text="", error=str(e),
        )

    async def _drain() -> None:
        async for _ in session.events():
            pass

    drain_task = asyncio.create_task(_drain())
    chunk_bytes = max(2, int(LIVE_SAMPLE_RATE_HZ * 2 * (chunk_ms / 1000.0)))
    step_sec = (chunk_ms / 1000.0) / max(speed, 1e-6)
    started = time.perf_counter()
    try:
        for i, offset in enumerate(range(0, len(pcm), chunk_bytes)):
            await session.send_pcm(pcm[offset:offset + chunk_bytes])
            target = started + (i + 1) * step_sec
            delay = target - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        # Let the last chunk actually reach Deepgram before finalizing.
        await asyncio.sleep(0.2)
        # Drain, then RECOVER, then shut down — the exact order the WS
        # handler uses. ``finalize()`` (drain + shutdown) would measure
        # only the half of the stop that happens before the envelope is
        # completed, and the envelope is what the user receives.
        result = await session.drain_transcript()
        if dump_dir is not None and isinstance(session, DualLiveSession):
            _dump_readings(
                dump_dir, file_label, run_index, session, language, dual_language,
                keyterms=cfg.keyterms,
                messages=captured if dump_messages else None,
            )
        evidence = evidence_from_session(session)
        stream_death_sec = session.stream_death_sec
        result = await run_recovery(
            payload=result,
            evidence=evidence,
            stream_death_sec=stream_death_sec,
            pcm=pcm,
            cfg=cfg,
            api_key=api_key,
        )
    finally:
        # In the ``finally`` so a run that raised mid-stream still closes
        # its socket(s) — the same teardown the WS handler guarantees.
        await session.shutdown()
        try:
            await asyncio.wait_for(drain_task, timeout=5.0)
        except asyncio.TimeoutError:
            await cancel_and_await(drain_task, what="ab-tool event drain", log=logging.getLogger(__name__))

    stats = result.get("stats") or {}
    recovery = stats.get("recovery") or {}
    word_rows = [
        (
            float(w.get("start") or 0.0),
            float(w.get("end") or 0.0),
            w.get("confidence"),
            str(w.get("language") or ""),
            str(w.get("source") or ""),
            str(w.get("word") or ""),
        )
        for seg in (result.get("segments") or [])
        for w in (seg.get("words") or [])
    ]
    text = str(result.get("text") or "")
    label = f"{language}+{dual_language}" if dual_language else language
    return RunResult(
        file=file_label, language=label, run=run_index,
        keyterms_count=len(keyterms),
        connect_ms=stats.get("connect_ms"), finalize_ms=stats.get("finalize_ms"),
        segments=len(result.get("segments") or []), words=len(text.split()),
        chars=len(text), text=text,
        recovery_spans=len(recovery.get("spans") or []),
        recovery_words=int(recovery.get("words") or 0),
        recovery_ms=float(recovery.get("ms") or 0.0),
        uncovered_sec=float(result.get("uncoveredSpeechSec") or 0.0),
        word_rows=word_rows,
    )


def _dump_readings(
    dump_dir: Path,
    file_label: str,
    run_index: int,
    session: DualLiveSession,
    language: str,
    dual_language: str,
    *, keyterms: "tuple[str, ...]" = (),
    messages: "dict[str, list[dict]] | None" = None,
) -> None:
    """Write the two readings this run merged, for ``dual_replay``."""
    readings = session.last_readings
    if readings is None:
        return
    primary_result, secondary_result = readings
    dump_dir.mkdir(parents=True, exist_ok=True)
    path = dump_dir / f"{Path(file_label).stem}.{language}+{dual_language}.run{run_index}.json"
    payload = build_dump(
        file=file_label,
        primary_language=resolve_live_language(language),
        secondary_language=dual_language,
        expected_languages=list(session.expected_languages),
        keyterms=list(keyterms),
        primary_segments=primary_result.get("segments") or [],
        secondary_segments=(secondary_result or {}).get("segments") or [],
        messages=messages,
    )
    write_dump(path, payload)
    print(f"readings: {path}", file=sys.stderr)


def _format_words(r: RunResult) -> str:
    """One line per delivered word: time, Deepgram's confidence and
    language, which reading it came from (dual), and the word."""
    lines = []
    for start, end, conf, lang, source, word in r.word_rows:
        c = f"{conf:.3f}" if isinstance(conf, (int, float)) else "  n/a"
        lines.append(f"    {start:7.2f}-{end:7.2f} conf={c} lang={lang or '-':<3} src={source or '-':<5} {word}")
    return "\n".join(lines)


def _format_row(r: RunResult, *, full: bool) -> str:
    if r.error:
        return f"{r.file:<28} lang={r.language:<9} run={r.run} ERROR: {r.error}"
    text = r.text if full or len(r.text) <= _TEXT_TRUNCATE_CHARS else (
        r.text[:_TEXT_TRUNCATE_CHARS] + "…"
    )
    connect = f"{r.connect_ms:6.0f}" if r.connect_ms is not None else "   n/a"
    finalize = f"{r.finalize_ms:6.0f}" if r.finalize_ms is not None else "   n/a"
    return (
        f"{r.file:<28} lang={r.language:<9} kt={r.keyterms_count:<2} run={r.run} "
        f"connect={connect}ms finalize={finalize}ms "
        f"segs={r.segments:<3} words={r.words:<4} chars={r.chars:<5} "
        f"rec={r.recovery_spans}/{r.recovery_words}@{r.recovery_ms:.0f}ms "
        f"uncov={r.uncovered_sec:.2f}s langs={_language_counts(r)} | {text}"
    )


def _language_counts(r: RunResult) -> str:
    """How many delivered words carry each Deepgram language label —
    the number a language-hint comparison is about."""
    counts: dict[str, int] = {}
    for _start, _end, _conf, lang, _source, _word in r.word_rows:
        key = lang or "-"
        counts[key] = counts.get(key, 0) + 1
    return ",".join(f"{k}:{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])) or "-"


async def _main_async(args: argparse.Namespace) -> int:
    if args.dump_messages and (not args.dump_readings or not args.dual):
        print("error: --dump-messages requires --dump-readings DIR and --dual", file=sys.stderr)
        return 3
    if args.dual:
        not_multi = [lang for lang in args.language if not dual_applies(lang)]
        if not_multi:
            # The app opens a second reading only for a multilingual
            # recording (``dual_stream_enabled``); measuring any other
            # configuration measures something no user ever runs.
            print(
                f"error: --dual applies only to a multilingual recording; "
                f"not for --language {', '.join(not_multi)}",
                file=sys.stderr,
            )
            return 3
    api_key = _load_api_key()
    if not api_key:
        print(
            "error: no Deepgram API key in config (providers.deepgram.key); "
            "set TRANSCRIPTOR_DATA_DIR to the right profile or configure a key",
            file=sys.stderr,
        )
        return 2

    keyterms = normalize_keyterms(args.keyterms or "")
    language_hints = normalize_language_hints(args.language_hint or [])
    if len(language_hints) != len(args.language_hint or []):
        print(f"error: --language-hint accepts only {', '.join(LANGUAGE_HINT_OPTIONS)}", file=sys.stderr)
        return 3

    paths = [Path(p) for p in args.wavs]
    pcm_by_path: dict[Path, bytes] = {}
    for p in paths:
        if not p.exists():
            print(f"error: file not found: {p}", file=sys.stderr)
            return 3
        try:
            pcm_by_path[p] = _load_pcm16_mono(p)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3

    dump_dir = Path(args.dump_readings) if args.dump_readings else None

    tasks = []
    labels: list[tuple[str, str, int]] = []
    for p in paths:
        for lang in args.language:
            for run_index in range(1, args.runs + 1):
                labels.append((p.name, lang, run_index))
                tasks.append(
                    _run_one(
                        api_key=api_key,
                        model=args.model,
                        pcm=pcm_by_path[p],
                        language=lang,
                        keyterms=keyterms,
                        chunk_ms=args.chunk_ms,
                        speed=args.speed,
                        file_label=p.name,
                        run_index=run_index,
                        dual_language=args.dual or "",
                        dump_dir=dump_dir,
                        language_hints=language_hints,
                        dump_messages=args.dump_messages,
                    )
                )

    results = await asyncio.gather(*tasks, return_exceptions=True)

    had_error = False
    rows: list[RunResult] = []
    for label, res in zip(labels, results):
        if isinstance(res, BaseException):
            had_error = True
            rows.append(
                RunResult(
                    file=label[0], language=label[1], run=label[2],
                    keyterms_count=len(keyterms), connect_ms=None, finalize_ms=None,
                    segments=0, words=0, chars=0, text="", error=repr(res),
                )
            )
        else:
            if res.error:
                had_error = True
            rows.append(res)

    rows.sort(key=lambda r: (r.file, r.language, r.run))
    for r in rows:
        print(_format_row(r, full=args.full))
        if args.words and not r.error:
            print(_format_words(r))

    return 1 if had_error else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deepgram_live_ab",
        description=(
            "Stream saved WAV recordings through Deepgram's live "
            "WebSocket API at real-time pacing, across one or more "
            "--language settings and an optional keyterms list, to "
            "reproduce and re-run the 2026-09-03 multi-vs-ru "
            "measurement (see BUGS_AUDIT_2026-09-03.md §1)."
        ),
    )
    parser.add_argument(
        "wavs", nargs="+",
        help="WAV file(s), 16 kHz mono PCM16 (the app's live capture format)",
    )
    parser.add_argument(
        "--language", "-l", action="append", required=True,
        help="Deepgram language value to test, e.g. 'multi' or 'ru'. "
             "Repeat the flag to compare several in one run.",
    )
    parser.add_argument(
        "--dual", nargs="?", const=DUAL_SECONDARY_LANGUAGE_DEFAULT, default="",
        metavar="LANGUAGE",
        help="Run the DUAL reading for every --language given: a second "
             "session in LANGUAGE (default "
             f"'{DUAL_SECONDARY_LANGUAGE_DEFAULT}') on the same audio, "
             "merged by word timestamps through the same DualLiveSession "
             "the app uses. Doubles the Deepgram seconds billed.",
    )
    parser.add_argument(
        "--dump-readings", default="", metavar="DIR",
        help="With --dual: write both readings each run merged to a JSON "
             "file in DIR, for offline re-merging with "
             "`python -m backend.tools.dual_replay`.",
    )
    parser.add_argument(
        "--dump-messages", action="store_true",
        help="With --dual and --dump-readings, also save each decoded raw Deepgram JSON payload.",
    )
    parser.add_argument(
        "--keyterms", default="",
        help="Comma- or newline-separated keyterms, normalised via "
             "backend.deepgram_keyterms.normalize_keyterms and applied "
             "to every language/run in this invocation.",
    )
    parser.add_argument(
        "--language-hint", action="append", default=[], metavar="CODE",
        help="Nova-3 multilingual language hint (repeat for several, e.g. "
             "--language-hint ru --language-hint en). Sent only for "
             "language=multi, exactly as the app sends its configured hints.",
    )
    parser.add_argument(
        "--runs", type=int, default=1,
        help="Number of repeat runs per file/language combination (default 1).",
    )
    parser.add_argument(
        "--speed", type=float, default=1.0,
        help="Playback speed multiplier; 1.0 = real-time. Values above 1.0 "
             "stream faster than spoken, which changes timing measurements "
             "— use 1.0 for a faithful reproduction of a live session.",
    )
    parser.add_argument(
        "--chunk-ms", type=int, default=DEFAULT_CHUNK_MS,
        help=f"PCM chunk size in milliseconds (default {DEFAULT_CHUNK_MS}).",
    )
    parser.add_argument(
        "--model", default=DEFAULT_DEEPGRAM_AUDIO_MODEL,
        help=f"Deepgram model id (default {DEFAULT_DEEPGRAM_AUDIO_MODEL}).",
    )
    parser.add_argument(
        "--log-level", default="WARNING",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="Backend log level to print to stderr. INFO shows the live "
             "session's own per-final and coverage-hole reporting, which "
             "is what a hole investigation reads.",
    )
    parser.add_argument(
        "--full", action="store_true",
        help=f"Print the full transcript text instead of truncating to "
             f"{_TEXT_TRUNCATE_CHARS} chars.",
    )
    parser.add_argument(
        "--words", action="store_true",
        help="Also print every delivered word with its time, Deepgram "
             "confidence, language and (with --dual) the reading it came from.",
    )
    return parser


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    try:
        return asyncio.run(_main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
