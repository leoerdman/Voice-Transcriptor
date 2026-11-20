"""Per-collection recorded-audio retention.

The rule the user asked for, and what these tests pin:

  Live Capsule   — voice notes dictated all day. Keep the audio of the
                   newest 100 takes; older audio goes. (Was 3, which
                   deleted a day's evidence within hours — see the
                   policy table in backend/main.py.)
  Uploaded Media — the track extracted from a file the user brought in.
                   Keep it for 7 days regardless of how many there are.
  Transcripts    — never deleted, at any age or count, anywhere.

That replaced a single global "only the newest recording keeps audio"
rule which discarded a take's audio the moment the next was saved, and
applied the same wrong answer to both collections.
"""

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


NOW = 1_000_000_000.0
MINUTE = 60.0


class AudioRetentionTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._old_home = os.environ.get("HOME")
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)
        self.root = (Path(self._tmp.name) / "recordings").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        names = self.main.RECORDING_COLLECTION_DIR_NAMES
        self.live_dir = self.root / names[self.main.RECORDING_COLLECTION_LIVE]
        self.uploads_dir = self.root / names[self.main.RECORDING_COLLECTION_UPLOADS]

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        self._tmp.cleanup()
        self._home.cleanup()
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home

    def _recording(
        self,
        stem: str,
        *,
        age_sec: float,
        directory: Path | None = None,
        ext: str = ".webm",
        with_transcript: bool = True,
    ) -> Path:
        d = directory or self.root
        d.mkdir(parents=True, exist_ok=True)
        stamp = NOW - age_sec
        if with_transcript:
            txt = d / f"{stem}.txt"
            txt.write_text(self._app_transcript(stem), encoding="utf-8")
            os.utime(txt, (stamp, stamp))
        audio = d / f"{stem}{ext}"
        audio.write_bytes(b"audio")
        os.utime(audio, (stamp, stamp))
        return audio

    def _app_transcript(self, title: str) -> str:
        """A transcript as the app writes it — the header is what makes a
        same-stem media file the app's own (``_is_app_recording_text``)."""
        return self.main._render_recording_content(
            title=title,
            source_text="",
            transcript_text="transcript",
            provider="local",
            model="",
            language="",
        )

    def _set_live_keep(self, count: int) -> None:
        """Point the LIVE policy at a small count for a sweep test.

        The sweep reads the policy TABLE (that is the thing under test
        here), so a mechanism test bends the table rather than creating
        a hundred files. Each test imports its own module instance, so
        this cannot leak.
        """
        self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_LIVE] = (
            self._keep(count)
        )

    def _keep(self, count: int):
        """A count-only policy, for tests about the count MECHANISM.

        The default count lives in one assertion (PolicyTableTests); the
        rules that operate on it are exercised with a small explicit
        value so a change to the default does not need dozens of files
        created to observe them.
        """
        return self.main.AudioRetentionPolicy(max_items=count)

    def _surviving_audio(self, directory: Path) -> set[str]:
        return {
            p.name
            for p in directory.iterdir()
            if p.suffix.lower() in self.main._RECORDING_AUDIO_EXTS
        }


