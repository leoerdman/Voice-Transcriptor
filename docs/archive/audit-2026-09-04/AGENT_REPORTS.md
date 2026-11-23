# Отчёты агентов, дословно (сессии 2026-09-03 → 2026-09-05)

Зачем этот файл: чтобы при обрыве сессии по лимиту токенов не пропали ни выводы, ни рассуждения агентов. Здесь — финальные отчёты каждого агента в том виде, в каком они вернулись оркестратору (на языке оригинала), и текущий статус. Полные транскрипты (JSONL, включая всё прочитанное и промежуточные рассуждения) — вне git: `~/Library/Application Support/transcriptor/evidence-2026-09-03/session-2026-09-04-ultra-audit/agent-transcripts/*.output` (файл называется по id агента; соответствие id → задача см. в конце), а также `…/session-2026-09-03-04/` (первая сессия) и `…/session-2026-09-04-dual-stream/` (эксперимент). Журналы правок с решениями — `*-fix-journal.md` рядом.

## Статус на момент записи (2026-09-05)

- `main`: все три доменные фикс-волны Ultra-Audit завершены и запушены (бэкенд 15 коммитов, рендерер 10, desktop 13). Сьюты: бэкенд 803, фронтенд 327, desktop 255.
- Работает один агент — **швы между доменами** (единая схема `final` на обоих концах с общей JSON-фикстурой; дефолты dual-stream и факты бэкенда — из bootstrap, а не копией в рендерере; половинки D-009/013/015/053; один эпилог `stopLive`; структурная изоляция тестов от `HOME`). Его результат — в `docs/archive/audit-2026-09-04/backend-fix-journal.md`, раздел «Швы (2026-09-05)».
- Далее по плану: сборщик отчёта (`BUGSAUDIT-2026-09-04.md` §4–§7 из журналов), релиз 1.6.1 (CHANGELOG, версия, PROJECT_STRUCTURE с новыми модулями `backend/async_tasks.py`, `backend/deepgram_language.py`, `backend/deepgram_recovery.py`, реестр долга), `./BUILD.command`, перезапуск, проверка boot-лога и первых живых записей (`source=envelope`, `dual=1`, `warm=1 preRollMs=500`, вставка ≤0.5 с, `verified=1`).
- Установлено по-прежнему 1.6.0.

---

## Фикс-волна 2, бэкенд (2026-09-05, Opus)

Backend Ultra-Audit FIX phase complete. All work is committed to `main` and pushed.

Commits (15): `46934ce` `stats.recovery.spans_sec` — the renderer↔backend contract · `ea25b4f` Warm pool × dual-stream: B-003, B-004, B-013, B-087 · `f9ffa80` Cancellation, control frames, swap-vs-finalize: B-008, B-009, B-011, B-012, B-083a · `3c3bbe9` Envelope numbers: B-006, B-010, B-026 · `b463e58` Configuration: B-018–B-021 · `aed1e61` ffmpeg/models/files: B-014–B-017, B-037 · `1ed7b32` Deps & env docs: B-022, B-023, B-029, B-044, B-058 · `7461a64` One rule per place: B-028, B-030–B-032, B-073, B-084 · `cdcb11c` Engines & languages: B-027, B-033–B-036, B-039–B-041 · `6999634` Local live-assist arithmetic: B-068–B-071, B-078 · `fadc50e` Errors reported as something else + dead code (23 IDs) · `eb93fde` Tests that could not fail + resource bounds (12 IDs) · `1a4b122` Audit of `deepgram_recovery.py` (R-001…R-006) · `b209c87`, `3c3d565` Journal.

Counts: P0 2/2. P1 21/23 fixed — B-011 is not a bug (measured: `asyncio.wait_for` on Python 3.12 already awaits the cancelled task), B-025 is `desktop/main.js`. P2 60/65 fixed, 1 partial (B-088), 4 in debt. Both indexes closed with nothing unlabelled: SSOT 19/20, workarounds 37 fixed + 2 partial-with-debt. Tests: 652 → 803, green; suite runtime ~39 s → ~25 s.

Two findings of my own: `deepgram_recovery.run_recovery` set `durationSec` and `coveredEndSec` to the same value, which re-created B-006 on every repaired stop — fixed by stating the rule once (`decoded_end_sec`: provider finals + REST re-decodes count, interim guesses do not). The recovery splice applied only the word-level coverage rule, not the spanless one the live splice applies — a padded re-decode could put speech a wordless final already owned into the transcript twice.

