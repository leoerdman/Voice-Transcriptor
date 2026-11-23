# Ultra-Audit · BACKEND · фаза FIX

**Дата:** 2026-09-04
**Точка отката:** `22c6e3d` (backend на `bf84d6b`).
**Базовая линия тестов:** 631, все зелёные.

```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 631 tests in 32.230s
OK
```

---

## Коммит 1 — `d590a4e` · P0

**Заголовок:** «A Deepgram final that arrives without a word list is a reading again, and the merge of two long readings no longer stops the backend for half a minute»

**ID:** B-001 (P0), B-002 (P0). Попутно закрыта часть B-033 — новая публичная точка входа `segment_word_records` вместо четвёртой копии правила.

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_dual.py`.

**Верификация.**

Репродукция B-001/B-002 (`/tmp/repro_p0.py`, интерпретатор приложения) — ДО:
```
D: primary had no word list -> merged text = 'это'
D: primary no words, no secondary        = ''
  250 words/reading -> merge_readings    135 ms
 1000 words/reading -> merge_readings   2811 ms
 3000 words/reading -> merge_readings   30.8 s        (из отчёта аудита)
```
ПОСЛЕ:
```
D: primary had no word list -> merged text = 'это весь мой текст'
D: primary no words, no secondary       = 'это весь мой текст'
  750x750   -> cpu     8.2 ms   wall  14.7 ms
 1500x1500  -> cpu    17.4 ms   wall  25.0 ms
 3000x3000  -> cpu    39.6 ms   wall  65.2 ms     (load average 44 — машина под нагрузкой других агентов)
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 640 tests in 58.957s
OK
```
(631 → 640: +9 тестов; ни один не ослаблен.)

**Решения.**

* *Выбрано:* одно правило `segment_word_records(segment)` в `remote_deepgram_live` — сегмент со словами читается как слова, сегмент без них как ОДНА запись на весь свой span с его текстом и флагом `spanless`. Через него теперь ходят все четыре спрашивающих: `_spanless_coverage`, `deepgram_recovery.covered_spans`, `deepgram_dual.flatten_words` и (через первый) `_word_covered_by_spanless_final`.
  *Почему:* три места уже отвечали на этот вопрос, четвёртое (merge) отвечало «ничего», и это и есть B-001. Требование задания — «unify, don't add a fourth».
* *Выбрано:* на любом участке звука выигрывает ровно одно чтение. Блоб проигрывает реальным словам другого чтения, если те покрывают ≥ 50 % его span (`SPANLESS_SHADOW_MIN_FRACTION`); слова, попавшие под выживший блоб (правило центра — то же, что `_word_covered_by_spanless_final`), выбрасываются.
  *Отвергнуто:* «оставлять и блоб, и слова» — первая версия давала «это весь мой текст это», то есть ту самую дупликацию, с которой борются последние три релиза. *Отвергнуто:* «сопоставлять блоб со словом в `_same_audio`» — `_resolve` тогда заменяет целую клаузу одним словом (потеря текста хуже исходного бага).
* *Выбрано:* заметание (sweep) с кучей по `end` вместо двух указателей. *Отвергнуто:* предложенный в отчёте `lo`-указатель по `end` — `end` не монотонен в списке, отсортированном по `start`, поэтому продвижение `lo` по `end` может пропустить длинное слово, которое ещё релевантно. Куча ретайрит ровно то, что уже не может совпасть ни с этим, ни с любым последующим словом.
* *Выбрано:* merge остаётся синхронным. *Отвергнуто:* `asyncio.to_thread` — 40 мс CPU на 3000×3000 укладывается в объявленный `FINALIZE_ASSEMBLY_ALLOWANCE_SEC = 0.15`, а перевод `_merged_envelope` в async сделал бы асинхронным документированно синхронный `partial_result()`.
* *Выбрано:* перф-тест меряет `time.process_time`, а не настенные часы. *Почему:* дефект занимал event loop; CPU-время — единственная мера этого, которую загруженная машина не превращает в ложный красный (на этой машине load average 44).
* *Переписан тест* `test_a_wordless_segment_contributes_nothing` — он фиксировал сам дефект. Заменён двумя: правило и единственный по-настоящему пустой случай (нет ни слов, ни текста).

**Не сделано:** —

---

## Коммит 2 — `3b8f5a8` · P1 (запись восстановлена постфактум)

Предыдущий агент закоммитил эту группу, но не успел занести её в журнал; запись
добавлена следующим агентом по коммиту, без изменения кода.

**Заголовок:** «Deepgram's answer to Finalize is no longer thrown away, so the stop ends when the provider has answered instead of when a timer runs out»

**ID:** B-005 (P1), B-007 (P1), B-024 (P2). Попутно: `FINALIZE_COVERED_WAIT_SEC` и `FINALIZE_EMPTY_TAIL_WAIT_SEC` удалены — это и был костыль, названный в §5.1 первой строкой.

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_finalize_budget.py`, `backend/tests/test_deepgram_finalize_flush.py`, `backend/tests/test_deepgram_seam_tail.py`.

**Верификация:** сьют 640 → 652, зелёный (см. тело коммита; перепроверено на `1a12c3c`: `Ran 652 tests … OK`).

**Решения:** подробно изложены в теле коммита `3b8f5a8` (одна причина вместо трёх констант; пустой финал — это факт «флаш отвечен» и «окно декодировано и пусто», но не сегмент; `tail_needs_flush` остаётся правилом ПОВТОРА, `tail_needs_recovery` — правилом ПЕРЕДЕКОДИРОВАНИЯ, и первое по построению подмножество второго; `UtteranceEnd` вынесен в общий `confirmed_silence_gap`).

**Не сделано:** —

---

## Коммит 3 — `stats.recovery` · контракт с рендерером

**Заголовок:** «The stop trace can state how many seconds were re-decoded, because the envelope now reports the number the renderer reads»

**ID:** контракт из `docs/archive/NEXT_SESSION_2026-09-04b.md` §5.3 (рендерер `889c91a` ↔ бэкенд `bf84d6b`).

**Файлы:** `backend/deepgram_recovery.py`, `backend/tests/test_deepgram_recovery.py`.

**Верификация.**

До правки — поле, которое рендерер парсит, в конверте отсутствовало:
```
$ PYTHONPATH=. …/python3 -c "from backend.deepgram_recovery import RecoveryReport; print(RecoveryReport(spans=[(5.2,6.4)]).as_dict())"
{'spans': [[5.2, 6.4]], 'ms': 0.0, 'words': 0}
```
После:
```
{'spans': [[5.2, 6.4]], 'spans_sec': 1.2, 'ms': 0.0, 'words': 0}
```
Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 656 tests in 34.556s
OK
```
(652 → 656: +4 теста формы провода.)

**Решения.**

* *Выбрано:* `spans_sec` **выводится** из `spans` методом `RecoveryReport.spans_sec()`, а не хранится рядом полем.
  *Почему:* сумма и список, который она суммирует, не могут разойтись — это то же правило SSOT, по которому `uncoveredSpeechSec` пересчитывается, а не корректируется (`run_recovery`).
  *Отвергнуто:* второе поле в датаклассе, заполняемое вызывающим, — второй источник той же истины.
* *Выбрано:* лог-строка `recovery: spans=… total=…` теперь читает тот же `RecoveryReport`, а не считает `total_span_sec` третьим выражением. Отчёт строится один раз перед логом и он же уходит в `stats`.
* *Выбрано:* `spans` и `words` остаются в проводе. *Почему:* рендерер их не читает, но это диагностика, которую читают лог и тесты; удалять поле контракта ради «рендерер не смотрит» — сузить конверт без причины.
* *Выбрано:* форма провода закреплена отдельным тест-классом `RecoveryReportWireShapeTests` (имена ключей, типы, вывод суммы, пустой случай, неотрицательность).
  *Почему:* переименование на этой стороне не роняло ни одного теста — рендерер просто переставал показывать два числа; ровно этот класс дефекта и создал расхождение.

**Не сделано:** —

---

## Коммит 4 — тёплый пул × dual-stream

**Заголовок:** «A dual-stream recording pays one connect before its first byte instead of two, and the second reading is warmed like the first»

**ID:** B-003 (P1), B-004 (P1), B-013 (P1, частично — см. «решения»), B-087 (P2).

**Файлы:** `backend/deepgram_warm.py`, `backend/main.py`, `backend/tests/test_deepgram_warm.py`, `backend/tests/test_deepgram_coverage_holes.py`.

**Верификация.**

Новые тесты на коде ДО правки (`git show HEAD:backend/deepgram_warm.py`, `…:backend/main.py`):
```
FAIL: test_two_configurations_connect_at_the_same_time
AssertionError: 1 != 2 : the second acquire never reached connect
ERROR: test_a_stalled_connect_does_not_block_an_adoption  (TimeoutError)
FAIL: test_boot_warms_both_configurations_when_dual_is_on
  '…language=ru' not found in ['…language=multi'] : boot warmed only the primary reading
FAIL: test_both_configurations_are_warmed_when_the_recording_ends
  '…language=ru' not found in ['…language=multi'] : the second reading's configuration was never warmed
```

B-087 — прямой запуск тестовых модулей (`if __name__ == "__main__"` посреди файла):
```
ДО:   python3 backend/tests/test_deepgram_warm.py           Ran 39 tests
      python3 backend/tests/test_deepgram_coverage_holes.py Ran  8 tests
ПОСЛЕ: …test_deepgram_warm.py            Ran 54 tests   OK
       …test_deepgram_coverage_holes.py  Ran 29 tests   OK
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 662 tests in 33.481s
OK
```
(656 → 662.)

**Решения.**

* **B-003.** *Выбрано:* под `self._lock` остаётся только бухгалтерия пула; `connect()` ждётся снаружи через задачу. Та же `_pending`-машинерия схлопывает одновременные коннекты одной конфигурации, поэтому отдельная защита не нужна. `_await_pending` удалён — его роль (снять запись и подождать) теперь разложена по двум сторонам lock'а.
  *Дополнительно:* вызывающий (`_run_deepgram_live_session`) запускает второй `acquire` задачей ДО первого — без этого снятие lock'а само по себе ничего не ускоряет.
  *Отвергнуто:* «оставить lock, но взять для второго чтения отдельный lock по ключу» — два лока вместо одного и та же сериализация для любого третьего потребителя (boot-прогрев, `GET /api/live/warm`).
* **B-003, отмена.** Ждать задачу снаружи lock'а открывает новую дыру: вызывающего могут отменить, пока коннект уже вернул сокет. `_await_connect` вешает `done_callback`, который закрывает такой сокет на луупе. Это единственный реально достижимый случай «cancel проиграл гонку» (см. ниже).
* **B-004.** *Выбрано:* обе точки `rewarm` греют весь набор конфигураций, который использует эта запись/этот boot. На boot решение берётся из того же `dual_stream_enabled(cfg, "auto")`, что и в WS-обработчике, — одно правило, не второе.
* **B-013.** *Выбрано:* `_cancel_pending` больше не глотает собственную отмену пула (`except (CancelledError, Exception): pass` → разбор `task.cancelled()`), и закрывает сессию, если задача всё же вернула её.
  *Уточнение к находке:* описанная в отчёте утечка через `_cancel_pending` **не достижима** на текущем коде, и это измерено: тест `test_a_warm_connect_cancelled_by_a_key_change_closes_its_socket` проходит и ДО правки. Причина — `_warm_connect` ловит `CancelledError` вокруг `connect()` и закрывает сессию, а CPython при `_must_cancel` доставляет отмену именно в эту точку. Достижима **другая** половина того же класса — отменённый `acquire` поверх уже завершившегося коннекта; она закрыта `_await_connect` и закреплена вторым тестом (`test_an_acquire_cancelled_after_its_connect_returned_closes_it`), который ДО правки падает.
* **B-087.** *Выбрано:* охранник `if __name__ == "__main__"` перенесён в конец обоих файлов. *Почему:* `unittest discover` собирал всё и раньше, но прямой запуск модуля (как в этом журнале) молча выполнял треть тестов — то есть инструмент проверки врал.
* *Попутно:* `_WarmFakeUpstream` отвечает на четыре вопроса, которые задаёт `deepgram_recovery.evidence_from_session`. До этого каждый тест обработчика печатал `AttributeError`-трейсбек, а путь восстановления в них не исполнялся вовсе — фейк был не тем, что он изображал.
* *Попутно:* провал первичного коннекта теперь закрывает уже открытый сокет второго чтения (`_discard_secondary_acquire`) — раньше его просто не существовало, потому что второй `acquire` начинался после успеха первого.

**Не сделано:** —

---

## Коммит 5 — отмена, управляющие кадры и порядок стопа

**Заголовок:** «A cancelled stop stops, a control frame is never cancelled mid-write, and a socket swap can no longer be pulled out from under the finalize»

**ID:** B-008 (P1), B-009 (P1), B-011 (P1, «не баг» — см. решения), B-012 (P1), B-083 (P2, вторая половина — импорты посреди модуля).

**Файлы:** `backend/async_tasks.py` (новый), `backend/main.py`, `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_warm.py`, `backend/tests/test_live_teardown.py` (новый), `backend/tests/test_deepgram_warm.py`, `backend/tests/test_deepgram_dual.py`.

**Верификация.**

```
$ grep -rn "except (asyncio.CancelledError, Exception)" backend --include="*.py" | grep -v tests | wc -l
ДО: 11    ПОСЛЕ: 0
```
(в отчёте было 13 — два места закрыты коммитами `3b8f5a8`/`ea25b4f`.)

Новые тесты на коде ДО правки:
```
FAIL: test_a_swap_in_flight_is_waited_for_before_the_drain
AssertionError: True is not false : the stop finalized on the socket the swap was about to discard
```
(проверено на `ea25b4f` c добавленным `_WARM_SWAP_GRACE_SEC = 0.0`, иначе `mock.patch.object` не к чему прицепиться.)

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 675 tests in 36.970s
OK
```
(662 → 675.)

