# Ultra-Audit · backend transcription engines (read-only) · HEAD acbf737

Auditor: backend-engines. Scope: deepgram_* modules, remote_deepgram(_live), remote_openrouter, live.py, live_envelope.py, transcribe.py, transcribe_gigaam.py, tools/deepgram_live_ab.py, contracts/live-*.json, their tests.
Known/closed not re-reported: B-001/B-002/B-005/B-007/B-038/B-040/B-041/B-042/B-083/B-088 (docs/audit-2026-09-04).

## Coverage

| Area | Status | How |
|---|---|---|
| backend/deepgram_dual.py (all 1259 lines) | read fully | merge, contested rule, facade, drain, envelope |
| backend/remote_deepgram_live.py (3952) | read: constants, config, connect, control/send, drain_transcript, shutdown/close, coverage/holes, enqueue, recv, keepalive, _process_deepgram_message, merge_seam_fragments; NOT line-by-line: splice helpers (825-1080), word_accounted_for/covering_final_word, `_splice_uncovered_interim_words`, `_log_coverage_holes` | partial |
| backend/deepgram_recovery.py | read fully | |
| backend/deepgram_warm.py | read fully | clean (see Clean) |
| deepgram_endpoints/language/words/keyterms/format | read fully | |
| remote_deepgram.py, remote_openrouter.py | read fully | |
| live.py, live_envelope.py | read fully | |
| transcribe.py, transcribe_gigaam.py | read fully | |
| tools/deepgram_live_ab.py | read fully | |
| contracts/live-final-envelope.json | read; live-defaults.json not opened (covered by test_live.py:193 refs only) | partial |
| tests | test_deepgram_dual.py contested/facade parts, test_live_envelope.py fixture builder read; others only listed/grepped | partial |

## Findings

