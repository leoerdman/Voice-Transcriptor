"""Deepgram Nova-3 — pre-recorded REST transcription.

Uses the synchronous listen endpoint:
    POST https://api.deepgram.com/v1/listen

Used for:
  * File uploads and stop-time fallback transcription of the canonical WAV.
  * NOT used for live streaming — see ``backend.remote_deepgram_live``
    which is the single source of truth for live Deepgram sessions.

Accepts raw audio bytes (WAV/MP3/etc.) as the request body.
"""

import logging
from typing import Any, Dict, Optional, Sequence

from backend.audio_mime import audio_content_type
from backend.deepgram_keyterms import keyterm_query_pairs
from backend.deepgram_language import language_hint_pairs, rest_language_params
from backend.deepgram_words import deepgram_word_text
from backend.deepgram_format import shared_format_params
from backend.http_retry import RemoteError, request_with_retry
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL

logger = logging.getLogger(__name__)


class DeepgramRemoteError(RemoteError):
    """Deepgram-specific remote failure (REST / pre-recorded API).

    Subclass of ``RemoteError`` so callers can catch provider-specific
    failures (``except DeepgramRemoteError`` → switch to OpenRouter or
    local Whisper) or a generic remote failure (``except RemoteError``).

    Previously this was a bare ``DeepgramRemoteError = RemoteError``
    alias — ``main.py`` imported it as ``DgRemoteError`` which gave
    zero provider discrimination at the catch site (``except
    (OrRemoteError, DgRemoteError)`` was equivalent to catching
    ``RemoteError`` twice).
    """


# 1.1.25 SSOT: imported from ``backend.deepgram_endpoints`` so REST
# and live modules share one source of truth for the Deepgram host.
from backend.deepgram_endpoints import DEEPGRAM_REST_BASE  # noqa: E402


_DEEPGRAM_CONNECT_TIMEOUT_SEC = 10
# A body at most this large is a short live-capture recovery: one attempt,
# a short read timeout. Both are published to the renderer
# (``runtime_limits``, FU-13b / FG-10), which bounds its own wait for such
# a request by them instead of keeping copies.
DEEPGRAM_SMALL_AUDIO_BYTES = 1 * 1024 * 1024
DEEPGRAM_SMALL_AUDIO_READ_TIMEOUT_SEC = 12
_DEEPGRAM_LARGE_AUDIO_BYTES = 5 * 1024 * 1024


def _deepgram_http_policy(audio_size_bytes: int) -> tuple[tuple[int, int], int]:
    """Return (timeout, attempts) for Deepgram REST by body size.

    Short live-capture recoveries are usually tiny compressed payloads.
    They should fail fast on provider stalls instead of inheriting the
    long upload budget required by multi-megabyte files.
    """
    size = max(0, int(audio_size_bytes or 0))
    body_mb = max(1.0, size / (1024 * 1024))

    if size <= DEEPGRAM_SMALL_AUDIO_BYTES:
        return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, DEEPGRAM_SMALL_AUDIO_READ_TIMEOUT_SEC), 1
    if size < _DEEPGRAM_LARGE_AUDIO_BYTES:
        return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, max(45, int(body_mb * 10))), 2
    return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, max(180, int(body_mb * 8))), 2


def _format_deepgram_speaker_words(words: object) -> str:
    """Return a speaker-labelled transcript from Deepgram word objects."""
    if not isinstance(words, list) or not words:
        return ""
    parts: list[str] = []
    current_speaker: Optional[int] = None
    current_words: list[str] = []
    saw_speaker = False

    def flush() -> None:
        nonlocal current_words
        if not current_words:
            return
        text = " ".join(current_words).strip()
        if not text:
            current_words = []
            return
        if current_speaker is None:
            parts.append(text)
        else:
            parts.append(f"Speaker {current_speaker}: {text}")
        current_words = []

    for item in words:
        if not isinstance(item, dict):
            continue
        token = deepgram_word_text(item)
        if not token:
            continue
        speaker_raw = item.get("speaker")
        speaker: Optional[int] = None
        if speaker_raw is not None:
            try:
                speaker = int(speaker_raw)
                saw_speaker = True
            except (TypeError, ValueError):
                speaker = current_speaker
        else:
            speaker = current_speaker
        if current_words and speaker != current_speaker:
            flush()
        current_speaker = speaker
        current_words.append(token)

    flush()
    return "\n\n".join(parts) if saw_speaker else ""