**Решения.**

* **B-008.** *Выбрано:* один помощник `backend/async_tasks.py` (`await_cancelled`, `cancel_and_await`, `cancel_and_collect`) вместо одиннадцати копий идиомы.
  *Важная поправка к предложенному в отчёте коду:* проверки `if not task.cancelled(): raise` **недостаточно**. Отмена корутины, которая ждёт другую задачу, отменяет и ту задачу, поэтому `task.cancelled()` истинно и в «нашем» случае тоже. Тест `test_our_own_cancellation_propagates` падал ровно на этом. Решающий вопрос — `asyncio.current_task().cancelling() > 0` (счётчик запросов отмены на НАС); он задаётся первым, `task.cancelled()` остаётся вторым.
  *Отвергнуто:* `contextlib.suppress(asyncio.CancelledError)` — то же самое подавление, только короче.
* **B-009.** *Выбрано:* `DeepgramLiveSession._send_control` — запись не отменяется никогда; зависшая ограничивается закрытием сокета, что и освобождает запись. Это дословно то правило, которое `send_pcm` уже формулирует и применяет к аудио-пути. Порог — новая именованная `CONTROL_SEND_WEDGE_SEC = 5.0`, те же 5 с, что были у `wait_for`, чтобы момент обнаружения не сдвинулся.
  *Плюс:* при отмене НАС управляющая запись тоже не отменяется — сокет закрывается, запись собирается, отмена пробрасывается.
* **B-012.** *Выбрано:* заявка на замену снимается ПЕРЕД ожиданием sender'а (раньше `warm_probe` отменялся после — слишком поздно, чтобы помешать замене начаться), а уже начатой замене даётся её собственный бюджет коннекта: `_WARM_SWAP_GRACE_SEC = DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC`.
  *Почему выведено, а не выбрано числом:* замена ждёт коннект, значит её отсрочка — это бюджет коннекта; отдельная константа отстала бы от изменения любой из двух.
  *Отвергнуто:* «блокировать замену флагом и продолжать стоп немедленно» — тогда стоп финализируется на сокете, который замена уже признала мёртвым, то есть тот же потерянный транскрипт другой дорогой.
  *Оставлено:* если замена не уложилась и в grace, это `logger.error` с явным текстом — потеря будет объяснимой, а не загадочной.
* **B-011 — «не баг» (измерено).** `asyncio.wait_for` в Python 3.12 сам отменяет и **дожидается** внутреннюю задачу перед тем, как поднять `TimeoutError` (`_cancel_and_wait`), поэтому к моменту `partial_result()` вторичный drain уже завершён. Написанный по находке тест (`test_a_late_secondary_is_awaited_before_it_is_snapshotted`) проходит и ДО правки. Замена `secondary_task.cancel()` на `cancel_and_await` оставлена: она делает инвариант явным и не зависит от того, останется ли эта деталь `wait_for` в следующей версии Python.
* **B-083 (вторая половина).** Шесть импортов из `remote_deepgram_live` переехали с 1000-й строки в начало файла; `# noqa: E402` больше не нужны. Все шесть — листовые модули, цикла нет (проверено импортом).
* *Попутно:* `_WarmFakeUpstream` дополнен `stream_death_sec`, чтобы путь восстановления в тестах обработчика исполнялся целиком.

**Не сделано:** —

---

## Коммит 6 — числа конверта

**Заголовок:** «`coveredEndSec` stops repeating `durationSec`, so a spliced tail word can no longer make an incomplete envelope look complete»

**ID:** B-006 (P1), B-010 (P1), B-026 (P2).

**Файлы:** `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/audio_constants.py`, `backend/main.py`, `backend/tests/test_deepgram_interim_splice.py`, `backend/tests/test_deepgram_warm.py`, `backend/tests/test_audio.py`.

**Верификация.**

B-006, тот же сеанс, ДО и ПОСЛЕ (финал 0–1 с + вставленное interim-слово 3.0–3.5 с):
```
BEFORE: durationSec=3.5 coveredEndSec=3.5
AFTER:  durationSec=3.5 coveredEndSec=1.0
```

B-010, тест на коде ДО правки:
```
AssertionError: 'streamed_sec=0.0' not found in
  'ws deepgram session complete: bytes=3200 streamed_sec=0.1 …'
```
(запись со сменой сокета: конверт нёс 0.0, лог печатал 0.1 — два разных числа об одном.)

B-026:
```
$ grep -rn "2 \* LIVE_SAMPLE_RATE_HZ\|2 \* max(1" backend/*.py
ДО: 5 совпадений    ПОСЛЕ: 0
```

