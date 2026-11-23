# Ultra-Audit · BACKEND · фаза DISCOVERY

**Дата:** 2026-09-04
**Ревизия на момент фиксации:** `e8f163291b0c838e0f53fd0474bbfcf647f54ffe` (`git rev-parse HEAD`, 2026-09-04T12:46:32Z).
`backend/**` на этой ревизии — чистое дерево (`git status` показывает только правки во `frontend/`, которые ведёт другой агент).

## Как проверялось

1. **Движущееся дерево.** Аудит начался на `0de0c2d`, и во время чтения параллельный агент дважды менял `backend/remote_deepgram_live.py` (я поймал промежуточное состояние, где `_tail_needs_flush` уже имел новую сигнатуру, а тело ещё ссылалось на удалённую `TAIL_GUARD_MIN_SEC`). Поэтому работа велась по **замороженным снимкам** дерева (`rsync` в scratchpad), а каждая находка **перепроверена заново на `e8f1632`**. Всё, что коммит `e8f1632` закрыл (переименование константы, арность в тестах, три устаревших теста tail-guard), из отчёта **исключено** — в нём нет ни одной находки, которую уже починили.
2. **Исполняемые репродукции, а не чтение.** Семь скриптов гоняли реальные модули бэкенда на интерпретаторе установленного приложения (`/Applications/Transcriptor.app/Contents/Resources/runtime/python/bin/python3`, Python 3.12, websockets 15.0.1) против снимка. Каждая находка, помеченная «подтверждено (repro)», сопровождается выводом реального запуска, а не рассуждением.
3. **Три обязательных прохода:** HISTORY (`git log -p -40 -- backend`, 22 326 строк дифа, просмотр на маркеры костылей/полу-миграций/откатов), STRUCTURE (карта модулей + таблица покрытия ниже), PRODUCT SCENARIOS (сквозные проходы по сценариям и их швам — см. §3).
4. **Классы дефектов** прогонялись поимённо по каждому файлу: контракты/границы, состояние и гонки, ошибки, ресурсы, данные, безопасность, SSOT, уровень инженерии, производительность, тесты, мёртвый код, UX-ошибки.
5. Длинные объясняющие комментарии в этом коде **не считались доказательством корректности**: по каждому проверялось, делает ли код то, что комментарий обещает. Четыре находки — именно расхождения кода и комментария.

## Дрейф дерева во время аудита (важно для номеров строк)

Дерево двигалось всё время работы. Зафиксированное состояние отчёта — **`e8f1632`**, последний коммит, затронувший `backend/**`; все номера строк относятся к нему. К моменту сдачи отчёта:

* `HEAD` ушёл на `a152ec7` (три коммита: `889c91a`, `74ff589`, `a152ec7`), но `git diff e8f1632..HEAD -- backend` **пуст** — эти коммиты бэкенда не касались;
* в рабочем дереве появились незакоммиченные правки другого агента: `backend/deepgram_dual.py` (+113), `backend/main.py` (+354), `backend/remote_deepgram_live.py` (+687) и новый неотслеживаемый файл `backend/deepgram_recovery.py` (580 строк).

Из-за этого **номера строк в `main.py`, `remote_deepgram_live.py` и `deepgram_dual.py` уже сместились** (например, ранний выход `if not text:` из B-005 переехал с 3089 на 3290). Поэтому в каждой находке рядом с адресом назван **символ** — функция, метод или константа: искать нужно по нему. Остальные файлы (`config.py`, `audio.py`, `live.py`, `transcribe*.py`, `models_manager.py`, `storage.py`, `jobs.py`, `http_retry.py`, `remote_deepgram.py`, `remote_openrouter.py`, `.env.example`, `requirements*.txt`) с `e8f1632` не менялись — их номера точны.

**Перепроверка на текущем рабочем дереве.** Перед сдачей я заново прогнал по нему восемь ключевых находок — B-001, B-002, B-003, B-004, B-005, B-006, B-014, B-017, B-018, B-026, B-008 — все воспроизводятся. Ни одна находка отчёта незакоммиченными правками не закрыта; новый `deepgram_recovery.py` в периметр не входил и не аудирован.

## Карта модулей (STRUCTURE)

```
точка входа: backend/main.py  (FastAPI app, uvicorn)
├── HTTP  /api/*            auth=_require_api_auth · Host-guard middleware · rate limit
├── HTTP  GET /             index.html + инъекция API-токена (единственный неаутентифицированный)
└── WS    /ws/transcribe    ── provider=deepgram ──> _run_deepgram_live_session
                            └─ provider=local ────> _run_local_live_session

Deepgram live (горячий путь диктовки):
  main.ws_transcribe
    → main._live_config ──────────── DeepgramLiveConfig (SSOT конструктор)
    → DEEPGRAM_WARM_POOL.acquire ─── deepgram_warm.DeepgramWarmPool
    → DeepgramLiveSession | DualLiveSession (фасад двух сессий)
         remote_deepgram_live ── deepgram_endpoints (URL)
                              ── deepgram_format   (smart_format/punctuate/filler)
                              ── deepgram_keyterms (keyterm=)
                              ── deepgram_words    (punctuated_word)
                              ── audio_constants   (16 кГц)
                              ── model_catalog     (nova-3)
         deepgram_dual ─────── merge_readings (слияние двух чтений по времени слова)

Local live:  main._run_local_live_session → live.LiveSession → transcribe / transcribe_gigaam → models_manager

REST-транскрипция: main.create_job|from-path|transcribe-sync|remote_* → jobs → audio (ffmpeg)
                                                                      → remote_deepgram | remote_openrouter → http_retry

Записи/хранение: main._resolve_recordings_dir · AudioRetentionPolicy · _prune_recording_audio · storage (атомарная запись)
Recovery:        main._open_live_recovery → _record_recovery_chunk → _finalize_live_recovery → _promote_live_recovery
Конфигурация:    config (deep-merge, валидация, миграция, шифрование ключей)
Инструменты:     tools/deepgram_live_ab.py
```

---

## 2. Покрытие

Обязательная таблица. «Средство» — чем именно смотрели. Строки, где найдено 0 находок, — это не «не смотрели», а закрытая область: чистые места названы в §7.

| Область | Файлы (строк) | Статус | Чем проверено | Почему не полнее |
|---|---|---|---|---|
| Deepgram live: сессия, финализация, покрытие, сшивка | `remote_deepgram_live.py` (3303) | **проверено** | полное чтение всех 3303 строк + 4 исполняемые репродукции (`repro1/4/7`) на реальном классе | — |
| Deepgram dual-stream: решение, слияние, фасад | `deepgram_dual.py` (768) | **проверено** | полное чтение + 3 репродукции (`repro2/3`), профилирование `merge_readings` на 250…3000 слов | — |
| Тёплый пул сокетов | `deepgram_warm.py` (586) | **проверено** | полное чтение + репродукция сериализации коннектов (`repro5`) и ветки `_cancel_pending` (`repro6`) | — |
| SSOT-модули Deepgram | `deepgram_endpoints/format/keyterms/words.py` (396) | **проверено** | полное чтение всех четырёх + сверка обоих путей (live/REST) на использование | — |
| WS-обработчик live, warm-probe, очередь отправки | `main.py:3689-5360` (1671) | **проверено** | полное чтение всех веток + трассировка швов «очередь ↔ sentinel ↔ watchdog» и «warm pool ↔ dual ↔ замена» | — |
| HTTP-эндпоинты, записи, ретенция, recovery-спул, пресеты | `main.py:1-3700, 5360-7370` (~5700) | **проверено** | делегированный проход по §2-классам поимённо; ключевые находки перепроверены мной исполнением (`_TMP_ORPHAN_RE`) и чтением исходника | 7370 строк одного файла нельзя охарактеризовать одним проходом; охвачены все объявленные функции, но не каждая ветка внутри 40+ эндпоинтов |
| Конфигурация, шифрование ключей, миграции | `config.py` (1002) | **проверено** | полное чтение + исполняемые репродукции (перезапись на чтении, пустой keyfile, краш импорта) — я перепроверил три из них сам | — |
| Env-переменные и `.env.example` | `.env.example`, все `os.environ` в `backend/**` | **проверено** | автоматическая сверка множеств (`comm` по извлечённым именам) — выполнено мной | — |
| Зависимости | `requirements*.txt` + метаданные установленного рантайма | **проверено** | сверка прямых импортов против объявленных, лок-файла против диапазонов, реальных `Requires-Dist` из `site-packages` | — |
| Аудио-конвейер (ffmpeg) | `audio.py` (642) | **проверено** | полное чтение; находка про `stdin`/`-nostdin` перепроверена мной по исходнику | — |
| Локальная транскрипция | `transcribe.py` (603), `transcribe_gigaam.py` (320), `models_manager.py` (338), `model_catalog.py` (139) | **проверено** | полное чтение; асимметрия `release_*` vs `model_is_resident` перепроверена мной | — |
| Локальный live-ассист | `live.py` (569) | **проверено** | полное чтение, арифметика окна пересчитана вручную | — |
| Удалённые провайдеры и ретраи | `remote_deepgram.py` (301), `remote_openrouter.py` (257), `http_retry.py` (302) | **проверено** | полное чтение всех трёх | — |
| Задания и атомарное хранение | `jobs.py` (267), `storage.py` (241) | **проверено** | полное чтение | — |
| Константы аудио и MIME | `audio_constants.py` (33), `audio_mime.py` (43) | **проверено** | полное чтение + поиск всех потребителей | — |
| Тесты | `backend/tests/**` (43 модуля) | **проверено** | AST-анализ: разрешение импортируемых имён, арность вызовов приватных методов, цели `mock.patch`, наличие assert'ов; + мои собственные перепроверки на `e8f1632` | — |
| Инструменты | `tools/deepgram_live_ab.py` (381) | **проверено** | полное чтение + поиск ссылок в доках/коде | — |
| Фронтенд и desktop | `frontend/**`, `desktop/**` | **не проверялось** | — | вне периметра этой секции; трогали только там, где контракт бэкенда имеет вторую сторону (напр. дубли дефолтов dual-stream, чтение `config.json` из `desktop/main.js`) |
| Реальные сетевые вызовы к Deepgram/OpenRouter | — | **не проверялось** | — | read-only аудит без ключей и без права тратить деньги пользователя; все выводы о протоколе сделаны по коду и по докам, процитированным в модулях |

**Итог по счёту.** **90 находок: 2 P0, 23 P1, 65 P2** (B-001…B-090). **72 подтверждены полностью**; у **18** подтверждён путь в коде, а срабатывание помечено гипотезой (зависит от тайминга, окружения или формы ответа провайдера) — они сведены в §6. **12 находок подкреплены исполняемой репродукцией** (B-001, B-002, B-003, B-005, B-006, B-007, B-013, B-017, B-018, B-020, B-021, B-024). Ни одна из проблем, закрытых коммитом `e8f1632`, в отчёт не включена: устаревший импорт `TAIL_GUARD_MIN_SEC`, неверная арность в восьми вызовах тестов и три теста, фиксировавших отменённое правило, были поправлены тем же коммитом и перепроверены мной на `e8f1632`.

---

## 3. Сценарии и швы (PRODUCT SCENARIOS)

Каждый сценарий пройден от входа до выхода; в скобках — ID находок, которые лежат именно на этом пути.

1. **Живая диктовка Deepgram: старт → стрим → стоп → конверт.** `ws_transcribe` → auth/Host/rate-limit → `_open_live_recovery` → `_run_deepgram_live_session` → `_preconnect_reader` (аудио пишется в спул уже во время connect) → `acquire` → `sender`/`receiver`/`forwarder` → `finalize` → `drain_transcript` → конверт → `shutdown` → `rewarm`. Найдено: B-005 (пустой `is_final` теряется), B-006 (`coveredEndSec` лжёт), B-007 (правило tail-guard не защищает случай, который обещает защищать), B-009 (`wait_for` вокруг `ws.send`), B-010 (`streamedSec` считается вторым способом на ветке ошибки).
2. **Dual-stream.** `dual_stream_enabled` → `secondary_config` → второй `acquire` → `DualLiveSession` → `send_pcm` в оба → `drain_transcript` обоих под одним бюджетом → `merge_readings` → один конверт. Найдено: B-001 (потеря текста), B-002 (квадратичное слияние), B-003/B-004 (пул), B-011 (отмена без await).
3. **Тёплый пул.** boot-прогрев → `acquire` → `_unfit_reason` → усыновление → warm-probe → `_swap_warm_socket` с реплеем → `rewarm` после записи. Найдено: B-003 (lock через connect), B-004 (вторичная конфигурация не греется никогда), B-012 (замена может пересечься с `drain_transcript`), B-013 (`_cancel_pending` теряет сокет).
4. **REST: upload / from-path.** `create_job` → `_save_upload_file` → `audio.ensure_wav_16k*` → провайдер → `jobs`. Найдено: B-014 (ffmpeg наследует stdin), B-072/B-037 (мёртвый конвертер, дубли таймаута), B-060 (`split_channels` в RAM).
5. **Записи: сохранение / ретенция / восстановление.** `save-with-audio` → claim-имени → `_write_recording_text_file` → `_prune_recording_audio`; `promote` → `write_wav_from_pcm16_stream`. Найдено: B-016 (rollback теряет claim), B-017 (sweeper не видит собственные tmp-имена), B-032 (два пути к «уникальному имени»), B-076 (sidecar-поля не читаются).
6. **Конфигурация и ключи.** `load_config` → deep-merge → `_validate_config_shape` → `_migrate_schema` → расшифровка. Найдено: B-018 (перезапись на чтении), B-019 (`preferences.openrouter` не валидируется), B-020 (пустой keyfile), B-021 (краш импорта).
7. **Прогрев и локальные модели.** `/api/transcribe/warmup` → `warm_model` / `warm_gigaam`; idle-выгрузка. Найдено: B-015 (GigaAM никогда не выгружается), B-034/B-044 (жёсткие 16000, необёрнутый `int()`).
8. **Keyterms.** config → `configured_keyterms` → live (`to_query_string`) и REST (`keyterm_query_pairs`). **Чисто** — единственный источник, оба пути, один парсер (см. §7).

**Швы, проверенные отдельно:**

* **Тёплый пул × dual-stream × замена сокета** — B-003, B-004, B-012. Все три живут ровно на стыке: пул спроектирован под две конфигурации, но зовут его последовательно и греют одну.
* **Ретенция × recovery-спул × улики** — потолок промоута выведен из потолка спула (чисто, §7), но tmp-имена промоута не подметаются (B-017), а статус спула пишется и не читается (B-076).
* **Deep-merge конфига × валидация** — `deepgram` валидируется, `openrouter` нет (B-019); штамп схемы пишет не то, что печатает (B-018).
* **Очередь отправки × sentinel финализации × watchdog** — порядок «всё аудио, потом Finalize» держится на очереди, а не на таймере, и это верно; но `_swap_warm_socket` живёт в том же sender'е и может пересечься с `drain_transcript` после истечения `_SEND_FLUSH_DEADLINE_SEC` (B-012).

---

## 4. Находки

Порядок внутри уровня: архитектура → корректность → функция → производительность → SSOT → UX → совместимость → мелочь.

### P0

---

#### B-001 · `backend/deepgram_dual.py:202` `flatten_words` (и `:383` `merge_readings`) — финал без списка слов молча выпадает из склеенного транскрипта целиком

**Суть.** Слияние двух чтений построено исключительно на словах: `flatten_words` берёт только `_segment_words(seg)`. Финал, пришедший без `words`, не даёт ни одного слова — и его `text` нигде больше не используется, потому что `merged.text` собирается из слов (`" ".join(w["word"] …)`). Текст такого финала исчезает из конверта.

**Как наблюдать / воспроизвести.** Реальный запуск против снимка (`repro2.py`, интерпретатор приложения):

```
D: primary had no word list -> merged text = 'это'
D: primary no words, no secondary        = ''
```

Первый случай: у primary финал `{"start":0,"end":3,"text":"это весь мой текст"}` без `words`, у secondary есть одно слово — на выходе одно слово вместо четырёх. Второй: secondary пуст — на выходе пустая строка вместо всего текста.

**Путь входа.** `ws_transcribe` (Auto) → `dual_stream_enabled` = True по умолчанию (`config.py:512`) → `DualLiveSession.drain_transcript` → `_merged_envelope` → `merge_readings` → `flatten_words`. Дальше конверт `{"type":"final"}` уходит рендереру как окончательный текст.

**Достижимость.** Одиночный путь этот случай обрабатывает явно и по имени — `_word_covered_by_spanless_final` (`remote_deepgram_live.py:1901`), `_spanless_coverage` (`:1955`), ветка `else` в `_process_deepgram_message` (`:3196`), — то есть кодовая база сама считает «финал без списка слов» реальным событием провайдера. Плюс `normalize_words` (`:263`) выбрасывает слова с `end <= start` и с пустым токеном, так что `message_words` может стать `[]` и на вполне валидном ответе.

**Последствие.** Полная или частичная потеря транскрипта на пути, который включён по умолчанию, — без ошибки, без warning'а, без следа в логе. Пользователь видит «Deepgram отработал» и пустую/обрезанную вставку.

**Серьёзность.** P0 · **подтверждено (repro)**.

Текущий код:
```python
def flatten_words(segments: Iterable[dict], source: str) -> list[dict]:
    out: list[dict] = []
    for seg in segments or []:
        for w in _segment_words(seg):
            ...
```
и
```python
    return MergedReading(
        words=merged,
        segments=_segments_from_words(merged),
        text=" ".join(w["word"] for w in merged),
```

Исправление — сегмент без списка слов становится одним «словом» на всю свою длительность, ровно как одиночный путь трактует его как span:
```python
def flatten_words(segments: Iterable[dict], source: str) -> list[dict]:
    """Finalized segments to one time-ordered word list, tagged.

    A segment that arrived WITHOUT a word list is not empty — its span is
    the only thing knowable about it, which is exactly how the
    single-stream path treats it (``_spanless_coverage``). Dropping it
    here deleted the whole clause from the merged transcript.
    """
    out: list[dict] = []
    for seg in segments or []:
        words = _segment_words(seg)
        if not words:
            text = str(seg.get("text") or "").strip()
            if not text:
                continue
            start = float(seg.get("start") or 0.0)
            end = float(seg.get("end") or start)
            out.append(
                {"word": text, "start": start, "end": max(end, start),
                 "source": source, "spanless": True}
            )
            continue
        for w in words:
            token = str(w.get("word") or "")
            if not token:
                continue
            out.append({
                "word": token,
                "start": float(w.get("start") or 0.0),
                "end": float(w.get("end") or 0.0),
                "source": source,
            })
    out.sort(key=lambda w: (w["start"], w["end"]))
    return out
```
(и в `_same_audio` — не сопоставлять по стему запись с `spanless: True`, чтобы целая фраза не «схлопнулась» с одиночным словом; сравнение по перекрытию времени для неё остаётся корректным.)

**Почему это баг, а не решение.** Докстринг `merge_readings` обещает «merge two readings of one recording into one transcript», а не «слов, у которых есть таймстампы». Отдельная ветка `if not secondary:` («single-stream degradation … the primary reading, **untouched**») прямо декларирует, что при отсутствии второго чтения первое должно дойти нетронутым — а как раз в этой ветке текст и обнуляется. Осознанного решения «финалы без слов игнорируем» нигде не записано, при том что в соседнем модуле этот случай описан тремя отдельными функциями.

---

#### B-002 · `backend/deepgram_dual.py:250` `_pairs` — сопоставление слов квадратично и синхронно блокирует event loop на стопе, вне объявленного бюджета

**Суть.** Для каждого слова primary перебирается secondary **с нулевого индекса**; ранний `break` есть, ранний «пропуск головы» — нет. Сложность O(P×S) на CPU-bound пути, который выполняется синхронно внутри `DualLiveSession.drain_transcript`, то есть блокирует весь asyncio-цикл процесса.

**Как наблюдать / воспроизвести.** Реальный замер (`repro2.py`/`repro3.py`, интерпретатор приложения, снимок `e8f1632`):

```
 250 слов/чтение -> merge_readings    135 мс
 500 слов/чтение -> merge_readings    616 мс
1000 слов/чтение -> merge_readings   2811 мс
1500 слов/чтение -> merge_readings   4633 мс
2000 слов/чтение -> merge_readings    9.7 с
3000 слов/чтение -> merge_readings   30.8 с
```

**Путь входа.** `finalize` → `DualLiveSession.drain_transcript` → `_merged_envelope` → `merge_readings` → `_pairs`. Это происходит **после** того, как `on_budget` уже объявил рендереру потолок (`worst_case = flush_wait*k + FINALIZE_ASSEMBLY_ALLOWANCE_SEC`, где `FINALIZE_ASSEMBLY_ALLOWANCE_SEC = 0.15`).

**Последствие.** Двойное. (1) Стоп на 7-минутной диктовке (~1000 слов) добавляет ~2.8 с, на 20-минутной (~3000 слов) — ~31 с, и всё это время процесс не обрабатывает ни WebSocket, ни HTTP: рендерер видит зависший бэкенд, watchdog'и не тикают. (2) Объявленный бюджет перестаёт быть верхней границей — а это ровно тот контракт (C3), ради которого `FINALIZE_ASSEMBLY_ALLOWANCE_SEC` и вводили; рендерер, доверившись числу, закроет ожидание раньше и уйдёт в recovery.

**Серьёзность.** P0 · **подтверждено (repro)**. (На типичной короткой диктовке цена — сотни миллисекунд; P0 присвоен потому, что рост неограничен и работа синхронная.)

Текущий код:
```python
    candidates: list[tuple[float, int, int]] = []
    for pi, pw in enumerate(primary):
        for si, sw in enumerate(secondary):
            if sw["start"] > pw["end"] + ADJACENT_SAME_STEM_MAX_GAP_SEC:
                break
            if _same_audio(pw, sw):
                candidates.append((_time_overlap(pw, sw), pi, si))
```

