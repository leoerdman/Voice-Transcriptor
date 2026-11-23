"""OpenRouter — multimodal transcription & text upscaling.

Uses the chat completions endpoint with audio inputs for transcription,
and standard text completions for upscale/post-processing.
"""

import base64
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from backend.audio_mime import audio_content_type
from backend.http_retry import RemoteError, request_with_retry
from backend.model_catalog import (
    DEFAULT_OPENROUTER_AUDIO_MODEL,
    DEFAULT_OPENROUTER_UPSCALE_MODEL,
    OPENROUTER_AUDIO_MODELS,
)

logger = logging.getLogger(__name__)


class OpenRouterError(RemoteError):
    """OpenRouter-specific remote failure.

    Subclass of the generic ``RemoteError`` so callers can either:
      * catch ``OpenRouterError`` specifically (retry, fall back to
        local Whisper, pick a different OpenRouter model), or
      * catch ``RemoteError`` to handle any provider failure uniformly.

    Prior to this subclass, ``main.py`` imported the base ``RemoteError``
    under the alias ``OrRemoteError`` and pretended it was a distinct
    type — catching ``(OrRemoteError, DgRemoteError)`` was just
    catching ``RemoteError`` twice with no provider discrimination.

    ``status_code`` is the HTTP status OpenRouter answered with, when the
    failure IS an HTTP answer (``None`` otherwise: no key, a malformed
    body, an empty completion). Callers decide on it — the upscale
    model fallback used to search the message for "HTTP 404" / "not
    found", which also matched unrelated prose (BM-13).
    """

    def __init__(self, message: str, *, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


# One endpoint, named once: both calls below post to it.
OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"


def _content_text(raw_content: Any, *, what: str) -> str:
    """The text of a chat completion's ``message.content``.

    A string is the text. The multimodal form — a list of parts like
    ``{"type": "text", "text": "..."}`` — is the text of its text parts,
    joined. Anything else is a response this client does not understand
    and is raised as a provider error. ``str()`` of the list (what both
    callers used to do) delivered the Python repr ``[{'type': 'text',
    'text': '…'}]`` to the user as their transcript (BE-20).
    """
    if isinstance(raw_content, str):
        return raw_content
    if isinstance(raw_content, list):
        parts = [
            part.get("text")
            for part in raw_content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        if parts and all(isinstance(p, str) for p in parts):
            return "".join(parts)
    raise OpenRouterError(
        f"{what}: unexpected message content type {type(raw_content).__name__}"
    )


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _openrouter_audio_format(filename: str) -> str:
    """Return OpenRouter's `input_audio.format` token for *filename*.

    OpenRouter expects file-format identifiers (`mp3`, `m4a`, `webm`, ...),
    not MIME subtypes. Deriving the value from `audio/mpeg` produced `mpeg`
    for `.mp3`, and deriving it from `audio/mp4` produced `mp4` for `.m4a`.
    Keep this mapping at the provider boundary so the shared MIME SSOT can
    remain focused on HTTP Content-Type values.
    """
    ext = Path(filename or "").suffix.lower()
    by_ext = {
        ".wav": "wav",
        ".mp3": "mp3",
        ".m4a": "m4a",
        ".aac": "aac",
        ".flac": "flac",
        ".ogg": "ogg",
        ".oga": "ogg",
        ".opus": "opus",
        ".webm": "webm",
        ".mp4": "mp4",
        ".m4v": "mp4",
        ".mov": "mov",
    }
    if ext in by_ext:
        return by_ext[ext]
    return audio_content_type(filename or "audio.wav").split("/")[-1]


def _json_response(response: Any, context: str) -> Dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise OpenRouterError(f"{context}: invalid JSON response") from exc
    if not isinstance(payload, dict):
        raise OpenRouterError(f"{context}: unexpected JSON response type {type(payload).__name__}")
    return payload


def openrouter_transcribe(
    *, api_key: str, model: str, audio_bytes: bytes, filename: str
) -> Dict[str, Any]:
    """Best-effort transcription via OpenRouter audio inputs.

    OpenRouter routes to a multimodal model; output is plain text.
    Diarization depends on the model.
    """
    key = (api_key or "").strip()
    if not key:
        raise OpenRouterError("OpenRouter key is not configured")

    fmt = _openrouter_audio_format(filename or "audio.wav")

    url = OPENROUTER_CHAT_COMPLETIONS_URL
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "model": model or DEFAULT_OPENROUTER_AUDIO_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Transcribe audio exactly. Return only transcript text.",
                    },
                    {
                        "type": "input_audio",
                        "input_audio": {"data": _b64(audio_bytes), "format": fmt},
                    },
                ],
            }
        ],
        "stream": False,
        "temperature": 0.0,
    }

    logger.info("openrouter_transcribe: model=%s, audio=%d bytes", model, len(audio_bytes))
    # Adaptive timeout for OpenRouter audio. The request body embeds base64
    # audio in JSON, so large files still need a generous upload/read window.
    # Short live recordings must not inherit the old 180 s floor: when a
    # provider stalls, the UI should fall back promptly instead of looking
    # stuck on "Transcribe" for minutes.
    encoded_mb = max(1.0, (len(audio_bytes) * 1.34) / (1024 * 1024))
    if encoded_mb <= 2:
        read_timeout = 45
    elif encoded_mb <= 5:
        read_timeout = max(75, int(encoded_mb * 15))
    else:
        read_timeout = max(180, int(encoded_mb * 8))
    # Keep retry count bounded for interactive live-final use. The 2nd
    # attempt catches transient edge failures; a 3rd stalled attempt is
    # usually just extra UI latency before local fallback.
    upload_attempts = 2
    r = request_with_retry(
        "POST", url, headers=headers, json=payload,
        timeout=(10, read_timeout),
        attempts=upload_attempts,
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        # Audio-unsupported signature (BUG-66): the bare "image" token
        # misclassified unrelated errors (a model id containing "image",
        # throttling copy mentioning images) as audio-unsupported and
        # hid the real cause. The upstream refusal names the rejected
        # content type, so match the phrase, not one word.
        lowered = error_text.lower()
        if "input_audio" in lowered or "image input" in lowered:
            raise OpenRouterError(
                f"Model '{model}' does not support audio input. Please use a model that supports audio, "
                f"such as: {', '.join(OPENROUTER_AUDIO_MODELS)}",
                status_code=r.status_code,
            )
        raise OpenRouterError(f"openrouter failed: HTTP {r.status_code} {error_text}", status_code=r.status_code)

    js = _json_response(r, "OpenRouter transcribe")
    text = ""
    try:
        raw_content = js["choices"][0]["message"]["content"]
        # ``content`` is null whenever the model declines to answer
        # (safety refusal, empty audio, tool-call-only reply). The
        # previous code assigned it straight through, so the ``len(text)``
        # in the success log raised TypeError and the endpoint returned an
        # opaque HTTP 500 instead of a typed provider error the caller
        # could fall back from.
        if raw_content is None:
            raise OpenRouterError(
                f"OpenRouter model '{model or DEFAULT_OPENROUTER_AUDIO_MODEL}' "
                "returned no transcript content for this audio"
            )
        text = _content_text(raw_content, what="OpenRouter transcribe")
    except (KeyError, IndexError, TypeError) as shape_err:
        # OpenRouter changed the response shape (or echoed an empty
        # error envelope). Returning ``str(js)`` made the entire raw
        # API response — potentially echoing the user's prompt and
        # the audio's base64 payload — visible to the caller as if
        # it were the transcribed text. Far better to surface the
        # shape mismatch as an OpenRouterError so the route handler maps
        # it to a 502 with a sane message and the renderer falls
        # back to local Whisper.
        raise OpenRouterError(
            f"OpenRouter response shape unexpected: {type(shape_err).__name__}"
        ) from shape_err

    logger.info("openrouter_transcribe: success, %d chars", len(text))
    # ``duration`` is part of the adapter contract (see the Deepgram
    # adapter). A chat-completion response carries no audio duration, so
    # this one reports 0.0 — which is what the caller was already
    # getting, but now because this provider says so rather than because
    # the caller was reading another provider's payload shape.
    return {"text": text, "duration": 0.0, "raw": js}


def openrouter_upscale_text(
    *, api_key: str, model: str, text: str, instruction: str
) -> Dict[str, Any]:
    """Upscale/improve transcript text via OpenRouter chat completion."""
    key = (api_key or "").strip()
    if not key:
        raise OpenRouterError("OpenRouter key is not configured")

    source_text = (text or "").strip()
    if not source_text:
        raise OpenRouterError("empty text for upscale")

    url = OPENROUTER_CHAT_COMPLETIONS_URL
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "model": model or DEFAULT_OPENROUTER_UPSCALE_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You improve transcript text quality. Preserve meaning and language. "
                    "Return only final polished text without explanations."
                ),
            },
            {
                "role": "user",
                "content": f"{instruction}\n\nText:\n{source_text}",
            },
        ],
        "temperature": 0.15,
        "stream": False,
    }

    logger.info("openrouter_upscale: model=%s, text=%d chars", model, len(source_text))
    # Same (connect, read) split as openrouter_transcribe. Upscale can
    # be slower than transcribe (large Gemini generations), so read budget
    # is 120s. Connect budget stays at 10s — DNS path is identical.
    r = request_with_retry("POST", url, headers=headers, json=payload, timeout=(10, 120))

    if r.status_code >= 400:
        raise OpenRouterError(
            f"openrouter upscale failed: HTTP {r.status_code} {r.text[:400]}",
            status_code=r.status_code,
        )

    js = _json_response(r, "OpenRouter upscale")
    try:
        raw_content = js["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as shape_err:
        # A response-shape change must not masquerade as "empty text"
        # (BUG-66): triage needs to see WHAT was actually received.
        raise OpenRouterError(
            f"openrouter upscale: unexpected response shape ({shape_err}): {str(js)[:200]}"
        ) from shape_err
    # ``openrouter_transcribe`` coerces defensively for exactly this
    # reason and this function did not: a model answering with the
    # multimodal form (``content: [{"type": "text", ...}]``) reaches
    # ``.strip()`` on a list, and ``AttributeError`` is not in the tuple
    # above — so it escaped as an unredacted 500 instead of a provider
    # error the caller could fall back from.
    if raw_content is None:
        raise OpenRouterError("openrouter upscale returned no content")
    out_text = _content_text(raw_content, what="openrouter upscale").strip()
    if not out_text:
        raise OpenRouterError("openrouter upscale returned empty text")

    logger.info("openrouter_upscale: success, %d chars", len(out_text))
    return {"text": out_text, "raw": js}