### BE-01 · P1 · confirmed (path) · deepgram_dual.py:`_settle_contested_stretches` — a single junk secondary word can erase a whole foreign-language stretch
Path: DualLiveSession._merged_envelope -> merge_readings -> _settle_contested_stretches. `rivals` = secondary words whose midpoint is inside the run; `if not rivals: continue` is the only coverage test. Then `secondary_conf >= primary_conf` (tie to secondary) removes ALL primary run words and ALL rivals; nothing checks how much of the stretch the rivals actually cover.
Reproduce: multi = 8 words 30.0-36.0 s tagged "fr" conf 0.6; ru = one word "да" 33.0-33.3 conf 0.97 (ru skipping the French clause but emitting one fragment, the very September shape the docstring cites). rivals=[да], 0.97>=0.6 -> secondary owns the stretch: the French clause is deleted, one word delivered.
Consequence: silent loss of text, the thing the module exists to prevent; mean confidence of 1 word is not evidence about 6 s.
Current:
```python
        rivals = [w for w in secondary if not w.get(SPANLESS_WORD_FLAG) and start <= (w["start"] + w["end"]) / 2 < end]
        if not rivals:
            continue
        primary_conf = _mean_confidence(run)
        secondary_conf = _mean_confidence(rivals)
        if primary_conf is None or secondary_conf is None:
            continue
```
Fixed (reuse the product's own shadow threshold):
```python
        rivals = [...]
        covered = sum(min(w["end"], end) - max(w["start"], start) for w in rivals)
        if not rivals or covered / (end - start) < SPANLESS_SHADOW_MIN_FRACTION:
            continue   # the partner barely heard it: primary is the only reading
```
(weight the means by word duration while there.) Why a bug: the docstring's own rule "the secondary has no words there -> primary keeps" is the limit case of this; "almost no words" is the same situation and the SPANLESS_SHADOW_MIN_FRACTION rule 20 lines above already treats it that way. No test covers it.

### BE-02 · P1 · hypothesis · deepgram_dual.py:`merge_readings(... secondary_source)` -> `_contested_runs` — secondary language "en" makes every Russian stretch "contested"
Path: Settings picker offers `DUAL_SECONDARY_LANGUAGE_OPTIONS = ("ru","en")` (model_catalog.py:121); `dual_secondary_language()` returns "en"; DualLiveSession passes `secondary_source=self._secondary_language`; `_contested_runs(primary, "en")` marks every multi word tagged "ru" as contested. Outcome now depends on how an `en` decoder scores Russian audio vs multi's own ru confidence; docstring evidence (lt/de/bg vs ru) was measured only with partner=ru. If the en reading's junk Latin words score >= multi's mean confidence (tie goes to secondary), Russian speech is replaced by English gibberish.
Also conflation: `secondary_source` is both provenance label and language-tag comparand (merge_readings:749), so `source` strings can never differ from Deepgram language codes without silently changing the rule.
Fix: pass an explicit `secondary_language` argument; and gate the rule to the measured configuration (secondary == "ru") or require measured evidence for "en". Tests: ContestedStretchTests never pass a non-ru secondary (grep test_deepgram_dual.py: only `secondary_language="ru"`).
Why a bug: the option is reachable from the UI; rule's premise ("the secondary's language is the language the user speaks") is false for "en".

### BE-03 · P1 · confirmed · deepgram_dual.py:`_segments_from_words` / `flatten_words` — dual merge drops `speaker`, diarize silently lost in Auto mode
Path: frontend sends `diarize=1` (main.py:4118) with language auto -> `dual_stream_enabled` is True (it never looks at diarize) -> `secondary_config` keeps diarize=True (billing both) -> `merge_readings` -> `flatten_words` keeps only word/start/end/source/confidence/language; `normalize_words` never carried `speaker`; `_segments_from_words` builds segments with no `speaker`. Final envelope segments (the transcript, per live_envelope.py) therefore have no speaker; renderer reads `speaker` (frontend/src/main.tsx:3120-3135).
Consequence: diarization works only for non-Auto languages; no log or error.
Current: `_segments_from_words` segment dict has keys start,end,text,confidence,is_final,speech_final,words,source.
Fixed: either (a) `dual_stream_enabled` returns False when diarize is requested (honest, halves cost) or (b) carry speaker per word (`normalize_words` + `flatten_words`) and group `_segments_from_words` by it. (a) is the minimal root-cause fix; document in dual module.
Why a bug: a user-visible option is a no-op on the default path; every other field of the segment shape is preserved elsewhere.

### BE-04 · P2 · confirmed · deepgram_dual.py:`DualLiveSession.drain_transcript` — "hard ceiling" for the secondary is measured from the wrong instant
`ceiling = announced[0]` (the primary's worst case, counted from Stop) is then used as `wait_for(secondary_task, timeout=ceiling)` AFTER `await self.primary.drain_transcript()` returned. Total wall time can be primary_elapsed + ceiling, i.e. up to ~2x the number the renderer was told (the secondary drain started concurrently, so it is usually done earlier; but a slower secondary with its own retry, or the f94121ae shape, is exactly the case).
Fixed: `remaining = ceiling - (loop.time() - started)`; `timeout=max(0.1, remaining)` with `started` taken before creating the task.
Why a bug: docstring promises "it must never be the reason a stop runs long".

### BE-05 · P1 · hypothesis · deepgram_dual.py:`send_pcm` / `_feed_secondary` — a stalled secondary socket stalls the primary's audio and is reported as a wedged recording
`send_pcm` awaits `primary.send_pcm` then `secondary.send_pcm`, serially, with no timeout on the second (`DeepgramLiveSession.send_pcm` is deliberately never cancelled). If the secondary connection half-opens, `ws.send` blocks once the write buffer fills; the sender task in main.py stops draining its queue, `send_watchdog` (main.py:5547-5584) declares "Deepgram upstream wedged", `report_fatal` (primary) -> recording ends with an error although the primary was healthy. Contradicts the class docstring: "ERRORS are the primary's alone... a secondary that dies... not a failure worth aborting a recording for".
Fix: feed the secondary through its own bounded queue + task (drop-oldest, mark `_fail_secondary` when its age exceeds the wedge bound), never in the primary's send path.
Why hypothesis: needs a half-open secondary; path itself is certain.

### BE-06 · P2 · hypothesis · deepgram_dual.py:`DualLiveSession.drain_transcript` — secondary drain task orphaned if the primary's drain raises
`secondary_task = create_task(secondary.drain_transcript())` is created, then `await self.primary.drain_transcript(...)` has no try/finally; on exception/cancel the task keeps running (sending Finalize/CloseStream) while main.py falls into `partial_result()` and `shutdown()`; its exception is never retrieved.
Fix: `try: ... except BaseException: await cancel_and_await(secondary_task, ...); raise`.
Test gap: DualLiveSessionDrainTests has no "primary drain raises" case.

### BE-07 · P2 · confirmed · deepgram_dual.py:`_merged_envelope` — `stats.dual_stream=false` although the text is a merge
`merged_path = secondary_result is not None and not self._secondary_failed`. A secondary that died at minute 3 of 5 (`_fail_secondary` from `_feed_secondary`) still delivers its committed segments, `merge_readings` uses them, but the envelope says dual_stream false; the comment above says false only "when no usable transcript exists". Same logs/telemetry then misdescribe the transcript. Fix: `dual_stream = merged.secondary_word_count > 0`; keep a separate `dual_secondary_failed`.

### BE-08 · P2 · hypothesis · remote_deepgram_live.py:`merge_seam_fragments` (fused dict) — a seam-fused word loses `confidence`/`language`
`fused = {"word","start","end"}` (line ~671) while normalize_words now keeps evidence. In a contested multi stretch, the fused word has `language=None`, so `_contested_runs` ends the run at it and that one word goes through word-by-word pairing — the interleaving the rule was introduced to stop. Fix: carry confidence (duration-weighted) and language of the longer fragment.

### BE-09 · P2 · hypothesis · deepgram_dual.py:`_settle_contested_stretches` — rivals chosen by midpoint, stretch bounded by the primary's words only
If the secondary's last word of the stretch has its midpoint at/after `end` (decoders place the last word late — the very "без без" shift), and the primary wins, that word is neither removed nor paired with anything (the primary word it duplicates is settled), so it prints beside the settled primary words; `_drop_duplicate_runs` cannot catch it (different spelling/language, no stem match). Mirror case when the secondary wins. Fix: take rivals by overlap with the run, using the same `SPLICE_COVERAGE_OVERLAP_FRACTION` rule as `_pair_overlap`, or settle edge words with `_pairs`.

### BE-10 · P2 · hypothesis · deepgram_dual.py:`_contested_runs` — a run ignores language changes
Consecutive words tagged `en` then `fr` (or `lt` then `en`) with gaps <= 1 s form ONE run and one mean decides both: genuine English (0.98) adjacent to a hallucinated stretch (0.6) is averaged and one of them is lost. Fix: split the run when `language` changes; compare per run.

### BE-11 · P2 · confirmed · deepgram_recovery.py:`_words_from_rest_result` — REST recovery words carry neither confidence nor language, and are decoded with language=multi
Answer to "do recovery words carry confidence/language": no — `normalize_words` returns them, the dict rebuilt at recovery:~405 keeps word/start/end/source only. Recovery runs AFTER the merge, with `resolve_live_language(cfg.language)` = "multi" and no partner, so the multi->Lithuanian hallucination the contested rule fixes can re-enter through recovery un-checked. Minimum: keep the evidence on the word (so the tool/diagnostics show it); decision: run recovery spans through the same two-language comparison or tag-and-log. Severity P2 as recovery spans are small.

### BE-12 · P2 · hypothesis (perf) · deepgram_dual.py:`_settle_contested_stretches` — O(runs x secondary) rescans on the stop path
`rivals = [w for w in secondary if ...]` per run: the whole list is rescanned for every run, the exact shape B-002 removed from `_pairs`. MergeCostTests contain no language-tagged words, so the new code is outside the cost guard. Fix: bisect on the time-sorted `secondary`.

### BE-13 · P2 · confirmed · contracts/live-final-envelope.json, live_envelope.py:`live_final_stats` docstring — dual stats contract not pinned
`_merged_envelope` writes dual_stream, dual_secondary_language, dual_filled_from_{secondary,primary}, dual_duplicates_removed, dual_contested_to_{secondary,primary}. Fixture (and test_live_envelope.py:97-100, which hand-writes the stats input) lists only four; `live_final_stats` docstring lists the same four. Nothing builds the fixture from a real `DualLiveSession` envelope, so the producer and the contract cannot disagree loudly. Fix: build the dual stats via one function (`dual_stats(merged, language)`) used by both the session and the fixture test; list all keys.

### BE-14 · P2 · confirmed · deepgram_dual.py:`_merged_envelope` — `envelope["words"]` is dead
`envelope_from_result` copies named fields only, `words` never reaches the wire (main.py:5878 runs it before recovery), yet the comment claims "`words` is the merged list; `segments` is that same list grouped... two views". Remove or add to FINAL_ENVELOPE_KEYS deliberately.

### BE-15 · P2 · confirmed · stale/contradicting comments (crutches of documentation)
- remote_deepgram_live.py:292 names `backend.deepgram_dual._language_disagreements` — does not exist (it is `_settle_contested_stretches`).
- deepgram_dual.py:~107-110 orphaned comment ("Merged words further apart than INTERIM_WORD_GAP_SPLIT_SEC ...") above `_LATIN`, attached to no code.
- deepgram_keyterms.py module docstring still argues "a monolingual language, not multi, belongs on the live config for Russian dictation" — the shipped default is multi + dual; DeepgramLiveConfig.to_query_string (remote_deepgram_live.py:~1186-1209) carries a 25-line copy of the same measurement. One owner (docs/ or deepgram_language.py) should hold it.
- remote_deepgram_live.py:~2495 `DeepgramLiveSession.finalize` and deepgram_dual.py:1046 `finalize` "back-compat" wrappers have NO non-test caller (grep) and the dual docstring claims the A/B tool uses it (the tool calls drain_transcript+run_recovery+shutdown).
- remote_deepgram.py:45 `DEEPGRAM_API_BASE` alias "for external callers" — only caller is the same file (line 158).

### BE-16 · P2 · hypothesis · three definitions of `uncoveredSpeechSec`
(1) single stream `_uncovered_speech_sec` = clipped word-level holes + span-level holes (>=0.25 s floor); (2) dual `_merged_uncovered_speech_sec` = sum of union of `coverage_hole_spans()` (unclipped uncovered-word spans, no 0.25 s floor) minus merged coverage; (3) recovery residual `missing_spans` (word coverage vs candidates). `run_recovery` returns the payload unchanged ("none needed") or rewrites the number with (3), so the same field means different things depending on whether recovery ran and which session class served. Docstring in dual claims one implementation. Fix: one function over (holes, covered spans).

### BE-17 · P2 · confirmed · SSOT of silence defaults
0.3 / 2.0 appear in deepgram_recovery.py `InterimEvidence` defaults, `evidence_from_session` (`float(session.endpointing_sec or 0.3)`, `utterance_end_sec or 2.0`) and as 300/2000 ms in `DeepgramLiveConfig`. `or` also turns a legitimate 0 into the default. Fix: read from the config constants; no fallbacks.

### BE-18 · P2 · hypothesis · remote_deepgram_live.py:`drain_transcript` — announced budget decided before the wait, retry decided after
`needs_flush` (budget x2) is measured before the wait; the tail-guard retry fires on a re-measure after it. Interims arriving during the flush can flip `_tail_needs_flush` to True, so up to 3 s + 3 s + 0.15 is spent against an announced 3.15 s. `_send_control` can also add up to 5 s per frame (CONTROL_SEND_WEDGE_SEC) outside the budget. Fix: decide the retry only if it was budgeted (`needs_flush` at announce time), or re-announce.

### BE-19 · P2 · confirmed · pass-through wrappers / restated rules in remote_deepgram_live.py
`DeepgramLiveSession._union` (-> `union_spans`), `_join_segment_texts` (-> `join_segment_texts`), `_tail_needs_flush` docstring re-states `tail_needs_flush`'s 25-line rationale (two places for one rule's text). Remove the static wrappers; link instead of copy.

### BE-20 · P2 · confirmed/hypothesis · remote_openrouter.py
(a) confirmed: both URLs `https://openrouter.ai/api/v1/chat/completions` hard-coded twice (lines ~92, ~211) while Deepgram has an endpoints SSOT; (b) hypothesis: the B-042 fix turns a multimodal list `content` into `str(list)` = Python repr, delivered as the transcript/polished text (`openrouter_transcribe` has done this all along). Fix: join the `text` parts, or raise RemoteError for non-str content. (c) timeout tiers (45/75/180, x15/x8) are a second copy of remote_deepgram._deepgram_http_policy's idea with different magic numbers; one policy function would own both.

### BE-21 · P2 · confirmed · deepgram_language.py:`rest_language_params` vs `resolve_live_language`
The "auto/blank" test is written twice; `rest_language_params` does not lowercase (`"RU"` reaches REST as "RU", live as "ru") although its docstring says "the same passthrough". Fix: share one `_normalize()`.

### BE-22 · P2 · confirmed · transcribe.py / transcribe_gigaam.py
- `transcribe_file` empty-sequence path returns `_empty_transcribe_result(0.0)` (duration 0) while `_undecodable_wav_result` was written precisely so the same empty recognition reports the real duration through every door.
- `_env_int` is defined in transcribe.py:51 AND main.py:637; gigaam imports the private one from transcribe.
- `_DEFAULT_CPU_THREADS = max(4, min(8, env))` silently raises a user's `TRANSCRIPTOR_WHISPER_CPU_THREADS=2` to 4.

### BE-23 · P2 · hypothesis · transcribe_gigaam.py:`transcribe_gigaam`
A chunk that returns text but no usable words is dropped whenever ANY other chunk produced words (`if not by_chunk:` is the only fallback); BUG-55's reasoning covers the 1.2 s seam, not the 18.8 s of non-overlap content. Fix: fall back per chunk, trimming the overlap by time.

### BE-24 · P2 · hypothesis · transcribe_gigaam.py:`_load_model` vs `release_gigaam`/`resident_gigaam_models`
`_MODEL_CACHE` is mutated under the per-model lock, read/popped under `_MODEL_LOCKS_GUARD`: two locks, one dict; two different-model loads can both pass the cap check and evict each other's fresh model. Also transcribe.release_idle_models calls `gigaam.resident_gigaam_models()` while holding `_MODEL_LOCK` right below a comment forbidding exactly that nesting. One lock for the cache.

### BE-25 · P2 · confirmed · tools/deepgram_live_ab.py
`--dual` builds `DualLiveSession` for any `--language` (also `ru`), bypassing `dual_stream_enabled` (the app never runs that configuration); `primary_language=language` can be "auto" (the app passes `resolve_live_language`); `session.shutdown()` is not in the `finally` (leak on exception); default data dir `~/Library/Application Support/transcriptor` duplicates desktop's userData name.

### BE-26 · P2 · confirmed · tests
ContestedStretchTests (test_deepgram_dual.py:777-852) pin only partner "ru"; no test for: sparse rivals (BE-01), tie rule, secondary "en" (BE-02), spanless record inside a stretch, recovery interplay, seam-fused word (BE-08), run across language change (BE-10), primary-drain-raises (BE-06), slow secondary vs ceiling clock (BE-04). The live-tail tests in test_deepgram_finalize_* use real wall-clock waits (known: B-088).

## Clean places (proved)

- deepgram_warm.py: lock held for bookkeeping only; connect outside; cancel-race closed by `_close_orphaned_connect`/`_cancel_pending`; adoption refuses sockets that carried audio (timestamp invariant) and stale keepalives; TTL is a one-shot sleep per slot (no poll); `_store_warm` mutates before first await; bound WARM_MAX_SOCKETS enforced. No finding.
- `_pairs` sweep (deepgram_dual.py): linear heap sweep, tie-break explicit, retire window correct for the +/-0.3 s rule.
- `_drop_duplicate_runs`: index arithmetic after `del` checked for both branches; guarded by `_same_audio`.
- `_reconcile_spanless` x `_settle_contested_stretches`: spanless words never enter a run or the rivals (explicit filters); step-2 removal happens before runs are computed, so the two rules cannot both own a word. No finding for that interaction.
- Words without timings: `normalize_words` drops end<=start, `flatten_words` takes spanless via `segment_word_records`; zero-width run -> empty rival interval -> primary kept. Safe.
- Recovery order: recovery runs after the merge on the assembled envelope; contested rule never sees recovery words (BE-11 is about the reverse gap).
- `_send_control` / `send_pcm` never cancel a write; `close()` idempotent and bounded; `_enqueue_event` keeps FIFO across eviction; `_recv_loop` always puts the sentinel.
- `connect()` retry policy matches its docstring; InvalidStatus mapping complete; no key in logs/URL.
- deepgram_endpoints / format / words / keyterms: single owners, env parsing degrades with warning, token budget conservative.
- live.py: single-flight, 60 s ceiling, coverage only advances on success; ring eviction fixed as documented.
- live_envelope.py: one constructor, always-present keys, NaN guard.
- Env vars TRANSCRIPTOR_DEEPGRAM_* all documented in .env.example.