Исправление — оба списка уже отсортированы по времени, значит окно кандидатов движется вместе с курсором (линейно по числу слов, константа — ширина окна):
```python
    candidates: list[tuple[float, int, int]] = []
    lo = 0
    for pi, pw in enumerate(primary):
        # Both lists are time-sorted, so the window of secondary words
        # that can possibly describe this moment only moves forward.
        # Scanning from 0 for every primary word made this O(P*S): a
        # 20-minute dictation (3000 words per reading) spent 30.8 s here,
        # synchronously, on the stop path.
        while lo < len(secondary) and secondary[lo]["end"] < pw["start"] - ADJACENT_SAME_STEM_MAX_GAP_SEC:
            lo += 1
        for si in range(lo, len(secondary)):
            sw = secondary[si]
            if sw["start"] > pw["end"] + ADJACENT_SAME_STEM_MAX_GAP_SEC:
                break
            if _same_audio(pw, sw):
                candidates.append((_time_overlap(pw, sw), pi, si))
```
Дополнительно, чтобы объявленный бюджет снова стал честным, слияние следует унести с цикла: в `DualLiveSession._merged_envelope` — `merged = await asyncio.to_thread(merge_readings, ...)` (метод придётся сделать `async`), либо учесть измеренную стоимость в `worst_case`.

**Почему это баг, а не решение.** Докстринг `_pairs` объясняет только порядок ранжирования кандидатов; про стоимость перебора там нет ни слова, а модуль в целом гордится тем, что «two concurrent sockets did not slow the connect … the cost is money, not latency» — то есть автор считает, что фича не добавляет задержки. Замер показывает обратное, и добавляет её на самом чувствительном участке продукта — между Stop и вставкой текста.


### P1

---

#### B-003 · `backend/deepgram_warm.py:266` `DeepgramWarmPool.acquire` — пул держит свой `asyncio.Lock` через `await session.connect()`, поэтому два коннекта dual-stream всегда сериализуются

**Суть.** Весь метод обёрнут в `async with self._lock`, а внутри — сетевое ожидание до 12 с (`connect` = 8 с + один ретрай 4 с). Пока один вызов ждёт TCP+TLS+handshake, любой другой `acquire()` — в том числе для **другой** конфигурации — стоит в очереди.

**Как наблюдать / воспроизвести.** `repro5.py` (интерпретатор приложения, фейковая сессия с `connect` = 0.9 с — измеренная p50 из аудита):

```
main.py's sequential shape       : 1.80 s
same two acquires under gather   : 1.80 s  <- the lock serialises them anyway
```

То есть даже если вызывающий код исправить на `asyncio.gather`, задержка не изменится: узкое место — сам lock.

**Путь входа.** `_run_deepgram_live_session` → `acquire(api_key, dg_cfg)` (`main.py:4586`) → затем `acquire(api_key, secondary_config(dg_cfg, dual_language))` (`main.py:4628`), оба под одним lock'ом.

**Последствие.** На каждой dual-записи (режим по умолчанию для Auto) пользователь платит **два** коннекта подряд перед первым отправленным байтом: p50 ≈ 1.8 с, худший случай 24 с. Это ровно та задержка, ради устранения которой написан модуль. Плюс любой другой потребитель пула (boot-прогрев, статус) блокируется на время коннекта.

**Серьёзность.** P1 (архитектура; деградация на нормальной нагрузке) · **подтверждено (repro)**.

Текущий код:
```python
        key = cfg.to_query_string()
        async with self._lock:
            pending = self._pending.get(key)
            ...
            session = self._factory(api_key, cfg)
            await session.connect()
            return WarmAcquisition(...)
```

Исправление — lock защищает только структуры пула; сетевое ожидание выносится наружу через ту же `_pending`-машинерию, которая уже умеет схлопывать одновременные коннекты одной конфигурации:
```python
        key = cfg.to_query_string()
        async with self._lock:
            pending = self._pending.get(key)
            if pending is not None and pending[1] == api_key:
                task = pending[0]
                self._pending.pop(key, None)
            else:
                if pending is not None:
                    await self._cancel_pending(key)
                slot = self._slots.get(key)
                if slot is not None:
                    reason = self._unfit_reason(slot, api_key)
                    if reason is None:
                        self._release_slot(key)
                        return self._adopt(
                            slot.session,
                            age=max(0.0, self._clock() - slot.warmed_at),
                        )
                    await self._drop_slot(key, reason)
                task = asyncio.get_running_loop().create_task(
                    self._connect_only(api_key, cfg), name="deepgram-acquire-connect",
                )
        # OUTSIDE the lock: a connect is up to 12 s of network wait, and
        # holding the pool lock across it serialises every other
        # acquire() — including the second reading of a dual-stream
        # recording, which is the one case WARM_MAX_SOCKETS=2 exists for.
        session = await task
        if session is None:
            raise DeepgramLiveError("Deepgram connect failed")
        return WarmAcquisition(
            session=session, adopted=False, warm_age_sec=0.0,
            connect_ms=session.stats.connect_ms,
        )
```
и в `main._run_deepgram_live_session` два `acquire` запускать одновременно:
```python
        primary_task = asyncio.ensure_future(DEEPGRAM_WARM_POOL.acquire(api_key, dg_cfg))
        secondary_task = (
            asyncio.ensure_future(
                DEEPGRAM_WARM_POOL.acquire(api_key, secondary_config(dg_cfg, dual_language))
            )
            if dual_language
            else None
        )
```

**Почему это баг, а не решение.** Докстринг класса объясняет, что `WARM_MAX_SOCKETS = 2` существует именно потому, что «a dual-stream recording … opens two readings … which are two configurations and therefore two keys», и что «warming only one of them would leave the other paying exactly the connect this module removes». Замок, сериализующий эти два коннекта, отменяет всю выгоду для второго чтения — это противоречит заявленной цели, а не реализует её.

---

#### B-004 · `backend/main.py:4464` (`_prewarm_deepgram_at_boot`) и `backend/main.py:5293` (пост-запись `rewarm`) — вторичная конфигурация dual-stream не прогревается **никогда**

**Суть.** `rewarm` вызывается ровно в двух местах, и оба раза с `dg_cfg` — конфигурацией **первичного** чтения. Ключ пула — `cfg.to_query_string()`, а у вторичного чтения `language=ru` вместо `language=multi`, то есть другой ключ. Слот для него не создаётся ни при загрузке, ни после записи.

**Как наблюдать.** `grep -rn "rewarm(" backend --include="*.py"` даёт три строки: определение (`deepgram_warm.py:335`) и два вызова (`main.py:4464`, `main.py:5293`), оба с `dg_cfg`. `GET /api/live/warm` в dual-режиме никогда не покажет двух сокетов.

**Последствие.** `WARM_MAX_SOCKETS = 2`, вся его документация и вся логика вытеснения «самого старого» — мёртвый код: в пуле никогда не бывает больше одного слота. Вторичное чтение платит холодный коннект на каждой записи. Вместе с B-003 это и есть удвоенная задержка старта dual-записи.

**Серьёзность.** P1 (функция сделана наполовину; заявленное обоснование константы ложно) · **подтверждено**.

Текущий код (`main.py:5293`):
```python
        DEEPGRAM_WARM_POOL.rewarm(api_key, dg_cfg)
```

Исправление — греть ровно тот набор конфигураций, который эта запись использовала:
```python
        # Re-warm every configuration this recording actually used, not
        # just the primary: the second reading has its own query string
        # and therefore its own pool key, and warming only one of them is
        # what WARM_MAX_SOCKETS=2 exists to avoid.
        DEEPGRAM_WARM_POOL.rewarm(api_key, dg_cfg)
        if dual_language:
            DEEPGRAM_WARM_POOL.rewarm(api_key, secondary_config(dg_cfg, dual_language))
```
и симметрично в `_prewarm_deepgram_at_boot`, где решение о dual уже можно принять из того же `cfg`:
```python
    cfg_primary = _live_config(
        model=DEFAULT_DEEPGRAM_AUDIO_MODEL, language="auto",
        diarize=False, keyterms=configured_keyterms(cfg),
    )
    DEEPGRAM_WARM_POOL.rewarm(api_key, cfg_primary)
    if dual_stream_enabled(cfg, "auto"):
        DEEPGRAM_WARM_POOL.rewarm(
            api_key, secondary_config(cfg_primary, dual_secondary_language(cfg))
        )
```

**Почему это баг, а не решение.** Константа `WARM_MAX_SOCKETS = 2` вместе с её комментарием была введена специально под dual-stream; если бы «греем только первичное» было решением, потолок остался бы равным 1. Это недоделанная проводка, а не выбор.

---

#### B-005 · `backend/remote_deepgram_live.py:3089` `_process_deepgram_message` — `is_final` с пустым `transcript` отбрасывается ДО ветки финала, поэтому нормальный ответ Deepgram на `Finalize` никогда не завершает ожидание

**Суть.** Ранний выход `if not text: return None` стоит выше проверки `is_final`. Пустой финал — штатный ответ Deepgram на `Finalize`, когда во входном буфере ничего не осталось, — не увеличивает `segments_final`, не взводит `_final_arrived` и не обновляет `_last_final_ended_the_utterance()`.

**Как наблюдать / воспроизвести.** `repro1.py` на реальном классе:

```
A: event returned      = None
A: segments_final      = 0
A: _final_arrived set  = False
```
(вход: `{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"","words":[]}]}}`)

**Путь входа.** `_recv_loop` → `_process_deepgram_message` → ранний `return None`; параллельно `drain_transcript` (`:1596-1612`) ждёт `self._final_arrived`, которое никто не взведёт.

**Последствие.** Ожидание после `Finalize` всегда досиживает свой потолок, даже когда провайдер уже ответил «мне нечего слать». Именно вокруг этого симптома выстроены три эмпирические константы — `FINALIZE_COVERED_WAIT_SEC = 0.75` («267 из 410 стопов сожгли полный потолок, ожидая сообщение, которое не придёт»), `FINALIZE_EMPTY_TAIL_WAIT_SEC = 0.25` («9 из 9 таких стопов прождали всё окно, и Deepgram не прислал ничего») и весь трёхветочный выбор бюджета. Сообщение приходило; его выбрасывали здесь. То есть это первопричина, а три константы — обход симптома, ровно то, что просят убрать.

**Серьёзность.** P1 (первопричина задержки стопа + три костыля поверх неё; глушение сигнала) · **подтверждено (repro)**.

Текущий код:
```python
        text = str(alt.get("transcript") or "").strip()
        if not text:
            return None
```

Исправление — пустой финал не даёт транскрипта, но он **факт протокола**, и его надо записать:
```python
        text = str(alt.get("transcript") or "").strip()
        is_final = bool(msg.get("is_final"))
        if not text:
            if is_final:
                # Deepgram's normal answer to Finalize when nothing is
                # buffered: no transcript, but a real "the flush is
                # done" signal. Dropping it here is why the flush wait
                # always ran to its ceiling — the three empirically
                # tuned wait budgets below exist to paper over exactly
                # this. Arm the event so the wait can end on the answer.
                if bool(msg.get("speech_final")):
                    self._last_empty_speech_final = True
                self._final_arrived.set()
            return None
```
и в `_last_final_ended_the_utterance` учитывать `self._last_empty_speech_final` (сбрасывать его при каждом непустом финале), а в `_tail_awaits_more_finals` — прекращать ожидание, когда пустой финал пришёл при уже покрытом хвосте. После этого `FINALIZE_EMPTY_TAIL_WAIT_SEC` и `FINALIZE_COVERED_WAIT_SEC` можно свести к одному честному потолку, потому что выход будет по событию, а не по таймеру.

**Почему это баг, а не решение.** Комментарий у `FINALIZE_COVERED_WAIT_SEC` прямо утверждает: «each having first burned the full FINALIZE_FLUSH_WAIT_SEC ceiling waiting for a message **that was never coming**». Это измеренное следствие, а не проверенная причина: сообщение приходило и удалялось строкой выше. Нигде не записано решения «пустые финалы игнорируем»; ранний выход стоит там ради интерим-веток, где он уместен.

---

#### B-006 · `backend/remote_deepgram_live.py:1779` (`drain_transcript`) и `:2787` (`partial_result`) — `coveredEndSec` равен `durationSec` и включает восстановленные interim-слова, вопреки собственному определению

**Суть.** `duration_sec` считается по `merged_segments`, а `merge_seam_fragments` вызывается **после** `_splice_uncovered_interim_words()`, который дописывает в `self._finalized_segments` fallback-сегменты с `"source": "interim-fallback"`. Одно и то же число уезжает в конверт дважды — как `durationSec` и как `coveredEndSec`, — хотя второе документировано как «the point up to which the transcript is a committed final, **as opposed to spliced interim fallback**».

**Как наблюдать / воспроизвести.** `repro1.py`, часть B: финал 0.0–1.0 с, интерим со словом на 3.0–3.5 с, которого не покрыл ни один финал:

```
B: spliced             = 1
B: segments            = [(0.0, 1.0, None), (3.0, 3.5, 'interim-fallback')]
B: coveredEndSec would be 3.5 (docstring: 'last FINALIZED segment, as opposed to spliced interim fallback')
```

**Путь входа.** `drain_transcript` → `_splice_uncovered_interim_words` (`:2082`, дописывает `fallback_segments` в `self._finalized_segments`) → `merged_segments` (`:1713`) → `duration_sec` (`:1723`) → `"coveredEndSec": round(duration_sec, 3)` (`:1779`) → WS-конверт (`main.py:5236`) → рендерер.

**Последствие.** Рендерер принимает решение «полон ли конверт» именно по этой паре (`envelopeCoversRecording({streamedSec, coveredEndSec, …})`, введённой коммитом `0cd3837` как раз для того, чтобы неполный конверт не завершал гонку). Одно восстановленное interim-слово в хвосте делает конверт «покрывающим», и recovery не запускается — то есть возвращается ровно тот дефект, который чинили. Плюс два поля конверта, документированные как разные величины, всегда равны — рендереру не с чем их сравнивать.

**Серьёзность.** P1 (два источника правды сведены в одно число; контракт с рендерером нарушен) · **подтверждено (repro)**.

Текущий код:
```python
        merged_segments = merge_seam_fragments(list(self._finalized_segments))
        merged_segments = drop_repeated_seam_ngrams(merged_segments)
        ...
        duration_sec = float(max(s.get("end", 0.0) for s in merged_segments))
        ...
            "durationSec": round(duration_sec, 3),
            ...
            "coveredEndSec": round(duration_sec, 3),
```

Исправление — измерять `coveredEndSec` только по нативным финалам, до сплайса:
```python
        # Measured BEFORE the splice and over NATIVE finals only: this is
        # the point up to which the transcript is a committed final, which
        # is what the renderer's envelopeCoversRecording() reads. A
        # recovered interim word extends durationSec (the transcript is
        # genuinely that long) but it must not extend coveredEndSec, or a
        # single spliced tail word makes an incomplete envelope look
        # complete and suppresses recovery.
        committed_end_sec = max(
            (float(s.get("end") or 0.0) for s in self._finalized_segments
             if s.get("source") != "interim-fallback"),
            default=0.0,
        )
        ...
        spliced_words = self._splice_uncovered_interim_words()
        ...
            "durationSec": round(duration_sec, 3),
            "coveredEndSec": round(committed_end_sec, 3),
```
То же самое в `partial_result` (`:2778-2787`).

**Почему это баг, а не решение.** Определение поля написано в трёх местах — в `drain_transcript`, в WS-обработчике (`main.py:5233-5237`) и в докстринге — и все три говорят «в противоположность вставленному interim-фолбэку». Код делает обратное. Совпадение с `durationSec` символ в символ показывает, что второе поле просто не было вычислено отдельно.


---

#### B-007 · `backend/remote_deepgram_live.py:2414` `_tail_needs_flush` — докстринг утверждает, что правило 2 защищает случай 2026-08-24, код на этом самом случае возвращает `False`; параметр `tail_gap` не используется вовсе

**Суть.** Новое правило: ретрай `Finalize` только при (1) `tail_speech >= 0.25` или (2) `_latest_interim_window_end - covered_end > endpointing_ms/1000`. Докстринг заявляет: «Rule 2 is what keeps the 2026-08-24 case from regressing … it does not require RECOGNISED words … only that Deepgram's own decoder is still visibly reaching into that audio». Но в том самом случае Deepgram **замолчал** за 3.7 с до Stop — значит окно последнего интерима не выходит за `covered_end`, и правило 2 не срабатывает. Одновременно `tail_gap` принимается как параметр и в теле не читается ни разу.

**Как наблюдать / воспроизвести.** `repro4.py` строит ровно описанную в комментарии продакшн-ситуацию (`gap=4.01s`, `speech_in_gap=0.00`, финал закончился естественно):

```
streamed=14.01 covered_end=10.00 gap=4.01 speech_in_gap=0.00
latest interim window end = 10.2
_tail_needs_flush -> False   (docstring claims rule 2 keeps this case from regressing)
_tail_awaits_more_finals -> False
tail_gap referenced in body? -> False
```

**Путь входа.** `drain_transcript` → `_tail_coverage()` → `_tail_needs_flush(...)` (`:1542` — выбор бюджета, `:1631` — решение о ретрае).

**Последствие.** Три вещи сразу. (1) Возвращается известная потеря: провайдер, ушедший в молчание с непрослитой концовкой, больше не получает второй `Finalize` — концовка теряется. (2) Сигнал `UtteranceEnd`, который специально собирают (C7, §3.5) и который уменьшает `tail_gap` в `_tail_coverage`, теперь **никак не влияет** на решение о ретрае, потому что `tail_gap` не читается: собранная улика стала мёртвой. (3) Порог `INTERIM_SPEECH_MIN_CHARS = 8` усугубляет первое: одно короткое русское слово в хвосте не даёт интериму пройти порог, значит `tail_speech` = 0, значит правило 1 тоже молчит.

**Серьёзность.** P1 (расхождение кода и комментария; регрессия ранее закрытой потери слов) · **подтверждено (repro)**.

Текущий код:
```python
    def _tail_needs_flush(
        self, tail_gap: float, tail_speech: float, covered_end: float
    ) -> bool:
        ...
        if tail_speech >= TAIL_GUARD_MIN_SPEECH_SEC:
            return True
        endpointing_window_sec = self._cfg.endpointing_ms / 1000.0
        window_overhang = self._latest_interim_window_end - covered_end
        return window_overhang > endpointing_window_sec
```

Исправление — добавить третью улику, которая и покрывает случай «провайдер замолчал»: молчание, начавшееся ПОСЛЕ последнего финала и не подтверждённое `UtteranceEnd`, — это не «пользователь замолчал», а «неизвестно». Отличить их можно ровно тем сигналом, который уже собран:
```python
        if tail_speech >= TAIL_GUARD_MIN_SPEECH_SEC:
            return True
        endpointing_window_sec = self._cfg.endpointing_ms / 1000.0
        if self._latest_interim_window_end - covered_end > endpointing_window_sec:
            return True
        # Rule 3 — the 2026-08-24 shape (gap=4.01s, speech_in_gap=0.00,
        # provider silent for 3.7 s before Stop). Rules 1 and 2 both read
        # signals a SILENT provider cannot produce, so neither of them
        # keeps that case from regressing. What separates "the user
        # stopped talking" from "the provider stopped answering" is
        # Deepgram's own UtteranceEnd: with one inside the tail the
        # silence is CONFIRMED and _tail_coverage has already shrunk
        # tail_gap to it; without one, a gap this wide is unexplained
        # and worth one retry.
        utterance_end = self._last_utterance_end
        confirmed_silence = (
            utterance_end is not None and utterance_end >= covered_end
        )
        return tail_gap > TAIL_GUARD_UNEXPLAINED_GAP_SEC and not confirmed_silence
```
с новой именованной константой рядом с остальными (`TAIL_GUARD_UNEXPLAINED_GAP_SEC = 0.75` — прежнее измеренное значение, с ссылкой на лог 2026-08-24), после чего `tail_gap` перестаёт быть мёртвым параметром.

**Почему это баг, а не решение.** Решение «убрать gap как улику» принято сознательно и обосновано измерением (1 транскрипт из 84). Но в том же докстринге записано обязательство не потерять при этом случай 2026-08-24, и это обязательство кодом не выполнено — репродукция показывает `False` там, где текст обещает `True`. Мёртвый параметр в сигнатуре — отдельный признак того, что переход не доведён.

---

#### B-008 · 13 мест: `except (asyncio.CancelledError, Exception): pass` — подавляется отмена задачи и бесследно проглатывается любая ошибка

**Суть.** `asyncio.CancelledError` наследуется от `BaseException`, а не от `Exception` (проверено на рантайме приложения: `issubclass(asyncio.CancelledError, Exception) == False`), поэтому этот кортеж написан **специально**, чтобы поймать отмену — и тут же её выбросить в `pass`. Плюс во всех тринадцати местах любая настоящая ошибка исчезает без единой строки в логе.

**Все места:**
`main.py:376` (lifespan) · `main.py:4235` (`_run_local_live_session` finally) · `main.py:4592` (отмена pre-task после провала connect) · `main.py:4656` (отмена pre-task после успеха) · `main.py:5134` (finally: `await rx`) · `main.py:5164` (`await wd`) · `main.py:5171` (`await warm_probe`) · `main.py:5303` (`await snd`) · `main.py:5313` (`await fw`) · `remote_deepgram_live.py:1819` (`shutdown`: keepalive) · `remote_deepgram_live.py:1832` (`shutdown`: recv-задача) · `remote_deepgram_live.py:2679` (`close`: keepalive) · `deepgram_warm.py:518` (`_cancel_pending`).

**Как наблюдать.** `grep -rn "except (asyncio.CancelledError, Exception)" backend --include="*.py" | grep -v tests` — ровно 13 совпадений, все с телом `pass`.

