import asyncio
import contextlib
import logging
from dataclasses import dataclass
from collections import deque
from typing import Optional

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.transcribe import transcribe_audio

logger = logging.getLogger(__name__)

@dataclass
class LiveConfig:
    # Constrained to ``LIVE_SAMPLE_RATE_HZ`` — the canonical live PCM
    # rate that the Deepgram WS announces, the WAV writer outputs,
    # and Whisper expects natively. Overriding here also requires
    # coordinated updates in those three sites.
    sample_rate: int = LIVE_SAMPLE_RATE_HZ
    window_sec: float = 8.0
    # Seconds of already-transcribed audio re-fed at the head of each
    # window so a word split across two windows is still decoded with
    # context on at least one side. Consumed by ``maybe_transcribe``.
    overlap_sec: float = 1.0
    min_step_sec: float = 1.0
    min_audio_sec: float = 0.7
    # Tolerance of the ALREADY-EMITTED WATERMARK: a word whose second
    # reading (this session re-feeds ``overlap_sec`` at every window
    # head) ends within this much of the last emitted end has already
    # been sent, and is dropped rather than repeated.
    #
    # NOT the renderer's ``UI_TOKENS.finalize.segmentEpsilonSec`` (0.08),
    # and deliberately not derived from it — the two look alike and are
    # different questions (S-04…S-06 named the pair as an unexplained
    # divergence, which it was; the explanation is here and in the token's
    # own comment). This one governs what this session EMITS and its
    # value is a property of Whisper's word timestamps across two passes
    # over overlapping audio. The renderer's governs whether two segments
    # ALREADY SENT — by any provider, including Deepgram, which this
    # module never touches — describe the same moment in its preview
    # pane. Tying them together would make a Whisper timestamp property
    # decide how a Deepgram interim is deduplicated.
    emit_epsilon_sec: float = 0.05
    # Extra seconds retained in the ring beyond ``window_sec``. This is
    # the catch-up budget: when one inference pass runs longer than
    # ``window_sec`` (slow CPU, large model, first-load stall) the next
    # window must be able to reach BACK past ``window_sec`` to cover the
    # audio recorded meanwhile. Without it that audio is silently
    # dropped and the user loses words mid-stream.
    ring_slack_sec: float = 10.0
    # Decode each window with word-level timestamps so already-emitted
    # audio can be trimmed PRECISELY instead of by segment-end heuristic.
    # Every window re-feeds ``overlap_sec`` of previously committed audio
    # (see ``overlap_sec``), and Whisper's SEGMENT timestamps are coarse
    # enough to drift across window boundaries between passes: a segment
    # that lies entirely inside the re-fed region on one pass can come
    # back with an estimated end slightly PAST the watermark on the next,
    # passing the ``g_end <= _last_emitted_end`` guard and being emitted
    # again — the duplicated-phrase report. Word timestamps let us drop
    # exactly the words that were already emitted and keep exactly the
    # new ones, which also removes the mirror-image failure (a boundary-
    # straddling segment whose estimated end lands within epsilon of the
    # watermark gets skipped wholesale today, swallowing its genuinely
    # new trailing words).
    #
    # Costs ~10-20% extra inference per window (alignment pass); at
    # beam_size=1 on 8 s windows that is well inside the 60 s ceiling.
    # Flip to False only on hardware too slow to afford it — the code
    # falls back to the segment-watermark heuristic automatically when
    # the model returns no word data.
    word_timestamps: bool = True


# Longest head of a fresh window that may be recognised as a repeat of what
# was already emitted. Each window re-feeds ``overlap_sec`` (1 s) of committed
# audio, which carries at most a handful of words; anything past this is real
# speech that happens to echo an earlier phrase.
REPEAT_TRIM_MAX_WORDS = 10


def _word_centre(offset_sec: float, word: dict) -> float:
    """Midpoint of a word in global stream seconds."""
    start = float(word.get("start", 0.0) or 0.0)
    end = float(word.get("end", 0.0) or 0.0)
    return offset_sec + (start + end) / 2.0


def _comparable_words(text: str) -> list[str]:
    """Lowercased, punctuation-free tokens for overlap comparison."""
    out = []
    for token in str(text or "").split():
        core = "".join(ch for ch in token.lower() if ch.isalnum())
        if core:
            out.append(core)
    return out