Live check: `--dual --language auto` on the 72.7 s WAV: `dual-stream merge: auto=105 ru=119 merged=128 filled_from_ru=23 filled_from_auto=9 dups_removed=0`; `recovery: spans=2 total=2.22s → words=0 in 1166ms` (both dropped as already owned); `post-Finalize … waited=360ms (budget=3.00s)`. No repeated phrases, all three language transitions intact.

Debt D-01…D-10 in the journal; load-bearing: B-038 (three incompatible shapes of the `final` wire type — needs one commit spanning the renderer), B-027 (frontend copy of dual-stream defaults — a wrong "absent" default is persisted by the next autosave), PROJECT_STRUCTURE lacks `backend/async_tasks.py`, `backend/deepgram_language.py`, `backend/deepgram_recovery.py`. Side effects: an early test version created `~/.transcriptor/.encryption_key` (not deleted; nothing reads it while `TRANSCRIPTOR_DATA_DIR` is set); disk hit 100 % mid-session.

## Фикс-волна 2, рендерер (2026-09-05, Opus)

Commits: `e679872`¹ SSOT copy shown on two surfaces (`src/ui-copy.ts`) · `50e52f6` SSOT numbers (`UI_TOKENS.feedback/notice/recordings/upload`), one copy-feedback mechanism · `9cca7d0` hotfix (`src/button-feedback.ts` missing from `50e52f6`) · `a52e976` SSOT types (`Provider`/`RemoteProvider`/`LiveFinalEnvelope`) and design tokens · `206737f` workarounds — listeners, timers, clocks that outlive their cause · `90876fa` History — dead branches, error text in the transcript body, phantom session token · `e1bf3d4` P2 — wrong causes in messages, dead buttons, the `document.title` bridge · `c31b642`, `4da7273`, `5c56e65` journal, index accounting, cross-region test repair. ¹ Group 1 landed inside `e679872` because the desktop agent's concurrent commit picked up staged files (recorded; later commits path-limited).

Counts: P0 1/1. P1 23/23 (21 fixed, F-004/F-005 removed by `889c91a`). P2 46 closed, 5 not-a-defect, 16 debt. Workaround index 44/49 fixed, 2 not-a-defect, 3 debt. SSOT index 60/68 closed, 2 not-a-defect, 6 debt. Tests 281 → 327 (26 files).

Live-path invariant verified: `stopLive` — finalize send → lazily-armed envelope wait → single `envelopeMissing` predicate → `envelopeTranscript` / on-disk fallback → `[trace stopLive] FINAL … source=…`; of 1012 changed lines exactly one hunk inside `stopLive` (literal → `UI_TOKENS.notice.briefMs`).

Not done: F/7 (seven stop epilogues) and U-022 (refactor inside `stopLive`); U/K-2 (upload progress needs XHR); U/K-5+U-020 (legacy reveal migration, product decision); SSOT row 14 (`frontend/package.json.version` read by desktop test); R-016/S-04/S-05/S-06 (backend-owned facts → bootstrap payload); ten more in the journal's «Долг». Disk filled to 100 % mid-session; a concurrent rename in `desktop/main.js` broke a cross-region test (repaired in `4da7273`).

## Фикс-волна 2, desktop + репозиторий (2026-09-05, Opus)

13 commits: `8585a37` Python version SSOT · `e679872` dependency-pins SSOT · `b2d3461` CI on macOS · `091865f` packaging invariants · `c9d905a` documented hotkeys + AGENTS.md pointer · `e74fca6` last two P1s · `f8db476` paste-path duplicates · `f59850d` identity strings · `15bd422` two tests that could not fail · `aeb7039` dead symbols + console rate limit · `88de1c7` named numbers + docs · `7be4938` both indexes · `ae42aa3` live checks + summary. Tests 208 → 255.

Counts: P0 3/3 (prior session), P1 26/26, P2 54/55. Indexes: hardcode 26/26, crutches 12/12 with verdicts.

WIP review: rewrote most of `origin/wip/ultra-audit-2026-09-04` — its `prepare-runtime.sh` called `die()` before definition; its `mas` extraResources claim was wrong (electron-builder concatenates; the bug was three duplicates); `concurrency.group` restated `github.workflow`; duplicated `fs.existsSync`. Added `python-version.js`, extraResources/`build.files` entries, packaging tests.

Findings worth flagging: `canonicalAcceleratorForPlatform("Control+ +V")` returned `"Control+V"` and registered it globally (the app would have taken paste away from the whole desktop); `requirements.runtime-lock.txt` was never in the shipped bundle (confirmed against installed 1.6.0); `split(".", 2)` on WM_CLASS made every GNOME/Flatpak window parse as `org`/`gnome`; the two osacompile suites had never run in CI (ubuntu runner); 13 unbudgeted paste timeouts under a green "worst case" test; `build.files` matcher discarded `!` patterns.

