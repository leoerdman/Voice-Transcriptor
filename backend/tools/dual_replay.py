"""Re-merge two recorded Deepgram readings offline.

``python -m backend.tools.deepgram_live_ab FILE.wav --language multi
--dual ru --dump-readings DIR`` saves, per run, the two readings the
shipped ``DualLiveSession`` merged — each exactly as its session
delivered it. This tool feeds such a file back through
``backend.deepgram_dual.merge_readings`` (the working tree's rules) and
prints the merged transcript, the merge counters and, with ``--words``,
every delivered word with the reading it came from.

It exists so a change to the merge rules is judged against REAL
readings of the user's recordings without paying Deepgram once per
variant of the rule: stream once, replay as often as needed. It never
touches the network.

Usage::

    python -m backend.tools.dual_replay DIR/take.multi+ru.run1.json [--words]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.deepgram_dual import merge_readings  # noqa: E402
from backend.tools.dual_dump import load_dump  # noqa: E402


def merge_dump(data: dict, *, expected_languages: "list[str] | None" = None):
    expected = expected_languages if expected_languages is not None else data.get("expected_languages") or []
    return merge_readings(
        data.get("primary_segments") or [],
        data.get("secondary_segments") or [],
        primary_language=str(data.get("primary_language") or "multi"),
        secondary_language=str(data.get("secondary_language") or "ru"),
        expected_languages=expected,
        keyterms=data.get("keyterms") or [],
    )


def replay(path: Path, *, words: bool, expected_languages: "list[str] | None" = None) -> str:
    data = load_dump(path)
    merged = merge_dump(data, expected_languages=expected_languages)
    lines = [
        f"{data.get('file', path.name)}: merged={len(merged.words)} words "
        f"filled_from_secondary={merged.filled_from_secondary} "
        f"filled_from_primary={merged.filled_from_primary} "
        f"dups_removed={merged.duplicates_removed} "
        f"contested_to_secondary={merged.contested_to_secondary} "
        f"contested_to_primary={merged.contested_to_primary}",
        merged.text,
    ]
    if words:
        for w in merged.words:
            conf = w.get("confidence")
            c = f"{conf:.3f}" if isinstance(conf, (int, float)) else "  n/a"
            lines.append(
                f"    {w['start']:7.2f}-{w['end']:7.2f} conf={c} "
                f"lang={w.get('language') or '-':<3} src={w.get('source') or '-':<5} "
                f"{w['word']}"
            )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dual_replay",
        description="Re-merge readings saved by deepgram_live_ab --dump-readings.",
    )
    parser.add_argument("dumps", nargs="+", help="JSON file(s) written by --dump-readings")
    parser.add_argument("--words", action="store_true", help="print every merged word")
    parser.add_argument(
        "--expect", action="append", default=None, metavar="CODE",
        help="declared language(s) for the merge (repeat); overrides the dump's. "
             "--expect none replays with no declared languages.",
    )
    return parser


def main(argv: "list[str] | None" = None) -> int:
    args = build_parser().parse_args(argv)
    for name in args.dumps:
        expected = None if args.expect is None else [c for c in args.expect if c != "none"]
        print(replay(Path(name), words=args.words, expected_languages=expected))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
