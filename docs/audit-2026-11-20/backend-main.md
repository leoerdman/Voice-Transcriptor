# Ultra-Audit · backend/main.py + support modules (read-only)

Repo: /Users/leoerdman/Programming - Main/Voice Transcriptor, HEAD acbf737. Method: full read of the areas below (main.py read in all non-Deepgram-internal regions; Deepgram live internals 4560-6030 only skimmed — another auditor owns them), then §2 classes per sub-area. Paths are relative to the repo; lines are as of HEAD and will drift, symbols are given.

## Coverage
| Area | Status | Notes |
|---|---|---|
| main.py 1-700 (logging, watchdog, errors redaction, limits, Host/WS-auth helpers, env) | viewed | |
| main.py 700-1700 (presets, token, tmp sweep, rate limit, live-recovery spool/list/promote, auth dep, `GET /`) | viewed | |
| main.py 1700-3060 (ui state, warmup, network, upload/copy helpers, naming/claims, dir resolvers) | viewed | |
| main.py 3060-3830 (collections, retention, scan caches, registry, sweeper, text writer) | viewed hard | screen retention |
| main.py 3830-4560 (upscale presets, WS handler head, recovery spool) | viewed | |
| main.py 4560-6030 (Deepgram/local live sessions) | partial (skim) | other auditor |
| main.py 6030-7215 (jobs, remote, upscale, cli routes, config routes) | viewed | |
| main.py 7215-8164 (folder routes, list/delete-all/get/audio/screens/stats/save*) | viewed hard | |
| screen_sessions.py, contracts/screen-session.json | viewed fully | |
| config.py, data_dir.py, storage.py, jobs.py | viewed fully | |
| audio.py, audio_constants.py, audio_mime.py | viewed fully | |
| cli_access.py, cli.py | viewed fully | |
| models_manager.py, model_catalog.py, http_retry.py, async_tasks.py | viewed fully | |
| tests: test_screen_sessions.py, test_audio_retention.py (screen parts), test_cli_access.py (route rules) | viewed | other tests only grepped |

Known/closed not re-reported: B-011, B-025, B-038, B-057, B-059, B-063, B-065, B-088 (list in BUGSAUDIT-2026-09-04 §6). `GET /` token injection itself is documented (backend-findings.md:31) as design; BM-01 is about its interaction with the CLI token.

## Findings

### BM-01 · backend/main.py `index()` × backend/cli_access.py `_CLI_ROUTES`/module docstring — the CLI token's restriction is cosmetic: any holder can fetch the renderer token from unauthenticated `GET /`
- Reproduce: take base_url from `<data>/cli/connection.json` (the CLI token holder has it), `curl http://127.0.0.1:PORT/` → HTML contains `window.__TRANSCRIPTOR_API_TOKEN="..."`; send it as `x-api-token` → `GET /api/config`, `GET /api/recordings`, `DELETE /api/recordings`, `POST /api/cli/disable`.
- Consequence: cli_access.py claims "it cannot read or write the config, provider keys, the archive listing or the live socket"; `test_everything_else_is_closed` pins that. In reality the separation holds only against code that does not know `GET /`. Any local process (incl. another OS user on a shared Mac) gets full control. Host allowlist only stops DNS rebinding, not local callers.
- Severity P1, confirmed. Path: any local client → `GET /` (no `Depends(_require_api_auth)`) → token → every route.
- Current:
```python
@app.get("/", response_class=HTMLResponse)
def index():
    ...
    f'window.__TRANSCRIPTOR_API_TOKEN={json.dumps(API_TOKEN)};'
```
- Fixed: stop serving the token over HTTP. Electron owns the process: hand it over via preload/IPC (or a per-launch secret the main process injects into the request: require header `x-bootstrap-nonce` == `TRANSCRIPTOR_BOOT_NONCE`/a launch secret known only to the shell, else serve the page without the token). Until then correct the docstring and the "cannot read the archive" claim.
- Why a bug: two documents (cli_access docstring + tests) assert an isolation the code does not provide; the CLI feature exists specifically to hand a *weaker* credential to agents.