**Последствие.** (1) Пять из них (`main.py:5134/5164/5171/5303/5313`) стоят в `finally` WS-обработчика: если сам обработчик отменяют — при остановке uvicorn или при разрыве соединения, — `await` внутри поднимет `CancelledError`, она будет съедена, и корутина продолжит выполнение, как будто её не отменяли. Задача становится трудноубиваемой, а `close_all()` в lifespan ограничен 1 с и уйдёт по таймауту. (2) Тринадцать точек, где реальная ошибка (провал закрытия сокета, исключение внутри задачи) исчезает без следа — прямое нарушение AGENTS.md §1-2 и класса «ownerless errors».

**Серьёзность.** P1 · **подтверждено** (форма кода и семантика `CancelledError`); последствие «незавершаемая задача» — **гипотеза** (нужна отмена именно в этот момент).

Текущий код (типовой вид, `main.py:5303`):
```python
        if not snd.done():
            snd.cancel()
        try:
            await snd
        except (asyncio.CancelledError, Exception):
            pass
```

Исправление — один помощник, применяемый во всех тринадцати местах:
```python
async def _await_cancelled(task: "asyncio.Task", *, what: str) -> None:
    """Await a task we cancelled, without eating OUR OWN cancellation.

    ``asyncio.CancelledError`` is a BaseException: catching it here
    suppresses the cancellation of the coroutine doing the awaiting,
    which is how a WS handler survives uvicorn's shutdown. Only the
    cancellation OF THAT TASK is swallowed; anything else is logged
    rather than vanishing.
    """
    try:
        await task
    except asyncio.CancelledError:
        if task.cancelled():
            return          # the task we cancelled — expected
        raise               # OUR cancellation — must propagate
    except Exception as e:
        logger.warning("%s ended with an error: %s", what, e, exc_info=True)
```
```python
        if not snd.done():
            snd.cancel()
        await _await_cancelled(snd, what="deepgram sender")
```

**Почему это баг, а не решение.** Ни в одном из тринадцати мест нет комментария, объясняющего, почему отмену нужно подавить; кортеж выглядит как идиома «поймать всё», скопированная по файлу. Модуль `remote_deepgram_live` в других местах (`_recv_loop:2895`, `_keepalive_loop:3033`) как раз **пробрасывает** `CancelledError` явным `raise` — то есть автор знает правильную форму и применяет её там, где думал об этом.

---

#### B-009 · `backend/remote_deepgram_live.py:1490` (`drain_transcript`, Finalize), `:1643` (tail-guard Finalize), `:1804` (`shutdown`, CloseStream) — `asyncio.wait_for` вокруг `ws.send()`, ровно то, что этот же модуль объявил причиной зависаний

**Суть.** `send_pcm` содержит развёрнутое объяснение: «The send is NEVER cancelled once started. `websockets` documents that cancelling a `send()` mid-frame leaves the connection in an undefined state, and the 5-second `wait_for` that used to wrap this call did exactly that — which is the most plausible explanation for the observed runs of four consecutive hangs». Тот же 5-секундный `wait_for` остался на всех трёх управляющих кадрах.

**Как наблюдать.** `grep -n "asyncio.wait_for(" backend/remote_deepgram_live.py` → три обёртки вокруг `self._ws.send(json.dumps(...))`.

**Последствие.** Если сокет подвиснет на отправке `Finalize`, `wait_for` отменит send посреди кадра и оставит соединение в неопределённом состоянии — прямо перед тем, как из него нужно вычитать хвост транскрипта. Это худший момент для такого состояния.

**Серьёзность.** P1 (внутреннее противоречие правила, установленного тем же модулем) · **подтверждено** (противоречие), **гипотеза** (частота срабатывания).

Текущий код:
```python
                await asyncio.wait_for(
                    self._ws.send(json.dumps({"type": "Finalize"})),
                    timeout=5.0,
                )
```

Исправление — тот же приём, что уже применён на аудио-пути: не отменять запись, а закрывать сокет, чем и разблокировать её.
```python
    async def _send_control(self, frame: dict, *, what: str) -> bool:
        """Send a control frame without ever cancelling the write.

        Same rule as ``send_pcm``: cancelling a ``websockets`` send
        mid-frame leaves the connection undefined, and this frame is
        sent at the exact moment we still need to READ from that
        connection. A wedged socket is answered by closing it (which
        makes the pending write raise), never by cancelling the write.
        """
        ws = self._ws
        if ws is None:
            return False
        send = asyncio.ensure_future(ws.send(json.dumps(frame)))
        guard = asyncio.ensure_future(asyncio.sleep(CONTROL_SEND_WEDGE_SEC))
        done, _ = await asyncio.wait({send, guard}, return_when=asyncio.FIRST_COMPLETED)
        if send not in done:
            logger.warning("deepgram-live: %s send wedged (>%.1fs); closing the socket", what, CONTROL_SEND_WEDGE_SEC)
            try:
                await ws.close()
            except Exception:
                pass
            await asyncio.gather(send, return_exceptions=True)
            return False
        guard.cancel()
        try:
            send.result()
        except (ConnectionClosed, WebSocketException) as e:
            logger.warning("deepgram-live: %s send failed: %s", what, e)
            return False
        return True
```

**Почему это баг, а не решение.** Правило сформулировано в этом же файле, обосновано наблюдаемой продакшн-сериями зависаний и применено к аудио-пути. Никакого текста, объясняющего, почему для управляющих кадров оно не действует, нет — это просто не доведённая до конца правка (audit §3.6).

---

#### B-010 · `backend/main.py:5258` и `backend/main.py:5316` — `streamedSec` пересчитывается вторым способом, мимо `_streamed_seconds`, и теряет `audio_offset_sec`

**Суть.** `DeepgramLiveSession._streamed_seconds` (`remote_deepgram_live.py:2338`) объявлен единственным местом перевода байтов в секунды: «One conversion, used by both the coverage measurement and the envelope's `streamedSec`, **so they cannot drift apart**». В `main.py` то же вычисление написано ещё дважды, без смещения и без `self._cfg.sample_rate`.

**Как наблюдать.** `grep -n "2 \* LIVE_SAMPLE_RATE_HZ" backend/main.py` → `:4379`, `:4787`, `:5258`, `:5316`.

**Последствие.** На ветке ошибки (`:5258`) конверт уносит рендереру `streamedSec`, посчитанный **без** `audio_offset_sec`. После замены тёплого сокета (`_swap_warm_socket` даёт ненулевое смещение) это число занижено на длину сброшенного кольца — а рендерер сравнивает именно `streamedSec` с `coveredEndSec`, решая, полон ли конверт. Занижение `streamedSec` делает неполный конверт «полным».

**Серьёзность.** P1 (два источника правды для числа, на котором строится решение о recovery) · **подтверждено**.

Текущий код:
```python
                "streamedSec": round(
                    session.stats.bytes_sent / float(2 * LIVE_SAMPLE_RATE_HZ), 3,
                ),
```

Исправление — спросить сессию, а не пересчитывать:
```python
                # One conversion, in the session that owns the offset —
                # see DeepgramLiveSession._streamed_seconds. Recomputing
                # it here dropped audio_offset_sec, which is exactly the
                # drift that method's docstring forbids.
                "streamedSec": round(session.streamed_seconds(), 3),
```
(с публичным `def streamed_seconds(self) -> float: return self._streamed_seconds(self.stats.bytes_sent)` в `DeepgramLiveSession` и делегатом в `DualLiveSession`), и то же самое для лог-строки `:5316`.

**Почему это баг, а не решение.** Докстринг `_streamed_seconds` явно называет цель «чтобы они не разошлись», а `audio_constants.py` был создан ровно с формулировкой «bytes/sec … appeared at four different sites in `main.py` alone». Оба инварианта нарушены механическим повтором арифметики.


---

#### B-011 · `backend/deepgram_dual.py:632` `DualLiveSession.drain_transcript` — отменённая задача вторичного чтения не дожидается, и её `shutdown` идёт параллельно с ещё живой `drain_transcript`

**Суть.** В ветке таймаута вызывается `secondary_task.cancel()`, после чего сразу читается `secondary.partial_result()` и метод возвращается. Отменённую задачу никто не `await`. Дальше вызывающий код (`main.py:5271`) вызывает `session.shutdown()` → `_both("shutdown")` → `secondary.shutdown()`, тогда как отменяемая `secondary.drain_transcript()` ещё может выполняться и работать с тем же `self._ws`.

**Как наблюдать.** Читается прямо: `except asyncio.TimeoutError: secondary_task.cancel(); … secondary_result = secondary.partial_result()`. Между `cancel()` и фактическим завершением задачи нет ни одной точки синхронизации.

**Последствие.** Три: (1) `partial_result()` может прочитать `_finalized_segments` в момент, когда отменяемый `drain_transcript` уже вставил fallback-сегменты сплайса, — снимок «зафиксированного» окажется не зафиксированным; (2) `shutdown()` и незавершённый `drain_transcript` могут одновременно писать в сокет (второй `Finalize` против `CloseStream`); (3) если задача упадёт с исключением, оно никем не получено — asyncio напечатает «Task exception was never retrieved» и всё.

**Серьёзность.** P1 (гонка на пути стопа) · **подтверждено** (отсутствие `await` и последующий параллельный `shutdown`), **гипотеза** (какое именно из трёх последствий проявится).

Текущий код:
```python
            except asyncio.TimeoutError:
                secondary_task.cancel()
                ...
                secondary_result = secondary.partial_result()
```

Исправление:
```python
            except asyncio.TimeoutError:
                secondary_task.cancel()
                # Wait for the cancellation to LAND before snapshotting:
                # the abandoned drain_transcript() is still mutating
                # _finalized_segments (its splice appends fallback
                # segments), and shutdown() runs right after this method
                # returns — two coroutines on one socket otherwise.
                try:
                    await secondary_task
                except asyncio.CancelledError:
                    if not secondary_task.cancelled():
                        raise
                except Exception as e:
                    logger.warning("dual-stream: secondary drain ended with %s", e)
                secondary_result = secondary.partial_result()
```

**Почему это баг, а не решение.** Комментарий в этой же ветке объясняет только, почему частичный результат лучше отбрасывания; про отмену там ничего нет. Соседний код проекта отменяет задачи именно с `await` (`main.py:5163-5172`, `deepgram_warm.py:515-519`) — то есть форма известна и здесь просто пропущена.

---

#### B-012 · `backend/main.py:4765` `_swap_warm_socket` × `backend/main.py:5209` `drain_transcript` — после истечения `_SEND_FLUSH_DEADLINE_SEC` замена сокета может выполняться одновременно с финализацией и оборвать её

**Суть.** Замена тёплого сокета живёт внутри задачи `sender`. В `finally` WS-обработчика ожидание её завершения ограничено: `await asyncio.wait({snd}, timeout=_SEND_FLUSH_DEADLINE_SEC)` (6.0 с), после чего пишется предупреждение и выполнение идёт дальше — к `session.drain_transcript()`. Но `_swap_warm_socket` внутри делает `await fresh.connect()` (до 12 с), потом `await old.discard()`, потом переприсваивает `session`. Если он не уложился в 6 с, `drain_transcript` стартует на объекте, который замена вот-вот закроет.

**Как наблюдать.** `main.py:5145` — `_done, _still = await asyncio.wait({snd}, timeout=_SEND_FLUSH_DEADLINE_SEC)`; далее `:5209` — `drained = await session.drain_transcript(...)`; `main.py:4800-4820` — `await fresh.connect()` … `old = session.replace_primary(fresh)` / `session = fresh` … `await old.discard()`. Ни одного флага, который бы связывал эти два места.

**Достижимость.** `warm_probe_requested` взводится через 2.5 с после первого озвученного кадра. Приложение — диктовка короткими фразами; запись длиной 3-4 с попадает в это окно штатно. Отмена `warm_probe` в `finally` (`:5166`) происходит **после** ожидания sender'а, то есть уже поздно.

**Последствие.** `old.discard()` закрывает сокет, на котором в этот момент идёт `Finalize` и ожидание финалов → транскрипт стопа теряется, при том что реплей уже ушёл в новый сокет, о котором `drain_transcript` ничего не знает.

**Серьёзность.** P1 (потеря транскрипта на стопе) · **подтверждено** (путь в коде), **гипотеза** (нужен тайминг: замена стартовала непосредственно перед стопом и connect занял > 6 с).

Текущий код:
```python
        _done, _still = await asyncio.wait({snd}, timeout=_SEND_FLUSH_DEADLINE_SEC)
        if _still:
            logger.warning(
                "deepgram send queue did not drain within %.1fs "
                "(%d bytes still queued); finalizing anyway", ...
            )
```

Исправление — стоп не может начаться, пока замена не закончилась; и заявку на замену надо снимать до, а не после ожидания:
```python
        # A swap in flight OWNS the session object: it will discard the
        # one drain_transcript() is about to Finalize on. Withdraw the
        # request first, then give an already-started swap its own
        # connect budget before giving up on the sender.
        warm_swap_requested = False
        if warm_probe is not None and not warm_probe.done():
            warm_probe.cancel()
        deadline = _SEND_FLUSH_DEADLINE_SEC + (
            _WARM_SWAP_GRACE_SEC if warm_swap_in_progress else 0.0
        )
        _done, _still = await asyncio.wait({snd}, timeout=deadline)
        if _still and warm_swap_in_progress:
            logger.error(
                "deepgram warm-socket swap still running at finalize; "
                "the transcript will be drained from the replacement"
            )
```
(с `_WARM_SWAP_GRACE_SEC = DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC`, выведенной из бюджета коннекта, а не выдуманной.)

**Почему это баг, а не решение.** Докстринг `_swap_warm_socket` специально подчёркивает, что замена выполняется «inside the sender, which is the only writer to the upstream socket — so the old session is never being written to while it is torn down». Это верно относительно `sender`, но `drain_transcript` — второй писатель, и он запускается по таймауту, не спрашивая, закончилась ли замена. Инвариант «единственный писатель» сформулирован и нарушен.

---

#### B-013 · `backend/deepgram_warm.py:501` `_cancel_pending` — на одном из двух путей уже подключённый сокет выбрасывается, не закрываясь

**Суть.** Если задача ещё не `done()`, код делает `task.cancel()`, затем `await task` и глушит результат. `cancel()` на корутине, которая уже прошла свой последний `await` и вот-вот вернёт сессию, не отменяет её: `await task` вернёт готовый `DeepgramLiveSession`, и он будет отброшен без `discard()`.

**Как наблюдать.** Ветка `task.done()` выше закрывает сессию корректно (`repro6.py`: `done-task branch closes the socket: True`); симметричной обработки в ветке «не done» нет — там результат просто не читается.

**Последствие.** Открытое, тарифицируемое соединение с Deepgram, занимающее слот в лимите конкурентности, остаётся висеть до конца процесса. Достижимо при смене API-ключа во время фонового прогрева (`acquire` → `pending[1] != api_key` → `_cancel_pending`).

**Серьёзность.** P1 (утечка ресурса, стоящего денег) · **подтверждено** (форма кода; окно узкое).

Текущий код:
```python
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
```

Исправление:
```python
        task.cancel()
        session = None
        try:
            session = await task
        except asyncio.CancelledError:
            if not task.cancelled():
                raise
        except Exception as e:
            logger.debug("deepgram-live: cancelled warm connect ended with %s", e)
        if session is not None:
            # cancel() lost the race: the connect had already returned and
            # this is a live, billed socket holding a concurrency slot.
            await _quiet_close(session)
```

**Почему это баг, а не решение.** Ветка `task.done()` прямо выше делает именно это (берёт результат и закрывает его) — значит, намерение «не потерять сокет» есть; вторая ветка его просто не реализует. Плюс это частный случай B-008.

---

#### B-014 · `backend/audio.py:151` `_run_ffmpeg` — ffmpeg наследует stdin бэкенда; `-nostdin` стоит только в двух командах из четырёх

**Суть.** `subprocess.Popen` задаёт `stdout=DEVNULL, stderr=PIPE`, но не `stdin`. Флаг `-nostdin` есть в `_compact_audio_for_remote_cmd` (`:230`) и `_compact_audio_chunks_for_remote_cmd` (`:269`), и отсутствует в `ensure_wav_16k` (`:442`) и `ensure_wav_16k_preserve_channels` (`:515`).

**Как наблюдать.** `grep -n "nostdin\|hide_banner" backend/audio.py` → `-hide_banner` в четырёх местах (`228, 267, 442, 515`), `-nostdin` только в двух (`230, 269`).

**Путь входа.** `main.py:2153` `ensure_wav_16k_preserve_channels(...)` и `main.py:2183` `ensure_wav_16k(...)` (локальная транскрипция любого загруженного файла) → `_run_ffmpeg` → `Popen` без `stdin=`.

**Последствие.** Интерактивный консольный ридер ffmpeg читает байты из stdin родителя — то есть из stdio-канала, по которому Electron общается с бэкендом. При запуске в фоне на POSIX процесс может получить `SIGTTIN` и остановиться.

**Серьёзность.** P1 (ресурс/данные чужого канала; половина команд следует правилу, половина нет) · **подтверждено**.

Текущий код:
```python
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
```

Исправление — одно место закрывает все четыре вызова:
```python
    proc = subprocess.Popen(
        cmd,
        # ffmpeg reads its interactive console from stdin. Inherited, it
        # steals bytes from the parent's stdio channel (Electron's) and
        # can take SIGTTIN when backgrounded. -nostdin on the argv covers
        # only the two commands that carry it; this covers all of them.
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
```
плюс `"-nostdin",` после `"-hide_banner",` в обеих командах конверсии — правило уже закреплено тестами `backend/tests/test_audio.py:27,54`, которые проверяют его только для двух других команд.

**Почему это баг, а не решение.** Тесты проекта фиксируют `-nostdin` как обязательный для ffmpeg-команд; применён он к половине. Кроме того, `ensure_wav_16k` не имеет `-map 0:a:0 -vn -sn -dn -map_metadata -1`, которые есть у её близнеца `ensure_wav_16k_preserve_channels`, — два пути конверсии разошлись.

---

#### B-015 · `backend/transcribe.py:228` `release_model` и `:244` `release_idle_models` — idle-выгрузка и выселение при удалении не трогают GigaAM, хотя `model_is_resident` про него знает

**Суть.** `model_is_resident` (`:207`) отдельно обрабатывает `gigaam-`, заглядывая в `backend.transcribe_gigaam._MODEL_CACHE`. Обе освобождающие функции работают только с whisper-кэшем; в `transcribe_gigaam` вообще нет пути освобождения.

**Как наблюдать.** `main.py:329 start_idle_model_sweeper()` → `release_idle_models()` → цикл только по `backend.transcribe._MODEL_CACHE`. Выбрать `gigaam-v3-e2e-rnnt` (он в `LOCAL_TRANSCRIPTION_MODELS` → в `ALLOWED_LOCAL_MODELS`, `main.py:635`), транскрибировать один файл, подождать `_MODEL_IDLE_UNLOAD_SEC`: whisper-модели уходят, ~1 ГБ torch-модели остаётся до выхода из приложения.

**Последствие.** Заявленный контракт «сбросить любую модель, простаивавшую дольше окна» не выполняется ровно для самого тяжёлого движка — то есть именно для того сценария OOM, ради которого `_MODEL_IDLE_UNLOAD_SEC` вводился. Плюс два разных ответа на вопрос «резидентна ли модель»: `model_is_resident` говорит «да», освобождающие функции делают вид, что её нет.

**Серьёзность.** P1 (фича сделана наполовину; два расходящихся источника правды) · **подтверждено**.

Текущий код (`transcribe.py:256`):
```python
    with _MODEL_LOCK:
        for name in list(_MODEL_CACHE.keys()):
            ...
            _MODEL_CACHE.pop(name, None)
```

Исправление — точка освобождения в адаптере и диспетчеризация по тому же префиксу, что уже использует `model_is_resident`:
```python
# backend/transcribe_gigaam.py
def release_gigaam(model_id: str) -> bool:
    """Drop one GigaAM model from the resident cache."""
    with _MODEL_LOCKS_GUARD:
        return _MODEL_CACHE.pop(model_id, None) is not None
```
```python
# backend/transcribe.py
def release_model(model_name: str) -> bool:
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        module = sys.modules.get("backend.transcribe_gigaam")
        released = bool(module and module.release_gigaam(model_name))
        with _MODEL_LOCK:
            _MODEL_LAST_USED.pop(model_name, None)
            _MODEL_WARM_STATE.pop(model_name, None)
        if released:
            logger.info("gigaam model released on request: model=%s", model_name)
        return released
    ...
```
и в `release_idle_models` — старить gigaam-идентификаторы по тому же `_MODEL_LAST_USED` (для этого добавить `_touch_model(model_name)` в gigaam-ветку `transcribe_audio`, `transcribe.py:467`).

**Почему это баг, а не решение.** Докстринг `release_idle_models` говорит «Drop **every** cached model idle for longer than the unload window», а `model_is_resident` уже платит цену знания про gigaam-кэш. Это пропуск в одной тройке функций, а не политика.


---

#### B-016 · `backend/main.py:7261` `_save_recording_audio_source` — откат удаляет `out_text`, но не снимает `.claim`-маркер, и имя записи остаётся занятым навсегда

**Суть.** Новое имя резервируется `O_EXCL`-маркером `<stem>.txt.tmp-000000.claim` (`_claim_recording_text_path`, `:2678`), а снимается он только в `finally` внутри `_write_recording_text_file`. Если запись аудио падает **до** этого вызова, откат делает `_best_effort_unlink(out_text)` — по файлу, который ещё не создавался, — и маркер остаётся.

**Как наблюдать / воспроизвести.** `POST /api/recordings/save-with-audio` с телом больше `MAX_UPLOAD_BYTES`, или обрыв загрузки, или заполненный диск: `write_tmp_audio` (`:7235`) бросает → `except BaseException` (`:7249`) → `_best_effort_unlink(out_text)` — no-op → маркер жив.