Not done: D-061 (release artifact set — product decision); D-015/D-009/D-013/D-053 (halves in frontend); D-034 (secure-field detection needs the expensive AX read); D-072 (PROJECT_STRUCTURE). Debt: 13 items (capsule preload, afterPack↔unlockDist chmod cycle, versioned ffmpeg mirror, notarisation, DMG artwork copy…). Live: capability probe 158/196/202 ms; bundle-id read +6 ms; AppleScript suites 15/15. Windows/Linux unverified on hardware; notarisation never run.

## Швы между доменами (2026-09-05, Opus) — в работе
Задание: B-038 единая схема `final` (один конструктор на бэкенде, один парсер в рендерере, общая JSON-фикстура из вывода бэкенд-теста); B-027 дефолты dual-stream из bootstrap; R-016/S-04/S-05/S-06 факты бэкенда в bootstrap; D-015/D-009/D-013/D-053 обе половины; F/7 + U-022 один эпилог `stopLive` с тестом «ровно одно место доставки»; структурная изоляция тестов от `HOME`. Результат — в журнале бэкенда, раздел «Швы (2026-09-05)».

---

## Первая сессия (2026-09-03/04) — ключевые отчёты

### Единый владелец текста, рендерер (`889c91a`)
Deleted: `transcript-merge.ts` 979 → 64 lines (`chooseStopTranscript`, `mergeReadings`, `unionTranscripts`, timed-token seam machinery); `live-coverage.ts` 295 → 134 (`decideDeadStreamRecovery`, `envelopeCoversRecording`); `live-source.ts` 397 → 235 (recovered-tail reconciliation); `main.tsx` −800 lines (opportunistic-envelope union, tail-gap arithmetic, envelope-vs-recovery race, auto-REST, preview fallback). Remains: `joinTranscriptSegments`, `richerTranscript` (preview floor only), `mergeInterim` (preview), `envelope-deadline.ts` (`computeEnvelopeDeadlineMs`, `envelopeMissing`, `envelopeTranscript`). Stop sequence: stop capture (200 ms tail hold, worklet barrier) → `finalize{framesSent,bytesSent}` → wait envelope (1500 ms confirm, re-armed to budget+800, ceiling 11 000) → `envelopeMissing` false → deliver verbatim `source=envelope`; true → `transcribe-on-disk`, `source=ondisk-fallback`. Tests 196/17 files.

### Восстановление внутри конверта, бэкенд (`bf84d6b`)
`backend/deepgram_recovery.py`: `InterimEvidence`, `missing_spans` (holes, tail with evidence, after stream death, whole recording when no finals), `uncovered_spans` (pad 0.3 s, merge, clamp), `recovery_budget_sec` = 2.5 + 0.25×span, cap 8, `pcm_span_wav`, `recover_spans` (REST, same language decision — `multi` stays `multi`, keyterms, format), `splice_recovered_words`, `run_recovery`. Wired in `main.py::_apply_live_recovery` for the normal and the connect-failure paths (the latter no longer sends an empty envelope; keeps spooling until finalize). Second `finalizing` with the extended bound when needed. Splice helpers hoisted to module level (one implementation for live splice and recovery). Tests 593 → 631. A/B: `recovery: spans=2 total=2.22s → words=0 in 1216ms` (both words already owned, logged). Spools > 128 MB skip recovery with a warning.

### Tail guard по свидетельствам (`e8f1632`) и пустой финал (`3b8f5a8`)
`_tail_needs_flush` decides only from evidence: ≥ `TAIL_GUARD_MIN_SPEECH_SEC` (0.25 s) of interim-recognised words in the uncovered span, or the newest interim window reaching past the last final by more than the endpointing silence with non-empty text; elapsed time alone never counts. Dual facade merges a late secondary's `partial_result()` instead of dropping it. Later (`3b8f5a8`): an empty-transcript `is_final` — Deepgram's normal answer to `Finalize` — is a final: it arms `_final_arrived` and the wait ends when the provider has answered, removing the need for the tuned wait constants.

