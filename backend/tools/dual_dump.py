"""Canonical JSON format for captured and replayed dual readings."""

from __future__ import annotations

import json
from pathlib import Path


def build_dump(*, file: str, primary_language: str, secondary_language: str,
               expected_languages: list[str], keyterms: list[str],
               primary_segments: list[dict], secondary_segments: list[dict],
               messages: dict[str, list[dict]] | None = None) -> dict:
    return {
        "format": "voice-transcriptor.dual-reading.v1",
        "file": file,
        "primary_language": primary_language,
        "secondary_language": secondary_language,
        "expected_languages": expected_languages,
        "keyterms": keyterms,
        "primary_segments": primary_segments,
        "secondary_segments": secondary_segments,
        "messages": messages or {},
    }


def load_dump(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: dual-reading dump must be a JSON object")
    return data


def write_dump(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