class PolicyTableTests(AudioRetentionTestBase):
    """The declarative SSOT itself."""

    def test_live_keeps_the_newest_hundred_and_has_no_age_limit(self) -> None:
        policy = self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_LIVE]
        self.assertEqual(policy.max_items, 100)
        self.assertEqual(policy.max_age_sec, 0)
        self.assertTrue(policy.enabled)

    def test_uploads_age_out_after_seven_days_with_no_count_limit(self) -> None:
        policy = self.main.AUDIO_RETENTION_POLICIES[
            self.main.RECORDING_COLLECTION_UPLOADS
        ]
        self.assertEqual(policy.max_age_sec, 7 * 24 * 3600)
        self.assertEqual(policy.max_items, 0)
        self.assertTrue(policy.enabled)

    def test_screen_sessions_keep_the_newest_five_and_have_no_age_limit(self) -> None:
        policy = self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_SCREEN]
        self.assertEqual(policy.max_items, 5)
        self.assertEqual(policy.max_age_sec, 0)
        self.assertEqual(
            self.main._audio_retention_policy_for_dir(
                self.root / self.main.RECORDING_COLLECTION_DIR_NAMES[
                    self.main.RECORDING_COLLECTION_SCREEN
                ]
            ),
            policy,
        )
        self.assertEqual(
            self.main._normalize_recording_collection("screen"),
            self.main.RECORDING_COLLECTION_SCREEN,
        )

    def test_a_policy_with_no_limits_is_disabled(self) -> None:
        self.assertFalse(self.main.AudioRetentionPolicy().enabled)

    def test_collection_folders_resolve_to_their_own_policy(self) -> None:
        resolve = self.main._audio_retention_policy_for_dir
        self.assertEqual(
            resolve(self.live_dir),
            self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_LIVE],
        )
        self.assertEqual(
            resolve(self.uploads_dir),
            self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_UPLOADS],
        )

    def test_archive_root_and_custom_dirs_fall_back_to_the_default(self) -> None:
        # The root predates the collection folders and held voice
        # recordings, so it must inherit the Live policy — not silently
        # become "no retention".
        resolve = self.main._audio_retention_policy_for_dir
        self.assertEqual(resolve(self.root), self.main.DEFAULT_AUDIO_RETENTION_POLICY)
        self.assertEqual(
            resolve(Path("/somewhere/custom")), self.main.DEFAULT_AUDIO_RETENTION_POLICY
        )
        self.assertEqual(
            self.main.DEFAULT_AUDIO_RETENTION_POLICY,
            self.main.AUDIO_RETENTION_POLICIES[self.main.RECORDING_COLLECTION_LIVE],
        )


class LiveCollectionCountTests(AudioRetentionTestBase):
    """Voice notes: keep the newest N audio files."""

    def test_keeps_exactly_the_newest_n(self) -> None:
        # The count rule itself, exercised with an explicit policy: the
        # DEFAULT count is asserted once, in PolicyTableTests, so raising
        # it does not need every mechanism test rewritten around the new
        # number.
        for i in range(1, 8):  # Take1 newest … Take7 oldest
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        deleted = self.main._prune_recording_audio(
            self.live_dir, now=NOW, policy=self._keep(3)
        )

        self.assertEqual(deleted, 4)
        self.assertEqual(
            self._surviving_audio(self.live_dir),
            {"Take1.webm", "Take2.webm", "Take3.webm"},
        )

    def test_every_transcript_survives_the_count_rule(self) -> None:
        for i in range(1, 8):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        self.main._prune_recording_audio(self.live_dir, now=NOW, policy=self._keep(3))

        for i in range(1, 8):
            self.assertTrue((self.live_dir / f"Take{i}.txt").exists(), f"Take{i}.txt")

    def test_age_alone_never_collects_a_live_recording(self) -> None:
        # No age dimension for Live: two very old takes are still the
        # two newest, so both keep their audio.
        old_a = self._recording("Ancient", age_sec=3650 * 24 * 3600, directory=self.live_dir)
        old_b = self._recording("Elder", age_sec=3600 * 24 * 3600, directory=self.live_dir)

        self.assertEqual(self.main._prune_recording_audio(self.live_dir, now=NOW), 0)
        self.assertTrue(old_a.exists())
        self.assertTrue(old_b.exists())

    def test_fewer_than_the_limit_deletes_nothing(self) -> None:
        kept = [
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)
            for i in range(1, 4)
        ]

        self.assertEqual(self.main._prune_recording_audio(self.live_dir, now=NOW), 0)
        for audio in kept:
            self.assertTrue(audio.exists(), audio.name)

    def test_just_saved_stem_is_exempt_but_still_occupies_a_slot(self) -> None:
        # The save path exempts its own stem. It must not thereby widen
        # the window to four: the fresh take IS one of the newest three.
        self._recording("Fresh", age_sec=0, directory=self.live_dir)
        for i in range(1, 5):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        deleted = self.main._prune_recording_audio(
            self.live_dir, keep_stems=("Fresh",), now=NOW, policy=self._keep(3)
        )

        self.assertEqual(deleted, 2)
        self.assertEqual(
            self._surviving_audio(self.live_dir),
            {"Fresh.webm", "Take1.webm", "Take2.webm"},
        )

    def test_exempt_stem_survives_even_when_ranked_out(self) -> None:
        # A clock skew that dates the new file into the past must never
        # let a save collect its own audio.
        skewed = self._recording("Skewed", age_sec=99 * 24 * 3600, directory=self.live_dir)
        for i in range(1, 5):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        self.main._prune_recording_audio(
            self.live_dir, keep_stems=("Skewed",), now=NOW, policy=self._keep(3)
        )

        self.assertTrue(skewed.exists())

    def test_same_mtime_ties_break_deterministically(self) -> None:
        for name in ("alpha", "bravo", "charlie", "delta", "echo"):
            self._recording(name, age_sec=MINUTE, directory=self.live_dir)

        self.main._prune_recording_audio(self.live_dir, now=NOW, policy=self._keep(3))

        # Descending name order among equal mtimes → e, d, c survive.
        self.assertEqual(
            self._surviving_audio(self.live_dir),
            {"echo.webm", "delta.webm", "charlie.webm"},
        )