def trim_repeated_prefix(previous_text: str, new_text: str) -> str:
    """Drop the head of ``new_text`` that repeats the tail of ``previous_text``.

    The time-based guard above this is not enough on its own. Every window
    re-decodes ``overlap_sec`` of already-committed audio, and the SAME word
    comes back with different timestamps on each pass — RNNT and Whisper both
    drift by more than ``emit_epsilon_sec`` across passes. A word whose
    re-decoded end lands past the watermark survives the trim and is emitted a
    second time, which is what reaches the user as "хорошо. хорошо работает"
    and "проблемы. проблемы".

    Timestamps cannot settle this because both readings are equally plausible;
    the text can. The longest suffix of what we already said that equals the
    prefix of what we are about to say is the re-decoded overlap, and it is
    dropped. Bounded by ``REPEAT_TRIM_MAX_WORDS`` so a genuine repetition
    further back in the sentence is never touched, and anchored at the head:
    a repeat that starts mid-way through the new text is real speech.
    """
    new_tokens = str(new_text or "").split()
    if not new_tokens:
        return ""
    prev_words = _comparable_words(previous_text)
    new_words = [_comparable_words(t) for t in new_tokens]
    # Map raw-token index -> comparable words it contributes.
    flat: list[tuple[int, str]] = []
    for idx, words in enumerate(new_words):
        for w in words:
            flat.append((idx, w))
    if not flat or not prev_words:
        return str(new_text or "").strip()
    limit = min(REPEAT_TRIM_MAX_WORDS, len(prev_words), len(flat))
    for k in range(limit, 0, -1):
        if prev_words[-k:] != [w for _idx, w in flat[:k]]:
            continue
        # Every raw token up to and including the last matched one is
        # consumed — punctuation-only tokens inside the run included.
        return " ".join(new_tokens[flat[k - 1][0] + 1:]).strip()
    return str(new_text or "").strip()


# Consecutive transcribe failures before we escalate to a fatal error.
# Single transient errors (audio glitch, model hiccup) should not kill
# the live session — but an unrecoverable failure (model unload, OOM,
# corrupted state) repeats forever, so we bound retries and surface
# a fatal event to the frontend.
_LIVE_MAX_CONSECUTIVE_ERRORS = 3