### BM-02 · backend/main.py `save_recording_from_path` + `_save_recording_audio_source` × `cli_access._CLI_ROUTES` — the CLI token may overwrite existing recordings and register arbitrary archive dirs
- Reproduce: `POST /api/recordings/save-from-path` with the CLI token, body `{"source_path": "/any/file.wav", "name": "<existing>.txt", "archive_dir": "~/<any dir under home>"}` (route is on the CLI list; the handler forwards `name`, `archive_dir`, `recording_collection`, `require_existing`). The existing recording's audio is replaced (`audio_backup` then deleted) and its `.txt` rewritten (empty transcript → "[No speech captured]"). `_register_archive_dir` then adds any home dir to the retention registry (see BM-03).
- cli.py `save_to_archive` sends none of `name/archive_dir/...`, so the route is wider than its only caller needs. test_cli_access only asserts the route is open (`assertTrue(may("POST", "/api/recordings/save-from-path"))`) — no payload restriction is tested.
- Severity P1, confirmed (CLI token → `_save_recording_audio_source(existing_name=...)`).
- Fixed: for a CLI-token caller force `name=""`, `require_existing=False`, `archive_dir=""`, `recording_collection="uploads"`; i.e. pass the caller kind from `_require_api_auth` (e.g. `request.state.caller = "cli"`) into the handler, and add a test that a CLI request with `name` is rejected (400/403).
- Why a bug: the credential is documented as "transcribes, nothing else"; overwriting user data is outside that.

### BM-03 · backend/main.py `_prune_recording_audio`, `_delete_all_recordings_sync`, `_audio_retention_policy_for_dir` — retention and "delete all" treat every same-stem media file in ANY registered dir as app-owned
- Reproduce: set Recordings folder (or save once with `archive_dir`) to a folder with the user's own media, e.g. `~/Movies`, containing `talk.mp4` + `talk.txt` and >100 pairs. `_register_archive_dir` stores it forever (`known_archive_dirs.json`, no removal path); the hourly sweeper then applies the default (Live, newest 100) policy → unlinks `talk.mp4`. `DELETE /api/recordings` deletes every `.txt` in every registered dir plus its same-stem audio/video.
- Consequence: deletion of user files that Transcriptor never created. No ownership marker (manifest / header check) is consulted; the only test is "a sibling .txt exists".
- Severity P1, confirmed mechanism (path: Settings folder or BM-02 → `_register_archive_dir` → `_sweep_recording_audio_retention` / delete-all).
- Fixed: before collecting a file or deleting a `.txt`, require the app's own header (`_extract_meta_field(raw,"Provider")`/`Saved at:` first lines produced by `_render_recording_content`) and refuse dirs not created by the app (marker file written on first save), plus drop dead registry entries.
- Why a bug: "audio without a transcript is left alone" shows the intent is to touch only app-owned pairs, but the pairing rule is a name coincidence.

### BM-04 · backend/main.py `_open_live_recovery` meta + `_promote_live_recovery` × backend/screen_sessions.py `sweep_orphan_sessions` — a crashed screen-mode take loses its screenshots
- Reproduce: record in screen mode, kill the app mid-take. Next start: renderer promotes the spool → `Recovered <ts>.wav/.txt` in `Screen Sessions` (collection is in the sidecar) but the sidecar has no `screen_session_id`; `_promote_live_recovery` never calls `adopt_session`. The staged folder `<data>/screen-sessions/<id>` is deleted by `_cleanup_live_recovery_files` after `LIVE_RECOVERY_RETENTION_SEC` (24 h).
- Consequence: screen recording with its marks/screenshots irrecoverably split; screen_sessions.py's docstring ("the same window the audio spool of such a take is kept for") implies recoverability that does not exist. Also the recovered recording is subject to the Screen retention count without screens.
- Severity P1, confirmed (data loss on the crash path the recovery subsystem exists for).
- Fixed: put `screen_session_id` (WS query param) into `meta_payload` in `_open_live_recovery` and, in `_promote_live_recovery`, call `screen_sessions.adopt_session(DATA_DIR, meta["screen_session_id"], target_dir, stem, audio_started_at=...)` before `_prune_recording_audio`; extend the orphan sweep to skip sessions still referenced by a live recovery sidecar.
- Why a bug: two owners (recovery spool, staging folder) of one take with no link between them.