Полный набор:
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
Ran 683 tests in 39.007s
OK
```
(675 → 683.)

**Решения.**

* **B-006.** *Выбрано:* `_committed_end_sec()` — максимум по сегментам БЕЗ поля `source`, читается ДО сплайса. Правило «провайдерский финал», а не «не interim»: сегмент от REST-восстановления (`source="recovery"`) тоже не покрытие живого чтения, и тест это фиксирует.
  *Отвергнуто:* фильтровать по конкретной строке `"interim-fallback"` — тогда следующий источник вставки снова врал бы в это поле.
  *Строка `"interim-fallback"` названа константой* `INTERIM_FALLBACK_SOURCE` — её теперь читают два места.
* **B-006, dual.** *Выбрано:* `coveredEndSec` объединённого конверта — максимум из двух `coveredEndSec` чтений, а не конец объединённых слов. *Почему:* объединение включает вставленные interim обеих сторон; каждое чтение уже измеряет своё покрытие правильно, и дальнейшее из двух — это ground, который хотя бы одно чтение зафиксировало.
* **B-010.** *Выбрано:* лог-строка стопа читает `final_payload["streamedSec"]` — то самое число, которое ушло рендереру.
  *Отвергнуто (сначала сделано, потом откачено):* публичный `session.streamed_seconds()`. Он потребовал бы метода на пяти тестовых фейках и на фасаде, а главное — оставил бы ДВА выражения (метод сессии и вызов в main) там, где нужен один источник. Конверт уже содержит ответ.
* **B-026.** *Выбрано:* `LIVE_PCM_BYTES_PER_SEC` в четырёх местах `main.py` с фиксированной частотой и новая `pcm16_bytes_per_sec(rate)` в двух местах, где частота приходит из конфигурации (`_streamed_seconds`, `run_recovery`).
  *Почему функция, а не ещё одна константа:* live-сессия берёт частоту из своего `DeepgramLiveConfig`; константа 16 кГц там была бы неверна, а `2 * rate` — пятой копией правила.
  *Плюс:* `pcm16_bytes_per_sec` не может вернуть 0 (это делитель).
  *Тест* `test_the_expression_is_no_longer_written_out_by_hand` ищет обе формы по всему `backend/*.py`, поэтому шестая копия не появится молча.

**Не сделано:** —

---

## Коммит 7 — конфигурация

**Заголовок:** «Reading the config stops rewriting it, an unusable data dir no longer kills the backend before it starts, and one bad POST can no longer brick Upscale forever»

**ID:** B-018 (P1), B-019 (P1), B-020 (P1), B-021 (P1).

**Файлы:** `backend/config.py`, `backend/tests/test_config.py`.

**Верификация.** Новые тесты на коде ДО правки:
```
FAIL: test_a_newer_config_is_never_rewritten_on_read
  b'{\n  "schema_version": 3, …}' != b'{"schema_version": 3}' : a read rewrote the config file
FAIL: test_a_string_where_the_block_belongs_is_reset
  'oops' is not an instance of <class 'dict'>
FAIL: test_a_non_string_model_falls_back_to_the_default
  42 != 'google/gemini-2.5-flash'
FAIL: test_an_empty_keyfile_is_replaced_and_secrets_work_again
  0 not greater than 0 : the empty keyfile was left in place
ERROR: test_an_unusable_data_dir_degrades_instead_of_raising   (NotADirectoryError на импорте)
```
Полный набор:
```
Ran 692 tests in 36.772s
OK
```
(683 → 692.)

**Решения.**

* **B-018.** *Выбрано:* штамповать только конфиг СТАРЕЕ этой сборки (`original < SCHEMA_VERSION`) или вовсе без поля, и писать именно `SCHEMA_VERSION`, а не то, что пришло из файла. `merged["schema_version"]` обновляется в памяти, чтобы возвращаемый словарь совпадал с диском.
  *Почему это важнее, чем «лишние fsync»:* `.bak` документирован как единственная автоматическая копия настроек; ротация на каждом чтении схлопывала окно восстановления в секунды.
  *Отвергнуто:* «понижать версию к нашей» — `_migrate_schema` специально сохраняет форвард-совместимость и неизвестные поля.
* **B-019.** *Выбрано:* симметричный ремонт `preferences.openrouter` рядом с блоком `deepgram`, по тем же правилам (не объект → дефолтный блок; `model` не строка → дефолтная модель).
  *Почему:* докстринг модуля прямо обещает это поведение для `openrouter`; сделано было только для `deepgram`.
* **B-020.** *Выбрано:* нулевой keyfile удаляется и создаётся заново; правило «никогда не перезаписывать» сохраняется для файла С СОДЕРЖИМЫМ (тест это фиксирует отдельно — испорченный, но непустой ключ не трогают). Ветка `FileExistsError` делает то же и один раз рекурсивно повторяет создание.
  *Почему так:* `main._load_or_create_api_token` для точно такой же ситуации уже перегенерирует файл — политика в проекте есть, здесь её просто не применили.
* **B-021.** *Выбрано:* `_resolve_data_dir()` — предупредить и уйти на `~/.transcriptor`; если и он недоступен, всё равно не падать, а сказать в лог, что конфиг не будет сохраняться.
  *Почему:* политика «warn and default» записана в `deepgram_endpoints` и исполняется `main._env_int`; `TRANSCRIPTOR_DATA_DIR` — единственная документированная настройка, которая ей не следовала, и её цена — «backend did not start» без причины.
  *Тест* подменяет `HOME`, чтобы не создавать каталог в настоящем домашнем.

**Не сделано:** —

**Долг:** первая версия теста B-021 (до подмены `HOME`) один раз создала `~/.transcriptor/.encryption_key` на машине пользователя. Файл пустой смысловой нагрузки не несёт и ничем не читается, пока `TRANSCRIPTOR_DATA_DIR` доступен; удалить его может пользователь — агент чужие файлы не удаляет.

---

## Коммит 8 — файлы, ffmpeg и модели

**Заголовок:** «ffmpeg no longer reads the channel Electron talks on, the heaviest model can finally be unloaded, and a failed save gives the name back»

**ID:** B-014 (P1), B-015 (P1), B-016 (P1), B-017 (P1), B-037 (P2).

**Файлы:** `backend/audio.py`, `backend/transcribe.py`, `backend/transcribe_gigaam.py`, `backend/storage.py`, `backend/main.py`, `backend/tests/test_audio.py`, `backend/tests/test_model_idle_unload.py`, `backend/tests/test_storage.py`, `backend/tests/test_recording_names.py`.

**Верификация.** Новые тесты на коде ДО правки:
```
FAIL: test_every_ffmpeg_process_is_started_with_stdin_closed
  None != -3 : ffmpeg inherited the backend's stdin
FAIL: test_the_conversion_commands_carry_the_flag_too (fn='ensure_wav_16k')          '"-nostdin"' not found
FAIL: test_an_idle_gigaam_model_is_released                 [] != ['gigaam-v3-rnnt']
FAIL: test_release_model_evicts_gigaam_too                  False is not true
FAIL: test_the_two_answers_about_residency_agree            True != False
ERROR: test_the_in_middle_marker_is_swept_whatever_the_name (ImportError: TMP_ORPHAN_RE)
ERROR: test_the_local_conversion_ceiling_is_named_once      (нет _LOCAL_CONVERT_TIMEOUT_SEC)
FAIL: test_a_failed_new_save_releases_the_name_it_reserved
  Lists differ: [PosixPath('…/lecture.txt.tmp-000000.claim')] != []
```
Полный набор:
```
Ran 704 tests in 38.028s
OK
```
(692 → 704.)

**Решения.**

* **B-014.** *Выбрано:* `stdin=subprocess.DEVNULL` в единственном `Popen` — это закрывает все четыре команды и любую пятую. `-nostdin` добавлен и в две команды конверсии, чтобы форма была одинаковой у всех четырёх (её уже проверяют тесты для двух других).
  *Отвергнуто:* только флаг в argv — он покрывает ffmpeg, но не общее правило «дочерний процесс не наследует наш stdio-канал».
* **B-015.** *Выбрано:* точка освобождения `release_gigaam` в адаптере + `resident_gigaam_models()`; `transcribe.release_model` и `release_idle_models` диспетчеризуются по тому же префиксу, что уже использует `model_is_resident`. Использование gigaam отмечается в общем `_MODEL_LAST_USED` (в обеих ветках транскрипции и в `warm_model`), то есть окно простоя одно на оба движка.
  *Важно:* освобождение gigaam выполняется ВНЕ `_MODEL_LOCK` — у чужого кэша свой замок, и брать один под другим значит завести дедлок.
  *Отвергнуто:* импортировать `backend.transcribe_gigaam` в подметальщике — это отменило бы ленивый импорт torch ради вопроса «а есть ли что выгружать»; вместо этого `_gigaam_module()` смотрит в `sys.modules`, и тест это фиксирует.
* **B-016.** *Выбрано:* `_release_recording_text_claim()` в обеих ветках отката. *Почему это не просто мусор:* архив регистрируется только после УСПЕШНОГО сохранения, поэтому подметальщик в эту папку никогда не заглянет, а имя маркера детерминировано — каждая следующая попытка того же заголовка уезжает на timestamp-имя. Тест проверяет обе стороны: два провала подряд не оставляют маркеров, и следующая успешная попытка получает естественное имя `lecture.txt`.
* **B-017.** *Выбрано:* соглашение об имени временного файла (`TMP_ORPHAN_RE`) переехало в `backend/storage.py` — модуль, который его и порождает и чей докстринг объявляет его инвариантом; `main` импортирует, тест импортирует. Группа расширений стала `*` вместо `?`.
  *Почему переезд, а не просто `?`→`*`:* правило было записано трижды (регулярка в `main`, литеральная копия в тесте, докстринг в `storage`), и разошлись именно копии. Тест `test_backend_main_reads_the_same_pattern_rather_than_a_copy` не даёт копии вернуться.
* **B-037.** `_LOCAL_CONVERT_TIMEOUT_SEC = 300` рядом с `_REMOTE_COMPACT_TIMEOUT_SEC`; тест запрещает литерал в обеих функциях.

**Не сделано:** вторая половина B-037 («локальные конверсии не принимают `cancel_event`») — это не дефект, а отсутствующая функция: у локального пути нет вызывающего, который умеет отменять. Записано в долг.

---

## Коммит 9 — зависимости и переменные окружения

**Заголовок:** «The env reference stops describing a mechanism that does not exist, and the package six symbols are imported from is declared»

**ID:** B-022 (P1), B-023 (P1), B-029 (P2), B-044 (P2), B-058 (P2).

**Файлы:** `.env.example`, `requirements.txt`, `backend/transcribe_gigaam.py`, `backend/tests/test_config.py`.

**Верификация.** Новые тесты на файлах ДО правки:
```
FAIL: test_every_backend_variable_is_documented_or_declared_internal
  ['TRANSCRIPTOR_DEEPGRAM_FILLER_WORDS', 'TRANSCRIPTOR_DEEPGRAM_PUNCTUATE',
   'TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT', 'TRANSCRIPTOR_GIGAAM_CACHE_SIZE'] != []
FAIL: test_the_file_does_not_promise_a_dotenv_mechanism
  'Copy to .env' unexpectedly found
FAIL: test_the_clamped_whisper_settings_state_their_range
FAIL: test_every_third_party_module_the_backend_imports_is_declared
  ['huggingface_hub'] != []
```
B-044:
```
$ TRANSCRIPTOR_GIGAAM_CACHE_SIZE=oops python3 -c "import backend.transcribe_gigaam"
ДО:    ValueError: invalid literal for int() with base 10: 'oops'   (движок недоступен)
ПОСЛЕ: invalid integer env TRANSCRIPTOR_GIGAAM_CACHE_SIZE='oops'; using default=1
```
Полный набор:
```
Ran 708 tests in 37.134s
OK
```
(704 → 708.)

**Решения.**

* **B-023.** *Выбрано:* сказать правду в шапке `.env.example` — «reference only, ничего не читает `.env`, экспортируйте в оболочке/CI».
  *Отвергнуто:* добавить `python-dotenv` и `load_dotenv()`. Это новая зависимость и новый порядок разрешения настроек (файл против окружения) на пути старта приложения — продуктовое решение, а не починка расхождения. Записано в долг.
  *Не сделано здесь:* `README.md:127` («`cp .env.example .env`») — README вне периметра бэкенд-агента. В долг.
* **B-022.** *Выбрано:* `huggingface_hub>=0.23,<2` в `requirements.txt` с обоснованием прямо в файле. Нижняя граница — из фактически используемого API, верхняя — потому что мажорная смена ломает листинг/скачивание/удаление локальных моделей, а faster-whisper объявляет только `>=0.13`.
  *Тест* держит список прямых сторонних импортов бэкенда против объявленного, явным перечнем: выведенный автоматически список требовал бы решать, что тут stdlib, и превратил бы тест в шум.
* **B-029.** Четыре переменные добавлены в `.env.example`; сканер в тесте ищет ЛЮБОЙ строковый литерал `"TRANSCRIPTOR_*"` в `backend/**`, а не только аргументы `os.environ`, — три из четырёх пропущенных шли через `_env_flag`, и узкий скан объявил бы файл полным.
* **B-058.** У двух Whisper-настроек указаны их реальные клампы (4–8 и 1–3); тест это фиксирует. Значение вне диапазона молча подтягивается, и пользователь, выставивший 16 потоков, не имеет способа узнать почему ничего не изменилось.
* **B-044.** `int(os.environ...)` → `_env_int` (политика пакета), импортирован из `backend.transcribe`; цикла нет — обратные импорты gigaam там ленивые.

**Не сделано:** —

---

## Коммит 10 — одно правило в одном месте (сохранение записей, пресеты, провайдеры)

**Заголовок:** «One list of built-in presets, one rule for an empty recognition, one way to claim a recording's name, and a duration each provider reports for itself»

**ID:** B-028 (P2), B-030 (P2), B-031 (P2), B-032 (P2), B-073 (P2), B-084 (P2).

**Файлы:** `backend/main.py`, `backend/model_catalog.py`, `backend/config.py`, `backend/remote_deepgram.py`, `backend/remote_openrouter.py`, `backend/tests/test_upscale_presets.py`, `backend/tests/test_recording_names.py`, `backend/tests/test_remote_chunking.py`, `backend/tests/test_remote_openrouter.py`.

**Верификация.**
```
Ran 719 tests in 38.173s
OK
```
(708 → 719.)

**Решения.**

* **B-030.** `UPSCALE_PRESETS` удалён; валидация легаси-поля читает ключи `BUILTIN_UPSCALE_PRESETS`. Тест запрещает второму списку вернуться (`assertFalse(hasattr(main, "UPSCALE_PRESETS"))`).
* **B-028.** `DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER = REMOTE_TRANSCRIPTION_PROVIDERS[0]` в `model_catalog` — той же формы, что рядом стоящий `DEFAULT_LIVE_PREVIEW_LOCAL_MODEL`; `config.DEFAULT_CONFIG` и вызов в `main` читают его.
* **B-031.** `_placeholder_source_text(...)` + `NO_SPEECH_PLACEHOLDER`. Расхождение было содержательным: только один эндпоинт освобождал `provider="none"` — маркер рендерера «сохранить запись, не прося транскрипт», — поэтому одно и то же пустое распознавание давало разные файлы. Правило одно, тест проверяет обе стороны и оба эндпоинта.
* **B-032.** Промоут берёт имя через `_claim_recording_text_path` (O_EXCL), как оба эндпоинта сохранения, и освобождает claim на откате. *Отвергнуто:* оставить `_unique_recording_stem` и «просто добавить лок» — примитив резервирования уже написан, второй механизм не нужен.
* **B-073.** Три функции семейства «проверить-и-использовать» (`_unique_recording_stem`, `_unique_stem_from_base`, `_unique_recording_stem_for_source_file`) после B-032 не имеют ни одного продакшн-вызывающего и удалены. Четыре теста, которые их держали, **перенаправлены на живой путь** — это и был смысл находки: покрытым был мёртвый код, а не тот, по которому ходит приложение.
* **B-084.** `duration` — часть контракта адаптера: `deepgram_transcribe` читает свой `metadata.duration`, `openrouter_transcribe` честно отдаёт 0.0, вызывающий читает один ключ. Раньше вызывающий разбирал форму Deepgram у ответа OpenRouter, и каждая удалённая транскрипция через OpenRouter сообщала нулевую длительность.

**Не сделано:**

* **B-038** (три формы одного wire-типа `final`). Закрыть его — значит поменять форму конверта локального пути и парсер рендерера ОДНИМ коммитом: `frontend/src/main.tsx` читает плоские `complete/coveredSec/totalSec/droppedSec/uncoveredTailSec` и прямо документирует «coverage присутствует только у local-assist». Рендерер в этой сессии ведёт другой агент; менять его отсюда нельзя, а односторонняя правка либо ломает парсер, либо добавляет ЧЕТВЁРТУЮ форму. → долг с готовой рекомендацией.

---

## Коммит 11 — движки, языки и общий словарный API

**Заголовок:** «"auto" means one thing per endpoint and says why, the live config has one builder, and the predicates two modules share stop being private»

**ID:** B-027 (P2), B-033 (P2), B-034 (P2), B-035 (P2), B-036 (P2), B-039 (P2), B-040 (P2), B-041 (P2).

**Файлы:** `backend/deepgram_language.py` (новый), `backend/remote_deepgram.py`, `backend/remote_deepgram_live.py`, `backend/deepgram_dual.py`, `backend/deepgram_recovery.py`, `backend/model_catalog.py`, `backend/config.py`, `backend/models_manager.py`, `backend/transcribe.py`, `backend/transcribe_gigaam.py`, `backend/main.py`, `backend/tools/deepgram_live_ab.py`, тесты: `test_deepgram_language.py` (новый), `test_deepgram_dual.py`, `test_transcribe_gigaam.py`, `test_live.py`.

**Верификация.**
```
Ran 742 tests in 54.591s
OK
```
(719 → 742.)

**Решения.**

* **B-039.** *Выбрано:* новый листовой модуль `backend/deepgram_language.py` владеет обоими ответами: `resolve_live_language` (переехал из `remote_deepgram_live`, реэкспортируется оттуда — ни один импортёр не тронут) и новый `rest_language_params`.
  *Поведение НЕ изменено намеренно:* REST по-прежнему шлёт `detect_language=true`. Измерение 2026-09-03 (память проекта) говорит, что `multi` теряет русские клаузы; REST-проход используется как «полное прочтение», и переводить его на `multi` — регрессия качества, а не унификация. Дефект был в том, что расхождение нигде не объяснено; теперь оно записано один раз, с причиной, и обе стороны читают его из одного места.
  *Исключение, которое не исключение:* `deepgram_recovery` намеренно шлёт `resolve_live_language` — она чинит дыру в чтении, сделанном стримом, и дыра не должна вернуться на другом языке, чем текст вокруг.
* **B-041.** `live_config()` переехал к типу конфигурации (`remote_deepgram_live`); `main._live_config` — привязка к нему (тесты зовут по этому имени), A/B-инструмент вызывает его же. Тест проверяет тождество объектов и что инструмент больше не может собрать конфиг сам.
* **B-033.** Пять имён (`_word_core`, `_word_duration`, `_time_overlap`, `_token_stem`, `_segment_words`) и шестое, найденное по ходу (`_as_float`, импортировался в `deepgram_recovery` отдельной строкой с `# noqa`), переименованы в публичные и внесены в `__all__`. Тест сканирует `backend/*.py` и запрещает импорт любого имени с подчёркиванием из этого модуля.
* **B-027.** `DUAL_STREAM_DEFAULT` / `DUAL_SECONDARY_LANGUAGE_DEFAULT` переехали в `model_catalog` — листовой модуль, который уже владеет «чем приложение пользуется по умолчанию» и который импортируют обе стороны.
  *Отвергнуто:* `deepgram_dual` импортирует `config` — тогда импорт модуля слияния создавал бы каталог данных (side effect на импорте) в любом тесте, который его трогает.
  *Не сделано:* третья копия в `frontend/src/deepgram-dual.ts` — фронтенд ведёт другой агент. В долг.
* **B-034/B-035.** `LIVE_SAMPLE_RATE_HZ` в четырёх местах GigaAM-адаптера; `GIGAAM_MODEL_PREFIX` в трёх местах `models_manager` вместо литерала, а неиспользуемый импорт `GIGAAM_MODELS` убран. Оба закреплены тестами, которые ищут литерал в исходнике.
* **B-036.** `_MIN_DECODABLE_WAV_BYTES` + `_undecodable_wav_result(path)`, спрошенный ДО диспетчеризации движка и до загрузки модели. Попутно закрыто названное в находке расхождение: пустой результат файловых входов сообщал жёсткий `0.0`, тогда как `transcribe_audio` считал реальную длительность; теперь считают все.
* **B-040.** Тест читает `main._FINALIZE_DRAIN_CEILING_SEC`, а не помнит `0.24`.

**Не сделано:** —

---

## Коммит 12 — арифметика локального live-ассиста

**Заголовок:** «The local assist stops overstating what it lost, sees its own output while deciding what to trim, and moves a trimmed segment out of committed time»

**ID:** B-068 (P2), B-069 (P2), B-070 (P2), B-071 (P2), B-078 (P2).

**Файлы:** `backend/live.py`, `backend/tests/test_live_coverage.py`.

**Верификация.** Новые тесты на коде ДО правки:
```
FAIL: test_a_second_truncation_does_not_double_count_the_overlap   24.0 != 23.0 (1.0 difference)
FAIL: test_a_repeat_inside_one_pass_is_trimmed
  ['починить очень важно', 'починить очень важно снова'] != ['починить очень важно', 'снова']
FAIL: test_a_text_trimmed_segment_moves_its_start_past_the_watermark
FAIL: test_escalation_is_by_count_and_keeps_no_write_only_state    True is not false
```
Полный набор: 742 → 748, зелёный.

**Решения.**

* **B-068.** `dropped = max(0, window_start_sec - covered_sec)` вместо `need_sec - max_window_sec`. Разница — ровно `overlap_sec` на событие, и она накапливалась: перекрытие переподаётся НАМЕРЕННО и уже декодировано, потерей оно не является. Существующий тест проверял только `> 0.0`, поэтому значение ничем не держалось; новые тесты закрепляют и величину, и отсутствие двойного счёта на второй усечённой итерации, и ноль на сессии, которая успевает.
* **B-069.** `_emitted_tail_text(pending)` — защита от повтора видит сегменты ЭТОГО прохода. Межпроходный случай был закрыт, внутрипроходный проходил насквозь; тест воспроизводит ровно его.
* **B-070.** Снимок `cutoff` до цикла удалён; словная и бессловная ветки читают одно живое выражение `self._last_emitted_end + emit_epsilon_sec`.
* **B-071.** Обрезанный по тексту сегмент сдвигает `g_start` за отметку выданного — по причине, дословно записанной двумя ветками выше для словной обрезки. Якоря по «первому новому слову» здесь нет (слов нет), поэтому якорь — сама отметка, ограниченная концом сегмента.
* **B-078.** *Выбрано:* удалить `_last_error_signature`. *Отвергнуто:* предложенный в отчёте вариант «считать подряд только ОДИНАКОВЫЕ ошибки» — это регрессия: сессия, мигающая между двумя разными сбоями, не эскалировала бы никогда, а `_LIVE_MAX_CONSECUTIVE_ERRORS` документирует именно счётчик подряд идущих отказов.

**Не сделано:** —

---

## Коммит 13 — ошибки, которые сообщали не то, что произошло; и код, который только выглядел работающим

**Заголовок:** «A refusal stops reporting itself as success, a failed permission tightening stops reporting itself as a failed write, and eight pieces of code that did nothing are gone»

**ID:** B-042, B-043, B-045, B-046, B-047, B-048, B-049, B-050, B-051, B-052, B-053, B-054, B-055, B-072, B-074, B-075, B-076, B-077, B-079, B-080, B-081, B-082, B-083 (все P2).

**Файлы:** `backend/main.py`, `backend/config.py`, `backend/storage.py`, `backend/jobs.py`, `backend/http_retry.py`, `backend/models_manager.py`, `backend/remote_openrouter.py`, `backend/remote_deepgram.py`, `backend/transcribe_gigaam.py`, `backend/audio.py`, тесты: `test_error_honesty.py` (новый), `test_audio.py`, `test_live.py`.

**Верификация.** Новый модуль `test_error_honesty.py` на коде ДО правки: `Ran 18 tests … FAILED (failures=6, errors=8)`. Полный набор: 748 → 766, зелёный.

**Решения (по ID).**

* **B-042.** `content` приводится, как это уже делает соседняя `openrouter_transcribe`; `None` — провайдерская ошибка, а не пустой текст. Добавлена цепочка `from shape_err`.
* **B-043.** `except ImportError` отделён от «модели нет в кэше» и логируется `warning`. Два неиспользуемых импорта исключений удалены — из-за них перенос любого символа в `huggingface_hub` молча сообщал бы «ни одна whisper-модель не скачана».
* **B-045.** Провал `thread.start()` снимает захват состояния и переводит модель в `error`; иначе она навсегда «downloading» — и не скачивается, и не удаляется.
* **B-046.** `JobStore.submit` вешает `done_callback`, логирующий исключение из воркера. `Future` выбрасывался, а это единственное место, куда `ThreadPoolExecutor` кладёт то, что вышло за обработчики воркера.
* **B-047.** Сообщение печатает `retried + 1` — число попыток, которые были; лог рядом уже печатал его правильно.
* **B-048.** Вытесненный транзитный ответ закрывается перед сном (`_close_quietly`). Сегодня `stream=True` не использует никто, поэтому это профилактика, а не исправление наблюдаемого.
* **B-049.** `chmod` ПОСЛЕ `os.replace` больше не превращает состоявшуюся запись в `OSError`. Цена этого дефекта была конкретна: `_load_or_create_api_token` уходил на in-memory токен, тогда как на диске лежал другой — и следующий запуск читал его.
* **B-050.** Нечитаемый каталог — `503` с именем каталога, а не `500 could not allocate unique recording name`.
* **B-051.** Неизвестный статус очереди → `queued`, а не `error`.
* **B-052.** `_clear_live_draft_state` возвращает `cleared: bool`; отказ по владельцу больше не приходит под `ok: true`.
* **B-053.** Форма определяется по СХЕМЕ (`draft` — объект или явный `null`), а не по количеству ключей. Собственный ответ `PUT` содержит три ключа, поэтому эхо этого ответа сохраняло пустой черновик с HTTP 200.
* **B-054.** `atomic_write_json` принимает `mode`; `config.json` пишется `0600` во всех трёх местах, `DATA_DIR` создаётся `0700`. Штатно там шифротекст, но модуль сам документирует plaintext-фолбэк без `cryptography`.
* **B-055.** `_is_masked_key_value` знает обе формы маски — свою (`abc...yz`) и рендереровскую (строка из U+2022). Сегодня рендерер защищает свой ввод сам, то есть защита стояла не на той стороне; любой другой клиент, отправивший показанное, записал бы строку из точек в качестве ключа.
* **B-072.** `compact_audio_for_remote` + её билдер argv удалены (единственный путь удалённой загрузки — чанковый); два теста перенацелены на живую команду. Обоснование «почему всегда конвертируем» перенесено в выжившую функцию, чтобы не потерять его вместе с мёртвой.
* **B-074.** `import numpy as np` и импорт `write_wav` удалены.
* **B-075.** Ветка «/api/health не требует токена» удалена из `_require_api_auth`; правило живёт на объявлении роута. Тест, который проверял мёртвую ветку, теперь проверяет сами зависимости обоих роутов.
* **B-076.** `status` и `write_error` попадают в строку списка восстановлений — сессия с половиной спула больше не предлагается как чистая.
* **B-077.** `_LAST_LOAD_ERROR` удалён (глобал, в который только писали и который не очищался при успехе).
* **B-079.** Мёртвая `step` удалена; вместо неё записано, чем шаг цикла на самом деле является.
* **B-080.** Два комментария про `np.frombuffer` и «500 MB / 1.5 GB heap» заменены на то, что код делает сейчас (потоковая конверсия, потолок `MAX_RECOVERY_PROMOTE_BYTES`).
* **B-081.** Обоснование порядка удаления переписано на верное: осиротевший `.json` не виден листингу вообще, а опасен обратный случай — снятый sidecar при выжившем `.pcm16`, когда «discard» пользователя молча не состоялся.
* **B-082.** В WS-области `HTTPException` заменена на протокольный `{"type":"error", …}` + close 4400.
* **B-083.** `RemoteError = DeepgramRemoteError` убрано; шесть `raise` в модуле называют подкласс явно. (Вторая половина — импорты посреди модуля — закрыта в коммите 5.)

**Не сделано:** —

---

## Коммит 14 — тесты, которые ничего не проверяли, и ресурсы без границы

**Заголовок:** «Four tests that could not fail now can, the stereo split stops loading the file it splits, and the job store's soft cap has a hard one behind it»

**ID:** B-056, B-060, B-061, B-062, B-064, B-066, B-067, B-085, B-086, B-088 (частично), B-089, B-090 (все P2).

**Файлы:** `backend/audio.py`, `backend/transcribe_gigaam.py`, `backend/model_catalog.py`, `backend/jobs.py`, `backend/main.py`, `backend/config.py`, тесты: `test_untested_units.py` (новый), `test_resource_bounds.py` (новый), `test_remote_chunking.py`, `test_live.py`, `test_transcribe_gigaam.py`, `test_deepgram_seam_tail.py`, `test_live_coverage_policy.py`, `test_mic_health.py`.

**Верификация.**
```
Ran 796 tests in 36.788s
OK
```
(783 → 796; за коммит 766 → 796.)

Скорость набора (B-088, частично):
```
backend/tests/test_deepgram_seam_tail.py   ДО: 12.04 s   ПОСЛЕ: 0.12 s
весь набор                                 ДО: ~39 s     ПОСЛЕ: ~25-36 s
```

Новые тесты ресурсов на коде ДО правки: `Ran 13 tests … FAILED (failures=5, errors=3)`.

**Решения.**

* **B-085.** Оба теста без утверждений переписаны так, чтобы падать: хелперы восстановления должны быть НИЧЕМ (не создавать спул из `None`, не логировать warning), а положительный auth-тест теперь ещё и проверяет, что НЕВЕРНЫЙ токен отвергается — иначе «прошло без исключения» защищало и короткое замыкание до сравнения.
* **B-086.** `mock.patch.dict(sys.modules, {"gigaam": None})` форсирует `ImportError`; `sys.modules.pop` не мешал импорту с диска, поэтому на машине С пакетом тест падал на `assertIsInstance(None, str)`. Добавлен зеркальный случай «движок доступен → причины нет».
* **B-088 — частично.** *Сделано:* `TailGuardTests` патчит `FINALIZE_FLUSH_WAIT_SEC` в `setUp` — три теста спали через реальный потолок дважды каждый, это было 12 из ~39 секунд набора. *Не сделано:* инжектируемые часы в `DeepgramLiveSession` (предложение отчёта). Это правка горячего пути финализации ради стиля тестов; риск выше выигрыша, оставшиеся утверждения по часам имеют запас ≥ 2× к пропатченным константам. → в долг.
* **B-089.** Отсутствие `node`/`frontend/node_modules` при `CI=1` — падение с объяснением, а не скип. Локально скип сохраняется.
* **B-090.** Новый `test_untested_units.py`: `audio_content_type` (все отображения + фолбэк + пустое имя), лестница `_exponential_backoff` (экспонента, а не линейная, и джиттер), `_parse_retry_after` (дельта, HTTP-дата, прошедшая дата, мусор), форма пустого результата и `_probe_tone`, слияние каналов, парсер и загрузчик PCM A/B-инструмента.
* **B-060.** `split_channels` пишет два моно-файла блоками через `sf.SoundFile.blocks` вместо `load_wav` целиком (двухчасовой стерео — 921 МБ float32 плюс копия на канал). Тест доказывает, что `load_wav` больше не вызывается вовсе, и что провал на втором файле не оставляет `.tmp-*`.
* **B-061.** `reader.join` перенесён в `finally` — раньше на ветках таймаута и отмены `collected` читался, пока поток мог в него писать, и это ровно те ветки, ради диагностики которых он и существует. Убитый ffmpeg подбирается через `_kill_and_reap`, который ЛОГИРУЕТ неудачу `wait` вместо проглатывания. `_FFMPEG_STDERR_CAP_BYTES` → `_FFMPEG_STDERR_CAP_CHARS`: поток текстовый, лимит всегда был в символах.
* **B-062.** `_write_wav` удаляет свой временный файл, если `sf.write` упал; имя не соответствует `.tmp-<hex>`, поэтому никакой свипер его не подберёт.
* **B-064.** `gigaam_available` под `lru_cache` — ответ не может измениться внутри процесса, а вопрос задаётся на опрашиваемом `/api/health`, и для отсутствующего модуля `find_spec` обходит весь `sys.path`.
* **B-066.** Жёсткий потолок `3 × max_jobs`: выше него вытесняются самые старые ТЕРМИНАЛЬНЫЕ задания независимо от того, наблюдал ли их кто-нибудь. Выполняющиеся не трогаются никогда. Комментарий называл потолок «намеренно мягким», но за ним не стояло ничего.
* **B-067.** Реестр локов промоута считает держателей; запись снимается, только когда их не осталось. Иначе третий вызывающий получал НОВЫЙ лок и входил в тело рядом со вторым.
* **B-056.** Миграция легаси-данных берёт с собой ключ шифрования. *Важно:* просто «скопировать, если своего нет» не работало бы — `_load_or_create_fernet_key()` выполняется на импорте, то есть свой ключ УЖЕ есть к моменту миграции. Ключ усыновляется только на той ветке, где локального `config.json` нет вообще, то есть свежесозданный ключ ничего не защищает; ципер модуля пересоздаётся тут же, чтобы первое же чтение перенесённого конфига расшифровалось.

**Не сделано:**

* **B-063** (временный WAV на каждый чанк GigaAM на горячем пути live-ассиста). Часть находки — «ограничить live-ассист движками, уважающими `vad_filter`» — это продуктовое решение (сужение списка моделей в live), а часть — переиспользование одного временного файла на сессию, что требует состояния в адаптере, спроектированного под конкурентные вызовы. → долг.
* **B-065** (двойное чтение исходника в `_copy_source_media_file`). Сам отчёт помечает это как «решение, которое стоит пересмотреть», а не дефект: сверка дайджестов ловит перезапись на месте с тем же inode и размером. Порог по размеру — продуктовый компромисс. → долг.
* **B-057** (`preferences.ui`, 22 ключа без дефолта, схемы и читателя на бэкенде). Ветка принадлежит рендереру; описать её на бэкенде — значит зафиксировать чужой контракт без владельца. → долг.
* **B-059** (`desktop/main.js` перетирает `TRANSCRIPTOR_DATA_DIR`) — вне периметра.

---

## Коммит 15 — аудит `backend/deepgram_recovery.py` (модуль не входил в снимок discovery)

**Заголовок:** «The recovery pass stops re-flattening the two envelope numbers it repairs, stops duplicating speech a wordless final already owned, and stops knowing where Deepgram keeps its words»

**ID:** R-001…R-006 — собственные находки этого прохода (модуль появился уже после `e8f1632` и в отчёт не попал). Прогнан по тем же классам дефектов: контракты и границы, состояние и гонки, ошибки, ресурсы, SSOT, комментарий против кода.

**Файлы:** `backend/deepgram_recovery.py`, `backend/remote_deepgram_live.py`, `backend/remote_deepgram.py`, `backend/tests/test_deepgram_recovery.py`, `backend/tests/test_deepgram_interim_splice.py`.

**Верификация.** Новые тесты на коде ДО правки: `Ran 6 tests … FAILED (failures=3, errors=2)`; ключевые сообщения:
```
AssertionError: 8.0 not less than 8.0 : a spliced interim was reported as decoded coverage
AssertionError: 'дубликат' unexpectedly found in 'начало это весь мой текст дубликат'
AssertionError: Lists differ: [] != [{'word': 'слово', …, 'source': 'recovery'}]
```
Полный набор: 796 → 797 (плюс 6 новых, минус переписанные), зелёный.

**Находки и решения.**

* **R-001 (контракт, важнейшая).** `run_recovery` присваивал `durationSec` и `coveredEndSec` ОДНО И ТО ЖЕ значение (конец объединённых слов). Это ровно то состояние, которое B-006 устранил для неисправленного конверта: пара, по которой рендерер решает «покрывает ли конверт запись», снова становилась тождественной — и один вставленный interim-хвост снова делал неполный конверт полным. Теперь `durationSec` — конец транскрипта целиком, `coveredEndSec` — `decoded_end_sec(segments)`.
  *Заодно уточнено само правило:* «покрытие» — это то, о чём отчитался ДЕКОДЕР: живые финалы И REST-передекодирования; исключается только interim-гипотеза. Прежняя формулировка (`_committed_end_sec` отбрасывала любой `source`) выбрасывала бы и восстановленные слова, то есть после успешного восстановления конверт объявлял бы себя менее покрытым, чем он есть. Правило вынесено в `remote_deepgram_live.decoded_end_sec` и читается обеими сторонами; тест проверяет тождество функций.
* **R-002 (дублирование текста).** `splice_recovered_words` фильтровала только по `covering_final_word` — словному правилу. Вторую половину правила покрытия («финал без списка слов отвечает за весь свой span») живой сплайс применяет, а этот — нет. Спаны передаются декодеру с паддингом, поэтому восстановленное слово попадает на землю такого финала — и та же речь уходит пользователю дважды, что и есть класс дефектов последних трёх релизов. Правило вынесено в публичные `spanless_coverage_spans` / `word_inside_spanless_final` и применяется в обоих местах.
* **R-003 (SSOT, тот же класс, что B-084).** `_words_from_rest_result` разбирала `raw["results"]["channels"][0]["alternatives"][0]["words"]` — форму ответа Deepgram, то есть приватное знание `remote_deepgram`, записанное во втором файле. Адаптер теперь отдаёт `words` первоклассным ключом (сырыми — нормализация это правило живого модуля, и импортировать его в REST-адаптер значило бы поставить пред-записанный путь в зависимость от стримингового).
* **R-004 (комментарий против кода).** Докстринг `run_recovery` обещал «Never raises», а `try/except` в функции нет вовсе: гарантию реализует вызывающий (`main._apply_live_recovery`). Текст исправлен: внутренние сбои поглощаются здесь и стоят только своих спанов, а гарантия «сломанное восстановление всё равно отправляет конверт» принадлежит вызывающему и там же описана.
* **R-005 (ресурсы).** На истечении бюджета отменённые `asyncio.to_thread`-задачи не собирались: поток нельзя прервать, он доработает свой HTTP-запрос, и его исключение осталось бы неполученным на луупе. Теперь они собираются фоновым `gather(..., return_exceptions=True)`.
* **R-006 (мелочь).** Лог-строка «слова, которые транскрипт уже содержит» строилась через `w not in fresh` — сравнение словарей по значению и O(n²); заменено на сравнение по `id`.

**Чисто (смотрел, дефекта нет):** бюджет и его вывод (`recovery_budget_sec`, ноль при отсутствии спанов); `pcm_span_wav` (клампы и привязка к целым сэмплам); ленивое чтение спула через callable + `audio_sec`; идемпотентность `missing_spans` (кандидаты всегда уменьшаются на `covered_spans`); `announce` под `try` — сбой уведомления не ломает стоп; отсутствие ключа/спанов/аудио — три ранних выхода без побочных эффектов.

---

## Живая проверка (шаг 5 хендоффа) — A/B на записи-улике 72.7 с, `--dual`

Команда (ключ не печатается ни в одной строке вывода — инструмент читает его из конфига):

```
PYTHONPATH=. TRANSCRIPTOR_DATA_DIR="$HOME/Library/Application Support/transcriptor" \
TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG=1 \
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 \
  backend/tools/deepgram_live_ab.py --language auto --dual --runs 1 --full --log-level INFO \
  "$HOME/Library/Application Support/transcriptor/evidence-2026-09-03/2026-09-03_23-49-57-983102__Так_ слушай. Если тебе нужно_ я вот сейчас.wav"
```

(`--language` обязателен — в хендоффе он опущен; взято `auto`, то есть ровно то, что шлёт приложение.)

**Слияние двух чтений:**
```
INFO backend.deepgram_dual: dual-stream merge: auto=105 words ru=119 words merged=128
     filled_from_ru=23 filled_from_auto=9 dups_removed=0
```
Совпадает с измерением 2026-09-03 (105 / 119 / 128) — правки dual-пути ничего не сдвинули.

**Восстановление:**
```
INFO backend.remote_deepgram: deepgram_transcribe: model=nova-3, audio=29164 bytes timeout=(10, 12) attempts=1 keyterms=0
INFO backend.remote_deepgram: deepgram_transcribe: model=nova-3, audio=41804 bytes timeout=(10, 12) attempts=1 keyterms=0
INFO backend.deepgram_recovery: recovery: 2 decoded word(s) already owned by the transcript: ['Them', 'Сейчас.']
INFO backend.deepgram_recovery: recovery: spans=2 total=2.22s → words=0 in 1166ms
```
Два спана передекодированы параллельно под одним бюджетом; оба вернувшихся слова отброшены как уже принадлежащие транскрипту — это тот самый guard от дублирования, который R-002 усилил правилом spanless. Второй прогон той же записи дал `rec=2/1`: одно слово всё же добавлено.

**Стоп и хвост:**
```
INFO backend.remote_deepgram_live: deepgram-live: post-Finalize finals=1 covered=72.72s gap=0.00s waited=360ms (budget=3.00s streamed=72.72s speech_in_gap=0.00s)
INFO backend.remote_deepgram_live: deepgram-live: finalize EXIT 368 ms text_len=725 segments_final=17 duration_sec=72.72 bytes_sent=2326890
INFO backend.remote_deepgram_live: deepgram-live: CloseStream sent
INFO backend.remote_deepgram_live: deepgram-live: CloseStream sent
```
Ожидание закончилось по ОТВЕТУ (360 мс из потолка 3.0 с) — это B-005 в работе; `CloseStream` ушёл на обе сессии через новый `_send_control` (B-009).

**Итоговая строка и текст:**
```
…wav lang=auto+ru kt=0 run=1 connect=882ms finalize=323ms segs=4 words=128 chars=759 rec=2/0@1166ms uncov=1.31s |
Так, слушай. Если тебе нужно, я вот сейчас записываю прямо сейчас голосовое сообщение, оно останется hello,
hello everybody that's close up agents workflow that we говорю просто большую кучу разных слов, only долго.
И ты можешь detect and find the issues inside my text lab de la capitale de la France. На французском я обычно
не говорю, но тем не менее Возможно, проблемы в чанках, возможно проблема в том что происходит после нажатия
кнопки стол. стоп. возможно проблема в обрезках, я не знаю, тебе нужно самостоятельно это все изучить, может
ты уже нашел истинные причины и can fix the nan sub agents sub agents subaging single source of 1 единый
источник истины вот такой вот длинный prompt я наговорил, ты можешь посмотреть в файл через логи прямо сейчас
```
Ни одного повтора фразы; трёхъязычные переходы (RU → EN → FR → RU) на месте; `connect=882 ms` — холодный, пул в инструменте намеренно не взведён.

---

## Долг (не делается здесь; ID, одна строка, рекомендация)

| ID | Что | Рекомендация |
|---|---|---|
| D-01 | **B-038**: три несовместимые формы wire-типа `final` (Deepgram / локальный / ветка ошибки) | свести к одному блоку `coverage` ОДНИМ коммитом с `frontend/src/main.tsx` (`parseLiveWsMessage` читает плоские `complete/coveredSec/totalSec/droppedSec/uncoveredTailSec`); односторонняя правка либо ломает парсер, либо добавляет четвёртую форму |
| D-02 | **B-023** (вторая половина): `README.md:127` предлагает `cp .env.example .env`, механизма нет | README вне периметра бэкенд-агента — поправить строку или подключить `python-dotenv` (продуктовое решение: новая зависимость + порядок «файл против окружения» на старте) |
| D-03 | **B-027** (третья копия): дефолты dual-stream в `frontend/src/deepgram-dual.ts` | читать из конфиг-пейлоада бэкенда; копия опасна тем, что неверный дефолт «отсутствия» ПЕРЕЗАПИСЫВАЕТСЯ следующим автосейвом и молча выключает фичу на диске |
| D-04 | **B-088** (вторая половина): ~20 утверждений по настенным часам в тестах финализации | инжектируемые часы в `DeepgramLiveSession` вместо прямого `time.perf_counter()`; сейчас запас ≥ 2× и самый дорогой модуль уже пропатчен (12.0 s → 0.12 s) |
| D-05 | **B-063**: GigaAM пишет временный WAV на КАЖДЫЙ чанк, в том числе на горячем пути live-ассиста; `vad_filter`/`language`/`beam_size` молча отбрасываются | продуктовое: либо один временный файл на сессию (нужно состояние адаптера, спроектированное под конкурентные вызовы), либо сузить live-ассист до движков, уважающих `vad_filter` |
| D-06 | **B-065**: `_copy_source_media_file` читает исходник дважды (до 4 ГБ на задание) | сам отчёт называет это «решением, которое стоит пересмотреть»: сверка дайджестов ловит только перезапись на месте с тем же inode и размером — ввести порог по размеру |
| D-07 | **B-057**: `preferences.ui` — 22 ключа без дефолта, схемы и читателя на бэкенде | ветка принадлежит рендереру; описывать её на бэкенде — фиксировать чужой контракт без владельца |
| D-08 | **B-025 / B-059**: `desktop/main.js` читает `config.json` в обход миграции и перетирает `TRANSCRIPTOR_DATA_DIR` | вне периметра — desktop-агенту |
| D-09 | `PROJECT_STRUCTURE` не знает о трёх новых модулях: `backend/async_tasks.py`, `backend/deepgram_language.py`, `backend/deepgram_recovery.py` (и о двух новых тестовых) | обновить на шаге релиза 1.6.1 (§5 хендоффа), файл вне периметра бэкенд-агента |
| D-10 | Первая версия теста B-021 (до подмены `HOME`) один раз создала `~/.transcriptor/.encryption_key` на машине | файл ничем не читается, пока `TRANSCRIPTOR_DATA_DIR` доступен; удалить может пользователь |
| ~~D-11~~ | **R-016 / S-04 / S-05 / S-06** — закрыто в этом же коммите (см. раздел «Дополнение к этому же коммиту» выше): S-04/R-016/S-05 перенесены в bootstrap-payload, S-06 опровергнут как ложный дубликат и задокументирован | — |
| ~~D-12~~ | Задание «Швы» пункты 4–6 — закрыты в последующих коммитах этой же сессии: пункт 4 (D-009/D-015/D-053 рендерер-половины), пункт 5 (F/7 частично + инвариант доставки), пункт 6 (изоляция тестов) — см. записи ниже. Остаток → **D-13** и **D-14** | — |
| D-14 | **D-013** (desktop-журнал) — рендерер уже отдаёт `statusKind` (`__transcriptorLiveStatusSnapshot`), главный процесс его читает и ИГНОРИРУЕТ, классифицируя заново по тексту в поллинг-цикле восстановления стопа (`queryRendererState`, `desktop/main.js` ~5563-5576) — словари `StatusKind` (рендерер, 7 значений) и `RECORDING_STATUS_KIND` (desktop, различает UPSCALING/TRANSCRIBING отдельно) не совпадают | нужен либо более гранулярный `StatusKind` на рендерере, либо таблица соответствия; оба варианта трогают тот же чувствительный поллинг-цикл, что и F/7 — верификация на живых записях нужна и здесь |

---

## Закрытие индексов: каждый ID помечен

### Индекс «хардкод → SSOT» (20 ID)

| ID | Статус |
|---|---|
| B-026 | ✅ коммит 6 (`LIVE_PCM_BYTES_PER_SEC` + `pcm16_bytes_per_sec`) |
| B-027 | ✅ коммит 11 (обе бэкенд-копии → `model_catalog`); третья, в рендерере → **D-03** |
| B-028 | ✅ коммит 10 (`DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER`) |
| B-029 | ✅ коммит 9 (четыре переменные в `.env.example` + тест-сканер) |
| B-030 | ✅ коммит 10 (`UPSCALE_PRESETS` удалён) |
| B-031 | ✅ коммит 10 (`_placeholder_source_text`) |
| B-032 | ✅ коммит 10 (промоут через `_claim_recording_text_path`) |
| B-033 | ✅ коммит 11 (шесть имён публичны + тест-запрет на приватные импорты) |
| B-034 | ✅ коммит 11 (`LIVE_SAMPLE_RATE_HZ` ×4) |
| B-035 | ✅ коммит 11 (`GIGAAM_MODEL_PREFIX` ×3, мёртвый импорт убран) |
| B-036 | ✅ коммит 11 (`_MIN_DECODABLE_WAV_BYTES`, проверка ДО загрузки модели) |
| B-037 | ✅ коммит 8 (`_LOCAL_CONVERT_TIMEOUT_SEC`); `cancel_event` для локальных конверсий — см. «не сделано» коммита 8 |
| B-038 | → **D-01** (кросс-доменный контракт, нужен один коммит с рендерером) |
| B-039 | ✅ коммит 11 (`backend/deepgram_language.py`, поведение сознательно не изменено) |
| B-040 | ✅ коммит 11 (тест читает `_FINALIZE_DRAIN_CEILING_SEC`) |
| B-041 | ✅ коммит 11 (`live_config` — один билдер для приложения и A/B) |
| B-055 | ✅ коммит 13 (`_is_masked_key_value` знает обе формы маски) |
| B-058 | ✅ коммит 9 (клампы Whisper указаны в `.env.example` + тест) |
| B-070 | ✅ коммит 12 (одна живая отметка в обеих ветках обрезки) |
| B-084 | ✅ коммит 10 (`duration` — ключ контракта адаптера) |

**19 из 20 закрыто, 1 в долге.**

### Индекс «костыли и workarounds» (39 ID)

✅ закрыты: B-003, B-004, B-005, B-006, B-007, B-008, B-009, B-010, B-014, B-015, B-016, B-017, B-018, B-020, B-021, B-024, B-030, B-031, B-032, B-036, B-039, B-041, B-043, B-044, B-051, B-052, B-053, B-055, B-068, B-069, B-070, B-071, B-078, B-080, B-081, B-083, B-087 (37).
✅ частично: B-023 — бэкендная половина (`.env.example`) закрыта, README → **D-02**.
◐ частично: B-088 — самый дорогой модуль пропатчен (12.04 s → 0.12 s), инжектируемые часы → **D-04**.

**Ничего без метки.**

### Все 90 находок отчёта

| Итог | Кол-во | ID |
|---|---|---|
| Исправлено | 82 | всё, кроме перечисленного ниже |
| Не баг (измерено) | 1 | B-011 (`asyncio.wait_for` в Python 3.12 сам дожидается отменённую задачу) |
| Частично + долг | 1 | B-088 → D-04 |
| Долг (продуктовое решение / кросс-домен) | 4 | B-038 → D-01, B-057 → D-07, B-063 → D-05, B-065 → D-06 |
| Вне периметра (desktop / README / frontend) | 2 | B-025, B-059 → D-08 (плюс половинки B-023 → D-02 и B-027 → D-03) |

**По уровням:** P0 — 2 из 2; P1 — 21 из 23 (B-011 «не баг», B-025 вне периметра), то есть 100 % достижимого и 91 % от объявленных; P2 — 60 из 65 закрыто, 1 частично, 4 в долге.

**Дополнительно, сверх отчёта:** R-001…R-006 в `backend/deepgram_recovery.py` — модуль появился после снимка discovery и в отчёт не входил (коммит 15).

---

## Швы (2026-09-05)

Кросс-доменный агент, продолжающий работу после `52dab76` (единая схема
конверта `final`, закрывает **D-01 / B-038** из раздела выше). Задание —
`docs/archive/NEXT_SESSION_2026-09-04b.md` §2, §7; журналы `frontend-fix-journal.md`
/ `desktop-fix-journal.md` (разделы «долг» / «не сделано»).

### Коммит: B-027 / R-016 — дефолты dual-stream, backend SSOT

**IDs:** B-027 (третья копия, → закрывает **D-03** выше), R-016 (частично —
только dual-stream/секондари; остальные факты R-016/S-04/S-05/S-06 см.
«не сделано» ниже).

**Файлы:**
- `backend/model_catalog.py` — `LIVE_LANGUAGE_OPTIONS = ("auto", "ru", "en")`,
  `DUAL_SECONDARY_LANGUAGE_OPTIONS` (тот же список без `"auto"`).
- `backend/deepgram_dual.py` — `dual_secondary_language()` теперь
  ВАЛИДИРУЕТ сохранённое значение по `DUAL_SECONDARY_LANGUAGE_OPTIONS`, а
  не просто приводит к нижнему регистру: значение не из списка (старая
  сборка, ручная правка конфига) больше не может рассинхронизировать
  «что показывает Settings» и «что реально стримится».
- `backend/main.py` — `_frontend_runtime_payload()["live_defaults"]`:
  `languages`, `dual_stream`, `dual_secondary_language`,
  `dual_secondary_languages`, `keyterm_token_budget` (из
  `deepgram_keyterms.MAX_KEYTERM_TOKENS`); плюс `audio_ext_to_mime`
  (инверсия для рендерера, S-04 — см. «не сделано», факт уже переехал,
  читатель ещё не описан тестом на стороне рендерера кроме source-level
  проверки).
- `frontend/src/deepgram-dual.ts` — `DUAL_STREAM_DEFAULT` /
  `DUAL_SECONDARY_LANGUAGE_DEFAULT` УДАЛЕНЫ; `resolveDualStreamPreference`
  принимает `fallback: DualStreamDefaults`, приходящий из бэкенда.
- `frontend/src/main.tsx` — `backendLiveDefaults` (заполняется из
  `live_defaults` один раз, до `loadCfg`); `readDeepgramDualStream()` /
  `readDeepgramDualSecondaryLanguage()` возвращают `undefined`, если
  бэкенд ещё не ответил, и `buildUiPreferencesSavePlan()` в этом случае
  НЕ пишет ключ вовсе (config.py делает deep-merge, отсутствующий ключ
  не трогает то, что уже на диске) — это и есть «отсутствующее значение
  не может быть автосохранено как off». Также: `applyAudioMimeMap`
  (инверсия `audio_ext_to_mime` → `MIME_TO_AUDIO_EXT`, было 12
  хардкоженных записей против 19 бэкендных), `applyLiveLanguageOptions`
  (переписывает `#language` из `live_defaults.languages`),
  `applyKeytermBudgetNote`.
- Исправлен реальный баг в незакоммиченном черновике: `applyBackendRuntimeConfig`
  типизировал `root` без полей `audio_ext_to_mime`/`live_defaults` —
  `tsc --noEmit` падал (TS2339) на обеих строках, где они читались.
  Дописан тип.

**Тесты (фикстура по образцу `52dab76`):**
- `backend/tests/test_live.py::FrontendLiveDefaultsFixtureTests` строит
  `contracts/live-defaults.json` из `_frontend_runtime_payload()`
  (языки, dual-дефолты, keyterm-бюджет, `audio_ext_to_mime`);
  `WebSocketAuthTokenTests.test_bootstrap_live_defaults_match_the_model_catalog_ssot`
  проверяет, что payload и есть константы `model_catalog.py` /
  `deepgram_keyterms.py`, а не отдельная копия.
- `frontend/tests/deepgram-dual.test.ts` переписан: больше не импортирует
  удалённые константы, читает `contracts/live-defaults.json` и передаёт
  его как `fallback` во все вызовы `resolveDualStreamPreference`;
  проверка дефолта чекбокса в разметке сверяется с `liveDefaults.dual_stream`
  из фикстуры, а не с константой модуля.
- `frontend/tests/renderer-main-contract.test.ts` — новый блок
  «live-path defaults have no renderer-owned copy»: source-level проверка,
  что `readDeepgramDualStream`/`readDeepgramDualSecondaryLanguage` читают
  `backendLiveDefaults`, а не литерал; что в `main.tsx` нет собственных
  `const DUAL_STREAM_DEFAULT` / `const DUAL_SECONDARY_LANGUAGE_DEFAULT`;
  что список `<option>` в `#language` (до гидратации) совпадает со
  списком языков из фикстуры; что заметка о keyterm-бюджете строится
  функцией, а не хардкодит число.
- `backend/tests/test_deepgram_dual.py::DualSecondaryLanguageTests` —
  старый `test_reads_and_normalizes_the_configured_value` проверял, что
  `"ES"` проходит как `"es"`; это больше не так (см. выше), тест
  переписан на `"EN"`/`"ru"`; добавлен
  `test_a_value_this_build_cannot_offer_falls_back_to_the_default`
  (`"es"`, `"auto"`, `"fr"` → `"ru"`).

**Проверка:**
```
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
# Ran 815 tests — OK (было 812 в 52dab76 + 3 новых теста здесь)
npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build
# typecheck: чисто; lint: чисто; test: 351 passed (было 347 в 52dab76 + 4 новых); build: ok
npm --prefix desktop test && node --check desktop/main.js && node --check desktop/preload.js
# 255 passed, оба чека чистые (домен не тронут этим коммитом, прогнан по правилу «все три сьюта перед коммитом»)
```

**Решения:**
- Валидация `dual_secondary_language` теперь по списку опций, а не
  просто по типу/непустоте — намеренное ужесточение поведения (было:
  любая непустая строка проходила как есть). Это меняет то, что
  возвращает `dual_secondary_language()` для значения вроде `"es"`,
  оставшегося в конфиге от гипотетической будущей опции или ручной
  правки: теперь `"ru"` (дефолт), а не `"es"` буквально. Соответствует
  докстрингу, который уже был в черновике; решение принято, так как это
  и есть суть шва — сторона рендерера физически не может предложить
  `"es"` в пикере, значит и сторона бэкенда не должна тихо стримить его.
- Фикстура — JSON, не Python/TS модуль: тот же формат, что
  `contracts/live-final-envelope.json`, для единообразия и потому что
  обе стороны уже умеют его парсить.
- `_validate_config_shape` (`backend/config.py`) НЕ ужесточён тем же
  списком опций — он остаётся проверкой формы (строка непустая), а не
  семантики. Семантическая проверка — работа `dual_secondary_language()`,
  вызываемого на пути чтения. Разделение уже было в коде до этого шва;
  сохранено, а не продублирован список опций во второй функции.

**Дополнение к этому же коммиту — R-016 / S-04 / S-05 / S-06 (задание, пункт 3):**

`frontend-fix-journal.md` строка 1432 называет три подозреваемых дубликата
знания, живущего в бэкенде:

1. **R-016 / S-05** — дефолты dual-stream (`deepgram-dual.ts` против
   `config.py`). Закрыто ЭТИМ коммитом (см. выше).
2. **S-04** — карта MIME ↔ расширение (`main.tsx`, 12 записей, против
   `audio_mime.py`, 19). Закрыто ЭТИМ коммитом: `audio_ext_to_mime` в
   bootstrap-payload, `applyAudioMimeMap` в `main.tsx`.
3. **S-06** — эпсилон «два сегмента — один момент»
   (`UI_TOKENS.finalize.segmentEpsilonSec = 0.08` против `live.py`'s
   `emit_epsilon_sec = 0.05`). Журнал называет это гипотезой
   («нужен бэкенд», не подтверждённым дубликатом). Проверено: это НЕ
   дубликат. `segmentEpsilonSec` дедуплицирует уже ОТПРАВЛЕННЫЕ сегменты
   в превью рендерера, от любого провайдера (`mergeTranscriptSegments`,
   `frontend/src/main.tsx`); `emit_epsilon_sec` — это порог «уже
   отправленной отметки» ВНУТРИ одной Whisper-сессии `LiveSession между
   двумя перекрывающимися проходами инференса (`backend/live.py`,
   `LiveConfig`), Deepgram эта сессия вообще не касается. Объединение
   означало бы, что свойство таймстемпов Whisper решает, как дедуплицируется
   пара сегментов Deepgram на экране. Решение — задокументировать обе
   константы (уже было в `live.py` от предыдущего агента; дописан
   парный комментарий в `main.tsx`) и закрепить тестом, что оба
   комментария называют друг друга (`renderer-main-contract.test.ts`,
   describe "segmentEpsilonSec vs. live.py's emit_epsilon_sec"), чтобы
   один нельзя было удалить, не тронув другой.

Все четыре ID из пункта 3 задания закрыты (три перенесены/задокументированы,
один опровергнут как ложный дубликат и закреплён тестом).

**Не сделано:** пункты 4–6 задания (D-015/D-009/D-013/D-053, эпилог
`stopLive`, изоляция тестов от `HOME`) не начаты в рамках этого коммита.

### Коммит: F/7 / U-022 — один эпилог `stopLive` (частично, по разумной границе риска)

**IDs:** F/7, U-022 (задание пункт 5).

**Что найдено при чтении `stopLive` целиком (1736 строк на момент чтения):**
семь мест «стоп без транскрипта» (усечённая запись, сорванный старт,
тишина, транскрипция выключена настройкой, нет провайдера, не настроен
ключ, и catch «Live transcription finalization failed»). Журнал называет
их «почти одинаковыми» — при построчном чтении все семь оказались
одинаковыми ТОЛЬКО в одном месте: тройке `clearLiveDraft(sessionUiToken);
setBusy(false, sessionUiToken); releaseStopTransitionAfterCaptureDetach();`
— и то только в шести из семи (седьмой, catch, освобождает эти три вещи
через ОБЩИЙ `finally`, разделяемый с успешным путём доставки, и порядок
там другой: `clearLiveDraft` → `micHealth.observe(...)` →
`releaseStopTransitionAfterCaptureDetach()`, без `setBusy` вовсе).

Всё ВОКРУГ этой тройки — не одинаково: `#progressRow` скрывается в
четырёх местах из шести и в разных точках относительно `await
saveRecordingText`; порядок «сохранить → пропатчить summary» и
«пропатчить → сохранить» отличается местами (блок «ключ не настроен»
патчит ДО попытки сохранения и не патчит после); `setStatusScoped`
вызывается на разных стадиях или не вызывается вовсе (блок «тишина»
никогда не скрывает `#progressRow`).

**Решение:** объединить ТОЛЬКО тройку — она порядко-независима,
аргументо-независима и байт-в-байт идентична во всех шести местах, то
есть чистое механическое извлечение без риска изменить поведение.
НЕ объединять сохранение/патч/статус — это единственный способ не
внести регрессию без верификации на живой записи, а живой записи в этой
среде (без микрофона, без реального Deepgram-сокета) сделать нельзя;
предыдущий агент по той же причине сознательно отложил это же место
(«нужна отдельная верификация на живых записях», см. коммит e1bf3d4 /
запись выше). Полное объединение по образцу `finishStopWithoutTranscript`
из рекомендации журнала остаётся в долге — см. ниже.

**Файлы:**
- `frontend/src/main.tsx` — новый локальный хелпер `stopLive`:
  `releaseStopEpilogueBookkeeping()` (замыкает `sessionUiToken` и
  `releaseStopTransitionAfterCaptureDetach`), вызывается в шести местах
  вместо повторенной тройки; седьмое место (catch → shared `finally`)
  сознательно не тронуто.
- `frontend/tests/renderer-main-contract.test.ts` — новый describe
  «stopLive has exactly one transcript delivery site (F/7 / U-022)»:
  извлекает тело `stopLive` регэкспом между `async function stopLive(`
  и следующей top-level функцией, проверяет (1) `kind: "transcript"`
  встречается РОВНО один раз — переводит одноразовую ручную проверку
  предыдущей сессии (`git diff` + `grep`, зафиксированную текстом в этом
  же журнале выше) в постоянный тест; (2) доставка читает
  `transcriptRaw`, а не пересобирает текст; (3) хелпер вызван РОВНО 6 раз
  и объявлен ровно один раз.

**Проверка:**
```
npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build
# typecheck/lint: чисто; test: 356 passed (было 352); build: ok
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
# Ran 815 tests — OK (бэкенд не тронут этим коммитом; прогнан по правилу «все три сьюта перед коммитом»)
npm --prefix desktop test && node --check desktop/main.js && node --check desktop/preload.js
# 255 passed, чисто
```

**НЕ верифицировано на живой записи** — в этой среде нет способа
удержать реальный микрофон и реальный сокет Deepgram до `stopLive`. Риск
оценён как низкий: рефакторинг чисто механический (три идентичные строки
→ один вызов, без изменения аргументов, порядка или окружающих веток), и
весь фронтенд-сьют (356 тестов, включая source-level инвариант этого же
коммита) зелёный. Пользователю стоит проверить на первой же живой записи
после сборки 1.6.1, что стоп по всем семи путям (особенно «тишина» и
«ключ не настроен») ведёт себя как раньше — если есть регрессия, откатить
только этот хелпер (все шесть мест тривиально восстановить обратно из
`git show`).

**Долг:**

| ID | Что | Рекомендация |
|---|---|---|
| D-13 | F/7 / U-022 полностью — `finishStopWithoutTranscript({domText, kind, status, tone, statusScope})`, объединяющий сохранение+патч+статус, а не только тройку bookkeeping | нужна верификация на живых записях по всем семи веткам (тишина, ключ не настроен, нет провайдера, транскрипция выключена, сорванный старт, усечённая запись, catch-ветка); делать отдельным коммитом с ручной проверкой перед пушем, как предупреждал предыдущий агент |

### Коммит: изоляция сьюта от `HOME` / `TRANSCRIPTOR_DATA_DIR` (задание, пункт 6)

**Находка при чтении `backend/config.py`:** `DATA_DIR = _resolve_data_dir()`
выполняется НА ИМПОРТЕ модуля (строка уровня модуля, не внутри функции) и
СОЗДАЁТ директорию как побочный эффект импорта. `unittest discover`
импортирует ВСЕ тестовые модули (в момент построения сьюта) ДО того, как
у любого теста выполнится `setUp`. Три тестовых файла
(`test_access_log_filter.py`, `test_deepgram_keyterms.py`,
`test_deepgram_dual.py`) делают `from backend.main import ...` /
`from backend.config import ...` НА УРОВНЕ МОДУЛЯ — то есть до того, как
чья-либо изоляция в `setUp` успевает подменить `TRANSCRIPTOR_DATA_DIR`
или `HOME`. Если ни то ни другое не задано в окружающей оболочке (обычное
состояние — `HOME` есть практически всегда, но не факт, что задан
`TRANSCRIPTOR_DATA_DIR`), `_resolve_data_dir()` резолвится на РЕАЛЬНЫЙ
`~/Library/Application Support/Transcriptor` (macOS) — ту же директорию,
которой пользуется установленное приложение (конфиг, ключи, архив
записей). Ровно это уже случилось один раз (см. долг **D-10** выше:
`~/.transcriptor/.encryption_key`, созданный на этой машине 2026-09-05 —
файл не тронут по прямому указанию задания, «пользовательский, не
трогать»).

**Механизм закрытия:** `backend/tests/__init__.py` — пакет, который
Python обязан импортировать ПЕРЕД любым `backend.tests.test_x`
(это гарантия языка, а не порядок обхода `unittest discover`). На уровне
модуля создаётся один временный каталог на весь процесс сьюта и
БЕЗУСЛОВНО (не `setdefault` — `HOME` есть почти всегда, `setdefault` его
бы не тронул) перенаправляет `TRANSCRIPTOR_DATA_DIR`, `HOME`,
`USERPROFILE`, `APPDATA` внутрь него, до импорта первого тестового файла.
`atexit` подчищает каталог. Отдельные тесты по-прежнему свободны
перенаправлять эти переменные дальше в СВОИ временные каталоги (большинство
уже так делает) — это только страховка для первого импорта и для любого
файла, который изоляцию не делает вовсе.

**Побочная находка при верификации (тем же коммитом, тот же корень
проблемы):** пять файлов делали `os.environ.pop("TRANSCRIPTOR_DATA_DIR",
None)` в `tearDown` БЕЗ сохранения предыдущего значения в `setUp` —
рабочий, но небрежный паттерн: после такого теста переменная остаётся
ПОЛНОСТЬЮ снятой до конца прогона (или до следующего теста, который её
переустановит), в отличие от корректного паттерна (`self._old_data_dir =
os.environ.get(...)` в `setUp`, условное восстановление в `tearDown`),
уже использованного в большинстве файлов сьюта. Это не течь наружу (`HOME`
из `backend/tests/__init__.py` всё равно ловит откат на реальный каталог),
но воспроизводимая нестабильность: тест `test_suite_home_isolation.py`,
добавленный этим коммитом, сначала падал именно на этом (см. «Проверка»)
— TRANSCRIPTOR_DATA_DIR оказывался пуст на момент его выполнения из-за
чужого `tearDown`. Найденное — исправлено по корню, а не подстройкой
теста под баг: `test_config.py` (5 классов:
`TestConfigLifecycle`, `SchemaStampTests`,
`OpenRouterPreferenceValidationTests`, `EmptyKeyfileTests`,
`DataDirFallbackTests`), `test_audio_retention.py`,
`test_live_recovery_liveness.py`, `test_remote_chunking.py`,
`test_recording_names.py` — все теперь сохраняют и восстанавливают
`TRANSCRIPTOR_DATA_DIR` тем же паттерном, что уже был в `test_live.py` /
`test_live_draft_state.py` / `test_deepgram_warm.py` и других.

**Файлы:**
- `backend/tests/__init__.py` — суть коммита, см. выше.
- `backend/tests/test_suite_home_isolation.py` — новый: пин инварианта
  (`HOME`/`USERPROFILE`/`APPDATA` уводятся из-под реального аккаунта,
  `TRANSCRIPTOR_DATA_DIR` — временный каталог МЕЖДУ тестами всегда,
  «голый» реимпорт `backend.config` резолвит `DATA_DIR` внутри
  временного корня).
- `backend/tests/test_config.py`, `test_audio_retention.py`,
  `test_live_recovery_liveness.py`, `test_remote_chunking.py`,
  `test_recording_names.py` — исправлен паттерн `tearDown` (см. выше).

**Проверка:**
```
# До фикса пяти файлов: test_suite_home_isolation падал (TRANSCRIPTOR_DATA_DIR == "")
# на 1-2 из 3 последовательных прогонов — воспроизведено, зафиксировано, исправлено по корню.
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
# Ran 819 tests — OK, три прогона подряд без единого падения (было 815 до этого коммита)
npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build
# не тронуто этим коммитом; 356 passed, чисто, build ok
npm --prefix desktop test && node --check desktop/main.js && node --check desktop/preload.js
# не тронуто; 255 passed, чисто
```
**Верификация побочного эффекта (не тест, ручная проверка):** снят
слепок `mtime` всех файлов под `~/.transcriptor` и
`~/Library/Application Support/Transcriptor` до и после полного прогона
сьюта — единственные изменившиеся файлы принадлежат реально запущенному
Electron-приложению (`DawnGraphiteCache`, `GPUCache`, `Cache_Data` —
GPU/HTTP-кэш живого процесса), НИ ОДИН файл конфига/ключей/записей не
изменился. `~/.transcriptor/.encryption_key` не тронут (сохранён по
прямому указанию задания).

**Решения:**
- Перенаправление в `backend/tests/__init__.py` — БЕЗУСЛОВНОЕ, не
  `os.environ.setdefault`: `HOME` присутствует практически в любой
  реальной оболочке, `setdefault` его бы не заменил и вся защита была
  бы бесполезна для самого частого случая.
- `atexit`-очистка, а не оставление временного каталога — гигиена, не
  требование безопасности (временные каталоги и так подчищаются ОС).
- Не удалён и не тронут `~/.transcriptor/.encryption_key` — прямое
  указание задания («пользовательский файл, не трогать»); D-10 остаётся
  открытым как «оставить пользователю».
- Пять файлов с `tearDown`-паттерном без восстановления — исправлены
  ПОЛНОСТЬЮ (root cause), а не просто ослаблением нового теста под их
  поведение; ослабленная версия теста (allow-unset) была написана первой,
  найдена неудовлетворительной при чтении собственного кода (не пинает
  реальный инвариант) и заменена на строгую версию ПОСЛЕ фикса.

**Не сделано:** пункт 4 задания (D-015/D-009/D-013/D-053, desktop-журнал)
не начат — из пяти пунктов задания «Швы» это единственный, требующий
чтения desktop-журнала и правок в `desktop/`, не начатых в этой сессии.

### Коммит: рендерер-половинки D-009 / D-015 / D-053 (задание, пункт 4 — 3 из 4)

**IDs:** D-009 (рендерер-половина), D-015 (рендерер-половина), D-053
(рендерер-половина). D-013 — см. «Не сделано» ниже, найдена причина,
почему это не тривиальная правка.

**D-053 — рендерер отписывается от `system-suspend`.**
`preload.js`'s `onSystemSuspend` возвращает функцию отписки;
`frontend/src/main.tsx` вызывал её один раз на верхнем уровне модуля и
отбрасывал результат. При повторном выполнении этого верхнеуровневого
кода в ОДНОМ и том же жизненном цикле страницы (Vite dev-server HMR —
именно это: переисполняет код верхнего уровня БЕЗ перезагрузки
страницы, которая единственная рвёт слушателей preload-мира) второй
подписчик наслаивался на первый. Безвредно по везению (функция снятия
холда идемпотентна), не по конструкции. Правка: подписка вынесена в
именованную функцию `subscribeToSystemSuspend()`, которая ПЕРВЫМ делом
снимает свою же предыдущую подписку через модульный `let
systemSuspendUnsubscribe`. TS control-flow narrowing не позволял
написать это как голый top-level код (`Type 'never' has no call
signatures]` — переменная типа `T | null`, инициализированная `null` на
верхнем уровне модуля, статически сужается ДО `null` в первом же месте
использования, потому что TS видит линейный проход один раз; функция —
единственный способ заставить TS учитывать повторные вызовы).

**D-009 — бейдж «Accessibility сломан».** `desktop/paste-capability.js`
уже различал 4 состояния (`unknown`/`untrusted`/`active`/`broken`) и
знал точный текст исправления (`pasteCapabilityMessage`), но это было
видно пользователю ТОЛЬКО реактивно — внутри строки статуса капсулы
ПОСЛЕ того, как вставка уже провалилась. Добавлен invoke-only мост
(`ipcMain.handle("paste-capability:get-status", ...)` /
`contextBridge.exposeInMainWorld("__transcriptorPasteCapability", ...)`)
— та же форма, что уже используется `__transcriptorEngine` — вместо
воскрешения удалённого коммитом 14 паттерна `executeJavaScript`-инъекции
глобала, который никто не читал. Рендерер: `#pasteCapabilityNote` рядом
с карточкой Shortcuts в Settings, скрыт по умолчанию, заполняется
`refreshPasteCapabilityNote()` при загрузке и на каждый фокус окна
(тот же ритм, что уже держит главный процесс —
`ensurePasteCapabilityFresh("focus")` на `win.on("focus")`).

**D-015 — рендерер выполняет ТУ ЖЕ миграцию хоткеев, что и главный
процесс.** `frontend/src/main.tsx`'s `loadCfg` вручную повторял
миграции 1 и 2 (`unpressablePaste`, `macFunctionPair`) и не реализовывал
миграцию 3 (`winLinuxFunctionPair`, BUGS_AUDIT §6.10) — на
Windows/Linux-конфиге с сохранённой парой F9/F10 главный процесс
регистрировал `Control+Alt+Shift+R`, а Settings продолжали показывать
`F9`, и следующий автосейв записывал F9/F10 обратно на диск НАВСЕГДА.
Правка: `frontend/src/main.tsx` теперь импортирует
`migrateShortcutPair` НАПРЯМУЮ из `desktop/shortcut-migration.js` —
модуль чистый CommonJS без зависимостей Node (`require`/`fs` не
используются), поэтому Vite/esbuild собирает его в рендерер-бандл так
же, как уже собирались бы любые чистые JS-модули (`shortcut-defaults.json`
уже читался на этапе сборки для тех же данных — теперь и правило едет
тем же путём, только через рантайм-импорт, а не через `vite.config.ts`).
Потребовалась одна опция компилятора: `"allowJs": true` в
`frontend/tsconfig.json` (НЕ `checkJs` — содержимое `.js`-файлов
по-прежнему не типизируется, только разрешение импорта). Собранный бандл
проверен на присутствие `winLinuxFunctionPair` (`grep` по
`dist/assets/index-*.js`) — миграция реально попала в поставляемый код,
не просто резолвится на этапе типов.

**Файлы:**
- `frontend/src/main.tsx` — все три правки выше.
- `frontend/tsconfig.json` — `allowJs: true`.
- `frontend/index.html` — `#pasteCapabilityNote`.
- `desktop/main.js` — `ipcMain.handle("paste-capability:get-status", ...)`;
  обновлён устаревший комментарий у `lastAccessibilityTrusted`.
- `desktop/preload.js` — `__transcriptorPasteCapability` мост.
- `desktop/ipc-contract.test.js` — новый тест на канал
  `paste-capability:get-status`; исправлен устаревший комментарий про
  D-053 (говорил «рендерер отбрасывает — в долге», больше не так).
- `frontend/tests/renderer-main-contract.test.ts` — три новых блока:
  system-suspend retire-before-resubscribe (D-053); markup + wiring
  бейджа Accessibility (D-009); импорт и реальное исполнение
  `migrateShortcutPair` из `desktop/shortcut-migration.js`, включая
  миграцию 3 (D-015).

**Проверка:**
```
npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build
# typecheck/lint: чисто; test: 363 passed (было 356); build: 30 модулей
# (было 29 — shortcut-migration.js реально вошёл в бандл), grep по
# dist/assets/index-*.js подтверждает "winLinuxFunctionPair" в поставке
npm --prefix desktop test && node --check desktop/main.js && node --check desktop/preload.js
# 256 passed (было 255), оба чека чистые
/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3 -m unittest discover -s backend/tests
# не тронуто этим коммитом; 819 passed
```

**Решения:**
- Импорт `desktop/shortcut-migration.js` напрямую в `frontend/src`, а не
  копирование или переписывание правила на TS — единственный способ
  СВЯЗАТЬ обе стороны так, что расхождение снова невозможно; модуль уже
  был спроектирован как чистый (никакого Node), что и сделало это
  безопасным.
- `paste-capability:get-status` — invoke-only (рендерер тянет), а не
  push через `executeJavaScript` — рекомендация отчёта прямо называла
  push-паттерн причиной провала прошлой попытки (глобал, который никто
  не читал); используется УЖЕ существующий в кодовой базе паттерн
  моста (`__transcriptorEngine`), а не третий.
- `subscribeToSystemSuspend` вынесена в функцию не ради стиля — это
  единственный способ, которым TypeScript'а control-flow analysis
  корректно типизирует «отписаться, если уже подписан» для module-level
  `let`.

**Не сделано — D-013 («рендерер шлёт свой `statusKind`»), с находкой:**
При чтении `desktop/main.js`'s `queryRendererState()`/поллинг-цикла
восстановления (~5563-5576) выяснилось, что рендерер УЖЕ отдаёт
`statusKind` через `window.__transcriptorLiveStatusSnapshot()`, и
главный процесс его УЖЕ читает в `state.statusKind` — но игнорирует,
классифицируя заново по тексту (`statusLower === "upscaling"` /
`"processing"` / `"transcribing"`). Это не тривиальная замена «читай
поле вместо текста»: словари не совпадают. Рендерер's `StatusKind`
(`frontend/src/main.tsx:326`) — `idle | recording | processing | done |
error | warning | info`, ОДНО значение `processing` на оба случая;
`desktop/recording-status.js`'s `RECORDING_STATUS_KIND` различает
`UPSCALING` и `TRANSCRIBING` отдельно, и именно это различие использует
поллинг-цикл. Закрытие D-013 требует либо (а) более гранулярного
словаря на стороне рендерера (новое поле или расширение `StatusKind`,
влияющее на `statusKindToDotClass` и всё, что уже читает `StatusKind`),
либо (б) таблицы соответствия между двумя словарями — обе имеют
собственный blast radius в код, который эта сессия не может проверить
на живой записи (тот же поллинг-цикл восстановления стопа, что и у
F/7). В долг, с точной находкой вместо общего «не сделано».