class LiveSession:
    def __init__(
        self,
        model_name: str,
        language: Optional[str],
        config: Optional[LiveConfig] = None,
    ):
        self.model_name = model_name
        self.language = language
        self.cfg = config or LiveConfig()

        self._ring = deque()  # deque[np.ndarray]
        self._ring_samples = 0
        self._total_samples = 0
        self._lock = asyncio.Lock()
        # Single-flight guard: at most one transcription pass may run at a
        # time. A forced (Stop-time) flush awaits the in-flight periodic
        # pass instead of racing it — two concurrent passes transcribe
        # overlapping windows and interleave their emits, duplicating or
        # reordering tail text.
        self._inflight: Optional["asyncio.Task"] = None
        self._last_transcribe_sec = 0.0
        # End (in global stream seconds) of the audio that has actually
        # been handed to the model. Distinct from
        # ``_last_transcribe_sec``, which only throttles how often we
        # start a pass. Windows are sized from THIS value so a slow
        # inference pass never leaves a hole in the coverage.
        self._covered_sec = 0.0
        self._dropped_sec_total = 0.0
        self._last_emitted_end = 0.0
        self._consecutive_errors = 0
        # 1.1.25: accumulator of every emitted segment so the
        # ``finalize_envelope`` method below can return the full
        # transcript at session end. Without this, the WS handler's
        # "final" envelope was always empty even when the local
        # pipeline produced N segments — frontend then mis-classified
        # the session as "no text" and triggered an unnecessary
        # recovery REST round-trip.
        self._emitted_segments: list[dict] = []

    def _emitted_tail_text(self, pending: "Optional[list[dict]]" = None) -> str:
        """The last few emitted segments, for overlap comparison.

        ``pending`` is what THIS pass has produced so far and has not
        committed yet. Without it the guard compared segment k against
        the transcript as it stood BEFORE the pass, so a decoder that
        emitted a boundary clause as two adjacent segments in one window
        sailed through — the very duplication this function exists to
        stop, one level down.
        """
        pool = self._emitted_segments + list(pending or [])
        if not pool:
            return ""
        tail = pool[-3:]
        return " ".join(str(s.get("text") or "") for s in tail).strip()

    def _get_last_samples(self, n: int) -> np.ndarray:
        if n <= 0 or self._ring_samples <= 0:
            return np.zeros((0,), dtype=np.float32)
        need = min(int(n), int(self._ring_samples))

        parts = []
        remaining = need
        for chunk in reversed(self._ring):
            if remaining <= 0:
                break
            if chunk.shape[0] <= remaining:
                parts.append(chunk)
                remaining -= int(chunk.shape[0])
            else:
                parts.append(chunk[-remaining:])
                remaining = 0
        if not parts:
            return np.zeros((0,), dtype=np.float32)
        parts.reverse()
        return np.concatenate(parts)

    async def append_pcm16le(self, chunk: bytes) -> None:
        if not chunk:
            return
        if len(chunk) % 2 != 0:
            chunk = chunk[: len(chunk) - 1]
        if not chunk:
            return

        pcm = np.frombuffer(chunk, dtype=np.int16)
        audio = (pcm.astype(np.float32) / 32768.0).clip(-1.0, 1.0)
        async with self._lock:
            self._ring.append(audio)
            self._ring_samples += int(audio.shape[0])
            self._total_samples += int(audio.shape[0])

            # Keep a rolling buffer of AT LEAST ``max_keep`` samples;
            # global timing uses _total_samples.
            #
            # Evict a chunk only when the remainder still covers the
            # retention target. The previous condition
            # (``while self._ring_samples > max_keep``) dropped the chunk
            # that carried the buffer over the line, so the ring ended up
            # holding *less* than the retention target — and a single
            # chunk larger than ``max_keep`` (possible whenever the
            # client batches aggressively, or on the first frame after a
            # stall) emptied the ring completely, silently discarding
            # every sample in it.
            max_keep = int(self._ring_keep_sec() * self.cfg.sample_rate)
            while (
                len(self._ring) > 1
                and (self._ring_samples - int(self._ring[0].shape[0])) >= max_keep
            ):
                dropped = self._ring.popleft()
                self._ring_samples -= int(dropped.shape[0])

    def _ring_keep_sec(self) -> float:
        return float(self.cfg.window_sec) + max(0.0, float(self.cfg.ring_slack_sec))

    def _max_window_sec(self) -> float:
        """Largest window we can serve from the ring without reading a
        chunk that ``append_pcm16le`` may evict concurrently."""
        return max(float(self.cfg.window_sec), self._ring_keep_sec() - 1.0)

    async def maybe_transcribe(self, *, force: bool = False):
        """Single-flight entry point around :meth:`_transcribe_pass`.

        A periodic tick that arrives while a pass is running is skipped —
        the next tick covers the gap. A forced (Stop-time) flush instead
        AWAITS the in-flight pass, so its window selection sees the
        updated ``_covered_sec`` and transcribes only the true remainder
        instead of an overlapping copy of it.
        """
        inflight = self._inflight
        if inflight is not None and not inflight.done():
            if not force:
                return None
            with contextlib.suppress(Exception):
                # The in-flight pass records its own errors/envelopes;
                # here we only need its completion for a clean handoff.
                await asyncio.shield(inflight)
        task = asyncio.create_task(self._transcribe_pass(force=force))
        self._inflight = task
        try:
            return await task
        finally:
            if self._inflight is task:
                self._inflight = None

    async def _transcribe_pass(self, *, force: bool = False):
        sr = self.cfg.sample_rate

        async with self._lock:
            total_samples = int(self._total_samples)
            total_sec = total_samples / float(sr)
            # Both the throttle AND the final forced flush key off
            # ``_covered_sec`` — what the model has actually seen. Using
            # ``_last_transcribe_sec`` (set when a pass STARTS) made the
            # forced tail flush a no-op whenever the last periodic pass
            # had already begun, so the trailing words spoken just
            # before Stop were never transcribed.
            if force and total_sec <= self._covered_sec + self.cfg.emit_epsilon_sec:
                return None
            if not force and total_sec - self._last_transcribe_sec < self.cfg.min_step_sec:
                return None

            # Window spans everything not yet covered, plus an overlap
            # head for context. When a previous pass ran longer than
            # ``window_sec`` this reaches further back than the nominal
            # window instead of leaving the gap untranscribed.
            uncovered_from_sec = max(0.0, self._covered_sec - self.cfg.overlap_sec)
            need_sec = max(0.0, total_sec - uncovered_from_sec)
            max_window_sec = self._max_window_sec()
            if need_sec > max_window_sec:
                # Only audio the model NEVER SAW is dropped. ``need_sec``
                # includes the overlap head, which is re-fed on purpose
                # and was already decoded, so subtracting it from the
                # cap counted covered audio as lost — overstating the
                # loss by exactly ``overlap_sec`` on every truncation
                # and accumulating that error in the total the envelope
                # and the user-facing warning both report.
                window_start_sec = total_sec - max_window_sec
                dropped = max(0.0, window_start_sec - self._covered_sec)
                if dropped > 0.0:
                    self._dropped_sec_total += dropped
                    logger.warning(
                        "live assist fell behind by %.2fs (window capped at "
                        "%.2fs); %.2fs of audio dropped this pass, %.2fs "
                        "total. The saved recording still holds the full "
                        "audio.",
                        need_sec, max_window_sec, dropped,
                        self._dropped_sec_total,
                    )
            win_sec = min(max(need_sec, self.cfg.min_audio_sec), max_window_sec)
            win = int(win_sec * sr)
            audio_window = self._get_last_samples(win)

            # Skip if no audio yet or audio too short
            if audio_window.shape[0] == 0:
                logger.debug("no audio window yet, skipping transcribe")
                return None

            audio_duration = audio_window.shape[0] / float(sr)
            if audio_duration < self.cfg.min_audio_sec:
                logger.debug(
                    "audio too short (%.2fs < %.2fs), skipping transcribe",
                    audio_duration, self.cfg.min_audio_sec,
                )
                return None

            offset_sec = (total_samples - int(audio_window.shape[0])) / float(sr)
            self._last_transcribe_sec = total_sec

        # Transcribe outside the lock — offload CPU-heavy inference to thread pool
        # so the event loop stays responsive for WS I/O.
        try:
            logger.info(
                "transcribing %d samples (%.2fs)",
                audio_window.shape[0], audio_window.shape[0] / sr,
            )
            loop = asyncio.get_running_loop()
            # Wrap in `asyncio.wait_for` with a hard 60 s ceiling. A wedged
            # Whisper worker (CUDA OOM hang, ctranslate2 deadlock on a
            # corrupt model file, stalled disk IO during first-load of a
            # new model) would otherwise block this coroutine forever,
            # which in turn freezes the WS forwarder loop in main.py that
            # invokes `maybe_transcribe` in a tight cycle — the user would
            # see an alive socket with NO further transcription output
            # and no error event to recover from. 60 s is ~12× a realistic
            # CPU inference of a 30 s window on small; a genuinely slow
            # machine (old Mac Intel on large-v3) stays well under budget.
            #
            # Note on cancellation semantics: `wait_for` cancels the
            # FUTURE, but threads in the default executor cannot be
            # forcibly interrupted in Python — the worker thread keeps
            # running until the native call returns. The coroutine here
            # returns an error envelope immediately regardless, so the
            # WS session can escalate via `_consecutive_errors` instead
            # of hanging. Leaked worker thread is acceptable on the
            # already-unrecoverable CUDA-hang path.
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: transcribe_audio(
                        audio_window,
                        self.model_name,
                        language=self.language,
                        vad_filter=True,
                        word_timestamps=self.cfg.word_timestamps,
                        beam_size=1,
                        best_of=1,
                    ),
                ),
                timeout=60.0,
            )
            logger.info(
                "transcribe result: %d segments",
                len(result.get('segments', [])),
            )
        except asyncio.TimeoutError:
            # Surface as a typed error; same escalation as other
            # transcribe failures (bounded retries before fatal).
            self._consecutive_errors += 1
            signature = "LocalTranscribeTimeout: inference exceeded 60 s"
            logger.error(
                "transcribe timeout (%d/%d consecutive)",
                self._consecutive_errors,
                _LIVE_MAX_CONSECUTIVE_ERRORS,
            )
            fatal = self._consecutive_errors >= _LIVE_MAX_CONSECUTIVE_ERRORS
            return {
                "type": "error",
                "error": signature,
                "fatal": bool(fatal),
            }
        except Exception as e:
            # Typed error envelope — bounded retries before escalating.
            # The transcriber loop in main.py forwards this to the frontend
            # via `_ws_send_json`, so the user sees what went wrong rather
            # than watching a silent dead session.
            self._consecutive_errors += 1
            signature = f"{type(e).__name__}: {e}"
            logger.error(
                "transcribe error (%d/%d consecutive): %s",
                self._consecutive_errors,
                _LIVE_MAX_CONSECUTIVE_ERRORS,
                signature,
                exc_info=True,
            )
            fatal = self._consecutive_errors >= _LIVE_MAX_CONSECUTIVE_ERRORS
            return {
                "type": "error",
                "error": signature,
                "fatal": bool(fatal),
            }

        # Reset on any successful inference pass — transient hiccups
        # should not count against us forever.
        # Escalation is by COUNT of consecutive failures, which is what
        # ``_LIVE_MAX_CONSECUTIVE_ERRORS`` documents. A
        # ``_last_error_signature`` field was written on both error paths
        # and cleared here, and read nowhere: the deduplication it was
        # meant for was never built, and gating the counter on a repeated
        # signature would be worse than not — a session flapping between
        # two different failures would never escalate at all.
        self._consecutive_errors = 0
        # Coverage advances only on a pass that actually reached the
        # model. On the error paths above it stays put so the same audio
        # is retried in the next window instead of being skipped.
        self._covered_sec = max(self._covered_sec, total_sec)

        new_segments = []
        for s in result.get("segments", []):
            g_end = offset_sec + float(s.get("end", 0.0) or 0.0)
            text = (s.get("text") or "").strip()
            if not text:
                continue
            words = s.get("words") or []
            if self.cfg.word_timestamps and words:
                # Word-precise trim: drop the head of the segment that
                # re-decodes already-committed overlap audio. A segment
                # with NO surviving word lies fully inside the committed
                # region — even when its coarse estimated end drifted a
                # few hundred ms past the watermark (the duplication
                # bug). A segment WITH surviving words is trimmed to its
                # new tail so the boundary clause is neither duplicated
                # nor swallowed whole.
                # A word is already committed when its CENTRE lies at or
                # before the watermark — not when its END does.
                #
                # The end test asks "did this word finish after what we
                # already said", and a re-decode answers yes for a word it
                # merely re-heard slightly later. Both engines re-estimate
                # word times on every pass and drift by more than
                # ``emit_epsilon_sec``, so the second reading of an already
                # emitted word kept passing and reaching the transcript
                # twice. Measured on a real recording: a segment at
                # 9.52-10.00 emitted after one covering 8.96-9.94 — the same
                # numbers re-decoded as digits, which the text guard below
                # cannot recognise because "пять" and "56789" share no token.
                #
                # A centre moves half as far as either edge under the same
                # drift, and a word whose middle is inside committed audio is
                # committed audio. This is the rule the interim splice in
                # the Deepgram path already applies to decide the same
                # question; both now answer it the same way.
                kept_words = [
                    w for w in words
                    if _word_centre(offset_sec, w) > self._last_emitted_end
                ]
                if not kept_words:
                    continue
                if len(kept_words) != len(words):
                    # faster-whisper words carry faster-whisper's own
                    # spacing convention (leading space on every token
                    # except the first), so plain concatenation
                    # reconstructs the original spacing exactly.
                    text = "".join(
                        str(w.get("word") or "") for w in kept_words
                    ).strip()
                    if not text:
                        continue
                    # Anchor the trimmed event at the FIRST NEW word's
                    # onset (never before the segment head): reporting
                    # the untrimmed start would make the frontend's
                    # time-ordered merge believe this event overlaps
                    # already-committed content.
                    g_start = max(
                        offset_sec + float(s.get("start", 0.0) or 0.0),
                        offset_sec + float(kept_words[0].get("start", 0.0) or 0.0),
                    )
                else:
                    g_start = offset_sec + float(s.get("start", 0.0) or 0.0)
            else:
                # No word data available (alignment unsupported, or
                # ``word_timestamps`` disabled): fall back to the
                # segment-end watermark heuristic. Read LIVE, like the
                # word branch above: a snapshot taken before the loop
                # answered "was this already emitted" without knowing
                # about anything this pass had just emitted, so the two
                # branches disagreed by exactly one pass.
                if g_end <= self._last_emitted_end + self.cfg.emit_epsilon_sec:
                    continue
                g_start = offset_sec + float(s.get("start", 0.0) or 0.0)
            # Text-level overlap guard. The timestamp trim above cannot
            # see a word whose re-decode drifted past the watermark; the
            # words themselves can.
            trimmed = trim_repeated_prefix(
                self._emitted_tail_text(new_segments), text
            )
            if not trimmed:
                # The whole segment re-states committed speech.
                self._last_emitted_end = max(self._last_emitted_end, g_end)
                continue
            if trimmed != text:
                logger.info(
                    "trimmed a re-decoded overlap from a live segment: "
                    "%d -> %d chars",
                    len(text),
                    len(trimmed),
                )
                text = trimmed
                # Move the event's start past the committed watermark,
                # for the reason the word branch states two branches up:
                # reporting the untrimmed start makes the frontend's
                # time-ordered merge believe this event overlaps content
                # it already holds. The word branch anchors on the first
                # surviving word; there are no words here, so the only
                # anchor available is the watermark itself.
                g_start = max(g_start, min(self._last_emitted_end, g_end))
            new_segments.append({"start": g_start, "end": g_end, "text": text})
            self._last_emitted_end = max(self._last_emitted_end, g_end)

        if not new_segments:
            logger.debug("no new segments to emit")
            return None
        logger.info("emitting %d new segments", len(new_segments))
        # 1.1.25: keep an internal cumulative copy so
        # ``finalize_envelope`` can return the full transcript at end.
        self._emitted_segments.extend(new_segments)
        return {"type": "segments", "segments": new_segments}

    def finalize_envelope(self) -> dict:
        """Return the canonical end-of-session payload for this LiveSession.

        Joins every previously-emitted segment into a single transcript
        and reports the duration as the latest segment's end-time. Used
        by ``_run_local_live_session`` to fill the ``"final"`` WebSocket
        message — the frontend treats an empty final envelope as a
        signal to fall back to recovery.

        The envelope also carries the session's **coverage truth**: how
        much of the captured stream actually reached the model. Two
        distinct ways exist to end up with a transcript that is missing
        words, and neither is visible from the text alone:

        * ``dropped_sec`` — the live assist fell behind (slow CPU, a
          cold model load) far enough that a window had to be capped,
          discarding audio between the previous coverage watermark and
          the start of the capped window.
        * ``uncovered_tail_sec`` — the stream ended with audio that was
          never handed to the model, e.g. the forced final flush raised
          and coverage stayed put.

        ``complete`` is true only when neither happened, which lets the
        frontend treat this transcript as authoritative and skip a full
        re-transcription of the saved recording. Without this signal the
        only safe assumption is "possibly holed", which is why the local
        stop path used to re-transcribe the entire file every time even
        though the live pass had already decoded it with the same model.
        """
        segments = list(self._emitted_segments)
        text = " ".join(
            (s.get("text") or "").strip() for s in segments if s.get("text")
        ).strip()
        duration_sec = max(
            (float(s.get("end") or 0.0) for s in segments),
            default=0.0,
        )
        total_sec = float(self._total_samples) / float(self.cfg.sample_rate)
        uncovered_tail_sec = max(0.0, total_sec - self._covered_sec)
        eps = float(self.cfg.emit_epsilon_sec)
        complete = (
            uncovered_tail_sec <= eps
            and self._dropped_sec_total <= eps
            and total_sec > 0.0
        )
        return {
            "text": text,
            "segments": segments,
            "duration_sec": round(duration_sec, 3),
            "total_sec": round(total_sec, 3),
            "covered_sec": round(float(self._covered_sec), 3),
            "dropped_sec": round(float(self._dropped_sec_total), 3),
            "uncovered_tail_sec": round(uncovered_tail_sec, 3),
            "complete": bool(complete),
        }