### BM-05 · backend/screen_sessions.py `adopt_session` + main.py `_save_recording_audio_source` — adoption destroys the old screenshots first, can leave a partial folder, and only `OSError` is handled
- Current:
```python
dest = screens_dir(target_dir, stem)
if dest.exists():
    shutil.rmtree(dest, ignore_errors=True)
shutil.move(str(source), str(dest))
manifest = _rehome_manifest(read_manifest(dest) or {...}, dest)
```
  and in the caller `except OSError as e: logger.warning("... adoption failed")`.
- Reproduce: (a) re-save of an existing recording with a new `screen_session_id` on a different volume / full disk: old `<stem>.screens` is already rmtree'd, `shutil.move` falls back to copytree, fails mid-way → partial `dest` stays and is listed by `list_screenshots`, the staged source still exists, response says `screens: null`; frontend `screenManifest = parseScreenManifest(persisted.screensManifest) || stagedScreenManifest` (main.tsx ~12682) then points the transcript at the staging paths that the orphan sweep will delete. (b) `events` not iterable (e.g. `"events": 5`) → `TypeError` in `_rehome_manifest`, not an `OSError` → HTTP 500 after audio and transcript were already saved and the staged folder already moved (retry finds nothing to adopt).
- Severity P1, confirmed code paths (a: ENOSPC/EXDEV; b: malformed events.json written by the shell).
- Fixed: move to `dest.with_name(dest.name + ".adopting-<hex>")`, rewrite the manifest there (validated), then `os.replace` over the old folder (rename-swap, old removed after); on any failure remove the temp copy, leave staging intact and return a structured failure; catch `(OSError, ValueError, TypeError)`; make the caller return `screens_error` instead of `null` so the renderer does not fall back to staging paths.
- Why a bug: error converted to success with a different truth (staging paths) held by the client.

### BM-06 · backend/screen_sessions.py `_write_manifest` / `adopt_session` — manifest rewrite failure swallowed; second atomic writer beside `backend/storage.py`
- `_write_manifest` re-implements tmp+replace without fsync, with tmp name `events.json.tmp-<pid>` (decimal pid) — not matched by `storage.TMP_ORPHAN_RE` (`[0-9a-f]{6,}`) and living inside `*.screens`, which `_sweep_orphan_tmp_files` never enters. On `OSError` `adopt_session` only logs and returns the in-memory rehomed manifest, while the archive keeps the OLD manifest (staging paths, no `audioStartedAt`) — exactly the field the docstring says every later re-transcription needs.
- Severity P2, confirmed. Reproduce: make events.json unwritable (read-only copy from a read-only source volume).
- Fixed: use `storage.atomic_write_json(folder/EVENTS_FILE_NAME, manifest)` (storage is stdlib-only, so the "dependency-free" argument does not hold) and treat failure as adoption failure (BM-05).
- Why a bug: AGENTS.md rule 2 (parallel implementation of an SSOT writer) + silent fallback.