def deepgram_transcribe(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    model: str = DEFAULT_DEEPGRAM_AUDIO_MODEL,
    language: Optional[str] = None,
    diarize: bool = False,
    num_speakers: Optional[str] = None,
    keyterms: Sequence[str] = (),
    language_hints: Sequence[str] = (),
) -> Dict[str, Any]:
    """Transcribe audio using Deepgram's pre-recorded API.

    Returns {"text": str, "raw": dict}.

    Formatting options come from ``backend.deepgram_format``, which both
    Deepgram paths read. They used to be set here and in the live module
    independently, with opposite values and each carrying a comment
    asserting the other was wrong; the same recording therefore came back
    formatted differently depending on which path served it. The premise
    for disabling smart formatting — that Deepgram strips punctuation for
    Russian — is contradicted by the live path's own output, and the
    measurement is recorded in that module.

    ``paragraphs`` and ``numerals`` stay here: the live endpoint does not
    accept them, so they are genuinely path-specific rather than a second
    opinion about a shared question.

    ``keyterms`` should already be normalised (see
    ``backend.deepgram_keyterms.normalize_keyterms``) — this function
    only decides whether *model* supports Keyterm Prompting and, if so,
    sends every term as a repeated ``keyterm`` parameter (``requests``
    repeats a query key for a list-valued param entry; a plain
    comma-joined string would send ONE term, not several).
    """
    if not api_key:
        raise DeepgramRemoteError("Deepgram API key is not configured")

    url = f"{DEEPGRAM_REST_BASE}/listen"

    params: Dict[str, Any] = {
        "model": model or DEFAULT_DEEPGRAM_AUDIO_MODEL,
        # Prerecorded-only options; the shared formatting decision below
        # covers everything both endpoints accept.
        "paragraphs": "true",
        "numerals": "true",
        **shared_format_params(),
    }
    if diarize:
        # Deepgram REST flag for speaker labelling. The response adds
        # ``words[...].speaker`` and the user-facing text below renders
        # speaker-labelled paragraphs from that canonical word list.
        params["diarize"] = "true"
        speakers_raw = str(num_speakers or "").strip()
        if speakers_raw:
            try:
                speakers = int(speakers_raw)
            except ValueError as exc:
                raise DeepgramRemoteError("Deepgram num_speakers must be an integer") from exc
            if speakers < 1 or speakers > 10:
                raise DeepgramRemoteError("Deepgram num_speakers must be between 1 and 10")
            params["num_speakers"] = str(speakers)
    kt_pairs = keyterm_query_pairs(keyterms, params["model"])
    if kt_pairs:
        # List-valued entry: ``requests`` encodes it as one repeated
        # ``keyterm=`` per element rather than a single joined value.
        params["keyterm"] = [term for _, term in kt_pairs]
    # What "auto" means on THIS endpoint, from the one module that owns
    # the question for both of them (``backend.deepgram_language``).
    # The live endpoint answers it differently — it has no
    # ``detect_language`` — and that difference is a fact about
    # Deepgram, written down once with its reason instead of being an
    # unexplained divergence between two files.
    params.update(rest_language_params(language))
    # Hints apply only to ``language=multi`` (the recovery pass's reading
    # of a live recording); "auto" here is ``detect_language`` and takes
    # none. Repeated ``language_hint=`` like ``keyterm=``.
    hint_pairs = language_hint_pairs(str(params.get("language") or ""), tuple(language_hints or ()))
    if hint_pairs:
        params["language_hint"] = [code for _, code in hint_pairs]

    content_type = audio_content_type(filename)

    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": content_type,
    }

    timeout, upload_attempts = _deepgram_http_policy(len(audio_bytes))
    # ``language=`` is what tells two concurrent calls apart: the recovery
    # pass of a dual-stream recording decodes the same span in both
    # readings at once (``deepgram_recovery``), and without it the two
    # start lines were byte-identical and read as a duplicated log line.
    logger.info(
        "deepgram_transcribe: model=%s language=%s audio=%d bytes timeout=%s attempts=%d keyterms=%d",
        model,
        params.get("language") or ("detect" if params.get("detect_language") else "-"),
        len(audio_bytes),
        timeout,
        upload_attempts,
        len(kt_pairs),
    )
    # Adaptive timeout for Deepgram REST uploads.
    #
    # User report (1 May 2026): a 26.6 MB m4a from a slow / cross-region
    # link (RU → us-east Deepgram) failed with
    #   network error after 3 attempts: ('Connection aborted.',
    #   TimeoutError('The write operation timed out'))
    # Root cause: ``requests`` applies the read-timeout to the SOCKET as
    # a whole, including the upload (write) phase. With the body still
    # being uploaded after 60 s the socket trips its idle timeout and
    # raises during ``data=`` send. Retrying the same 26 MB POST 3 times
    # just bled bandwidth — the bottleneck is upload speed, not transient
    # provider hiccups.
    #
    # Large files keep the old generous budget: ``read = max(180,
    # body_mb * 8)`` seconds, with two attempts. Short live recordings
    # use one 12 s attempt, because the body is already only a few
    # dozen KB after compaction; waiting 20-35 s there is provider or
    # network stall, not meaningful transcription work.
    r = request_with_retry(
        "POST", url,
        headers=headers,
        params=params,
        data=audio_bytes,
        timeout=timeout,
        attempts=upload_attempts,
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        raise DeepgramRemoteError(f"Deepgram API error (HTTP {r.status_code}): {error_text}")

    try:
        result = r.json()
    except Exception:
        raise DeepgramRemoteError(f"Deepgram: invalid JSON response: {r.text[:300]}")

    # Extract text from Deepgram response structure.
    # When paragraphs=true, Deepgram returns a structured paragraphs object
    # with proper sentence grouping. We join paragraphs with double newlines
    # to produce clean, WhisperFlow-quality formatted output.
    text = ""
    alternative: dict = {}
    try:
        channel = result["results"]["channels"][0]
        alternatives = channel.get("alternatives", [])
        alternative = alternatives[0] if alternatives else {}
        if diarize:
            text = _format_deepgram_speaker_words(alternative.get("words"))
        # Try paragraphs first (structured paragraph output)
        paragraphs_obj = alternative.get("paragraphs")
        if not text and paragraphs_obj and isinstance(paragraphs_obj, dict):
            paragraph_list = paragraphs_obj.get("paragraphs", [])
            if paragraph_list:
                para_texts = []
                for para in paragraph_list:
                    sentences = para.get("sentences", [])
                    para_text = " ".join(
                        s.get("text", "") for s in sentences
                    ).strip()
                    if para_text:
                        para_texts.append(para_text)
                if para_texts:
                    text = "\n\n".join(para_texts)
        # Fallback to flat transcript
        if not text:
            if alternatives:
                # ``or ""`` is load-bearing (BUG-77): a literal JSON null
                # passes .get's default (it only fires on a MISSING key),
                # and the None reached len(text) below — outside this
                # try — as an unhandled TypeError → raw 500.
                text = alternatives[0].get("transcript") or ""
    except (KeyError, IndexError, TypeError) as e:
        # 1.1.25: previously ``pass``-swallowed without context. A
        # Deepgram schema change (rename/restructure of channels/
        # alternatives) silently produced empty transcripts on
        # every call — the user saw "success, 0 chars" and assumed
        # the audio was bad. Now fail the provider call so the caller
        # can retry, fallback, or surface a real provider error.
        logger.error(
            "deepgram_transcribe: response shape mismatch (%s). "
            "Result keys at root: %r.",
            e,
            list(result.keys()) if isinstance(result, dict) else type(result).__name__,
        )
        raise DeepgramRemoteError("Deepgram: malformed response payload") from e

    # ``duration`` is part of the adapter contract, not of the caller's
    # knowledge of this provider's payload: the caller used to reach
    # into ``raw["metadata"]["duration"]`` — a Deepgram shape — for
    # EVERY provider, so an OpenRouter transcription always reported
    # zero seconds. Each adapter answers for its own response.
    duration = 0.0
    metadata = result.get("metadata") if isinstance(result, dict) else None
    if isinstance(metadata, dict):
        try:
            duration = max(0.0, float(metadata.get("duration") or 0.0))
        except (TypeError, ValueError):
            duration = 0.0

    # ``words`` for the same reason as ``duration``: the adapter knows
    # this provider's payload shape and its callers must not have to.
    # ``deepgram_recovery`` reached into
    # ``raw["results"]["channels"][0]["alternatives"][0]["words"]`` to
    # place re-decoded words — this module's private knowledge, spelled
    # out in another file. Handed over RAW: normalising them is the
    # live module's rule (``normalize_words``) and importing it here
    # would make the pre-recorded adapter depend on the streaming one.
    raw_words = alternative.get("words")

    logger.info(
        "deepgram_transcribe: success language=%s, %d chars",
        params.get("language") or ("detect" if params.get("detect_language") else "-"),
        len(text),
    )
    return {
        "text": str(text).strip(),
        "duration": duration,
        "words": list(raw_words) if isinstance(raw_words, list) else [],
        "raw": result,
    }