**Последствие.** (1) Мусорный файл в пользовательской папке записей; подметается только при следующем старте и только если каталог уже зарегистрирован — а `_register_archive_dir` (`:7274`) вызывается **после** успешного сохранения, то есть архив, у которого были только неудачи, не подметается никогда. (2) Имя маркера детерминировано, поэтому повтор сохранения натыкается на `FileExistsError` (`:2687`), пропускает естественное имя и кладёт запись как `lecture__2026-09-04_19-40-…`; каждая следующая попытка уезжает дальше.

**Серьёзность.** P1 (UX-видимый дрейф имён + мусор, который нечем убрать) · **подтверждено**.

Текущий код:
```python
        if claimed_new_text:
            _best_effort_unlink(out_text, context="recording text save rollback")
```
Исправление:
```python
        if claimed_new_text:
            _best_effort_unlink(out_text, context="recording text save rollback")
            # The claim marker is what reserves the NAME; releasing only
            # the text file leaves the reservation standing, so the next
            # attempt at the same title is pushed to a timestamped name.
            _best_effort_unlink(
                _recording_text_claim_path(out_text),
                context="recording text claim rollback",
            )
```

**Почему это баг, а не решение.** Та же ветка отката аккуратно восстанавливает резервную копию аудио и удаляет `out_text` — намерение «откатить полностью» однозначно. Маркер просто забыли, потому что в `save_recording` (`:7127`) запись текста идёт сразу следом и `finally` всегда отрабатывает. Тесты `tests/test_recording_names.py:868-909` покрывают только успешный путь.

---

#### B-017 · `backend/main.py:823` `_TMP_ORPHAN_RE` против `backend/main.py:2725` `_atomic_temp_path` — подметальщик временных файлов не распознаёт имена, которые сам же модуль и создаёт

**Суть.** В проекте два способа называть временный файл. `storage._tmp_path_for` дописывает `.tmp-<hex>` в конец (всегда матчится). `_atomic_temp_path` **вставляет** его перед `"".join(final_path.suffixes)`, поэтому у любого имени с более чем одной точкой получается две группы расширений, а регулярка допускает только одну.

**Как наблюдать / воспроизвести.** Прогон регулярки против реальных выходов `_atomic_temp_path`:

```
'rec.tmp-aaaaaaaa.wav'                                              matched=True
'my.tmp-aaaaaaaa.file.wav'                                          matched=False
'2026-09-04__Recovered 2026-09-04T19_37_12.tmp-aaaaaaaa.123456.wav' matched=False
```

**Путь входа (детерминированный).** `_promote_live_recovery` (`main.py:1351`) строит `title = f"Recovered {started_at}"`, где `started_at` — `datetime.now().isoformat()`, всегда с микросекундами `.123456`. `_sanitize_name` точку сохраняет, значит `audio_out` = `<ts>__Recovered …_12.123456.wav`, а `_atomic_temp_path` даёт `….tmp-<hex>.123456.wav` — третья строка выше. Убить бэкенд во время `write_wav_from_pcm16_stream` (`:1361`) — а это происходит на старте приложения, когда Electron ещё может его перезапускать, — и частичный WAV размером до `MAX_RECOVERY_PROMOTE_BYTES` (4 ГБ) останется в папке записей навсегда. Загрузочный путь воспроизводится любым файлом вида `my.file.wav`.

**Последствие.** Неограниченный рост занятого места в пользовательской папке записей, без единого следа. Плюс файл виден пользователю среди его записей.

**Серьёзность.** P1 (ресурсы; два разошедшихся источника правды на одном соглашении) · **подтверждено (repro)**.

Текущий код (комментарий над которым утверждает обратное — «The optional trailing `.<ext>` catches the in-middle tmp pattern»):
```python
_TMP_ORPHAN_RE = re.compile(
    r"\.tmp-[0-9a-f]{6,}(?:\.[A-Za-z0-9]+)?$", re.IGNORECASE
)
```
Исправление:
```python
# ``_atomic_temp_path`` inserts the marker before EVERY suffix
# (`"".join(path.suffixes)`), so a name with more than one dot —
# "Recovered 2026-09-04T19_37_12.123456.wav", produced on every
# live-recovery promote — yields TWO extension groups. One optional
# group matched only single-suffix names and left the rest unswept.
_TMP_ORPHAN_RE = re.compile(
    r"\.tmp-[0-9a-f]{6,}(?:\.[A-Za-z0-9]+)*$", re.IGNORECASE
)
```

**Почему это баг, а не решение.** Докстринг `storage.py` (§4) объявляет форму временного имени неотчуждаемым инвариантом, «matching the convention `_sweep_orphan_tmp_files` expects». `_atomic_temp_path` — второй производитель этих имён, который инвариант тихо нарушает, а комментарий у регулярки утверждает, что случай учтён.

---

#### B-018 · `backend/config.py:901` `_load_config_unlocked` — `load_config()` переписывает `config.json` и ротирует `.bak` на **каждом** вызове, если версия схемы на диске не равна текущей

**Суть.** Ветка срабатывает по `original_schema_version != SCHEMA_VERSION`, но записывает `merged`, у которого `schema_version` пришёл из deep-merge с сырым файлом (3), а не `SCHEMA_VERSION` (2). Штамп — no-op, условие остаётся истинным навсегда.

**Как наблюдать / воспроизвести.** Мой запуск (`repro8.py`) с `config.json`, содержащим `"schema_version": 3`:

```
read #0: config.json rewritten = True   .bak exists = True
read #1: config.json rewritten = True   .bak exists = True
read #2: config.json rewritten = True   .bak exists = True
```

**Путь входа.** Сборка с более высокой `SCHEMA_VERSION` (или откат версии, или правка руками) → `_migrate_schema` (`:687`) возвращает без изменений → условие → `_rotate_backup_if_primary_valid()` + `_atomic_write_json` (≈4 `fsync` на каждый **чтение**). `load_config()` зовётся из `GET /api/config` (`main.py:6384`), `POST /api/upscale` (`:6150`), удалённой транскрипции (`:5618`), `_resolve_recordings_dir` (`:2517`) и live-пути (`:3782`); в `main.py:510-521` задокументированы ~120 запросов рендерера в минуту.

**Последствие.** (1) Непрерывная запись на диск при операциях чтения. (2) Хуже: `.bak` документирован (`config.py:773`) как «снимок предыдущего сохранения» и является единственным путём восстановления при порче `config.json`; ротация на каждом чтении затирает его за секунды — окно восстановления схлопывается в ноль. (3) Лог врёт: печатает `stamped with version=2`, записывая `3`.

**Серьёзность.** P1 (уничтожение единственной резервной копии конфига + постоянные fsync на пути чтения) · **подтверждено (repro)**.

Текущий код:
```python
        if original_schema_version != SCHEMA_VERSION and CONFIG_PATH.exists():
            try:
                _rotate_backup_if_primary_valid()
                _atomic_write_json(CONFIG_PATH, _encrypt_provider_keys(merged))
```
Исправление — штамповать только когда версию действительно можно поднять, и записывать то, что печатаем:
```python
        # Only a config OLDER than this build (or one with no version at
        # all) needs stamping. Comparing with != re-fired on every read
        # for a NEWER file, and since the written value came from the
        # merge (still 3) the condition never cleared — rotating .bak,
        # the only recovery copy, on every load_config().
        needs_stamp = CONFIG_PATH.exists() and (
            original_schema_version is None
            or original_schema_version < SCHEMA_VERSION
        )
        if needs_stamp:
            try:
                stamped = dict(merged)
                stamped["schema_version"] = SCHEMA_VERSION
                _rotate_backup_if_primary_valid()
                _atomic_write_json(CONFIG_PATH, _encrypt_provider_keys(stamped))
                merged["schema_version"] = SCHEMA_VERSION
```

**Почему это баг, а не решение.** Комментарий на месте (`:902-910`) говорит «write it back WITH the new field», а докстринг `load_config` (`:794-803`) обещает идемпотентность. Код делает противоположное обоим. Существующий тест `tests/test_config.py:184` проверяет только возвращаемый словарь и ни разу — что файл остался нетронутым.

---

#### B-019 · `backend/config.py:619` `_validate_config_shape` — `preferences.deepgram` валидируется, `preferences.openrouter` нет; один POST навсегда роняет Upscale и удалённую транскрипцию в 500

**Суть.** Валидатор чинит форму `preferences.deepgram` (`keyterms`, `dual_stream`, `dual_secondary_language`), но `preferences.openrouter` не проверяет. `main._validate_config_payload` (`:2264`) под `preferences` пропускает всё, кроме `recordings_dir`.

**Как наблюдать / воспроизвести.** Значение `preferences.openrouter = "oops"` сохраняется, после чего потребители (`main.py:6154`, `:6161`, `:5633`) падают:
```
CRASH at main.py:6154 pattern -> AttributeError 'str' object has no attribute 'get'
```

**Путь входа.** `POST /api/config {"preferences":{"openrouter":"oops"}}` (аутентифицированный loopback) → валидатор пропускает → `save_config` сохраняет → любой `POST /api/upscale` и любая удалённая транскрипция → HTTP 500. Значение **персистентное**: переживает перезапуск, пока пользователь не отредактирует файл руками.

**Последствие.** Кирпич на двух платных функциях, с непрозрачным 500 и без пути восстановления из UI.

**Серьёзность.** P1 (крах на нормальном пути после одного плохого значения; асимметрия с уже сделанной защитой) · **подтверждено (repro)**.

Исправление — симметричная починка формы рядом с `deepgram`-блоком:
```python
        or_prefs = preferences.get("openrouter")
        if or_prefs is not None and not isinstance(or_prefs, dict):
            logger.warning("config.preferences.openrouter must be an object; resetting")
            preferences = dict(preferences)
            preferences["openrouter"] = dict(DEFAULT_CONFIG["preferences"]["openrouter"])
            out["preferences"] = preferences
        elif isinstance(or_prefs, dict) and not isinstance(or_prefs.get("model"), (str, type(None))):
            logger.warning("config.preferences.openrouter.model must be a string; resetting")
            preferences = dict(preferences)
            preferences["openrouter"] = {
                **or_prefs, "model": DEFAULT_CONFIG["preferences"]["openrouter"]["model"],
            }
            out["preferences"] = preferences
```

**Почему это баг, а не решение.** Докстринг модуля (`config.py:783`) прямо обещает: «a missing `preferences.openrouter` branch shouldn't crash a caller that reads `cfg["preferences"]["openrouter"]["model"]`». Для `deepgram` это сделано, для `openrouter` — нет; пропуск, а не выбор.

---

#### B-020 · `backend/config.py:113` `_read_existing_keyfile` + `:203` (ветка `FileExistsError`) — нулевой `.encryption_key` навсегда ломает хранение секретов, без самовосстановления

**Суть.** `_KEYFILE.exists()` истинно → `_read_existing_keyfile` возвращает `b""` (охранник `if raw:` означает, что **пустой файл не логируется вообще**) → падение в ветку генерации → `os.open(..., O_EXCL)` → `FileExistsError` → перечитывание → снова `b""` → `_FERNET` остаётся `None` на всю жизнь процесса и точно так же на каждой следующей загрузке.

**Как наблюдать / воспроизвести.** `: > .encryption_key`, затем импорт `backend.config`:
```
ERROR encryption keyfile appeared during creation but is not usable … REFUSING to use a session-only key.
FERNET = None
save_config raised: RuntimeError encryption key unavailable; refusing to store secret as plaintext
keyfile size after = 0
```

**Последствие.** Любой `POST /api/config` с ключом провайдера отдаёт 503 (`main.py:6404-6413`); все существующие значения `enc:` расшифровываются в `""`. Пользователь не может ввести ключ ни разу — приложение бесполезно, а сообщение говорит про «encryption key unavailable», не подсказывая, что чинить.

**Серьёзность.** P1 (необратимое без ручного вмешательства состояние; UX-ошибка, по которой пользователь не может действовать) · **подтверждено (repro)**.

Исправление — трактовать пустой keyfile как отсутствующий:
```python
    if _KEYFILE.exists():
        raw = _read_existing_keyfile()
        if raw:
            return raw
        # A 0-byte keyfile protects nothing, so the "never overwrite an
        # existing keyfile" rule has nothing to protect here — and
        # refusing to replace it guarantees permanent breakage instead.
        # main._load_or_create_api_token regenerates an empty token file
        # for exactly this reason.
        try:
            if _KEYFILE.stat().st_size == 0:
                logger.warning(
                    "encryption keyfile at %s is empty (0 bytes); replacing it "
                    "with a fresh key", _KEYFILE,
                )
                _KEYFILE.unlink()
        except OSError as e:
            logger.error("could not clear the empty keyfile at %s: %s", _KEYFILE, e)
```
(и та же проверка `st_size == 0` внутри ветки `FileExistsError`, прежде чем сдаваться.)

**Почему это баг, а не решение.** Правило «никогда не перезаписывать существующий keyfile» (`:156-168`, `:203-215`) правильно для файла **с содержимым**. Для нулевого файла оно охраняет пустоту. `main._load_or_create_api_token` (`:768-805`) для точно такой же ситуации перегенерирует файл — то есть в проекте уже принято обратное решение, и здесь просто не учтён этот случай.

---

#### B-021 · `backend/config.py:95` — `DATA_DIR.mkdir(...)` на уровне модуля; `import backend.config` роняет процесс, если каталог нельзя создать

**Суть.** `mkdir` выполняется при импорте. `backend/main.py:75` импортирует `backend.config` на уровне модуля, поэтому uvicorn не стартует вовсе.

**Как наблюдать / воспроизвести.**
```
$ TRANSCRIPTOR_DATA_DIR=/System/no-such-dir/T python -c 'import backend.config'
PermissionError: [Errno 1] Operation not permitted: '/System/no-such-dir'
```

**Последствие.** Electron видит мгновенный выход дочернего процесса, повторяет запуск восемь раз и показывает обобщённое «backend did not start» — без единого намёка, что причина в одной переменной окружения. Срабатывает и без переменной: на read-only домашнем каталоге или при отказе песочницы.

**Серьёзность.** P1 (краш при старте на конфигурируемом и задокументированном пути) · **подтверждено (repro)**.

Исправление — та же политика, что уже принята в двух других местах проекта:
```python
def _resolve_data_dir() -> Path:
    """Resolve DATA_DIR, degrading to a fallback instead of killing boot.

    ``backend.deepgram_endpoints`` and ``backend.main._env_int`` both
    establish the house policy for bad env input: warn and use a
    documented default so the app boots and the misconfiguration is
    visible in the log. Raising here killed the process before uvicorn
    started, so Electron only ever saw "backend did not start".
    """
    candidate = _default_data_dir()
    try:
        candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        return candidate
    except OSError as e:
        fallback = Path.home() / ".transcriptor"
        logger.error("data dir %s is unusable (%s); falling back to %s", candidate, e, fallback)
        fallback.mkdir(parents=True, exist_ok=True, mode=0o700)
        return fallback


DATA_DIR = _resolve_data_dir()
```

**Почему это баг, а не решение.** `deepgram_endpoints.py:36-44` содержит написанный именно по этому поводу текст: «Raising here (the previous behaviour) killed the backend process before uvicorn ever started … Match it [the house policy]». `TRANSCRIPTOR_DATA_DIR` — задокументированная пользовательская настройка (`.env.example:6`) и единственная, которая этой политике не следует.


---

#### B-022 · `requirements.txt` — `huggingface_hub` импортируется бэкендом напрямую, но нигде не объявлен как прямая зависимость

**Суть.** Импортируется в `backend/models_manager.py:88, 89, 179, 240, 258` и `backend/main.py:1550` (`try_to_load_from_cache`, `scan_cache_dir`, `HfApi`, `hf_hub_download`, `list_repo_files`, `huggingface_hub.utils.*`). В `requirements.txt` его нет; `requirements.runtime-lock.txt` пиннит `huggingface_hub==1.8.0` как **транзитивную**.

**Как наблюдать.** `grep -rn "huggingface_hub" backend requirements*.txt`. Реальные метаданные установленного `faster_whisper-1.0.3.dist-info/METADATA` дают `Requires-Dist: huggingface-hub >=0.13` — нижняя граница без верхней.

**Последствие.** На любой не-локированной установке (`pip install -r requirements.txt`) резолвер вправе поставить hub 2.x; ничего в проекте это не ограничивает, и список/удаление/скачивание локальных моделей сломается без объявленного контракта, который мог бы это предотвратить.

**Серьёзность.** P1 (SSOT зависимостей нарушен; supply-chain) · **подтверждено** (текущий рантайм при этом исправен — все шесть символов резолвятся под 1.8.0).

Исправление — в `requirements.txt`:
```
# Imported directly by backend/models_manager.py (cache scan, repo info,
# download) and backend/main.py (offline error taxonomy). It arrives
# transitively through faster-whisper, but that bound is ">=0.13" with no
# upper limit, so declare and cap it here.
huggingface_hub>=0.23,<2
```

**Почему это баг, а не решение.** `requirements.runtime-lock.txt:1-9` формулирует собственную политику: «Keep requirements.txt as the direct dependency SSOT. This file pins transitive dependencies…». Пакет, из которого импортируют шесть символов, транзитивным не является — это нарушение записанного правила.

---

#### B-023 · `.env.example:2` и `README.md:127` — описан механизм `.env`, которого в проекте не существует

**Суть.** Файл начинается с «Copy to .env and customize only the values you need», README предлагает `cp .env.example .env`. Ничего в проекте `.env` не читает.

**Как наблюдать.** `grep -rn "dotenv\|load_dotenv" backend requirements*.txt desktop/main.js` — **пусто**. `python-dotenv` отсутствует в обоих requirements-файлах; `desktop/main.js` читает только `process.env`; единственный `dotenv` в дереве принадлежит electron-builder и загружает исключительно `electron-builder.env`.

**Последствие.** Пользователь, следующий README, получает нулевой эффект от всех 43 переменных — молча. Все документированные настройки (регион Deepgram, окна ретенции, лимиты Whisper) выглядят работающими и не работают.

**Серьёзность.** P1 (документация противоречит коду; настройка, которую пользователь не может применить и не может продиагностировать) · **подтверждено**.

Исправление — минимальное (сказать правду):
```
# Transcriptor — user-facing environment variables
# Reference only. Nothing in the app reads a .env file: export these in
# the shell, launch agent or CI job that starts the app.
```
или полное — подключить загрузку: `python-dotenv` в `requirements.txt` + `load_dotenv()` в `backend/main.py` до блока `_env_int`, и `require("dotenv").config()` в `desktop/main.js`. Первое честнее, второе — то, что обещано.

**Почему это баг, а не решение.** AGENTS.md §4 объявляет `.env.example` источником правды по переменным окружения релиза. Источник правды, который описывает несуществующий механизм, — расхождение доков и кода, а не соглашение.

---

#### B-024 · `backend/tests/test_deepgram_finalize_flush.py:55, 80, 98` `FinalizeFlushOrderingTests` — три теста патчат константу, которую их путь не читает, поэтому не могут упасть

**Суть.** Общий хелпер `_session()` (`:45-51`) не задаёт ни `stats.bytes_sent`, ни финализированных сегментов. Значит `_tail_coverage()` = `(0,0,0,0)` → `_tail_needs_flush` = `False` → `tail_gap (0.0) <= COVERAGE_GAP_MIN_SEC (0.25)` → выбирается **`FINALIZE_EMPTY_TAIL_WAIT_SEC` = 0.25 с**. Все три теста при этом патчат `FINALIZE_FLUSH_WAIT_SEC`.

**Как наблюдать / воспроизвести.** `repro7.py` на реальном классе:
```
the _session() harness in test_deepgram_finalize_flush.py: streamed=0.0 covered=0.0 gap=0.0 speech=0.0
needs_flush = False -> branch chosen: FINALIZE_EMPTY_TAIL_WAIT_SEC (0.25 s)
=> patching FINALIZE_FLUSH_WAIT_SEC to 5.0 / 0.15 changes nothing on this path
```

**Последствие.** `test_wait_short_circuits_when_the_transcript_lands_early` утверждает `elapsed < 1.0` при реальном бюджете 0.25 с — условие выполняется независимо от того, работает ли короткое замыкание. `test_silent_upstream_still_closes_within_the_ceiling` требует `elapsed >= 0.15` при реальных 0.25. Регрессия, из-за которой `finalize()` всегда досиживал бы полный потолок, прошла бы зелёной. Это те самые тесты, которые прикрывают задержку стопа — главный симптом, вокруг которого построены три последних релиза.

**Серьёзность.** P1 (тест утверждает, что защищает поведение, которое не исполняет) · **подтверждено (repro)**.

Текущий код (`:80`):
```python
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 1.0, ...)
```
Исправление — привести харнесс к форме, которая действительно читает патчимую константу (непокрытый хвост), и мерить механизм, а не секундомер:
```python
    async def test_wait_short_circuits_when_the_transcript_lands_early(self):
        """A prompt Deepgram must not be made to pay the full ceiling."""
        # Only an UNCOVERED tail reads FINALIZE_FLUSH_WAIT_SEC; the bare
        # harness picks FINALIZE_EMPTY_TAIL_WAIT_SEC (0.25 s), which is
        # why patching the ceiling used to change nothing.
        session = _session()
        session.stats.bytes_sent = int(11.0 * 2 * session._cfg.sample_rate)
        session._finalized_segments = [{"start": 0.0, "end": 10.0, "text": "x"}]
        session._interim_speech_spans = [(10.0, 11.0)]   # real speech in the tail

        async def deliver_covering_final():
            await asyncio.sleep(0.02)
            session._finalized_segments.append(
                {"start": 10.0, "end": 11.0, "text": "tail", "speech_final": True}
            )
            session._final_arrived.set()

        started = time.perf_counter()
        task = asyncio.create_task(deliver_covering_final())
        with mock.patch("backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0):
            await session.finalize(wait_timeout=6.0)
        await task
        self.assertLess(time.perf_counter() - started, 1.0)
```