class UploadsCollectionAgeTests(AudioRetentionTestBase):
    """Uploaded media: keep the extracted track for a week."""

    @property
    def window(self) -> int:
        return self.main.AUDIO_RETENTION_POLICIES[
            self.main.RECORDING_COLLECTION_UPLOADS
        ].max_age_sec

    def test_track_past_the_window_is_deleted(self) -> None:
        stale = self._recording(
            "Lecture", age_sec=self.window + 1, directory=self.uploads_dir, ext=".m4a"
        )

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 1)
        self.assertFalse(stale.exists())
        self.assertTrue((self.uploads_dir / "Lecture.txt").exists())

    def test_track_inside_the_window_survives(self) -> None:
        fresh = self._recording(
            "Recent", age_sec=self.window - MINUTE, directory=self.uploads_dir
        )

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 0)
        self.assertTrue(fresh.exists())

    def test_boundary_is_inclusive_of_the_window_edge(self) -> None:
        edge = self._recording("Edge", age_sec=self.window, directory=self.uploads_dir)

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 1)
        self.assertFalse(edge.exists())

    def test_count_alone_never_collects_an_upload(self) -> None:
        # No count dimension for uploads: twenty fresh files all stay.
        for i in range(20):
            self._recording(f"Clip{i:02d}", age_sec=MINUTE, directory=self.uploads_dir)

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 0)
        self.assertEqual(len(self._surviving_audio(self.uploads_dir)), 20)

    def test_future_dated_track_is_kept(self) -> None:
        future = self._recording("Future", age_sec=-3600, directory=self.uploads_dir)

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 0)
        self.assertTrue(future.exists())

    def test_video_containers_are_retained_like_audio(self) -> None:
        # _RECORDING_AUDIO_EXTS derives from ALLOWED_AUDIO_EXTS, so an
        # uploaded .mp4 is a candidate too — otherwise the heaviest
        # files in the archive would be the only ones exempt.
        self.assertIn(".mp4", self.main._RECORDING_AUDIO_EXTS)
        stale = self._recording(
            "Movie", age_sec=self.window + 1, directory=self.uploads_dir, ext=".mp4"
        )

        self.assertEqual(self.main._prune_recording_audio(self.uploads_dir, now=NOW), 1)
        self.assertFalse(stale.exists())