### BM-07 · backend/main.py `_prune_recording_screens` × `_prune_recording_audio` — "same ranking" is two separate rankings on two different mtimes
- Audio candidates rank among audio files by file mtime; screens rank among `.screens` folders by directory mtime (changed by adoption's `events.json` rewrite, by any later entry). A recording whose audio is re-saved/updated (name given → new audio mtime) or whose recovery-promoted audio has no screens (BM-04) shifts the audio rank but not the screens rank, so a recording's audio can be kept while its screenshots go, or vice versa. test_screen_sessions only uses identical mtimes for both.
- Severity P2, hypothesis (needs a re-save or promote of a screen-collection recording; no executed repro).
- Fixed: compute the keep set once per stem (rank recordings, not files) and delete audio and screens of the same stems from that one set.
- Why: docstring says "kept or collected as one kind of thing, never by a second count" — it is a second list.

### BM-08 · backend/main.py `_prune_recording_screens`, `_delete_all_recordings_sync` — `.screens` folders whose `.txt` is gone are never collected
- Prune requires `screens_stem in text_stems`; delete-all iterates `.txt` files only. User deletes `x.txt` in Finder (the archive is a visible folder, `open-folder` route exists) → `x.screens` with PNGs (MBs each) stays forever and `DELETE /api/recordings` does not remove it.
- Severity P2, confirmed. Fixed: delete-all also removes `*.screens` dirs without a sibling `.txt`; prune treats an orphan `.screens` older than a grace period like an orphan staging folder.

### BM-09 · backend/main.py comments at `RECORDING_COLLECTION_SCREEN` and the retention block × desktop/screen-mode.js header — two contradictory statements of who owns screenshot retention
- main.py: "Their screenshots live in the desktop shell's screen-session store, which keeps the same newest-N count" and "the same count the desktop shell keeps for their screenshot batches". screen-mode.js/screen_sessions.py: the backend owns it, the shell deletes nothing but discarded takes. P2 confirmed (docs vs code). Fix: delete the stale sentences (and the "newest five" literal in screen_sessions.py's docstring — it is `TRANSCRIPTOR_SCREEN_AUDIO_KEEP_COUNT`'s default, a fourth copy next to `.env.example:60`).

### BM-10 · backend/screen_sessions.py `screenshot_path` vs `list_screenshots`/`is_screens_dir` — two different guards for "is this a screens folder"
- `list_screenshots` rejects a symlinked folder; `screenshot_path` checks only the file. A `<stem>.screens` symlink to a directory containing `shot-01.png` is listed as empty but served. P2 confirmed (local-user only). Fix: one helper `_screens_dir_or_none(target, stem)` used by both and by `_read_recording_payload` (which today calls `screens_dir()` + `is_screens_dir()` three times).

### BM-11 · backend/main.py `_delete_all_recordings_sync` — screenshots removed with `ignore_errors=True` after the transcript is already unlinked and the item is counted deleted
- A failing `rmtree` (permissions, open file on Windows) leaves screenshots, increments `deleted`, and nothing is logged; ordering (txt unlinked first, rollback only covers audio) means the failure cannot be undone. P2 confirmed. Fix: rename `.screens` to a `.tmp-<hex>` sibling together with the audio backup, delete after txt, log failures, count `failed`.

### BM-12 · backend/main.py `_save_recording_audio_source` — blocking filesystem work inside an `async def` on the event loop
- `atomic_promote_file(tmp_audio, out_audio)` (fsync of up to 2 GB), `adopt_session` (`shutil.move`/copytree of PNGs), `_prune_recording_audio` (iterdir + stat of the whole dir), `_claim_recording_text_path` (iterdir per candidate), `_write_recording_text_file` (fsync) are all called directly in the coroutine; only the source copy is `to_thread`. While a big upload is being filed, live WS frames and every other request stall.
- Severity P2, confirmed (code path: `POST /api/recordings/save-with-audio` with a large upload while a live session is streaming). Fix: run the post-write section in `asyncio.to_thread` as one synchronous function (also makes BM-05's swap testable).

### BM-13 · backend/main.py `_run_remote_transcribe_once`, `upscale_text`; backend/http_retry.py error hints — control flow decided by substrings of error prose
- `if "ffmpeg is not installed" not in err_text` (audio.py wording), `if ("HTTP 404" in msg) or ("not found" in msg.lower())` for model fallback, `"ssl" in err_lower` / `"tls"` hints. A reworded message silently changes behaviour; `"not found"` also matches e.g. "audio file not found".
- Severity P2, confirmed. Fix: `class FfmpegMissingError(AudioError)` raised by `_has_ffmpeg()` sites; carry `status_code` on `OpenRouterError`.

### BM-14 · backend/audio.py `ensure_wav_16k` × `ensure_wav_16k_preserve_channels` — ~90 duplicated lines, and the two choose different audio tracks
- Both implement fast-path / ffmpeg / no-ffmpeg-WAV fallback separately. Only the preserve variant (and the remote compactor) pass `-map 0:a:0 -vn -sn -dn`; the mono variant lets ffmpeg pick the "best" stream (most channels). A multi-track mp4 can therefore be transcribed from track 1 on the split-stereo path and from another track on the mono path.
- Severity P2, confirmed (code). Fix: one function with `channels: Optional[int]`; one argv builder (also owns `-nostdin`, `-map`).

### BM-15 · backend/main.py `_upload_queue_str/_upload_queue_number` × `_live_draft_str/_live_draft_number` — same helpers written twice
- Identical number parser (`0 <= parsed < inf`), same strip+cut string parser with different default caps (200 000 vs 4096). P2 confirmed. Fix: one `_clamped_text(value, max_len)` / `_nonneg_number` in a small module.

### BM-16 · backend/main.py `save_recording` × `_save_recording_audio_source` — argument normalisation and target/existing-name branching restated
- Both parse `name/title/source/transcript/provider/model/language`, resolve `target_dir` via `_resolve_recordings_collection_target_dir`, and branch on `existing_name`/`require_existing`/claim. B-031/B-032 unified only the placeholder rule. P2 confirmed. Fix: one `_normalize_save_request()` returning a dataclass used by both.

### BM-17 · backend/cli_access.py `command_cards` — Windows "Add to PATH" card is `setx PATH "%PATH%;<dir>"`
- `%PATH%` is the merged system+user path: the command writes system entries into the user PATH and truncates at 1024 chars (silently, `setx` warns only in its own stdout). P2 confirmed (documented `setx` behaviour; command shown to the user verbatim). Fix: show the PowerShell `[Environment]::SetEnvironmentVariable("Path", ...User)` form reading the User value, or just the wrapper path.

### BM-18 · backend/cli_access.py `CliAccess.disable` / `status` — revoke can silently fail and the switch reports memory, not the file system
- `disable()` clears `_token` first, then logs (not raises) on `unlink` OSError. Token file survives; `status()["enabled"]` says false; the next boot `load()` re-enables the old token. Docstring of `enable()` says "the switch reports what the file system holds".
- Severity P2, confirmed (unlink failure: Windows lock, read-only dir). Fix: make `is_enabled` derive from the token file after the attempt, and have `/api/cli/disable` answer 500 when it still exists.

### BM-19 · backend/main.py `create_job_from_path`/`create_remote_job_from_path` × cli.py `cmd_transcribe` — every CLI transcription leaves a full copy of the source for 24 h
- `_snapshot_source_media_for_job` copies+hashes the file (up to 2 GB) into `UPLOADS_DIR`, `cleanup_upload_path=False`; removed only by `_cleanup_expired_files` after `RESULT_RETENTION_SEC` (86 400 s), triggered by later job calls. cli.py documents "once per file over a directory". 500 videos ⇒ hundreds of GB until the sweep. Without `--save` the snapshot is never used again.
- Severity P2, confirmed (bounded by time, not size). Fix: delete the snapshot when the job reaches a terminal state unless the caller asked to keep it (`keep_source` flag set by `--save`), or cap `UPLOADS_DIR` total bytes.

### BM-20 · backend/cli.py `--token` / `--base-url` — secret accepted in argv
- Visible to every user via `ps`. Docstring offers it for "a wrapper invoked from another machine's shell". P2, hypothesis (only if used). Fix: accept `TRANSCRIPTOR_CLI_TOKEN` env or stdin instead.

### BM-21 · backend/config.py `_load_or_create_fernet_key` / `_clear_empty_keyfile` — whitespace-only keyfile = permanent "no encryption", with a log that says "regenerating"
- File containing "\n": `raw=strip()` is empty → `_read_existing_keyfile` returns b"" and logs "corrupted — regenerating"; `_clear_empty_keyfile` checks `st_size != 0` → False; `O_EXCL` create → `FileExistsError` → `raced_key` empty → still not cleared → `return b""` → `_FERNET=None` for the life of the install, every `POST /api/config` with a key answers 503 (the B-020 class, residual). Same for any non-empty invalid content. P2 confirmed. Fix: decide on the stripped content ("no usable key") and move an invalid non-empty keyfile aside (`.encryption_key.corrupt-<ts>`) before creating a new one; fix the message.

### BM-22 · backend/config.py `_adopt_legacy_encryption_key` — unlink-then-create keyfile replacement
- `_KEYFILE.unlink(missing_ok=True)` precedes `os.open(O_EXCL)`; if the create fails the on-disk key is gone while `_FERNET` still holds the in-memory key created at import, later saves encrypt with a key that exists nowhere (the exact silent-loss scenario the 1.1.25 comment describes). P2, hypothesis (needs a write error in that window). Fix: write `.tmp-<hex>` via `os.open(0o600)` and `os.replace`.

### BM-23 · backend/models_manager.py `_download_worker` — import outside `try`, and a `time.sleep(0.5)` that does nothing
- `from huggingface_hub import hf_hub_download, list_repo_files` sits before the `try`; an ImportError kills the thread with the state still `"downloading"` (B-045 class: model neither downloadable nor deletable until restart; `whisper_downloaded` tolerates the same ImportError so `start_download` gets this far). The `finally: time.sleep(0.5)  # give pollers a moment` runs after the terminal state is already set — pollers read the stored state, the sleep only holds the thread. P2 confirmed. Fix: move the import inside the `try`, delete the sleep.

### BM-24 · backend/http_retry.py `request_with_retry` — `retries` means attempts; a superseded transient response is only closed if another transient follows
- `attempts = max(1, int(retries or 0))`, default `retries=3` ⇒ 2 retries; docstring/param name say retries. `last_resp` is closed only when replaced by another transient `resp`; if attempt 2 succeeds (or raises `RequestException`) the earlier 5xx stays referenced; after a mixed sequence (503, then two `RequestException`s) the function raises `RemoteError` although a response was in hand. P2 confirmed (naming/semantics; the leak matters for `stream=True` callers). Fix: rename to `attempts`; close `last_resp` on every exit.

### BM-25 · backend/main.py `network_status` — polled endpoint probes three third-party hosts every ~10 s and never short-circuits
- Renderer polls `/api/network` (muted in the access log for exactly that reason); each poll does up to three sequential `urlopen` to openrouter.ai, google.com, cloudflare.com even once one answered (loop only keeps the best latency). Privacy/telemetry footprint and 3× the work for a boolean. P2 confirmed. Fix: stop at first success, or use the OS reachability event (Electron `online/offline`) instead of polling.

### BM-26 · backend/main.py `_save_upload_file` / upload routes — `MAX_UPLOAD_BYTES` is enforced only after Starlette has already spooled the whole multipart body
- The 413 check runs while copying from `UploadFile`; the body was already written to a temp file by the parser (no limit) so a >2 GB body fills the temp volume first. Also the chunk loop does blocking `f.write` on the loop. P2, hypothesis (not executed; depends on Starlette version). Fix: reject on `Content-Length` in a middleware before parsing, or stream the body manually.

### BM-27 · backend/tests — screen adoption and CLI scope have no end-to-end tests
- No test calls `/api/recordings/save-with-audio` (or `_save_recording_audio_source`) with `screen_session_id`; nothing covers adoption of an existing recording, a failing move, a malformed `events.json`, a failing manifest rewrite, `RECORDING` + recovery (BM-04), or the orphan sweep against a session an active take still writes to. `test_screen_sessions.py` ranking tests give audio and folders identical mtimes. `test_cli_access.py::test_transcription_routes_are_open` asserts `save-from-path` is open but nothing asserts its payload is restricted (BM-02). P2 confirmed.

### BM-28 · backend/main.py `_live_recovery_paths`, `_delete_live_recovery` — suffix glob can match another session
- Spool name is `<ts>_<session_id>`; `glob(f"*_{sid}.pcm16")`/`*_{sid}.json` for id `b` also matches `<ts>_a_b` (ids may contain `_`; BUG-52 already notes this for the reverse parse). discard/promote of `b` can act on session `a_b`. P2, hypothesis (ids are UUIDs from the renderer today). Fix: match exactly `[0-9]{8}_[0-9]{6}_` + sid.

### BM-29 · backend/main.py `_build_recordings_stats_payload` — `min/max/avg_duration_sec` are word counts ÷ 150 wpm, exposed as durations
- Real audio duration is known for recordings that have audio (and `duration` in live sidecars); the endpoint reports an estimate under a duration name. P2 confirmed (UX/accuracy). Fix: name it `estimated_*` or read WAV headers.

## Clean places (checked, no finding)
- Path traversal: `_recording_text_name_leaf`, `_normalize_filename`, `_resolve_recordings_target_dir` (resolve + home containment), `screenshot_path` name regex, `SCREEN_SESSION_ID_RE.fullmatch` before any join in `adopt_session`/`sweep_orphan_sessions`, `_upscale_preset_path`, `LIVE_SESSION_ID_RE` — all reject separators; routes `/api/recordings/{name}[/audio|/screens/{file}]` cannot escape the archive dir.
- Auth: constant-time compares in HTTP and WS, `/api/health` and `/` the only unauthenticated routes (see BM-01), WS token in subprotocol not URL, Host allowlist applied on WS, Origin check on mutating methods, error text redacted by `_safe_error_text`, no key in logs (`_log_target` strips query, `redact_config`).
- Orphan sweep vs an ACTIVE session: sweep uses dir mtime and a 24 h window, the active take writes its folder continuously and `finishNow` rewrites events.json, so a live session is not collected (only the BM-04 case, where the take is dead).
- Adoption on update of an existing recording: handled (`dest` replaced), subject to BM-05's ordering. Collision with a stale `<stem>.screens` for a new recording: `_recording_stem_available` compares `entry.stem`, so the folder reserves the stem.
- Scan caches: `_recordings_scan_cache_key` includes the dir mtime, so adoption/retention removal of a `.screens` folder changes the key and every save also calls `_invalidate_recordings_cache`; `_recordings_entry_cache` is pruned to the live set (bounded); `_live_promote_cache`/rate buckets/job store are bounded (TTL, hard caps).
- Rename paths: there is no rename/delete-one route; the only deleters are retention, delete-all and failed-save rollback (all reviewed).
- Config: schema migration/stamp idempotent (B-018 closed), `_deep_merge` results are deep-copied before reaching callers, key redaction + masked-key round trip, backup rotation only from a valid primary.
- storage.py atomic writers (fsync file+dir, tmp cleanup, chmod after replace is non-fatal); async_tasks.py cancellation rule; jobs.py (setters tolerate pruned ids, cancel event, hard ceiling); model_catalog.py single list sources; audio_mime/ALLOWED_AUDIO_EXTS import-time drift assert; cli.py exit codes, poll interval vs the 1200/min limit, locale-safe output.