**Почему это баг, а не решение.** Докстринги тестов формулируют намерение прямым текстом («must not be made to pay the full ceiling»), а механизм его не проверяет. Харнесс устарел вместе с переходом от «одного потолка» к трёхветочному выбору бюджета — тест за этим переходом не пошёл.

---

#### B-025 · `desktop/main.js:8582` и `desktop/main.js:7454` — главный процесс читает `config.json` напрямую, в обход миграции, валидации и восстановления из `.bak`

*(Файл вне периметра секции, но это вторая сторона контракта, который объявляет бэкенд, поэтому фиксируется здесь.)*

**Суть.** Оба места делают `JSON.parse(fs.readFileSync(path.join(dataDir, "config.json")))` и читают `raw.preferences.ui.shortcut_*` / `raw.preferences.recordings_dir` напрямую. `backend/config.py:31-34` декларирует ИНКАПСУЛЯЦИЮ как гарантию SSOT: «Callers never see the raw disk format; they see the decrypted, migrated, validated structure only».

**Как наблюдать.** Ровно те два случая восстановления, которые `load_config` документирует у себя: **испорченный `config.json` при живом `.bak`** — бэкенд восстанавливает настройки (`config.py:835-843`), а `catch` в `main.js` проваливается в `shortcutDefaultsForPlatform()`, и глобальные хоткеи пользователя молча возвращаются к платформенным умолчаниям, пока Settings показывает настроенные. **Отсутствующий `config.json` при живом `.bak`** — случай, который `config.py:805-819` называет «divergent-reader guard» и чинит внутри бэкенда; в `main.js` эквивалента нет.

**Последствие.** Хоткей записи перестаёт совпадать с тем, что показано в настройках, — при этом всё выглядит работающим.

**Серьёзность.** P1 (два читателя одного файла с разными правилами; UX-расхождение) · **подтверждено**.

Исправление — после подъёма бэкенда перерегистрировать хоткеи из `GET /api/config`, а сырое чтение оставить только как до-бэкендный бутстрап и с явным фолбэком на `.bak`:
```js
const cfgPath = path.join(dataDir, "config.json");
let raw = null;
for (const p of [cfgPath, `${cfgPath}.bak`]) {
  try { if (fs.existsSync(p)) { raw = JSON.parse(fs.readFileSync(p, "utf8")); break; } }
  catch (e) { appendMainLog(`[shortcuts] unreadable ${p}: ${e?.message || e}`); }
}
```

**Почему это баг, а не решение.** Инкапсуляция названа гарантией в докстринге модуля конфигурации; второй читатель, обходящий её, — нарушение объявленного контракта, а не осознанное дублирование.


---

### P2

Формат тот же, изложение плотнее. Все места перечислены; исправления — реальный код.

#### SSOT: одна константа / правило / список в двух местах

**B-026 · `backend/main.py:4379, 4787, 5258, 5316` — `2 * LIVE_SAMPLE_RATE_HZ` написано четыре раза при существующей `LIVE_PCM_BYTES_PER_SEC`.**
Суть: `backend/audio_constants.py:28` заводит `LIVE_PCM_BYTES_PER_SEC` с докстрингом «the bytes/sec value (16000 × 2 = 32000) … appeared at four different sites in `main.py` alone»; константа импортирована (`main.py:45`) и использована ровно один раз (`:1166`), а выражение вернулось на прежние четыре места (плюс пятое — `remote_deepgram_live.py:2338`, где оно записано как `2 * max(1, int(self._cfg.sample_rate))`). Наблюдать: `grep -n "2 \* LIVE_SAMPLE_RATE_HZ" backend/main.py`. Последствие: изменение частоты дискретизации потребует пяти согласованных правок вместо одной — ровно тот сценарий, который модуль констант объявил недопустимым. Серьёзность: P2 · **подтверждено**.
Исправление: `_WARM_REPLAY_MAX_BYTES = 8 * LIVE_PCM_BYTES_PER_SEC`; `offset_sec = warm_replay_dropped / float(LIVE_PCM_BYTES_PER_SEC)`; два оставшихся — через `session.streamed_seconds()` (см. B-010). Почему баг: докстринг `audio_constants.py` прямо запрещает эту форму.

**B-027 · `backend/config.py:512-513` × `backend/deepgram_dual.py:85, 91` × `frontend/src/deepgram-dual.ts:24-25` — дефолты dual-stream живут в трёх местах.**
Суть: `dual_stream = True` и `dual_secondary_language = "ru"` записаны трижды, при том что `deepgram_dual.py:88-91` утверждает «it is read from ONE place». Наблюдать: три файла выше. Последствие: копия во фронтенде опаснее прочих — `frontend/src/deepgram-dual.ts:13-18` объясняет, что неверный дефолт «отсутствия» **сохраняется** следующим автосейвом, то есть расхождение молча выключает фичу на диске. Серьёзность: P2 · **подтверждено**.
Исправление — один владелец, публикуемый через уже существующий механизм каталога (`health_model_catalog` → бутстрап → `/api/health`), которым уже ходят все остальные дефолты:
```python
# backend/main.py, внутри _frontend_runtime_payload()
        "preference_defaults": {
            "remote_provider": DEFAULT_CONFIG["preferences"]["remote_provider"],
            "deepgram": dict(DEFAULT_CONFIG["preferences"]["deepgram"]),
        },
```
и `config.py` берёт значения из листового модуля (`deepgram_dual` импортировать нельзя — он тянет `remote_deepgram_live`), а рендерер читает `bootstrap.preference_defaults` вместо литералов. Почему баг: комментарий утверждает единственность источника, код её не даёт.

**B-028 · `backend/config.py:492` × `backend/main.py:5626` × `backend/model_catalog.py:74` — `"openrouter"` как дефолтный провайдер написан трижды.**
Суть: строкой в дефолтах конфига, строкой в `or "openrouter"` и как `REMOTE_TRANSCRIPTION_PROVIDERS[0]`. Наблюдать: соседняя строка `config.py:495` в том же словаре делает правильно — импортирует `DEFAULT_OPENROUTER_AUDIO_MODEL`. Последствие: смена дефолтного провайдера требует трёх правок. Серьёзность: P2 · **подтверждено**. Исправление: `"remote_provider": REMOTE_TRANSCRIPTION_PROVIDERS[0]` в `config.py`, `or DEFAULT_CONFIG["preferences"]["remote_provider"]` в `main.py:5626`. Почему баг: соседняя строка того же словаря показывает принятую в файле форму.

**B-029 · `.env.example` — четыре переменные бэкенда читаются кодом и не документированы, при том что файл объявляет свой список исключений полным.**
Суть и наблюдение: автоматическая сверка множеств (извлечение `TRANSCRIPTOR_*` из `backend/**` и из `.env.example`, `comm -23`) даёт: `TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT` (`deepgram_format.py:85`), `TRANSCRIPTOR_DEEPGRAM_PUNCTUATE` (`:90`), `TRANSCRIPTOR_DEEPGRAM_FILLER_WORDS` (`:95`), `TRANSCRIPTOR_GIGAAM_CACHE_SIZE` (`transcribe_gigaam.py:62`). Обратная сверка: документированных-но-нечитаемых нет. `.env.example:151` перечисляет «internal variables intentionally not documented» — этих четырёх там тоже нет. Последствие: `deepgram_format.py:43` явно предлагает `TRANSCRIPTOR_DEEPGRAM_SMART_FORMAT=0` как способ изменить поведение обоих путей Deepgram — способ, которого пользователь не найдёт. Серьёзность: P2 · **подтверждено**. Исправление: четыре блока в `.env.example` с дефолтами и допустимыми значениями. Почему баг: AGENTS.md §4 объявляет `.env.example` источником правды по переменным окружения.

**B-030 · `backend/main.py:665` `UPSCALE_PRESETS` × `:692` `BUILTIN_UPSCALE_PRESETS` — список встроенных пресетов записан дважды.**
Суть: `UPSCALE_PRESETS = {"clean", "business", "ai_code", "refine"}` и словарь с теми же четырьмя ключами. Первый используется ровно один раз — `main.py:6145`, валидация легаси-поля `preset`. Последствие: добавление пятого встроенного пресета даст легаси-клиентам `400 unsupported upscale preset` на пресет, который существует. Серьёзность: P2 · **подтверждено**. Исправление: `UPSCALE_PRESETS = frozenset(BUILTIN_UPSCALE_PRESETS)`. Почему баг: один список, две записи, ноль связи между ними.

**B-031 · `backend/main.py:7109` (`save_recording`) × `:7172` (`_save_recording_audio_source`) — правило «[No speech captured]» продублировано и уже разошлось.**
Текущий код:
```python
    if not source_text and not transcript_text:                    # :7109
        source_text = "[No speech captured]"
    if (not safe_source_text and not safe_transcript_text          # :7172
            and safe_provider.lower() != "none"):
        safe_source_text = "[No speech captured]"
```
Последствие: одно и то же пустое распознавание даёт разный файл в зависимости от того, каким эндпоинтом воспользовался рендерер. Серьёзность: P2 · **подтверждено**. Исправление:
```python
def _placeholder_source_text(source_text: str, transcript_text: str, provider: str) -> str:
    """The ONE rule for what an empty recognition writes to the file."""
    if source_text or transcript_text or provider.strip().lower() == "none":
        return source_text
    return "[No speech captured]"
```
Почему баг: расхождение по `provider != "none"` показывает, что правило правили в одном месте из двух.

**B-032 · `backend/main.py:1356` (`_promote_live_recovery`) × `:7125`/`:7194` (эндпоинты сохранения) — два разных механизма «выбрать свободное имя», один из них TOCTOU.**
Суть: промоут использует `_unique_recording_stem` (проверил-и-использовал), сохранение — `O_EXCL`-claim. Последствие: промоут, идущий одновременно с сохранением в тот же каталог, может выбрать то же имя и перезаписать чужие `.txt`/`.wav`. Серьёзность: P2 · **подтверждено** как два пути для одного решения; сама гонка — **гипотеза** (нужен одновременный вызов). Исправление:
```python
            stem, text_out = _claim_recording_text_path(
                target_dir, _recording_stem_candidates(title)
            )
            audio_out = target_dir / f"{stem}.wav"
```
(с освобождением claim на откате, см. B-016). Почему баг: примитив резервирования уже написан и применён на соседнем пути.

**B-033 · `backend/deepgram_dual.py:70-76` — модуль импортирует пять приватных имён другого модуля.**
Суть: `_segment_words`, `_time_overlap`, `_token_stem`, `_word_core`, `_word_duration` из `backend.remote_deepgram_live`; ни одно из них не входит в его `__all__` (`remote_deepgram_live.py:3283-3303`). Последствие: подчёркивание объявляет их непубличными, значит рефакторинг `remote_deepgram_live` вправе их менять — и молча сломает слияние двух чтений. Серьёзность: P2 · **подтверждено**. Исправление: повысить эти пять до публичного API (`word_core`, `word_duration`, `time_overlap`, `token_stem`, `segment_words`) и добавить в `__all__` рядом с уже вынесенными туда `covering_final_word` / `union_spans`; в `deepgram_dual` импортировать публичные имена. Почему баг: комментарий над импортом («deliberate reuse») объясняет мотив, но не снимает противоречие между «reuse» и «private»; правильный ответ на «этим пользуется второй модуль» — сделать имя публичным.

**B-034 · `backend/transcribe_gigaam.py:127, 236, 254, 255` — частота 16000 захардкожена четыре раза.**
Суть: `sf.write(..., 16000, ...)`, `total_sec = len(audio) / 16000.0`, `lo = int(start * 16000)`, `hi = int(end * 16000)`. Модуль не импортирует `LIVE_SAMPLE_RATE_HZ`, хотя его вызывающий (`transcribe.py:558`) валидирует вход именно против этой константы. Последствие: две половины одного контракта читают из разных источников; смена частоты оставит движок писать WAV с неверным рейтом и считать неверные смещения чанков — тот самый молчаливый отказ, ради которого создан `audio_constants.py`. Серьёзность: P2 · **подтверждено**. Исправление: `from backend.audio_constants import LIVE_SAMPLE_RATE_HZ` и подстановка во все четыре места. Почему баг: докстринг `audio_constants.py` называет такую дубликацию причиной своего существования.

**B-035 · `backend/models_manager.py:110, 164, 301` — префикс движка захардкожен трижды, а импортированный `GIGAAM_MODELS` не используется.**
Суть: `model_catalog.py:45` определяет `GIGAAM_MODEL_PREFIX = "gigaam-"`, `transcribe.py`/`transcribe_gigaam.py` диспетчеризуют по нему; здесь трижды написан литерал, зато импортирован (`:23`) неиспользуемый `GIGAAM_MODELS`. Серьёзность: P2 · **подтверждено**. Исправление: `from backend.model_catalog import GIGAAM_MODEL_PREFIX, WHISPER_LOCAL_MODELS`, затем `model_id.startswith(GIGAAM_MODEL_PREFIX)` во всех трёх местах. Почему баг: константа заведена ровно для этого и используется двумя другими модулями.

**B-036 · `backend/transcribe.py:521` × `:555` — порог «слишком мало байт для декодирования» — голое `64` в двух местах, и модель грузится до проверки.**
Суть: `os.path.getsize(...) <= 64` в `transcribe_file` и тот же литерал в `_transcribe_file_gigaam`. В `transcribe_file` проверка стоит **после** `_model(model_name)` (`:520`). Последствие: WAV в 12 байт всё равно оплачивает загрузку модели (до 3 ГБ, несколько секунд), чтобы вернуть пустой результат. Серьёзность: P2 · **подтверждено**. Исправление: `_MIN_DECODABLE_WAV_BYTES = 64` на уровне модуля и перенос проверки выше вызова `_model(...)`. Сопутствующее расхождение в том же файле: пустой результат считает реальную длительность в `transcribe_audio` (`:493`) и жёстко `0.0` в `transcribe_file` (`:535`) и `_transcribe_file_gigaam` (`:556`), хотя `os.path.getsize(path) / (LIVE_SAMPLE_RATE_HZ * 2)` доступен и там. Почему баг: одно правило, два безымянных литерала.

**B-037 · `backend/audio.py:456, 532` — таймаут конверсии 300 с продублирован литералом, и локальные конверсии не принимают `cancel_event`.**
Суть: рядом заведена именованная `_REMOTE_COMPACT_TIMEOUT_SEC = 1800` (`:39`), а `_run_ffmpeg(cmd, timeout_sec=300, ...)` написан числом дважды; `ensure_wav_16k` / `ensure_wav_16k_preserve_channels` не пробрасывают `cancel_event`, который `_run_ffmpeg` уже поддерживает (`:130`). Последствие: отмена локального задания (`main.py:_raise_if_cancelled`) оставляет ffmpeg жечь CPU до пяти минут. Серьёзность: P2 · **подтверждено**. Исправление: `_LOCAL_CONVERT_TIMEOUT_SEC = 300` рядом с удалённой константой + `cancel_event: Optional[threading.Event] = None` в обеих сигнатурах с пробросом в `_run_ffmpeg`. Почему баг: механизм отмены уже реализован и подключён только к половине путей.

**B-038 · `backend/main.py:5210` (Deepgram) × `backend/main.py:4262` (локальный) — у одного wire-типа `final` две несовместимые формы.**
Суть: Deepgram-конверт несёт `stats`, `uncoveredSpeechSec`, `streamedSec`, `coveredEndSec`; локальный — `complete`, `coveredSec`, `totalSec`, `droppedSec`, `uncoveredTailSec` и ни одного из первых. Плюс третья форма — ветка ошибки Deepgram (`:5250`), где нет ни `uncoveredSpeechSec`, ни `stats`. Последствие: рендерер обязан ветвиться по `source`, а контракт `{"type":"final"}`, описанный в докстринге `ws_transcribe`, не описывает ни одну из трёх форм полностью. Серьёзность: P2 · **подтверждено**. Исправление: свести к одному словарю покрытия — `"coverage": {"streamedSec": …, "coveredEndSec": …, "uncoveredSpeechSec": …, "complete": bool}` — заполняемому обоими провайдерами, и на ветке ошибки тоже. Почему баг: докстринг эндпоинта декларирует один протокол; реализовано три.

**B-039 · `backend/remote_deepgram.py:191-194` × `backend/remote_deepgram_live.py:878` `resolve_live_language` — «auto» решается двумя способами.**
Суть: REST при `language in ("auto","")` шлёт `detect_language=true`, live — `language=multi`. Наблюдать: обе строки. Последствие: REST-путь используется как «полное прочтение» при recovery и как фолбэк после провала live; при этом он читает аудио в другом режиме распознавания, чем стрим, — а именно про режим `multi` в §1 аудита измерено, что он теряет русские клаузы. Пользователь получает два разных прочтения одной записи и не знает, какое ему показали. Серьёзность: P2 · **подтверждено** (расхождение); влияние на качество — **гипотеза** (не измерено на этой паре). Исправление: вынести решение в один предикат, который знает про оба эндпоинта:
```python
# backend/deepgram_language.py
def rest_language_params(language: str) -> dict[str, str]:
    """What 'auto' means on the PRERECORDED endpoint.

    The live endpoint has no detect_language and uses language=multi
    (``resolve_live_language``). Keeping the two answers in one module is
    what stops "auto" from meaning two different recognitions of the same
    recording depending on which path served it.
    """
```
Почему баг: комментарий у `resolve_live_language` объявляет его единственным местом, где «auto» превращается в значение Deepgram, — но охватывает только live-путь.

**B-040 · `backend/tests/test_live.py:638` — продакшн-константа переписана литералом.**
`self.assertGreaterEqual(elapsed, 0.24)` — это `main._FINALIZE_DRAIN_CEILING_SEC = 0.25` (`main.py:4300`, используется на `:4997`). Последствие: понижение константы даст ложное падение, повышение — тест перестанет что-либо фиксировать. Серьёзность: P2 · **подтверждено**. Исправление: `self.assertGreaterEqual(elapsed, main._FINALIZE_DRAIN_CEILING_SEC - 0.01)`. Почему баг: тест обязан читать значение, а не помнить его.

**B-041 · `backend/tools/deepgram_live_ab.py:154` — второе место конструирования `DeepgramLiveConfig`.**
Суть: инструмент строит конфиг напрямую, минуя `main._live_config`, чей докстринг говорит «the ONE place backend.main constructs one» и объясняет, что иначе ключ тёплого пула разойдётся. Формально ограничение сформулировано про `backend.main`, но инструмент ходит через тот же `DeepgramWarmPool.acquire`. Последствие: если у `_live_config` появится ещё одно поле, A/B перестанет измерять то, что приложение реально отправляет. Серьёзность: P2 · **подтверждено**. Исправление: вынести `_live_config` из `main` в `backend/deepgram_session.py` и звать из обоих мест. Почему баг: инструмент существует, чтобы воспроизводить продакшн-поведение; конфиг — часть этого поведения. *(В остальном инструмент образцовый: все решения импортируются, а не переписываются, — см. §7.)*


#### Ошибки: проглоченные, превращённые в успех, необслуживаемые

**B-042 · `backend/remote_openrouter.py:246` `openrouter_upscale_text` — не-строковый `content` уходит нетипизированным 500.**
Суть: соседняя `openrouter_transcribe` (`:180`) защитно приводит `raw_content` через `str(...)`, здесь же сразу `.strip()`, а `AttributeError` не входит в `except (KeyError, IndexError, TypeError)`. Наблюдать: модель, вернувшая мультимодальную форму `content: [{"type":"text",...}]` → `list.strip()` → `AttributeError` проходит мимо `main.py:6184` и `:6191` → generic 500 без санитайзинга `_safe_error_text`. Последствие: upscale, который мог бы уйти на следующую модель из списка фолбэков, умирает непрозрачно. Серьёзность: P2 · путь **подтверждён**, срабатывание — **гипотеза** (зависит от формы ответа модели). Исправление:
```python
    try:
        raw_content = js["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as shape_err:
        raise RemoteError(
            f"openrouter upscale: unexpected response shape ({shape_err}): {str(js)[:200]}"
        ) from shape_err
    if raw_content is None:
        raise RemoteError("openrouter upscale returned no content")
    out_text = (raw_content if isinstance(raw_content, str) else str(raw_content)).strip()
```
Почему баг: тот же класс дефекта, про который комментарий на `:248` утверждает, что он исправлен (BUG-66) — но исправлен только в соседней функции. Заодно `raise` на `:250` теряет цепочку (`from shape_err` отсутствует).

**B-043 · `backend/models_manager.py:89-92` `whisper_downloaded` — два неиспользуемых импорта внутри `try`, который любую ошибку превращает в «модель не скачана».**
Текущий код:
```python
        from huggingface_hub.utils import (
            EntryNotFoundError,        # нигде не используется
            RepositoryNotFoundError,   # нигде не используется
        )
        result = try_to_load_from_cache(repo_id=repo, filename="model.bin")
        return isinstance(result, str)
    except Exception as e:
        return False
```
Последствие: если будущая версия `huggingface_hub` перенесёт любой из двух символов, `ImportError` будет проглочен и **все** whisper-модели навсегда отрапортуют `downloaded: false` — UI предложит перекачать уже лежащие на диске гигабайты. Единственный след — `logger.debug`. Серьёзность: P2 · **подтверждено** (мёртвый код с живым режимом отказа). Исправление: убрать оба импорта, отделить `except ImportError` с `logger.warning`. Почему баг: импорты ничего не ловят и ничего не значат — их оставили от предыдущей редакции, а широкий `except` превратил это в отложенную мину.