class SharedInvariantTests(AudioRetentionTestBase):
    """Rules that hold for every collection."""

    def test_orphan_audio_without_a_transcript_is_left_alone(self) -> None:
        # Either a stray file or a save in flight in another process —
        # neither is retention's to collect.
        orphans = [
            self._recording(
                f"Orphan{i}", age_sec=i * MINUTE, directory=self.live_dir,
                with_transcript=False,
            )
            for i in range(1, 9)
        ]

        self.assertEqual(self.main._prune_recording_audio(self.live_dir, now=NOW), 0)
        for audio in orphans:
            self.assertTrue(audio.exists(), audio.name)

    def test_non_audio_files_are_ignored(self) -> None:
        note = self.live_dir
        note.mkdir(parents=True, exist_ok=True)
        sidecar = note / "notes.md"
        sidecar.write_text("keep me", encoding="utf-8")
        os.utime(sidecar, (NOW - 99 * 24 * 3600,) * 2)
        for i in range(1, 6):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        self.main._prune_recording_audio(self.live_dir, now=NOW)

        self.assertTrue(sidecar.exists())

    def test_disabled_policy_deletes_nothing(self) -> None:
        for i in range(1, 9):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        deleted = self.main._prune_recording_audio(
            self.live_dir, now=NOW, policy=self.main.AudioRetentionPolicy()
        )

        self.assertEqual(deleted, 0)
        self.assertEqual(len(self._surviving_audio(self.live_dir)), 8)

    def test_both_dimensions_compose(self) -> None:
        # A policy carrying both limits collects a file failing EITHER.
        both = self.main.AudioRetentionPolicy(max_age_sec=3600, max_items=2)
        self._recording("New1", age_sec=MINUTE, directory=self.live_dir)
        self._recording("New2", age_sec=2 * MINUTE, directory=self.live_dir)
        self._recording("New3", age_sec=3 * MINUTE, directory=self.live_dir)   # over count
        self._recording("Old1", age_sec=7200, directory=self.live_dir)          # over both

        deleted = self.main._prune_recording_audio(
            self.live_dir, now=NOW, policy=both
        )

        self.assertEqual(deleted, 2)
        self.assertEqual(
            self._surviving_audio(self.live_dir), {"New1.webm", "New2.webm"}
        )


class SweepFanOutTests(AudioRetentionTestBase):
    """The sweep applies each directory's own policy."""

    def test_sweep_applies_the_matching_policy_per_collection(self) -> None:
        # Live: 5 recent takes → newest 3 survive.
        self._set_live_keep(3)
        for i in range(1, 6):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)
        # Uploads: one stale, one fresh — count is irrelevant here.
        stale_upload = self._recording(
            "OldClip", age_sec=8 * 24 * 3600, directory=self.uploads_dir
        )
        fresh_upload = self._recording(
            "NewClip", age_sec=MINUTE, directory=self.uploads_dir
        )

        removed = self.main._sweep_recording_audio_retention(now=NOW)

        self.assertEqual(removed, 3)  # 2 live over count + 1 stale upload
        self.assertEqual(
            self._surviving_audio(self.live_dir),
            {"Take1.webm", "Take2.webm", "Take3.webm"},
        )
        self.assertFalse(stale_upload.exists())
        self.assertTrue(fresh_upload.exists())
        # Transcripts in every collection survive the sweep.
        for i in range(1, 6):
            self.assertTrue((self.live_dir / f"Take{i}.txt").exists())
        self.assertTrue((self.uploads_dir / "OldClip.txt").exists())

    def test_sweep_is_idempotent(self) -> None:
        self._set_live_keep(3)
        for i in range(1, 6):
            self._recording(f"Take{i}", age_sec=i * MINUTE, directory=self.live_dir)

        first = self.main._sweep_recording_audio_retention(now=NOW)
        second = self.main._sweep_recording_audio_retention(now=NOW)

        self.assertEqual(first, 2)
        self.assertEqual(second, 0)

    def test_sweep_tolerates_a_missing_directory(self) -> None:
        missing = self.root / "gone"

        self.assertEqual(
            self.main._sweep_recording_audio_retention(target_dir=missing, now=NOW), 0
        )

    def test_sweeper_thread_not_started_when_every_policy_is_disabled(self) -> None:
        disabled = self.main.AudioRetentionPolicy()
        self.main.AUDIO_RETENTION_POLICIES = {
            key: disabled for key in self.main.AUDIO_RETENTION_POLICIES
        }
        self.main.DEFAULT_AUDIO_RETENTION_POLICY = disabled
        # The timer also owns the job results' age limit (BL-18); with that
        # off too, there is nothing for it to enforce.
        self.main.RESULT_RETENTION_SEC = 0
        self.main._audio_retention_sweeper_thread = None

        self.main.start_audio_retention_sweeper()

        self.assertIsNone(self.main._audio_retention_sweeper_thread)

    def test_sweeper_thread_still_starts_for_the_results_limit_alone(self) -> None:
        disabled = self.main.AudioRetentionPolicy()
        self.main.AUDIO_RETENTION_POLICIES = {
            key: disabled for key in self.main.AUDIO_RETENTION_POLICIES
        }
        self.main.DEFAULT_AUDIO_RETENTION_POLICY = disabled
        self.main.RESULT_RETENTION_SEC = 3600
        self.main._audio_retention_sweeper_thread = None

        self.main.start_audio_retention_sweeper()

        self.assertIsNotNone(self.main._audio_retention_sweeper_thread)


