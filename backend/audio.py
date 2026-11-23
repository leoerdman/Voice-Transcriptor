"""Audio conversion utilities: WAV normalization, channel splitting, and format detection.

Uses ffmpeg for format conversion when available, with a fallback to soundfile
for WAV files that are already in the expected format (16kHz PCM_16 mono).
"""

import logging
import glob
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import soundfile as sf

# 1.1.25: SSOT for the canonical live-streaming sample rate.
# Replaces in-file literals at the validation, write_wav default,
# split_channels resample, and conversion paths so the Deepgram
# announces / Whisper input contract / WAV writer rate stay in
# lock-step from a single source.
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.storage import atomic_promote_file

logger = logging.getLogger(__name__)


# Hard cap on ffmpeg stderr retained in memory. ffmpeg is normally
# quiet under ``-loglevel error``, but on a corrupt input ("malformed
# sample rate in moov", "Invalid data found when processing input")
# it can emit a multi-MB stderr that we DON'T need beyond the first
# few hundred bytes for diagnostics. Without this cap, a crash-loop
# upload could OOM the backend.
_FFMPEG_STDERR_CAP_CHARS = 64 * 1024
_REMOTE_COMPACT_TIMEOUT_SEC = 1800
# The ceiling for a straight decode-to-16 kHz-WAV conversion, which is
# what every LOCAL transcription starts with. Written out as ``300``
# twice, next to a named ceiling for the remote path, so a change to one
# left the other behind.
_LOCAL_CONVERT_TIMEOUT_SEC = 300
# Frames per block when splitting a stereo WAV into two mono files.
# 262144 frames of int16 stereo is ~1 MB — enough that the per-block
# overhead disappears, small enough that a two-hour recording never
# becomes a resident array.
_SPLIT_BLOCK_FRAMES = 1 << 18
_FFMPEG_DECODE_ERROR_PATTERNS = (
    "partial file",
    "input buffer exhausted",
    "invalid data found when processing input",
    "error submitting packet to decoder",
    "error while decoding",
    "corrupt",
    "truncated",
)


class AudioError(RuntimeError):
    pass


class FfmpegMissingError(AudioError):
    """The conversion needs ffmpeg and it is not installed. A type, so
    callers decide on the fact (fall back to a raw upload, say what to
    install) instead of on a substring of this module's prose (BM-13)."""


def _ffmpeg_stderr_has_decode_error(stderr_text: str) -> bool:
    low = str(stderr_text or "").lower()
    return any(pattern in low for pattern in _FFMPEG_DECODE_ERROR_PATTERNS)


def _bounded_stderr_reader(pipe, cap: int) -> list[str]:
    """Read lines off *pipe* until EOF, keeping at most *cap* CHARACTERS.

    Characters, not bytes: the pipe is opened in text mode, so ``len``
    of a line counts code points and a UTF-8 diagnostic can occupy up to
    four times the cap on disk. The cap exists to stop a multi-MB stderr
    from a corrupt input reaching the heap, and it does that either way
    — the name is what was wrong.

    Continues consuming past the cap so the writer (ffmpeg) is not
    blocked on a full OS pipe buffer — dropping beyond-cap bytes
    silently. Returned list preserves original ordering of the
    retained prefix.

    Runs on a helper thread because the main thread needs to
    ``proc.wait(timeout=...)`` concurrently; calling ``proc.stderr.read()``
    directly would dead-lock a chatty ffmpeg against the OS pipe
    buffer limit (~64 KB on Linux, ~4 KB on some Windows versions).
    """
    collected: list[str] = []
    size = 0
    try:
        for line in pipe:
            if size < cap:
                if size + len(line) > cap:
                    remaining = cap - size
                    collected.append(line[:remaining])
                    size = cap
                else:
                    collected.append(line)
                    size += len(line)
            # Past the cap: keep reading so ffmpeg isn't blocked on
            # a full pipe, but drop the content.
    except ValueError:
        # Pipe closed mid-read (proc killed); benign.
        pass
    return collected