**B-044 · `backend/transcribe_gigaam.py:62` `_GIGAAM_CACHE_MAX` — необёрнутый `int()` над переменной окружения.**
`max(1, int(os.environ.get("TRANSCRIPTOR_GIGAAM_CACHE_SIZE", "1")))` бросает `ValueError` при импорте, тогда как `transcribe.py:51 _env_int` — принятая в пакете политика («предупредить и взять документированный дефолт») для четырёх whisper-аналогов. Импорт ленивый (`transcribe.py:327/468/563`), поэтому ломается не загрузка, а транскрипция — с сообщением про `ValueError`, а не про конфигурацию. Серьёзность: P2 · **подтверждено** (расхождение с политикой), срабатывание — **гипотеза** (нужна заданная переменная). Исправление: `_GIGAAM_CACHE_MAX = max(1, _env_int("TRANSCRIPTOR_GIGAAM_CACHE_SIZE", 1))`. Почему баг: `main.py:600-609` описывает эту политику как обязательную для всего проекта.

**B-045 · `backend/models_manager.py:331-337` `start_download` — провал `thread.start()` заклинивает модель в состоянии `"downloading"` навсегда.**
Состояние захватывается под `_lock` (`:324-330`) **до** создания потока. Если `Thread.start()` бросит (`RuntimeError: can't start new thread`), воркер никогда не запустится и не снимет состояние, а `delete_model` (`:169`) отказывается удалять модель со статусом `"downloading"` — модель становится и нескачиваемой, и неудаляемой до перезапуска. Серьёзность: P2 · **подтверждено** (заклинивание), триггер — **гипотеза**. Исправление:
```python
    try:
        thread.start()
    except Exception as e:
        _set_state(model_id, status="error", progress=0.0, error=f"{type(e).__name__}: {e}")
        raise
```
Почему баг: атомарный захват состояния (BUG-63) сделан аккуратно, а его освобождение на единственном пути отказа — нет.

**B-046 · `backend/jobs.py:120` `JobRunner.submit` — `Future` отбрасывается, поэтому всё, что вышло за обработчики воркера, исчезает.**
`self._pool.submit(fn, *args, **kwargs)` без сохранения результата: `ThreadPoolExecutor` кладёт исключение в `Future`, а `Future` выброшен — ни лога, ни завершения задания. Задание остаётся `"running"` навсегда, рендерер опрашивает его вечно. Оба воркера в `main.py` ловят широко, но не `BaseException` и не отказ внутри собственного `finally`. Серьёзность: P2 · **подтверждено** (дыра в наблюдаемости), сам побег — **гипотеза**. Исправление:
```python
    def submit(self, fn, *args, **kwargs) -> None:
        future = self._pool.submit(fn, *args, **kwargs)

        def _report(fut) -> None:
            exc = fut.exception()
            if exc is not None:
                logger.exception("job worker crashed", exc_info=exc)

        future.add_done_callback(_report)
```
Почему баг: класс называется наблюдаемым (`test_pipeline_observability.py` фиксирует логирование жизненного цикла), а единственный путь, по которому воркер может умереть молча, не закрыт.

**B-047 · `backend/http_retry.py:298` — пользователю сообщается число попыток, которых не было.**
`raise RemoteError(f"network error after {attempts} attempts: …")` печатает объявленный лимит, тогда как на ветке неидемпотентного read-timeout (`:240`) цикл прерывается после первой попытки; лог на `:254` при этом честно печатает `retried + 1`. Последствие: два разных числа для одного события, и пользователь видит неверное. Серьёзность: P2 · **подтверждено**. Исправление: `f"network error after {retried + 1} attempts: …"`. Почему баг: правильное значение уже вычислено строкой выше и используется в логе.

**B-048 · `backend/http_retry.py:187-213` — вытесненный ответ не закрывается перед backoff.**
Ветка «транзитный статус» сохраняет `resp` в `last_resp` и уходит спать без `resp.close()`. При дефолтном `stream=False` тело уже вычитано и соединение вернулось в пул; при `stream=True` — нет, и каждый ретрай удерживает слот пула на всё время задержки. Серьёзность: P2 · **гипотеза** (сегодня ни один модуль не передаёт `stream=True`). Исправление: `resp.close()` сразу после `last_resp = resp`, когда ответ не будет возвращён.

**B-049 · `backend/storage.py:145-150` — сбой `chmod` **после** `os.replace` рапортует об ошибке записи, которая на самом деле состоялась.**
`raise` внутри ветки chmod попадает во внешний `except OSError`, который пытается удалить уже несуществующий tmp и пробрасывает ошибку — вызывающий видит `OSError`, хотя новое содержимое уже лежит по `path`. `_load_or_create_api_token` (`main.py:797`) после этого пишет «api token persist failed … using in-memory token for this session only», тогда как на диске лежит **другой**, сохранённый токен; следующий запуск прочитает его, и все клиенты этой сессии окажутся рассинхронизированы. Серьёзность: P2 · **подтверждено** (несоответствие «ошибка ↔ реальность»), триггер — **гипотеза** (нужна ФС, отвергающая `chmod`: SMB/exFAT под `DATA_DIR`). Исправление:
```python
        os.replace(tmp, path)
        if mode is not None:
            try:
                os.chmod(path, mode)
            except OSError as chmod_err:
                # The write LANDED; a failed permission tightening must
                # not be reported as a failed write, or the caller falls
                # back while the new content is already on disk.
                logger.warning("chmod %o skipped for %s: %s", mode, path, chmod_err)
```

**B-050 · `backend/main.py:2628-2644` `_recording_stem_available` — нечитаемый каталог выдаётся за «не удалось подобрать имя записи».**
Функция возвращает `False` на любом `OSError`, поэтому отвергаются все кандидаты, и `_unique_stem_from_base` / `_unique_recording_stem` / `_claim_recording_text_path` поднимают `500 could not allocate unique recording name`. Настоящая проблема пользователя — архив на отключённом диске или изменённые права — не видна в ответе, а текст активно уводит в сторону. Серьёзность: P2 · **подтверждено** (класс «ошибка без хозяина»). Исправление: пробросить `OSError` наружу как отдельный 409/503 с именем каталога. Почему баг: `_best_effort_unlink` в этом же файле логирует контекст каждой неудачи — принятая в модуле практика здесь не применена.

**B-051 · `backend/main.py:2312-2314` `_normalize_upload_queue_item` — неизвестный статус превращается в `"error"`.**
```python
    status = _upload_queue_str(raw.get("status"), 32)
    if status not in UPLOAD_QUEUE_STATUSES:
        status = "error"
```
Клиент, добавивший статус (например `"uploading"`), получит каждый такой элемент обратно из сохранённого снимка как проваленный. Безопасное значение для неизвестного — `"queued"`. Серьёзность: P2 · **подтверждено**, влияние сегодня низкое (набор статусов заморожен на `main.py:2281`). Почему баг: «не знаю» превращено в «плохо», а не в «нейтрально».

**B-052 · `backend/main.py:2451` `_clear_live_draft_state` — отказ очистить рапортуется как успех.**
При несовпадении владельца возвращается текущее состояние, а эндпоинт отвечает `{"ok": True, …}`. Вызывающий, доверяющий `ok`, считает черновик удалённым. Серьёзность: P2 · **подтверждено**. Исправление: вернуть явный `"cleared": bool` (или 409), чтобы отказ отличался от выполнения. Почему баг: `ok` в этом API означает «сделано», и здесь оно означает «не сделано».

**B-053 · `backend/main.py:2400` `_normalize_live_draft` — форма полезной нагрузки определяется по количеству ключей.**
```python
    draft_src = payload.get("draft") if "draft" in payload and len(payload) <= 2 else payload
```
`put_live_draft_state` возвращает `{"ok": True, "version": 1, "draft": {...}}` — три ключа. Если такой ответ отправить обратно (естественная идиома, которой учит связка `GET` → `PUT`), берётся ветка `else`: конверт трактуется как сам черновик, все поля падают в дефолты, и `atomic_write_json` сохраняет пустой черновик с HTTP 200. Живой черновик — страховка от падения во время диктовки, так что отказ тихий и стоит текста. Серьёзность: P2 · **подтверждено** достижимо по HTTP; делает ли так рендерер — **гипотеза** (фронтенд вне периметра). Исправление:
```python
    # Decide on the SCHEMA, not on how many keys the caller happened to send:
    # our own PUT response has three, so echoing it back silently wiped the draft.
    if isinstance(payload.get("draft"), dict) or ("draft" in payload and payload["draft"] is None):
        draft_src = payload["draft"]
    else:
        draft_src = payload
```

**B-054 · `backend/config.py:883, 914, 976` — `config.json` пишется с правами по umask (замерено 0644), тогда как соседний секрет — 0600.**
`_atomic_write_json` (= `storage.py:175`) не принимает `mode`. Замер: `config.json` = 644, `.encryption_key` = 600, `DATA_DIR` = 755. В штатном случае содержимое — шифротекст `enc:`, но докстринг модуля (`config.py:5-6`) документирует plaintext-фолбэк при отсутствии `cryptography` — тогда сырые API-ключи лежат в файле, читаемом всеми. Серьёзность: P2 · **подтверждено**. Исправление: добавить `mode` в `atomic_write_json` (проброс в `atomic_write_text`, который его уже поддерживает) и звать `_atomic_write_json(CONFIG_PATH, encrypted, mode=0o600)` во всех трёх местах; `DATA_DIR.mkdir(..., mode=0o700)` вместе с B-021. Почему баг: `main.py:801` уже демонстрирует правильную форму вызова для файла того же класса.

**B-055 · `backend/config.py:415` `_redact_provider_key_value` × `frontend/src/main.tsx:1866` `MASKED_KEY_VALUE` — бэкенд и рендерер не согласны, как выглядит замаскированный ключ.**
Бэкенд отдаёт `key[:3] + "..." + key[-2:]`, а `_preserve_redacted_provider_keys` (`:419-440`) распознаёт только эту форму; рендерер показывает и, теоретически, отправил бы `"••••…"`. Последствие: защита от «сохранения маски вместо ключа» в продакшене никогда не срабатывает (её единственный потребитель — `tests/test_config.py:71`), и если бы клиент отправил то, что показывает, `_encrypt_provider_keys` записал бы строку из точек в качестве API-ключа. Сегодня это блокирует `isMaskedKeyInput` в рендерере — то есть защита стоит на другой стороне, чем задумано. Серьёзность: P2 · **подтверждено** (латентно). Исправление:
```python
_UI_MASK_VALUES = frozenset({"•" * n for n in range(8, 65)})

def _is_masked_key(incoming: str, current: str) -> bool:
    return incoming in _UI_MASK_VALUES or incoming == _redact_provider_key_value(current)
```
Почему баг: две стороны одного контракта описывают одно значение по-разному.

**B-056 · `backend/config.py:450-454` `_migrate_legacy_data` — `config.json` копируется без `.encryption_key`.**
Если в легаси-каталоге лежит конфиг со значениями `enc:`, копия попадает в каталог со свежим ключом, которым её не расшифровать; `decrypt_value` (`:285-292`) логирует warning и возвращает `""` — ключи пользователя исчезают без видимого сигнала. Серьёзность: P2 · достижимость — **гипотеза** (ни `<repo>/data`, ни `Resources/data` сегодня не существуют, функция фактически мертва). Исправление: копировать keyfile первым (`atomic_copy_file(LEGACY_DATA_DIR / ".encryption_key", _KEYFILE)`, если целевого нет) — или удалить миграцию.

**B-057 · `backend/config.py:485-516` `DEFAULT_CONFIG` — подветка `preferences.ui` из 22 ключей без дефолта, без схемы и без читателя на бэкенде.**
Пишется рендерером (`frontend/src/main.tsx:5308-5334`), персистится через `save_config`, читается рендерером и `desktop/main.js:8582`. В `DEFAULT_CONFIG` отсутствует, `_validate_config_shape` её не трогает. Обычно переживает (проверено), но не-словарный `preferences` включает `out["preferences"] = dict(DEFAULT_CONFIG["preferences"])` (`:595`) и одним шагом уничтожает все хоткеи, выбор модели и id микрофона. Серьёзность: P2 · **подтверждено** (отсутствие схемы), срабатывание — **гипотеза**. Исправление: сохранять валидную подветку `ui` при этом сбросе, а не описывать все 22 ключа схемой.

**B-058 · `.env.example` — не указаны клампы двух настроек Whisper.**
Файл пишет «Default: auto based on CPU count» для `TRANSCRIPTOR_WHISPER_CPU_THREADS` и `TRANSCRIPTOR_WHISPER_NUM_WORKERS`; `transcribe.py:62-69` молча ограничивает их диапазонами `4..8` и `1..3`. Пользователь, поставивший 16, получает 8 без предупреждения. Все прочие клампованные переменные в этом файле свой диапазон указывают («clamped by backend to 60..3600»). Серьёзность: P2 · **подтверждено**. Почему баг: соглашение файла соблюдено везде, кроме этих двух строк.

**B-059 · `desktop/main.js:228` — безусловно перетирается заданный пользователем `TRANSCRIPTOR_DATA_DIR`.**
`process.env.TRANSCRIPTOR_DATA_DIR = newDir;` внутри `_relocateUserDataOffOneDrive()`. Путь только Windows+OneDrive, но на нём явная документированная настройка пользователя отбрасывается без строки в логе. Серьёзность: P2 · **подтверждено** (по коду). Исправление: обернуть в `if (!process.env.TRANSCRIPTOR_DATA_DIR) { … }` и логировать пропуск.


#### Ресурсы и производительность

**B-060 · `backend/audio.py:620` `split_channels` — весь стерео-WAV загружается в float32-память.**
`load_wav` возвращает `float32 (n, 2)`: двухчасовой 16 кГц стерео-файл — 921 МБ резидентно, плюс по непрерывной копии на канал (`:638-639`). Все прочие пути этого модуля осознанно переведены на потоковую обработку (`write_wav_from_pcm16_stream`, `:578`, докстринг: «OOM-kills 8-16 GB hosts»). Достижимо: `main.py:2164 split_channels(wav_path)` при включённом разделении каналов. Серьёзность: P2 · **подтверждено**. Исправление:
```python
    with sf.SoundFile(path_wav_16k) as src, \
         sf.SoundFile(tmp_ch1, "w", samplerate=LIVE_SAMPLE_RATE_HZ, channels=1, subtype="PCM_16") as d1, \
         sf.SoundFile(tmp_ch2, "w", samplerate=LIVE_SAMPLE_RATE_HZ, channels=1, subtype="PCM_16") as d2:
        for block in src.blocks(blocksize=1 << 18, dtype="int16", always_2d=True):
            d1.write(block[:, 0])
            d2.write(block[:, 1])
```
Почему баг: тот же файл уже содержит потоковую реализацию и её обоснование; здесь она просто не применена.

**B-061 · `backend/audio.py:192-200` `_run_ffmpeg` — `collected` читается, пока поток-читатель может ещё в него писать; убитый ffmpeg остаётся неподобранным.**
На ветке таймаута (`:185-191`) и отмены (`:170-176`) функция выходит, ни разу не вызвав `reader.join(...)`; на успешной ветке `reader.join(timeout=5)` может истечь. Во всех трёх случаях `msg = "".join(collected)` (`:200`) конкурирует с `collected.extend(...)`. Плюс `proc.kill()` + `proc.wait(timeout=5)` с проглоченным `TimeoutExpired` (`:187-190`, `:172-175`) бросает ребёнка неподобранным. Серьёзность: P2 · **подтверждено** (диагностическая строка может оказаться усечённой или перемешанной; краха нет — `list.extend` атомарен под GIL). Исправление: `reader.join(...)` в `finally` перед чтением `collected`; логировать, а не игнорировать, истечение `wait` после `kill()`. Сопутствующее: `_FFMPEG_STDERR_CAP_BYTES` сравнивается с `len(line)` текстового потока (`text=True`, `:155`), то есть лимит на самом деле в символах, а не байтах — недоучёт до 4× на UTF-8.

**B-062 · `backend/transcribe_gigaam.py:123` `_write_wav` — временный файл течёт, если `sf.write` падает.**
`NamedTemporaryFile(delete=False)` создаёт файл, после чего `sf.write` может бросить (диск полон, неверный dtype) раньше, чем у вызывающего (`:257-263`) появится путь для `unlink`. Последствие: по нулевому файлу в системном temp на каждый отказ, невидимому для собственного свипера `.tmp-<hex>`. Серьёзность: P2 · **подтверждено**. Исправление:
```python
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    path = Path(handle.name)
    try:
        sf.write(str(path), np.asarray(audio_16k_mono, dtype=np.float32),
                 LIVE_SAMPLE_RATE_HZ, subtype="PCM_16")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path
```

**B-063 · `backend/transcribe_gigaam.py:256` — на каждый чанк пишется временный WAV, в том числе на горячем пути live-ассиста.**
`transcribe_gigaam` достижим из цикла живого декодирования (`live.py:352 transcribe_audio(...)` → `transcribe.py:467` gigaam-ветка), потому что `LOCAL_LIVE_ASSIST_MODELS = LOCAL_TRANSCRIPTION_MODELS` (`model_catalog.py:54`), а `main.py:4160` пускает любую из них. Значит каждый проход `maybe_transcribe` делает синхронные `sf.write` + `unlink` до 17 с аудио, примерно раз в секунду речи. Плюс gigaam-ветка молча отбрасывает `vad_filter`, `language`, `beam_size`, `best_of` (`transcribe.py:470-474`), поэтому окна чистой тишины декодируются целиком. Серьёзность: P2 · **подтверждено** (достижимость). Исправление: переиспользовать один временный файл на сессию вместо файла на чанк и ограничить live-ассист движками, уважающими `vad_filter`.

**B-064 · `backend/model_catalog.py:13` `gigaam_available` — `find_spec` выполняется на каждом опросе `/api/health`.**
Цепочка: `_frontend_runtime_payload` → `health_model_catalog()` → `gigaam_available()` → `find_spec("gigaam")` + `find_spec("torch")`. `/api/health` опрашивается примерно раз в 10 с и заглушён в access-логе (`_ACCESS_LOG_POLLED_PATHS`), так что стоимость не видна; для **отсутствующего** модуля `find_spec` обходит весь `sys.path`. Доступность движка не может измениться внутри процесса. Серьёзность: P2 · **подтверждено** (повторная работа на опрашиваемом пути). Исправление: вычислить один раз при импорте и отдавать закешированное.

**B-065 · `backend/main.py:1873-1921` `_copy_source_media_file` — исходник читается дважды.**
Копирование хеширует на лету, затем **перечитывает весь исходник** ради сверки дайджестов — поверх уже выполненной проверки `st_dev`/`st_ino`/`st_size`. Для 2 ГБ (допустимо по `MAX_UPLOAD_BYTES`) это 4 ГБ чтения на каждое задание from-path или сохранение. Тройка `st_dev`/`st_ino`/`st_size` вместе с пробой стабильности `SOURCE_MEDIA_STABILITY_PROBE_SEC` уже закрывает случай «файл ещё дописывают»; второе полное чтение ловит только перезапись на месте с сохранением размера и инода. Серьёзность: P2 · **подтверждено** как стоимость; помечаю как решение, которое стоит пересмотреть (например, включать сверку только ниже порога размера), а не как однозначный дефект.

**B-066 · `backend/jobs.py:73-96` `_prune` — `max_jobs` мягкий, второго предела нет.**
Вытесняются только задания, которые терминальны **и** имеют `terminal_observed_at` **и** пережили 15-минутную отсрочку. Клиент, который не опрашивает (закрытый рендерер, скрипт «выстрелил и забыл»), оставляет все задания — вместе с полным `result`, включая сырой ответ провайдера — резидентными на всю жизнь процесса. Комментарий называет предел «deliberately soft», но за ним ничего нет. Серьёзность: P2 · **гипотеза** (нужен неопрашивающий клиент). Исправление: жёсткий потолок (например `3 * max_jobs`), выше которого ненаблюдённые терминальные задания вытесняются по старшинству.

**B-067 · `backend/main.py:1399` `_release_session_promote_lock` — лок снимается из реестра, пока на нём ещё кто-то ждёт.**
`finally` вынимает `Lock` из словаря; поток, уже заблокированный на этом объекте, продолжает его держать, а **третий** вызывающий создаёт новый объект и входит в тело параллельно. Кеш идемпотентности обычно это гасит, но на путях, которые ничего не кладут в кеш (404/400/413/409), два промоута могут выполняться одновременно. Серьёзность: P2 · **гипотеза** (нужны одновременные вызовы promote для одного `session_id`). Исправление: снимать запись только при отсутствии ожидающих, либо оставлять её и ограничивать словарь TTL-кешем.

#### Корректность: `backend/live.py`

**B-068 · `backend/live.py:294` `_transcribe_pass` — `dropped_sec` завышается ровно на `overlap_sec` при каждом усечении окна.**
`dropped = need_sec - max_window_sec`, где `need_sec` включает намеренно переподаваемую голову перекрытия, то есть уже покрытое аудио засчитывается как потерянное. Проверка вручную: при `_covered_sec = 10.0`, `total_sec = 40.0` → `uncovered_from = 9.0`, `need_sec = 31.0`, `max_window_sec = 17.0` → `dropped = 14.0`; реально отдаётся окно `[23.0, 40.0]`, значит недекодированный отрезок `[10.0, 23.0]` = 13.0 с. Ошибка — `overlap_sec` на событие, накапливается в `_dropped_sec_total`. Тест `tests/test_live_coverage.py:195` проверяет только `> 0.0`, так что значение ничем не закреплено. Последствие: «правда о покрытии», обещанная докстрингом (`live.py:527-542`) и уходящая во фронтенд как `droppedSec` и в пользовательский warning (`:296-301`), неверна на 1 с за событие. Ложных срабатываний не создаёт, поэтому `complete` остаётся корректным. Серьёзность: P2 · **подтверждено**. Исправление:
```python
if need_sec > max_window_sec:
    # Only audio the model never saw is "dropped": the window starts at
    # total_sec - max_window_sec, and everything before _covered_sec was
    # already decoded. The re-fed overlap head is not a loss.
    window_start_sec = total_sec - max_window_sec
    dropped = max(0.0, window_start_sec - self._covered_sec)
    if dropped > 0.0:
        self._dropped_sec_total += dropped
```