class RetentionLogTests(AudioRetentionTestBase):
    """BL-02: the retention line names a recording by timestamp + digest —
    its file name carries the first words dictated, and main.log is what
    users attach for support."""

    def test_the_removed_line_does_not_carry_the_title(self) -> None:
        self._recording("2026-11-08_10-00-00-000000__call mum about the tests", age_sec=5 * MINUTE)
        self._recording("2026-11-08_11-00-00-000000__newer", age_sec=1 * MINUTE)
        with self.assertLogs("backend.main", level="INFO") as logs:
            self.main._prune_recording_audio(self.root, now=NOW, policy=self._keep(1))
        joined = "\n".join(logs.output)
        self.assertIn("audio retention: removed 2026-11-08_10-00-00-000000#", joined)
        self.assertNotIn("call mum", joined)


class UserFilesAreNeverOursTests(AudioRetentionTestBase):
    """BM-03: the archive folder is user-chosen (it may be ~/Movies). A
    media file beside a same-stem ``.txt`` the app did not write is the
    user's own pair — retention and "delete all" must never touch it."""

    def _user_pair(self, directory: Path, stem: str, *, age_sec: float) -> tuple[Path, Path]:
        directory.mkdir(parents=True, exist_ok=True)
        stamp = NOW - age_sec
        txt = directory / f"{stem}.txt"
        txt.write_text("my notes for the talk", encoding="utf-8")
        media = directory / f"{stem}.mp4"
        media.write_bytes(b"user video")
        for p in (txt, media):
            os.utime(p, (stamp, stamp))
        return txt, media

    def test_retention_never_collects_a_users_own_media(self) -> None:
        txt, media = self._user_pair(self.root, "talk", age_sec=10 * MINUTE)
        self._recording("old-take", age_sec=5 * MINUTE)
        self._recording("new-take", age_sec=1 * MINUTE)

        self.main._prune_recording_audio(self.root, now=NOW, policy=self._keep(1))

        self.assertTrue(media.exists(), "the user's own video was deleted by retention")
        self.assertTrue(txt.exists())
        self.assertEqual(self._surviving_audio(self.root), {"new-take.webm", "talk.mp4"})

    def test_a_users_pair_does_not_take_a_slot_in_the_count(self) -> None:
        self._user_pair(self.root, "talk", age_sec=0)
        self._recording("only-take", age_sec=1 * MINUTE)

        self.main._prune_recording_audio(self.root, now=NOW, policy=self._keep(1))

        self.assertIn("only-take.webm", self._surviving_audio(self.root))

    def test_delete_all_leaves_a_users_own_pair_alone(self) -> None:
        txt, media = self._user_pair(self.root, "talk", age_sec=0)
        self._recording("take", age_sec=0)

        result = self.main._delete_all_recordings_sync()

        self.assertTrue(txt.exists(), "delete-all removed the user's own .txt")
        self.assertTrue(media.exists(), "delete-all removed the user's own video")
        self.assertFalse((self.root / "take.txt").exists())
        self.assertEqual(result, {"deleted": 1, "failed": 0})


if __name__ == "__main__":
    unittest.main()