def _has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _ffmpeg_io_paths(cmd: list[str]) -> Tuple[Optional[str], Optional[str]]:
    """Best-effort (input, output) from an ffmpeg argv.

    Every command in this module is built here in the same shape: the
    input follows ``-i`` and the output is the final argument. Reading
    them back beats threading two more parameters through six call
    sites, and a shape this code fully controls cannot surprise us.
    Returns ``None`` for either side it cannot identify — this only
    feeds a log line and must never be able to fail a conversion.
    """
    src = None
    try:
        src = cmd[cmd.index("-i") + 1]
    except (ValueError, IndexError):
        src = None
    dst = cmd[-1] if cmd and not cmd[-1].startswith("-") else None
    return src, dst


def _describe_ffmpeg_file(path: Optional[str]) -> str:
    """``name(bytes)`` for the log, or ``?`` when it cannot be read."""
    if not path:
        return "?"
    name = os.path.basename(path)
    try:
        return f"{name}({os.path.getsize(path)}B)"
    except OSError:
        return name


def _kill_and_reap(proc: "subprocess.Popen", why: str) -> None:
    """Kill ffmpeg and collect it; say so if it will not go.

    A ``TimeoutExpired`` after ``kill()`` used to be swallowed, which
    leaves the child unreaped — a zombie for the life of the backend,
    and no record that one exists.
    """
    proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        logger.warning(
            "ffmpeg did not exit within 5s of SIGKILL (%s); pid=%s left unreaped",
            why, proc.pid,
        )