**B-069 · `backend/live.py:491` — защита от текстового повтора сверяется с хвостом, не включающим текущий проход.**
`trim_repeated_prefix(self._emitted_tail_text(), text)` читает `self._emitted_segments`, а сегменты этого прохода дописываются только на `:512`, после цикла. Значит сегмент *k* сверяется с до-проходным хвостом, а не с сегментами 1..k-1, выданными секундой раньше. Последствие: повтор внутри одного прохода (Whisper выдал пограничную клаузу двумя соседними сегментами) проходит защиту и доезжает до пользователя — тот самый симптом дублирования фразы, ради которого функция написана, уровнем ниже. Серьёзность: P2 · **гипотеза** (нужно, чтобы декодер выдал повтор внутри одного окна; межпроходный случай закрыт). Исправление:
```python
    def _emitted_tail_text(self, extra: Optional[list[dict]] = None) -> str:
        pool = self._emitted_segments + list(extra or [])
        if not pool:
            return ""
        return " ".join(str(s.get("text") or "") for s in pool[-3:]).strip()
```
и на месте вызова — `trim_repeated_prefix(self._emitted_tail_text(new_segments), text)`.

**B-070 · `backend/live.py:419` × `:456` — две ветки обрезки читают две разные отметки одного и того же решения.**
`cutoff` снимается один раз до цикла по сегментам и используется фолбэком без словных таймстампов (`:485`), тогда как ветка со словными таймстампами читает **живое** `self._last_emitted_end` (`:456`), которое двигается внутри цикла (`:494`, `:504`). Один вопрос («было ли это уже выдано?»), два источника, различающиеся на всё, что выдал текущий проход. Серьёзность: P2 · **подтверждено**. Исправление: убрать локальную `cutoff` и в фолбэке использовать `self._last_emitted_end + self.cfg.emit_epsilon_sec`, чтобы обе ветки старели вместе с циклом.

**B-071 · `backend/live.py:496-503` — сегмент, обрезанный по тексту, сохраняет необрезанный `start`.**
При срабатывании `trim_repeated_prefix` текст укорачивается, а `g_start` не сдвигается — в отличие от словной ветки (`:475-478`), которая переставляет `g_start` именно для того, чтобы «временно-упорядоченное слияние во фронтенде» не считало событие пересекающимся с уже зафиксированным. Обоснование, записанное двумя ветками выше, здесь применимо дословно. Серьёзность: P2 · **подтверждено** (асимметрия, противоречащая собственному комментарию).


#### Мёртвый код, флаги без читателей, комментарии против кода

**B-072 · `backend/audio.py:289` `compact_audio_for_remote` (+ `:224` `_compact_audio_for_remote_cmd`) — мёртвая функция, но с тестом.**
Единственные ссылки — сама `audio.py` и `tests/test_audio.py:24, 41`, проверяющий только сборку argv; все удалённые загрузки идут через `compact_audio_chunks_for_remote` (`main.py:5707`). Последствие: ~60 строк документированного поведения («Why ALWAYS convert», контракт `.webm`) описывают путь, по которому никто не ходит, плюс тест, фиксирующий неиспользуемую команду. Серьёзность: P2 · **подтверждено**. Исправление: удалить обе функции, перенацелив два теста на `_compact_audio_chunks_for_remote_cmd`. Почему не намеренно: докстринг выжившей функции называет себя «the long-form counterpart to `compact_audio_for_remote`», то есть она писалась как равноправная, а не как замена — вызывающий мигрировал, оригинал забыли.

**B-073 · `backend/main.py:2711` `_unique_recording_stem_for_source_file` и `:2640` `_unique_stem_from_base` — мертвы, но именно они покрыты тестами.**
Единственное упоминание первой в продакшн-коде — её собственное `def`; вторая зовётся только из неё. Продакшн использует `_recording_stem_candidates_for_source_file` + `_claim_recording_text_path`. При этом `tests/test_recording_names.py:63, 94, 106` гоняют именно мёртвую функцию. Последствие: правило именования выглядит покрытым, а покрыта другая функция. Серьёзность: P2 · **подтверждено**. Исправление: удалить обе, перенацелив тесты на `_claim_recording_text_path`.

**B-074 · `backend/main.py:28` `import numpy as np` и `:72` `write_wav` — неиспользуемые импорты.**
`np` упоминается только в комментарии; `write_wav` не имеет ни одного вызова (используется только `write_wav_from_pcm16_stream`). Серьёзность: P2 · **подтверждено**.

**B-075 · `backend/main.py:1407` `_require_api_auth` — мёртвая ветка исключения для `/api/health`.**
`if request.url.path == "/api/health": return` — но `/api/health` (`:1496`) не объявляет `Depends(_require_api_auth)`, ветка недостижима. Хуже: она записывает правило «health не требует авторизации» во второе место, поэтому если зависимость когда-нибудь добавят, исключение сработает молча. Серьёзность: P2 · **подтверждено**. Исправление: удалить ветку — или добавить зависимость на эндпоинт и оставить ветку единственным выражением правила.

**B-076 · `backend/main.py:4020-4073` `_finalize_live_recovery` — поля `status` и `write_error` в sidecar пишутся и никем не читаются.**
`_list_live_recoveries` (`:1136`) строит строку без них; `_promote_live_recovery` их игнорирует (осознанно, комментарий `:1089-1113`). Последствие: сессия, у которой запись спула наполовину провалилась (`write_failed`, `:3993`), предлагается пользователю неотличимо от чистой, и промоут молча даёт обрезанное аудио. Серьёзность: P2 · **подтверждено** (мёртвое поле + отсутствие наблюдаемости на границе с пользователем). Исправление: вынести `status`/`write_error` в строку списка, чтобы UI мог предупредить, — либо перестать их писать.

**B-077 · `backend/transcribe_gigaam.py:64, 69, 74` `_LAST_LOAD_ERROR` — глобал, в который только пишут.**
`gigaam_import_error()` кладёт сообщение в модульный глобал, который никто не читает (поиск не даёт читателей вне присваивания), и не очищает его при последующем успехе. Объявление `global` и модульное состояние не дают ничего сверх возврата строки. Серьёзность: P2 · **подтверждено**. Исправление: убрать глобал, вернуть `f"{type(e).__name__}: {e}"` напрямую.

**B-078 · `backend/live.py:163` `_last_error_signature` — поле, в которое только пишут.**
Присваивается на `:373`, `:392`, очищается на `:410`, не читается нигде. Информация, которую оно должно было нести (дедупликация одинаковых отказов до эскалации), не реализована — `_consecutive_errors` эскалирует по одному лишь счётчику. Серьёзность: P2 · **подтверждено** (мёртвый код / недоделанная фича). Исправление — либо удалить поле, либо использовать:
```python
if signature == self._last_error_signature:
    self._consecutive_errors += 1
else:
    self._consecutive_errors = 1
self._last_error_signature = signature
```

**B-079 · `backend/transcribe_gigaam.py:137` — `step` вычисляется и не используется.**
`step = GIGAAM_MAX_CHUNK_SEC - GIGAAM_CHUNK_OVERLAP_SEC` мёртв; цикл двигается через `t = end - GIGAAM_CHUNK_OVERLAP_SEC` (`:143`). Серьёзность: P2 · **подтверждено**. Исправление: удалить строку либо использовать её (`t = t + step`), чтобы у шага было одно определение.

**B-080 · `backend/main.py:1307-1309` и `:5439-5444` — комментарии описывают реализацию, которой больше нет.**
Оба текста описывают `np.frombuffer + astype(float32)` и «reads up to 500 MB of PCM … ~1.5 GB transient heap», стоя прямо над потоковым `write_wav_from_pcm16_stream` (`:1361`), чей потолок — `MAX_RECOVERY_PROMOTE_BYTES` = 4 ГБ. Читатель, оценивающий эндпоинт промоута по этим комментариям, ошибётся и в алгоритме, и в лимите. Серьёзность: P2 · **подтверждено** (комментарий против кода).

**B-081 · `backend/main.py:1051-1055` `_delete_live_recovery` — обоснование порядка удаления перевёрнуто.**
Комментарий говорит, что удаление спула первым оставило бы «orphan `.json` still advertising a recovery whose PCM is gone». На деле `_list_live_recoveries` (`:1138`) обходит `*.pcm16` и терпит отсутствующий sidecar — осиротевший `.json` не показывается вообще, тогда как режим отказа текущего порядка (sidecar удалён, удаление спула провалилось) оставляет `.pcm16`, который **виден** и промотируем, то есть «discard», о котором попросил пользователь, молча не состоялся. Код не вреден, но записанная причина обратна тому, что делает модуль. Серьёзность: P2 · **подтверждено** (комментарий против кода).

**B-082 · `backend/main.py:3752` `_normalize_recording_collection` в WS-области — `HTTPException` после `websocket.accept()`.**
В WebSocket-области нет обработчика HTTP-исключений, поэтому клиент, передавший неизвестную коллекцию в query-строке, получает необработанное исключение сервера и закрытие 1011 вместо внятной протокольной ошибки. Серьёзность: P2 · **подтверждено**. Исправление: в WS-ветке валидировать через тот же нормализатор, но отвечать `{"type":"error","error":…,"fatal":true}` и закрывать с прикладным кодом.

**B-083 · `backend/remote_deepgram.py:45` `RemoteError = DeepgramRemoteError` и `backend/remote_deepgram_live.py:693-698` — переопределение импортированного имени и импорты посреди модуля.**
Первое: модульная переменная перекрывает имя, импортированное из `http_retry`, чтобы `raise RemoteError(...)` в этом файле давал подкласс. Работает и задокументировано, но читатель на строке 160 видит `raise RemoteError` и не имеет причин подозревать, что это другой класс; при этом `request_with_retry` продолжает бросать **базовый** `RemoteError`. *(Проверено: вызывающие в `main.py:5878, 6031, 6120, 6202` ловят `except RemoteError`, то есть базовый, — ошибка не пропускается. Дефекта поведения нет, только читаемость.)* Второе: шесть импортов на строках 693-698, ниже 690 строк кода, с `# noqa: E402` — причём `DEEPGRAM_LIVE_URL` без `noqa`, то есть даже пометка непоследовательна. Серьёзность: P2 · **подтверждено** (уровень инженерии). Исправление: явный `class DeepgramRemoteError(RemoteError)` и `raise DeepgramRemoteError(...)` на местах; импорты — наверх, а константы, которые они «обгоняют», вынести туда же или в модуль констант.

**B-084 · `backend/main.py:5591` `_remote_result_duration_sec` — читает форму ответа Deepgram у результата OpenRouter.**
Функция достаёт `raw["metadata"]["duration"]` — это схема Deepgram — и применяется к результату OpenRouter на `:5649`. OpenRouter возвращает конверт chat-completion без `metadata`, поэтому `duration` для каждой транскрипции через OpenRouter безусловно `0.0`, включая накопление по чанкам (`:5786-5787`). Серьёзность: P2 · **подтверждено** (один читатель на две формы адаптеров; сегодня потребителя у этого поля нет, поэтому и не заметили). Исправление: пусть `openrouter_transcribe` возвращает то, что может посчитать, первоклассным ключом (`{"text": …, "duration": None, "raw": js}`), а `_remote_result_duration_sec` сперва читает `result.get("duration")` и только потом падает в Deepgram-специфичный `raw`.

#### Тесты

**B-085 · `backend/tests/test_remote_chunking.py:155` `test_live_recovery_helpers_are_optional` и `backend/tests/test_live.py:92` `test_http_header_token_authenticates` — тесты без утверждений.**
Первый вызывает `_record_recovery_chunk(None, b"pcm")` и `_mark_recovery_error(None)` и не проверяет ничего: проходит, если ничего не бросило. Хелпер, который начнёт молча **создавать** recovery-словарь из `None` или проглатывать реальную ошибку, останется зелёным. Второй вызывает `_require_api_auth(request)` и не утверждает ничего — контракт «прошло без исключения» защитим, но подмена принципала или короткое замыкание до сравнения токена не заметятся (соседние негативные тесты на `:78`, `:100` при этом проверяют `status_code == 401`). Серьёзность: P2 · **подтверждено**. Исправление для первого:
```python
    def test_live_recovery_helpers_are_optional(self):
        # A session with no recovery spool must be a no-op — not a crash,
        # and not an implicitly created spool.
        self.assertIsNone(self.main._record_recovery_chunk(None, b"pcm"))
        self.assertIsNone(self.main._mark_recovery_error(None))
        with mock.patch.object(self.main.logger, "warning") as warn:
            self.main._record_recovery_chunk(None, b"pcm")
        warn.assert_not_called()
```

**B-086 · `backend/tests/test_transcribe_gigaam.py:241` `test_unavailable_engine_reports_reason_not_crash` — утверждение только о типе, и результат зависит от машины.**
`self.assertIsInstance(reason, str)` удовлетворяется пустой строкой, то есть «сообщает причину» не проверяется. Хуже: `gigaam_import_error()` (`transcribe_gigaam.py:67-75`) делает настоящий `import gigaam` и возвращает **`None`** при успехе, а `sys.modules.pop` не мешает импорту с диска — на машине с установленным пакетом это `assertIsInstance(None, str)`, то есть падение. Серьёзность: P2 · **подтверждено**. Исправление: форсировать `ImportError` через `mock.patch.dict(sys.modules, {"gigaam": None})` и проверять непустоту сообщения.

**B-087 · `backend/tests/test_deepgram_coverage_holes.py:117` и `backend/tests/test_deepgram_warm.py:532` — `if __name__ == "__main__"` посреди файла прячет 752 строки тестов.**
В первом пять из шести классов (строки 121-452) объявлены **после** охранника; во втором `WarmSessionLivenessTests` (`:658`) и `WarmStatusEndpointTests` (`:894`) — строки 536-949. Это единственные два файла в наборе, где охранник не последний оператор. Последствие: при `python backend/tests/test_deepgram_warm.py` `unittest.main()` выполняется на строке 532 и вызывает `sys.exit()` до того, как поздние классы вообще определены — тесты **liveness и реплея** тёплого сокета (то самое «мёртвый сокет заменяется без потери слова») не выполняются, и прогон рапортует «зелено». Под `pytest` / `python -m unittest` собираются все классы, так что это латентная ловушка, а не текущая дыра. Серьёзность: P2 · **подтверждено**. Исправление: удалить охранник из середины, оставив только тот, что в конце файла.

**B-088 · ~25 мест — утверждения по настенным часам поверх реальных `asyncio.sleep`.**
`test_deepgram_finalize_flush.py:78, 96, 109, 122, 175, 182, 211`; `test_deepgram_finalize_budget.py:238, 255, 284, 309, 481, 551, 617, 639`; `test_live.py:638`. Самое узкое: `test_deepgram_finalize_flush.py:175` — `assertLess(elapsed, 0.5)` при реальном бюджете 0.25 с, двукратный запас на загруженном CI. `test_deepgram_seam_tail.py:236-322` платит реальные ~0.75 с `FINALIZE_COVERED_WAIT_SEC` в каждом из трёх тестов без патча вовсе. Последствие: перемежающиеся красные прогоны и медленный набор; B-024 — прямое следствие этого стиля (проверяется секундомер, а не механизм). Серьёзность: P2 · **подтверждено**. Исправление: инжектируемые часы в `DeepgramLiveSession` вместо `time.perf_counter()` напрямую.

**B-089 · `backend/tests/test_live_coverage_policy.py:123` и `backend/tests/test_mic_health.py:152` — два модуля молча скипаются без Node и `frontend/node_modules`.**
Это **единственные** тесты для `frontend/src/live-coverage.ts` (политика принятия транскрипта — её собственный докстринг говорит: «getting that wrong in the permissive direction ships a transcript that is silently missing words») и для конечного автомата здоровья микрофона. На любом раннере без `node` или без установленного фронтенда они исчезают без сигнала. Последствие: политика, защищающая от потери слов, не защищена именно в том окружении (CI, свежий клон), где это нужнее всего. Серьёзность: P2 · **подтверждено**. Исправление: сделать скип громким (падение при отсутствии, если задан `CI=1`) либо гейтить CI на установку фронтенда.

**B-090 · Пробелы покрытия: `backend/audio_mime.py` — единственный продакшн-модуль без тестового модуля; `backend/tools/**` — без тестов; частичное покрытие у `transcribe.py`, `audio.py`, `http_retry.py`.**
`audio_content_type()` не вызывается ни одним тестом: фолбэк «неизвестное расширение → `mimetypes.guess_type` → `application/octet-stream`» не исполняется вовсе, а переопределения `.webm`/`.opus`/`.m4a`, ради которых модуль и существует, проверяются только как **ключи словаря** (`test_config.py:266, 278`), а не как отображаемые значения — при том что два вызывающих отправляют эти значения в Deepgram и OpenRouter заголовком `Content-Type`. `transcribe.py` (603 строки) не имеет собственного модуля: `merge_channel_transcripts`, `_build_result`, `_probe_tone`, `start_idle_model_sweeper`, `_empty_transcribe_result` не покрыты. У `audio.py` не названы ни разу `load_wav`, `write_wav`, `split_channels`, `_copy_file_atomic`, `_bounded_stderr_reader`. У `http_retry.py` не покрыты `_exponential_backoff` и `_parse_retry_after` — то есть разбор `Retry-After` и сама лестница задержек не зафиксированы, покрыто только логирование ретраев. `backend/tools/*` не импортируется ни одним тестом, хотя `build_parser()`, `_format_row()`, `_load_pcm16_mono()` чисты и тривиально тестируемы. Серьёзность: P2 · **подтверждено**.


---

## 5. Индексы

### 5.1 Костыли и workarounds

Здесь — не «плохой код», а места, где **симптом обойдён вместо причины**, где правка доведена наполовину, где механизм объявлен и не подключён, и где комментарий описывает не то, что делает код.

| ID | Что именно является костылём |
|---|---|
| **B-005** | Три эмпирические константы ожидания (`FINALIZE_FLUSH_WAIT_SEC` / `FINALIZE_COVERED_WAIT_SEC` / `FINALIZE_EMPTY_TAIL_WAIT_SEC`) и трёхветочный выбор бюджета существуют, чтобы обойти симптом «ответ Deepgram не приходит». Ответ приходит и выбрасывается строкой выше. **Корневая причина одной строкой; три константы — обход.** |
| B-007 | Правило tail-guard переписано, но обещанная в докстринге защита случая 2026-08-24 не реализована; `tail_gap` остался мёртвым параметром — переход не доведён. |
| B-004 | `WARM_MAX_SOCKETS = 2` заведена под dual-stream, но вторая конфигурация не греется ни разу — механизм объявлен и не подключён. |
| B-003 | Пул спроектирован под параллельные конфигурации, а его же lock их сериализует — заявленная цель отменяется реализацией. |
| B-009 | `wait_for` вокруг `ws.send` убран с аудио-пути как причина зависаний и оставлен на всех трёх управляющих кадрах. |
| B-008 | `except (asyncio.CancelledError, Exception): pass` в 13 местах — идиома «поймать всё», при том что тот же модуль в двух местах правильно пробрасывает `CancelledError`. |
| B-006 | `coveredEndSec` не вычисляется отдельно, а копирует `durationSec` — поле контракта заполнено «чем было под рукой». |
| B-010 | `streamedSec` пересчитан вручную на ветке ошибки вместо вызова владельца — обход того, что метод приватный. |
| B-014 | `-nostdin` добавлен в две команды из четырёх — правило применено точечно вместо `Popen(stdin=DEVNULL)`. |
| B-015 | GigaAM знает `model_is_resident`, но не знают обе освобождающие функции — фича сделана на одном движке из двух. |
| B-016 | Откат снимает файл, но не резервирование имени — компенсация неполная. |
| B-017 | Комментарий утверждает, что регулярка ловит «in-middle tmp pattern»; она его не ловит. |
| B-018 | Штамп версии схемы записывает не то, что печатает, поэтому «одноразовая миграция» повторяется вечно. |
| B-020 | Правило «никогда не перезаписывать keyfile» применено к нулевому файлу, который нечего защищать. |
| B-021 | `mkdir` на импорте — падение вместо документированной в двух других местах политики «warn and default». |
| B-023 | `.env.example` описывает механизм `.env`, которого нет ни в Python, ни в Electron. |
| B-024 | Тест патчит константу, которую его путь не читает, и «проходит» независимо от механизма. |
| B-030 | Список встроенных пресетов записан вторым множеством ради одной проверки легаси-поля. |
| B-031 | Правило «[No speech captured]» скопировано во второй эндпоинт и там подправлено. |
| B-032 | Промоут использует check-then-use, хотя рядом лежит `O_EXCL`-резервирование. |
| B-036 | Порог «слишком мало байт» — голое `64` дважды, проверка после загрузки модели. |
| B-039 | «auto» решается двумя способами: `detect_language` на REST, `multi` на live. |
| B-041 | A/B-инструмент собирает конфиг мимо единственного конструктора. |
| B-043 | Два неиспользуемых импорта исключений внутри `except Exception`, который делает из любого сбоя «не скачано». |
| B-044 | `int()` над переменной окружения мимо принятой в пакете политики `_env_int`. |
| B-051 | Неизвестный статус очереди трактуется как `"error"`. |
| B-052 | Отказ очистить черновик рапортуется как `ok: true`. |
| B-053 | Форма полезной нагрузки определяется по количеству ключей. |
| B-055 | Маска ключа описана по-разному на двух сторонах контракта; защита фактически стоит на другой стороне. |
| B-068 | `dropped_sec` считается по `need_sec` (с перекрытием) вместо реального начала окна. |
| B-069 | Защита от повтора сверяется с хвостом, не включающим текущий проход. |
| B-070 | Две ветки одного решения читают две разные отметки. |
| B-071 | Текстовая обрезка не переставляет `start`, хотя словная переставляет и объясняет зачем. |
| B-078 | `_last_error_signature` пишется и не читается — недоделанная дедупликация ошибок. |
| B-080 | Комментарии описывают удалённую реализацию (`np.frombuffer`, «500 MB», «1.5 GB heap»). |
| B-081 | Записанное обоснование порядка удаления обратно тому, что делает модуль. |
| B-083 | Переопределение импортированного `RemoteError` и шесть импортов на 693-й строке с `# noqa`. |
| B-087 | `if __name__ == "__main__"` посреди файла — 752 строки тестов не выполняются при прямом запуске. |
| B-088 | Тесты меряют секундомером вместо механизма — прямая причина B-024. |