### Двухпоточный Auto (`f187139`) и эксперимент
Experiment (11 WAVs, 44 sessions): multi + ru merged by word timestamps closed both language-switch holes on the 72.7 s file (ru filled multi's holes with «говорю просто большую кучу разных слов… detect and find», multi filled ru's French); 9/11 byte-identical across runs; connect/finalize latency indistinguishable from single stream; cost 2× billed seconds; one merge defect («без без» — time-overlap test broken by a word swallowing trailing silence) fixed in the product merge with ≥25 % of the shorter word + 300 ms same-core adjacency. Product: `backend/deepgram_dual.py` (`dual_stream_enabled`, merge, `DualLiveSession` facade; config `preferences.deepgram.dual_stream` default true when live language is Auto, `dual_secondary_language` default "ru"); warm pool holds two sockets; `stats.dual_stream`; 41 tests. Later fixed: events after `replace_primary` (`022fd27`), finals without word lists and O(P×S) pairing (`d590a4e`).

### Обнаружение Ultra-Audit (три обходчика, 2026-09-04)
Бэкенд: 90 находок (2 P0: B-001 dual merge loses word-less finals — measured «это весь мой текст» → «это»; B-002 `_pairs` O(P×S), 3000 words = 30.8 s; B-005 empty `is_final` dropped before the final branch → the three wait constants are a workaround; B-007 tail-guard rule 2 dead). Рендерер: 96 находок (U-001 P0 failed GET /api/ui/upload-queue → PUT of an empty queue wipes every upload's transcript; F-001 warm hold/pre-roll never engaged — 15/15 stops `warm hold=0 reason=track-ended`; F-002 failed /api/config → next click overwrites keyterms/hotkeys; C-003 dead Download button; C-006 CSP `ws:` any host; `tests/` outside `tsconfig.include`; `mic-health.ts` untested). Desktop: 84 находки (D-001 P0 `powerMonitor` handlers nested inside `restoreShortcutsAfterCaptureAbort` — dead; D-002 P0 `cscript //U` UTF-16 vs UTF-8 decode → Windows double paste; D-003 P0 ad-hoc signing breaks notarisation; D-004 no delay before AX read → `verified` never true → clipboard never restored; D-005 Accessibility prompt never shown on a new Mac).

### Исследования (2026-09-04)
Capture/merge: Chromium enables WebRTC AGC2 adaptive digital on macOS with `initial_gain_db=15`, `max_gain_change_db_per_second=6` (explains the 0 dBFS start and 10–15 dB slide); pre-roll 250–500 ms is standard in OSS (whisper-local, Hex, OpenWhispr adoption pattern); merging two readings: never union — align at a seam time with an n-gram guard (whisper_streaming `HypothesisBuffer`), rapidfuzz opcodes over difflib (autojunk); published two-pass systems rescore rather than merge (Sainath 2019, WeNet U2); Deepgram documents duplicated words across `is_final` boundaries. OSS apps: OpenWhispr (warm Deepgram WS, silence keepalive, 3 s cold buffer, liveness reconnect), Handy (`paste_tx` receipt via pasteboard promise), FluidVoice (AX verification), Whispering (`DictationCapability` for stale Accessibility grants), Wispr Flow discards start audio and documents a 5-attempt paste contract. Summary table: `docs/archive/COMPARISON_2026-09-04.md`.

---

## Соответствие id агента → задача (для чтения транскриптов)
`a4b578fef68d7a589` бэкенд фикс-волна 2 · `af2163c1575bdb650` рендерер фикс-волна 2 · `aff03e5d987ae819c` desktop фикс-волна 2 · `a53ecc4b8983a3c21` швы · `a817b830f3578e56d` бэкенд фикс-волна 1 · `a71e1e988c6833953` рендерер фикс-волна 1 · `a1251112f5f61c4b8` desktop фикс-волна 1 · `a7b51f1f3a066f2f0` / `a31fcdd7c3a9af8a2` / `ac8a1dcdc40e008ce` обходчики бэкенд/рендерер/desktop · `a284065e2b16c5a28` восстановление в конверте · `a6adaa0d314d7d85a` единый владелец (рендерер) · `a9ab0558d3d2e92ff` tail guard · `a454e88f87222fa8c` события фасада · `a213953f01b566a07` конверт авторитетен · `a9db6878e0070fda5` dual-stream (доделка) · `a0d440cbcc401f952` бэкенд A1+B1 · `ad09d59cea3f4e191` рендерер A2+B2+шов · `a4b99b9012dfeb1ac` desktop A3+B3 · `a2a5bdc3fc9195ab7` эксперимент dual-stream · `a33aa04b3aebe032d` COMPARISON · `a8b4f587ee969e4b4` релиз 1.6.0 · `ac29accf983d13056` сборка 1.5.0 · `ae26ef1ab115fe1ae` реестр долга.