def _run_ffmpeg(
    cmd: list[str],
    timeout_sec: int,
    cancel_event: Optional[threading.Event] = None,
    fail_on_decode_error: bool = False,
) -> None:
    """Run ffmpeg with bounded stderr + hard timeout.

    Shared between every ffmpeg invocation in this module so the
    bounded-memory stderr handling, kill-on-timeout, and AudioError
    surface stay uniform.

    It is also where every conversion is timed. Decoding a source file
    is the heaviest step in the upload pipeline — a long video can hold
    the worker for tens of seconds — and it produced no record at all:
    the module logged only ffmpeg FAILURES, so a slow import was
    indistinguishable in the log from a fast one, and from no import at
    all. Being the one runner every call site goes through, this is the
    only place that can record them uniformly.

    Raises AudioError on non-zero return or timeout.
    """
    started = time.monotonic()
    src_path, dst_path = _ffmpeg_io_paths(cmd)
    proc = subprocess.Popen(
        cmd,
        # ffmpeg reads its interactive console from stdin. Inherited, it
        # steals bytes from the parent's stdio channel — which is how
        # Electron talks to this backend — and a backgrounded process
        # reading an inherited terminal takes SIGTTIN on POSIX. The
        # ``-nostdin`` flag on the argv says the same thing, and it was
        # on two of the four commands that reach here; this covers all
        # of them, including any added later.
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    collected: list[str] = []
    reader = threading.Thread(
        target=lambda: collected.extend(
            _bounded_stderr_reader(proc.stderr, _FFMPEG_STDERR_CAP_CHARS)
        ),
        name="ffmpeg-stderr-reader",
        daemon=True,
    )
    reader.start()
    try:
        try:
            deadline = time.monotonic() + timeout_sec
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    _kill_and_reap(proc, "cancelled")
                    raise AudioError("ffmpeg conversion cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(cmd, timeout_sec)
                try:
                    proc.wait(timeout=min(0.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except subprocess.TimeoutExpired:
            _kill_and_reap(proc, "timed out")
            raise AudioError(f"ffmpeg conversion timed out after {timeout_sec}s")
    finally:
        # The reader thread is joined on EVERY exit — success, timeout
        # and cancellation alike. It used to be joined only on success,
        # so the two failure paths read ``collected`` while the thread
        # could still be appending to it, and the diagnostic string
        # those paths exist to produce could come out truncated or
        # interleaved. It is also the only place stderr is drained, so
        # closing the pipe before joining races the reader.
        reader.join(timeout=5)
        if reader.is_alive():
            logger.warning("ffmpeg stderr reader did not finish within 5s")
        try:
            if proc.stderr is not None and not proc.stderr.closed:
                proc.stderr.close()
        except Exception:
            pass
    elapsed_ms = int((time.monotonic() - started) * 1000)
    msg = "".join(collected).strip()
    if proc.returncode != 0:
        msg = msg or f"ffmpeg exited with code {proc.returncode}"
        logger.warning(
            "ffmpeg failed (rc=%d) after %d ms: %s", proc.returncode, elapsed_ms, msg
        )
        raise AudioError(f"ffmpeg failed to convert audio: {msg[:4000]}")
    if fail_on_decode_error and _ffmpeg_stderr_has_decode_error(msg):
        logger.warning(
            "ffmpeg reported decode errors despite rc=0 after %d ms: %s",
            elapsed_ms, msg,
        )
        raise AudioError(
            "ffmpeg decoded only part of the input; the source media appears "
            f"truncated or corrupt: {msg[:4000]}"
        )
    logger.info(
        "ffmpeg ok: %d ms in=%s out=%s",
        elapsed_ms,
        _describe_ffmpeg_file(src_path),
        _describe_ffmpeg_file(dst_path),
    )


def _compact_audio_chunks_for_remote_cmd(
    path_in: str,
    segment_pattern: str,
    chunk_sec: int,
) -> list[str]:
    sec = max(1, int(chunk_sec or 1))
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", path_in,
        "-map", "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata", "-1",
        "-ar", str(LIVE_SAMPLE_RATE_HZ),
        "-ac", "1",
        "-c:a", "libopus",
        "-b:a", "24k",
        "-application", "voip",
        "-f", "segment",
        "-segment_time", str(sec),
        "-reset_timestamps", "1",
        "-segment_format", "webm",
        segment_pattern,
    ]


def compact_audio_chunks_for_remote(
    path_in: str,
    output_dir: str,
    *,
    chunk_sec: int,
    cancel_event: Optional[threading.Event] = None,
) -> list[str]:
    """Compress arbitrary audio/video into bounded remote-upload chunks.

    Each output chunk is a standalone 16 kHz mono Opus/WebM file. The
    remote transcription layer sends those chunks sequentially and
    merges text afterward, so long videos never depend on one large
    socket write succeeding.

    Why ALWAYS convert, rather than only for large inputs: ffmpeg costs
    1-3 s on a tiny file, and what the conversion buys is not only size
    — a clean Opus/WebM stream removes the container quirks (mp4 with
    several audio tracks, m4a with an unusual moov-atom placement) that
    make provider-side decoding fail. The cost is bounded; the failure
    it prevents is not. ``ensure_wav_16k`` is unchanged: local Whisper
    still receives raw PCM WAV, which is what it expects.

    (There used to be a single-file counterpart with the same settings.
    Every remote upload goes through this chunked path — ``main`` has no
    other caller — so the single-file one was ~60 lines of documented
    behaviour describing a path nobody took, plus a test pinning an argv
    nobody built.)
    """
    if not _has_ffmpeg():
        raise FfmpegMissingError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg` "
            "or `winget install Gyan.FFmpeg`) — required for remote-provider "
            "audio compression."
        )
    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, "chunk_%05d.webm")
    cmd = _compact_audio_chunks_for_remote_cmd(path_in, pattern, chunk_sec)
    try:
        _run_ffmpeg(
            cmd,
            timeout_sec=_REMOTE_COMPACT_TIMEOUT_SEC,
            cancel_event=cancel_event,
            fail_on_decode_error=True,
        )
    except AudioError:
        for p in glob.glob(os.path.join(output_dir, "chunk_*.webm")):
            try:
                os.unlink(p)
            except OSError:
                pass
        raise

    chunks = sorted(glob.glob(os.path.join(output_dir, "chunk_*.webm")))
    chunks = [p for p in chunks if os.path.getsize(p) > 0]
    if not chunks:
        raise AudioError("ffmpeg produced no audio chunks")
    return chunks


def _copy_file_atomic(path_in: str, path_out: str) -> None:
    # Tmp name MUST match the hex-only convention `\.tmp-[0-9a-f]{6,}`
    # used by `_sweep_orphan_tmp_files` in backend/main.py.
    tmp_out = f"{path_out}.tmp-{uuid.uuid4().hex}"
    try:
        shutil.copyfile(path_in, tmp_out)
        atomic_promote_file(Path(tmp_out), Path(path_out))
    except Exception:
        try:
            os.unlink(tmp_out)
        except OSError:
            pass
        raise


def _wav16k_cmd(path_in: str, path_out: str, channels: Optional[int]) -> list[str]:
    """The ONE argv for "make a 16 kHz PCM16 WAV" (BM-14).

    ``-map 0:a:0 -vn -sn -dn``: always the FIRST audio track and nothing
    else. Without it ffmpeg picks the "best" stream (most channels), so a
    multi-track video was transcribed from one track on the split-stereo
    path and from another on the mono path. ``channels=None`` keeps the
    source's channel count (``-ac`` omitted)."""
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        path_in,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ar",
        str(LIVE_SAMPLE_RATE_HZ),
    ]
    if channels is not None:
        cmd += ["-ac", str(int(channels))]
    cmd += ["-c:a", "pcm_s16le", path_out]
    return cmd


def ensure_wav_16k(path_in: str, path_out: str, channels: Optional[int] = 1) -> str:
    """Ensure a 16 kHz PCM16 WAV at *path_out*; ``channels=None`` keeps the
    source's channel count (the split-stereo path).

    Fast-path: an input that is already a 16 kHz PCM16 WAV with the wanted
    channel count skips ffmpeg entirely (saves ~200-500 ms of subprocess
    overhead) and is copied atomically. Without ffmpeg only such a WAV can
    be accepted; anything else raises ``FfmpegMissingError`` or names what
    is wrong with the WAV.
    """
    ext = os.path.splitext(path_in)[1].lower()

    def _channels_fit(count: int) -> bool:
        return count >= 1 if channels is None else count == int(channels)

    # Fast-path: check if WAV is already in the right format.
    if ext == ".wav":
        try:
            info = sf.info(path_in)
            if info.samplerate == LIVE_SAMPLE_RATE_HZ and _channels_fit(info.channels) and info.subtype == "PCM_16":
                # Already perfect — copy atomically via tmp+rename so a
                # disk-full mid-copy leaves the destination untouched
                # (truncated-WAV transcribe would silently succeed with
                # garbage audio).
                if os.path.abspath(path_in) != os.path.abspath(path_out):
                    _copy_file_atomic(path_in, path_out)
                return path_out
        except Exception:
            pass  # Fall through to ffmpeg conversion

    if _has_ffmpeg():
        try:
            _run_ffmpeg(
                _wav16k_cmd(path_in, path_out, channels),
                timeout_sec=_LOCAL_CONVERT_TIMEOUT_SEC,
                fail_on_decode_error=True,
            )
        except AudioError:
            try:
                os.unlink(path_out)
            except OSError:
                pass
            raise
        return path_out

    if ext != ".wav":
        raise FfmpegMissingError(
            "ffmpeg is not installed. Install it (e.g. `brew install ffmpeg`) or upload a WAV file."
        )

    try:
        info = sf.info(path_in)
    except Exception as exc:
        raise AudioError("Unable to inspect WAV file without ffmpeg") from exc
    if int(info.samplerate) != LIVE_SAMPLE_RATE_HZ:
        raise FfmpegMissingError(
            f"ffmpeg is not installed. Please upload a {LIVE_SAMPLE_RATE_HZ} Hz WAV "
            "(or install ffmpeg for auto-convert)."
        )
    if channels is None and int(info.channels) < 1:
        raise AudioError("Audio has no readable channels")
    if channels is not None and int(info.channels) != int(channels):
        raise AudioError(
            f"Audio has {info.channels} channel(s), but {channels} required (install ffmpeg to convert)."
        )
    if str(info.subtype or "").upper() != "PCM_16":
        raise AudioError(
            "Audio WAV subtype is not PCM_16; install ffmpeg to normalize it."
        )
    # Copy atomically: write to tmp then rename. A raw copyfile()
    # leaves the destination truncated on ENOSPC, and a subsequent
    # transcribe would silently use the fragment.
    _copy_file_atomic(path_in, path_out)
    return path_out


# Frames per streaming chunk (1 MiB of int16 = 2 MB RAM per block).
_PCM16_STREAM_CHUNK_FRAMES = 1 << 20


def write_wav_from_pcm16_stream(pcm_path: str, path_wav: str, sr: int = LIVE_SAMPLE_RATE_HZ) -> int:
    """Convert a raw mono PCM16 spool file to WAV without loading it whole.

    The recovery-promote path can face multi-gigabyte spools (the spool
    ceiling is derived from the upload ceiling). Reading one into a
    numpy float32 array costs ~3x the file size in RAM and OOM-kills
    8-16 GB hosts; this streams fixed-size chunks through soundfile's
    writer instead, so memory stays flat regardless of duration.

    The source is already int16 PCM, so chunks are written verbatim —
    no float round-trip, no quantisation drift.

    Returns the number of frames written. Raises OSError/soundfile
    errors on failure; the partially written target is the caller's
    tmp file to clean up (same contract as ``write_wav``).
    """
    frames_written = 0
    with open(pcm_path, "rb") as src, sf.SoundFile(
        path_wav, mode="w", samplerate=sr, channels=1, subtype="PCM_16"
    ) as dst:
        while True:
            chunk = src.read(_PCM16_STREAM_CHUNK_FRAMES * 2)
            if not chunk:
                break
            # A trailing odd byte would make frombuffer raise; the
            # caller has already normalised the readable size, but stay
            # defensive at the stream boundary too.
            if len(chunk) % 2:
                chunk = chunk[:-1]
                if not chunk:
                    break
            block = np.frombuffer(chunk, dtype=np.int16)
            dst.write(block)
            frames_written += block.size
    return frames_written


def split_channels(path_wav_16k: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a 16k WAV into per-channel mono wav files.

    Returns (ch1_path, ch2_path). If mono, returns (mono_path, None) with mono_path=None (caller can use original).
    """
    with sf.SoundFile(path_wav_16k) as probe:
        if probe.samplerate != LIVE_SAMPLE_RATE_HZ:
            raise AudioError(f"Expected {LIVE_SAMPLE_RATE_HZ} Hz WAV input")
        if probe.channels < 2:
            return None, None

    base, _ = os.path.splitext(path_wav_16k)
    ch1 = base + ".ch1.wav"
    ch2 = base + ".ch2.wav"
    # Atomic-write SSOT (BUG-64): write to the canonical ``.tmp-<hex>``
    # convention and os.replace into place, like every other user-data
    # write in the app. A crash mid-write previously left a torn
    # ch1/ch2.wav that no orphan sweep recognised.
    tmp_ch1 = f"{ch1}.tmp-{uuid.uuid4().hex}"
    tmp_ch2 = f"{ch2}.tmp-{uuid.uuid4().hex}"
    # STREAMED, in blocks. A whole-file float32 read (``sf.read``) of a
    # two-hour 16 kHz stereo file was 921 MB resident plus a contiguous
    # copy per channel — on a path this module has already converted to streaming
    # everywhere else, with a docstring saying why ("OOM-kills 8-16 GB
    # hosts"). This was the one place it had not been applied.
    try:
        with sf.SoundFile(path_wav_16k) as src, \
                sf.SoundFile(
                    tmp_ch1, "w", samplerate=LIVE_SAMPLE_RATE_HZ,
                    channels=1, subtype="PCM_16", format="WAV",
                ) as dst1, \
                sf.SoundFile(
                    tmp_ch2, "w", samplerate=LIVE_SAMPLE_RATE_HZ,
                    channels=1, subtype="PCM_16", format="WAV",
                ) as dst2:
            for block in src.blocks(
                blocksize=_SPLIT_BLOCK_FRAMES, dtype="int16", always_2d=True
            ):
                dst1.write(block[:, 0])
                dst2.write(block[:, 1])
    except BaseException:
        for tmp in (tmp_ch1, tmp_ch2):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise
    os.replace(tmp_ch1, ch1)
    os.replace(tmp_ch2, ch2)
    return ch1, ch2