### 5.2 Хардкод → SSOT

| ID | Что дублируется | Места | Куда свести |
|---|---|---|---|
| **B-026** | байт/с живого PCM (`16000 × 2`) | `main.py:4379, 4787, 5258, 5316` + `remote_deepgram_live.py:2338` | `audio_constants.LIVE_PCM_BYTES_PER_SEC` (уже существует и импортирована) |
| **B-027** | дефолты dual-stream (`True`, `"ru"`) | `config.py:512-513` · `deepgram_dual.py:85, 91` · `frontend/src/deepgram-dual.ts:24-25` | листовой модуль дефолтов → `DEFAULT_CONFIG` → `_frontend_runtime_payload` → рендерер |
| B-028 | дефолтный удалённый провайдер `"openrouter"` | `config.py:492` · `main.py:5626` · `model_catalog.py:74` | `REMOTE_TRANSCRIPTION_PROVIDERS[0]` |
| B-029 | 4 переменные окружения бэкенда вне `.env.example` | `deepgram_format.py:85, 90, 95` · `transcribe_gigaam.py:62` | `.env.example` (AGENTS.md §4) |
| B-030 | список встроенных пресетов | `main.py:665` · `main.py:692` | `frozenset(BUILTIN_UPSCALE_PRESETS)` |
| B-031 | правило «[No speech captured]» | `main.py:7109` · `main.py:7172` | один `_placeholder_source_text(...)` |
| B-032 | правило «свободное имя записи» | `main.py:1356` · `main.py:2678` | `_claim_recording_text_path` |
| B-033 | пять приватных предикатов слов | `remote_deepgram_live` (приватные) → `deepgram_dual.py:70-76` | повысить до публичного API и внести в `__all__` |
| B-034 | частота 16000 | `transcribe_gigaam.py:127, 236, 254, 255` | `audio_constants.LIVE_SAMPLE_RATE_HZ` |
| B-035 | префикс движка `"gigaam-"` | `models_manager.py:110, 164, 301` | `model_catalog.GIGAAM_MODEL_PREFIX` |
| B-036 | порог 64 байта | `transcribe.py:521` · `transcribe.py:555` | `_MIN_DECODABLE_WAV_BYTES` |
| B-037 | таймаут конверсии 300 с | `audio.py:456` · `audio.py:532` | `_LOCAL_CONVERT_TIMEOUT_SEC` рядом с `_REMOTE_COMPACT_TIMEOUT_SEC` |
| B-038 | форма конверта `{"type":"final"}` | `main.py:5210` · `main.py:5250` · `main.py:4262` | один блок `coverage` для обоих провайдеров и обеих веток |
| B-039 | смысл слова «auto» | `remote_deepgram.py:191-194` · `remote_deepgram_live.py:878` | один модуль `deepgram_language` на оба эндпоинта |
| B-040 | `_FINALIZE_DRAIN_CEILING_SEC` | `main.py:4300` · `tests/test_live.py:638` (литерал `0.24`) | импортировать константу в тест |
| B-041 | конструктор `DeepgramLiveConfig` | `main.py:4382` · `tools/deepgram_live_ab.py:154` | вынести `_live_config` в общий модуль |
| B-055 | вид маски провайдерского ключа | `config.py:415` · `frontend/src/main.tsx:1866` | один предикат `_is_masked_key`, знающий обе формы |
| B-058 | клампы Whisper-настроек | `transcribe.py:62-69` (код) vs `.env.example` (текст) | указать диапазоны в `.env.example`, как сделано для остальных |
| B-070 | отметка «уже выдано» | `live.py:419` (снимок) · `live.py:456` (живое поле) | одно выражение `self._last_emitted_end + emit_epsilon_sec` |
| B-084 | извлечение длительности из ответа провайдера | `main.py:5591` (форма Deepgram) применяется к OpenRouter (`:5649`) | ключ `duration` в контракте адаптера |

---

## 6. Гипотезы

Путь в коде подтверждён; срабатывание зависит от тайминга, окружения или формы ответа провайдера. Проверять — измерением, не рассуждением.

| ID | Что именно гипотеза | Чем проверить |
|---|---|---|
| B-008 | что подавление `CancelledError` действительно делает WS-обработчик незавершаемым | отменить задачу обработчика во время `finally` и посмотреть, дойдёт ли она до конца |
| B-009 | что отмена `ws.send` посреди управляющего кадра реально приводила к сериям зависаний | тот же анализ лога, что дал вывод для аудио-пути (§3.6) |
| B-011 | какое из трёх последствий гонки «cancel без await» проявляется первым | лог `dual-stream: secondary late` рядом с `Finalize`/`CloseStream` вторичной сессии |
| B-012 | частота пересечения `_swap_warm_socket` и `drain_transcript` | счётчик «swap in progress at finalize» в лог, наблюдение на коротких записях |
| B-032 | реальность гонки промоута и сохранения | одновременный `promote` + `save-with-audio` в один каталог |
| B-039 | влияет ли `detect_language` vs `multi` на качество REST-прочтения | A/B на сохранённых уликах тем же `tools/deepgram_live_ab.py` |
| B-042 | возвращает ли какая-либо из моделей upscale мультимодальную форму `content` | лог формы `content` на реальных вызовах |
| B-044, B-057 | срабатывание требует заданной переменной / не-словарного `preferences` | искусственно задать и посмотреть |
| B-045 | вероятность отказа `Thread.start()` | нагрузочный сценарий с исчерпанием потоков |
| B-046 | реально ли что-то выходит за обработчики воркера | добавить `add_done_callback` и посмотреть, зажжётся ли он |
| B-048 | передаёт ли кто-нибудь `stream=True` | сегодня — нет; проверять при добавлении провайдера |
| B-049 | ФС, отвергающая `chmod` под `DATA_DIR` | SMB/exFAT-каталог |
| B-053 | отправляет ли рендерер собственный ответ обратно в `PUT` | трассировка запросов рендерера (фронтенд вне периметра) |
| B-056 | достижим ли `_migrate_legacy_data` вообще | сегодня ни `<repo>/data`, ни `Resources/data` не существуют — функция мертва |
| B-066 | наличие неопрашивающего клиента | наблюдение за ростом `jobs` в долгой сессии |
| B-067 | одновременные `promote` для одного `session_id` | нагрузочный сценарий |
| B-069 | выдаёт ли декодер повтор внутри одного окна | лог `trim_repeated_prefix` с обоими текстами |

---

## 7. Где смотрели и не нашли ничего

Область считается закрытой только когда названы и находки, и чистые места. Ниже — второе.

**`backend/deepgram_endpoints.py`, `deepgram_words.py`, `deepgram_format.py`, `deepgram_keyterms.py`, `audio_constants.py`, `audio_mime.py`, `model_catalog.py`.** Семь SSOT-модулей, прочитанных целиком. Каждый действительно единственный источник своего решения, и каждый действительно потребляется обоими путями: `shared_format_params()` вызывается и из `remote_deepgram.deepgram_transcribe` (`:170`), и из `DeepgramLiveConfig.to_query_string` (`:855`); `deepgram_word_text` — из обоих; `keyterm_query_pairs` — из обоих, а `configured_keyterms` вызывается ровно в двух точках входа (`main.py:3806` live, `main.py:5656` REST), и REST-путь единственный, поэтому все удалённые вызовы получают keyterms. `model_catalog` не содержит ни одного продублированного списка моделей: `LOCAL_TRANSCRIPTION_MODELS`, `LOCAL_LIVE_PREVIEW_MODELS`, `DEFAULT_LIVE_PREVIEW_LOCAL_MODEL`, `OPENROUTER_UPSCALE_FALLBACK_MODELS` выведены, а не переписаны, и фронтенд получает их через `health_model_catalog()`. `deepgram_endpoints` корректно деградирует на кривом `TRANSCRIPTOR_DEEPGRAM_HOST` вместо падения — та самая политика, отсутствие которой отмечено в B-021.

**Безопасность.** Ключи Deepgram и OpenRouter уходят только в заголовок `Authorization` (`remote_deepgram.py:199`, `remote_deepgram_live.py:1139`, `remote_openrouter.py:103, 212`) и ни разу в query-строку; ни один вызов логгера не форматирует ключ или словарь заголовков. `_safe_error_text` (`main.py:455`) применяется на каждой границе, где ошибка уходит наружу (WS-ошибки, финальный конверт, ветка провала connect, ошибки заданий), и порядок регулярок — кавычки, путь, токен — до усечения корректен. `redact_config` обходит `providers.keys()`, а не жёсткий кортеж. Единственная утечка — пять символов ключа в `_redact_provider_key_value`, и она осознанная. Проверок на инъекцию и обход путей: `_normalize_filename` (`:1760`), `_validate_audio_filename` (`:1808`), `_recording_path_or_404` (`:2731`), `_resolve_recordings_target_dir` (`:2741`), `_resolve_source_media_path` (`:1821`) — нормализация обратных слэшей до `basename`, NFC, зарезервированные имена Windows, отказ на пустое расширение, `resolve()`-затем-`relative_to(home)` (побег по симлинку закрыт), 409 при несовпадении коллекции. В `audio.py` инъекции нет: каждый `path_in` стоит после `-i` (ведущий дефис съедается как значение опции), каждый выходной путь генерируется сервером. Ни одного `shell=True` во всём бэкенде. Пикер папок и `open-folder` (`main.py:6419-6626`) — только argv-списки, UTF-8 форсирован с обеих сторон PowerShell, домашняя директория проверяется и на чтении, и на записи.

**Аутентификация и сетевые границы.** Константное сравнение токена на обоих путях (HTTP `_require_api_auth:1406`, WS `:3733`); Host-guard применён и в middleware, и отдельно в WS-области, где middleware не работает; разбор IPv6-скобок и одиночного двоеточия корректен; декодер subprotocol-токена отвергает битый base64 без утечки. Rate-limit (`:896-961`): монотонные часы, prune дека, оппортунистический GC раз в 30 с, жёсткий потолок ключей.

**Атомарность записи.** `backend/storage.py` целиком: tmp в том же каталоге → `fsync` дескриптора → `os.replace` → `fsync` родительского каталога, с удалением tmp на каждом пути ошибки; `O_EXCL` для варианта с правами; `rotate_backup` не фатален по замыслу. Все четыре заявленные в докстринге гарантии реализованы. Единственный дефект — отсутствие параметра `mode` (B-054).

**Конфигурация — то, что оказалось верным.** Алиасинг `DEFAULT_CONFIG` при неглубоких `dict()`-копиях (`:528, 572, 575, 592, 595`) проверен эмпирически и безопасен: все мутирующие места копируют перед изменением, а шифрование/расшифровка/редактирование ходят через `json.dumps`. Потерянных обновлений нет: `_CONFIG_IO_LOCK` (RLock) охватывает и `load_config`, и весь цикл чтение-слияние-валидация-шифрование-запись в `save_config`, а `save_config` сливает частичное обновление, а не перезаписывает. Гонка создания keyfile (`O_CREAT|O_EXCL|0600` + `FileExistsError` → перечитать) корректна. `_rotate_backup_if_primary_valid` действительно перепарсит основной файл перед ротацией. Сохранение провайдерских ключей при недоступном Fernet (`:349-412`) корректно на каждой ветке. Ни одного `except: pass`, проглатывающего реальный сбой: три широких `except` (`:712, 888, 919`) имеют написанное обоснование, которое **совпадает** с кодом и с контрактом «`load_config` никогда не бросает», а `save_config` корректно пробрасывает `OSError`.

**Порт, хоткеи, ретенция, модели — дублирования нет.** `DEFAULT_BACKEND_PORT = 8321` существует только в `desktop/main.js:365`; бэкенд не читает `TRANSCRIPTOR_PORT` и не содержит литерала порта. `desktop/shortcut-defaults.json` — настоящий единственный источник хоткеев, инжектируемый в рендерер как `__SHORTCUT_DEFAULTS__`; копии в бэкенде нет. Дефолты ретенции (`100` / `604800` / `3600`) живут только в `main.py:2851/2855/2875`, семантика «0 отключает» совпадает с `.env.example`. Идентификаторы моделей — только в `model_catalog`.

**Ретенция и подметание.** `_prune_recording_audio` / `_sweep_recording_audio_retention` (`main.py:2815-3349`): индекс стемов строится один раз, транскрипты никогда не кандидаты, `keep_stems` соблюдается, файлы из будущего сохраняются, tie-break по `max_items` детерминирован, таблица политик — единственное место, где живёт правило. Реестр архивных каталогов (`:3204-3308`) под локом, атомарен, терпит порчу файла, дедуплицирован по разрешённому пути. `_sweep_orphan_tmp_files` (`:828-875`) обходит все шесть каталогов плюс зарегистрированные архивы с отсечкой 60 с и терпимостью к `OSError` — неверна только регулярка (B-017). `_delete_all_recordings_sync` (`:6877`) — корректный move-aside/rollback, и его имя резервной копии односуффиксное, поэтому B-017 его не задевает. Потолок промоута выведен из потолка спула (`MAX_RECOVERY_PROMOTE_BYTES = MAX_LIVE_RECOVERY_BYTES`) — прежнее расхождение действительно закрыто.

**Кеши списка записей.** Двойная проверка блокировки корректна, кеш записей ключуется на `(mtime_ns, size)` и подрезается до живого набора при каждом скане, индекс аудио заменил пофайловую пробу, оба маршрута `async` со сканом и вычислением ключа в пуле.

**Задания и ретраи.** `jobs.py`: охрана терминальных состояний на всех четырёх сеттерах, монотонный прогресс, идемпотентная отмена, `terminal_observed_at` выставляется ровно один раз. `http_retry.py`: `_log_target` действительно выкидывает query-строку, `_parse_retry_after` устойчив к `nan`/`inf`, гейт идемпотентности корректно исключает `ConnectTimeout` из нератраибельных, `attempts = max(1, …)` закрывает дыру при `retries <= 0`.

**Локальная транскрипция.** Двойная проверка блокировки в `_model` корректна (свой лок на имя для загрузки, `_MODEL_LOCK` на вставку и вытеснение, `KeyError` у `move_to_end` обработан, LRU вытесняет с головы). `_is_empty_sequence_transcribe_error` действительно покрывает обе формулировки. `_build_result` и `merge_channel_transcripts` возвращают совпадающие наборы ключей. Сброс ссылки на словарь моделей во время активного декодирования безопасен — вызывающий держит свою ссылку. В `transcribe_gigaam`: `_chunk_bounds` завершается и покрывает `[0, total_sec]` без дыр и off-by-one; `_merge_overlapping_words` — корректные bisect-окно, порядок `(start, -duration)` и сравнение с epsilon; соглашение о ведущем пробеле переживает перегруппировку. В `models_manager`: `WHISPER_REPOS` выведены из каталога, `SIZE_HINTS` покрывают все идентификаторы, три причины отказа удаления соответствуют коду, ветка «на диске ничего нет» всё равно вытесняет из памяти, атомарная проверка-и-установка на `:324` действительно атомарна.

**Локальный live-ассист.** Удержание кольца (`live.py:229-234`) корректно, инвариант совпадает с `_max_window_sec` (кольцо ≥ 18 с, окно ≤ 17 с). `_get_last_samples` вызывается только под `self._lock`. `trim_repeated_prefix` корректен, включая токены только из пунктуации внутри совпавшего прогона и приоритет самого длинного совпадения. Логика single-flight в `maybe_transcribe` верна для реальной топологии вызывающих. `_covered_sec` двигается только после успешного прохода, а `complete` требует нулей и по `uncovered_tail_sec`, и по `dropped_sec`.

**OpenRouter.** Переопределение `RemoteError = OpenRouterError` последовательно (каждый `raise` в модуле даёт подкласс, `main.py:80` импортирует подкласс по имени); `_openrouter_audio_format` корректно обходит баг `audio/mpeg → mpeg`, который сам документирует; сужение проверки BUG-66 до фраз `input_audio`/`image input` действительно уже прежнего голого `"image"`; охрана `content is None` и отказ возвращать `str(js)` как транскрипт — оба реальны; ключ не попадает ни в лог, ни в тело ошибки; адаптивные ярусы таймаутов монотонны.

**Deepgram live — то, что оказалось верным.** Разделение `_closed` и `_close_ran` действительно закрывает описанную утечку сокета; `_enqueue_event` сохраняет FIFO при вытеснении (осушить всё → выкинуть первый интерим → дописать событие в хвост) — прежнее переупорядочивание финалов исправлено; sentinel действительно приземляется всегда; снимок `self._ws` перед `send` в keepalive-цикле закрывает описанную гонку с `close()`; `_recv_loop` и `_keepalive_loop` явным `raise` пробрасывают `CancelledError` (правильная форма, отсутствующая в 13 местах из B-008); `_as_float` защищает приёмный цикл от кривого кадра; классификация `InvalidStatus` по кодам 400/401/402/403/429 разумна и разбирает `err_msg` Deepgram; ретрай коннекта на `OSError` (DNS/RST) добавлен в соответствии с докстрингом. Порядок стопа «сначала конверт, потом teardown» (C4) реализован именно так, как описан. Ordering «весь захваченный звук, потом `Finalize`» держится на очереди и sentinel, а не на sleep — правильное решение. `_offer_pcm` объявляет отброшенные байты сессии, так что арифметика покрытия видит честную длину записи.

**Dual-stream — то, что оказалось верным.** `events()` фасада корректно переживает подмену primary (перечитывает `self.primary` после конца потока и завершается только если это тот же объект) — редкий и правильно решённый случай. `dual_stream_enabled` действительно спрашивает `resolve_live_language`, а не собственную копию правила. `stats.dual_stream` честно отражает, был ли merge. `_merged_uncovered_speech_sec` считается по слитому списку, что единственно корректно.

**Тесты — то, что оказалось верным.** Ни одного случая «замокали то, что тестируем»: проверены все 154 цели `mock.patch`/`patch.object`, каждая — легитимная заглушка соседа, и каждая строка-цель разрешается в реальный символ модуля (немых патчей нет). Ни одного случая переписывания продакшн-логики в тесте: AST-скан всех не-`test_` хелперов по плотности управляющих конструкций дал только два `setUpClass` с оркестрацией подпроцессов. Ни одного теста, ходящего в реальную сеть, и ни одного, пишущего вне временного каталога. `test_deepgram_keyterms.py:165-186` намеренно **отказывается** переписывать дефолты, а `test_deepgram_format_ssot.py` — специально написанный анти-дублирующий тест. `test_deepgram_dual.py` (41 тест) — самый качественный модуль набора.

**Инструмент A/B.** `tools/deepgram_live_ab.py` жив (на него ссылаются `PROJECT_STRUCTURE.md:59`, `CHANGELOG.md`, `BUGS_AUDIT_2026-09-03.md:281`, `remote_deepgram_live.py:808`, `deepgram_keyterms.py:8`) и не дублирует ни одного продакшн-правила: `normalize_keyterms`, `DEFAULT_DEEPGRAM_AUDIO_MODEL`, `secondary_config`, `DualLiveSession`, `LIVE_SAMPLE_RATE_HZ`, `load_config` — всё импортировано; сессии открываются через штатный `DeepgramWarmPool.acquire`, а не через `connect()`, с объяснением почему. Единственное замечание — B-041.

**Зависимости.** `requirements.runtime-lock.txt` соответствует собственной политике: содержит транзитивные плюс точные пины для пяти диапазонных прямых, и каждый пин удовлетворяет своему диапазону. Сверка с реальными метаданными установленного рантайма (`faster_whisper-1.0.3.dist-info/METADATA`: `av<13,>=11.0`, `ctranslate2<5,>=4.0`, `tokenizers<1,>=0.13`, `onnxruntime<2,>=1.14`) конфликтов не выявила. `websockets>=13.0` — корректный минимум для `websockets.asyncio.client` / `InvalidStatus`, которые используются на `remote_deepgram_live.py:56-57`. Четыре объявленных-но-неимпортируемых пакета (`uvicorn`, `httptools`, `python-multipart`, `urllib3`) — намеренные и с записанным обоснованием; дефектами не являются.

**Загрузка и бутстрап.** Дедупликация обработчиков логирования, `propagate = False`, фильтр access-лога (глушит только совпавшую пятёрку uvicorn и никогда не 2xx), watchdog смерти родителя (env-гейт, `isatty`-гейт, обоснование `os._exit`), lifespan (демон-потоки, отменяемая и ожидаемая задача boot-прогрева, дренаж заданий с потолком 1.5 с, закрытие пула с потолком 1.0 с — в заявленном порядке) — всё соответствует документации.

---

## 8. Что дальше

Отчёт — фаза DISCOVERY: правки не вносились, коммитов нет, рабочее дерево не тронуто. Порядок починки по вкладу в симптом, а не по номеру:

1. **B-005** — корневая причина задержки стопа; её устранение делает осмысленным пересмотр трёх констант ожидания и, возможно, снимает часть B-024.
2. **B-001, B-002** — dual-stream включён по умолчанию, и оба дефекта лежат на пути каждой Auto-записи.
3. **B-006, B-007** — решения о полноте конверта и о ретрае принимаются по числам, которые лгут.
4. **B-003, B-004** — вернуть тёплому пулу смысл на dual-записи.
5. **B-018, B-020, B-021, B-019** — конфигурация: разрушение резервной копии, необратимые состояния и падение при старте.
6. Остальное — по таблицам §5.1 и §5.2, каждая строка которых имеет один адрес назначения.
