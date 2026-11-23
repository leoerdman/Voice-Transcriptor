# Ultra-Audit · FRONTEND · фаза DISCOVERY

**Дата:** 2026-09-04
**База аудита:** `HEAD = 0de0c2d3f09fe3c980c6e849debc70ffad77a52e` (ветка `main`),
снимок `git show HEAD:frontend/src/*` в
`…/scratchpad/head/` — все номера строк ниже относятся к нему.
**Объём:** `frontend/**` — `index.html` (842), `src/` (14 897 строк `main.tsx`
+ 17 модулей + `pcm-worklet.js` + `styles.css`), `tests/` (17 файлов, 253 теста),
`vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`,
`package.json`.

## ⚠️ Состояние рабочего дерева на момент аудита (in-flight)

Параллельный агент **прямо во время аудита** переписывает stop-путь. На старте
`git status` по `frontend` был чист; к середине работы:

```
 M frontend/src/envelope-deadline.ts   +108 −…
 M frontend/src/live-coverage.ts       295 → 134
 M frontend/src/live-source.ts         397 → 171
 M frontend/src/main.tsx               14 897 → 14 764
 M frontend/src/text-match.ts
 M frontend/src/transcript-merge.ts    993 → 64
   всего 255 insertions(+), 1584 deletions(-)
```

**Обновление к концу аудита.** Правка была доведена и закоммичена: `HEAD`
переехал `0de0c2d` → `e8f1632` → **`889c91a`** («The renderer stops assembling a
transcript at stop and delivers the backend's envelope verbatim…»), суммарно
`+558 / −3298` по одиннадцати файлам фронтенда. Аудит остаётся привязан к
`0de0c2d`; перед починкой номера строк надо перепривязать. Что я успел
проверить на новом `HEAD`:

| Находка | Статус на `889c91a` |
|---|---|
| **F-001** (тёплый захват мёртв) | **открыта**, дословно: `getTracks().stop()` на `main.tsx:10822`, `holdWarmCapture()` на `11065` |
| **F-002** (автосейв после провала `loadCfg`) | **открыта**, `suppressUiPrefAutosave = false` в `finally` на `6395` |
| **F-003** (auto-stop-silence ×4) | **открыта** |
| **F-004** (копия `normalizeWords`) | **закрыта** рефакторингом — `transcript-merge.ts` ужат с 993 до ~64 строк вместе с LCS-машинерией |
| **F-005** (`transcriptSource` в ветке OpenRouter) | вероятно открыта — символ на месте (9 упоминаний), нужна перепроверка ветки |
| **F-006** (`diarize` мимо снапшота) | **открыта**, 4 прямых чтения DOM |
| **F-011** (два `catch { }`) | **открыта**, `10375` и `13337` |
| **F-014** (`wordCountOf`) | **закрыта** рефакторингом |
| Регионы **U / R / C** | рефакторинг их файлов не касался (`main.tsx` 6819-14897, `index.html`, `styles.css`, конфиги) — находки в силе |

Ниже — состояние дерева на середину аудита, оставлено как свидетельство того,
в каком виде код был прочитан.

В этом промежуточном состоянии дерево **не собиралось**: `main.tsx` использовал
`chooseStopTranscript`, `envelopeCoversRecording`, `decideDeadStreamRecovery`,
`textFromEnvelope`, `composeCanonicalLiveSourceText`, `boundRecoveredTail`,
`interimWindowOutrunsCoverage`, `retiredInterimTailBeyondCoverage`,
`uncoveredInterimTail`, но импортирует из `./transcript-merge` только
`joinTranscriptSegments` и `richerTranscript`, а из `./live-source` — только
`mergeInterim`. Это **не дефект кодовой базы**, это незавершённая правка
соседнего агента; аудит зафиксирован на HEAD. Одно следствие: находки по
`transcript-merge.ts` / `live-coverage.ts` / `live-source.ts` могут быть закрыты
или переписаны этим рефакторингом — перед починкой сверить с новым HEAD.

Backend в дереве тоже правится (`deepgram_dual.py`, `remote_deepgram_live.py`,
их тесты) — вне зоны этого отчёта.

## Как проверялось

1. **HISTORY** — `git log --oneline -40 -- frontend`, `git log --stat -12`,
   `git log -L` по конкретным строкам, `git show` по коммитам волн 1-3 и 1.6.0.
   Искались: костыли, временные обходы, недоделанные переименования, добавленный
   но не вызываемый код, поведение, изменённое в одном месте из двух, TODO
   вместо реализации. Маркеров `TODO/FIXME/HACK/XXX/workaround/for now` в
   `frontend/**` — **ноль** (`grep -rn` по `src`, `index.html`, `tests`).
2. **STRUCTURE** — карта символов `main.tsx` (`grep -n "^async function|^function|
   ^const [A-Z_]* ="`, 900+ строк), покрытие по регионам (таблица ниже),
   автоматический поиск неиспользуемых функций (каждая из 400+ функций
   `main.tsx` имеет ≥1 вызов — мёртвых функций нет) и экспортов без импортёров.
3. **PRODUCT SCENARIOS** — сквозной проход по путям: hotkey start → capture →
   live preview → stop → delivery → paste hand-off; warm capture + pre-roll;
   settings load/save (keyterms, dual-stream); upload queue; history/search/
   player; upscale; update check; local model UI; error surfaces. Швы:
   warm hold × device change × sleep; preview buffer × envelope; settings
   autosave × backend validation; mic-health FSM × capture fallback;
   short-recording discard × pre-roll.
4. **Эмпирика.** Там, где код давал проверяемое предсказание, оно сверено с
   реальным логом установленной сборки 1.6.0
   (`~/Library/Application Support/transcriptor/main.log`) — см. F-001.

Прочитано: `AGENTS.md`, `BUGS_AUDIT_2026-09-03.md` (включая «Реестр долга» и
«Состояние на 2026-09-04»), `docs/archive/NEXT_SESSION_2026-09-04.md`, `CHANGELOG.md`.
Пункты, закрытые в 1.5.0/1.6.0, не переоткрываются; открытые пункты реестра
помечены `known-but-open`.

Работа велась четырьмя параллельными потоками по непересекающимся регионам
(префиксы находок: **F** — ядро capture/live/stop и чистые модули, **U** —
upload queue / boot / update-check / поллы, **R** — History / плеер /
`saveRecordingText` / DOM-обвязка, **C** — типы / `UI_TOKENS` / каталог моделей /
статусы / api / конфиги / `index.html` / `styles.css`). Нумерация оставлена
порегионной: это единственный способ проследить, кто на что смотрел.

---

## Сводка: сколько и чего

Всего выписано **96** пронумерованных находок (F-001…F-017, U-001…U-023,
R-001…R-031, C-001…C-025). Пять из них — один и тот же дефект, найденный
дважды из разных регионов (перечислены ниже), поэтому **уникальных дефектов 91**.

| | подтверждено | гипотеза (целиком или частью) | всего |
|---|---|---|---|
| **P0** | 1 | 0 | **1** |
| **P1** | 22 | 1 | **23** |
| **P2** | 57 | 10 | **67** |
| **Итого** | **80** | **11** | **91** |

Отдельно, вне этого счёта: **49 позиций** в индексах «костыли/workarounds» и
**68 строк** в индексах «хардкод → SSOT» (пересекаются с находками выше — это
те же дефекты, посчитанные по другому признаку), плюс **6 гипотез**, не
доведённых до статуса находки (список в конце регионa F).

### P0

* **U-001** — сорванный `GET /api/ui/upload-queue` на старте затирает серверный
  снапшот пустым `PUT`; бэкенд пишет файл целиком, транскрипты завершённых
  загрузок уничтожаются без возможности восстановления. Проверено дважды
  (независимо субагентом и мной по HEAD-снимку + `backend/main.py:1510-1514`).

### P1 — по одной строке

| ID | Суть | Статус |
|---|---|---|
| **F-001** | Тёплый захват микрофона и pre-roll не включались **ни разу**: треки глушатся на 240 строк раньше решения об удержании. Подтверждено продакшн-логом: 15/15 стопов `reason=track-ended`, 14/14 стартов `warm=0 preRollMs=0` | подтверждено |
| **F-002** | Провал `/api/config` на старте не блокирует автосохранение → первое же действие пользователя перезаписывает keyterms, путь архива, микрофон, модель апскейла и оба хоткея дефолтами | подтверждено |
| **F-003 / S-03** | Дефолты и границы auto-stop-on-silence записаны 4 раза в 3 слоях, ни разу — в `UI_TOKENS`; бэкенд их не валидирует вовсе | подтверждено (найдено дважды независимо) |
| **F-004** | `transcript-merge.ts` держит копию `normalizeWords` из `text-match.ts` — модуля, объявленного в своей же шапке единственным источником этого правила | подтверждено |
| **F-005** | Ветка OpenRouter не проставляет `transcriptSource` → трасса `FINAL` врёт о происхождении доставленного текста для целого провайдера | подтверждено |
| **F-006 / R-004 / R-030** | `diarize` не входит в снапшот сессии и читается из DOM шестью инлайновыми кастами в момент восстановления → live-стрим и recovery могут расшифровать одну запись с разной разметкой говорящих; вдобавок настройка не сохраняется между запусками, в отличие от близнеца `#uploadDiarize` | подтверждено |
| **U-002** | Весь CSS блока проверки обновлений лежит в `frontend/styles.css`, который не подключён ни к чему (собирается `frontend/src/styles.css`) | подтверждено |
| **U-003** | После «Clear done» правая панель показывает транскрипт удалённого элемента и живую кнопку «Reveal in folder» | подтверждено |
| **U-004** | Upload молча подменяет провайдера на local; у Live-пути для этого факта есть текст, у очереди — ничего | подтверждено |
| **U-005** | `gated-poll.refreshNow()` теряет событие `online`/`offline`, если tick уже в полёте → до 10 с неверное `isRemoteProviderReachable`, и запись уходит к недоступному облаку вместо local | подтверждено |
| **U-006** | Путь чтения заводит `uploadQueueServerVersion` как SSOT версии схемы, путь записи шлёт литерал `1` | подтверждено |
| **R-001** | Фоновый рефреш History сбрасывает окно списка до 200 строк — keyed-реконсилятор сохраняет узлы, а сброс их тут же удаляет; симптом, ради которого он написан, остался | подтверждено |
| **R-002 / C-005** | Guard устаревшего рендера аудио стоит только на успешной ветке → утечка ObjectURL и подмена плеера аудиозаписью прошлой сессии | подтверждено (найдено дважды независимо) |
| **R-003** | Результат «Удалить всё», включая частичный провал, не показывается вообще: одна поверхность скрыта, вторая затирается через строку | подтверждено |
| **R-005 / U-021** | Полная O(N) фильтрация архива на каждое событие скролла, дважды за кадр при росте окна — прямо против цели `list-window.ts` | подтверждено |
| **R-006** | Разметочный дефолт `#deepgramDualStreamCheck` (снят) противоречит бэкендовому (`True`); при провале `loadCfg` автосейв запишет `dual_stream: false` и сотрёт keyterms | гипотеза |
| **C-001** | Guard идемпотентности `#providerSelect` сломан навсегда (подпись не знает про опцию `None`) → селект полностью пересобирается каждые 10 с, закрывая открытый dropdown | подтверждено |
| **C-002** | Состояние «None» пропускает присваивание `sel.value` → селект показывает «Local Whisper», хотя SSOT говорит «None» | подтверждено |
| **C-003** | Кнопка «Download» в модалке моделей **не скачивает ничего**: `pendingModelSelection` на момент подтверждения всегда `null` | подтверждено (проверено дважды) |
| **C-004** | Выбор облачной модели Deepgram/OpenRouter открывает диалог о скачивании весов на диск; на элементе висят два конкурирующих `change`-обработчика | подтверждено |
| **C-006** | CSP `connect-src … ws: wss:` — scheme-source, матчит любой хост; комментарий рядом обещает same-origin | подтверждено |
| **C-007** | Inline-фолбэк boot-оверлея написан через id-селекторы и потому всегда побеждает дизайн-систему; `styles.css:3448-3546` — мёртвый код | подтверждено |
| **C-008** | `.btn-primary` определён дважды; однострочник с единственным не-a11y `!important` гасит дизайн-системное правило и рисует все первичные кнопки вне палитры (`#5b8cff` по несуществующему токену `--accent`) | подтверждено |

### Что подтвердилось независимо в двух регионах

`F-003`↔`S-03` (дубли auto-stop), `R-002`↔`C-005` (guard рендера аудио),
`F-010`↔`C-023` (`tests/` не типизируется), `R-005`↔`U-021` (нетроттленный
скролл), `F-006`↔`R-004`/`R-030` (`diarize`), `F-011`↔`K-7` (`catch { }`),
`F-012`↔`R-018` (пустая ветка `if`), `R-016`↔`S-05` (дефолты dual-stream).
Каждый такой случай проверялся с двух сторон и с разных входов.

---

## Таблица покрытия

| Область | Статус | Чем покрыто | Почему не полностью |
|---|---|---|---|
| `main.tsx` 1–892 (типы, `parseLiveWsMessage`, форматтеры, appearance) | делегировано | субагент C (регион 1–3460) | — |
| `main.tsx` 892–1039 `UI_TOKENS`, storage-ключи | reviewed | чтение целиком | — |
| `main.tsx` 1039–3460 (каталог моделей, локальные модели, статусы, api*) | делегировано | субагент C | — |
| `main.tsx` 2432–2600 (провайдеры, `sanitizeUiErrorMessage`, нормализация) | reviewed | чтение | — |
| `main.tsx` 3114–3130 auto-stop-silence | reviewed | чтение + сверка с index.html и desktop | — |
| `main.tsx` 3427–3820 PcmSink / OPFS / MemoryPcmSink | reviewed | чтение целиком | — |
| `main.tsx` 3846–3951 canonical audio + MediaRecorder flush | reviewed | чтение | — |
| `main.tsx` 3953–4500 (jobs, remote/local, очередь) | partial | чтение сигнатур + вызовов из stopLive | тело job-хелперов дублируется по 6 вариантам; проверены контракты, не каждая ветка |
| `main.tsx` 4408–4760 (recovery-сессии, `resolveLiveWsMode`, warmup, `switchView`) | reviewed | чтение | — |
| `main.tsx` 4783–5014 (mics, constraints, `acquireMicStream`, VU) | reviewed | чтение целиком | — |
| `main.tsx` 5073–5347 live-draft (схема, очередь, recovery) | reviewed | чтение целиком | — |
| `main.tsx` 5347–5410 keyterms / dual-stream чтение | reviewed | чтение + сверка с `deepgram-dual.ts` и backend | — |
| `main.tsx` 5411–5760 shortcut picker | partial | чтение структуры + миграций в `loadCfg` | клавиатурный автомат `keyEventToAccelerator` прочитан по сигнатуре |
| `main.tsx` 5756–6171 upscale (пресеты, SLA, nonce) | reviewed | чтение целиком | — |
| `main.tsx` 6171–6470 ui-prefs save + `loadCfg` | reviewed | чтение целиком | — |
| `main.tsx` 6470–6820 ключи провайдеров, Settings-обвязка | partial | чтение `validateProviderKey` + вызовов | остальное — обработчики DOM, покрыто субагентом |
| `main.tsx` 6819–8360 (история, поиск, плеер, `saveRecordingText`, DOM-обвязка) | делегировано | субагент R | — |
| `main.tsx` 8360–9140 (ws-кадры, capture, warm capture, worklet) | reviewed | чтение целиком | — |
| `main.tsx` 9141–9930 (сессионные буферы, конверт, output SSOT, бюджет) | reviewed | чтение целиком | — |
| `main.tsx` 9932–10125 `pushCapturedFrame`, `flushWorkletPort` | reviewed | чтение целиком | — |
| `main.tsx` 10125–10736 `startLive` | reviewed | чтение целиком | — |
| `main.tsx` 10736–13048 `stopLive` (2312 строк) | reviewed | чтение целиком, шестью проходами | — |
| `main.tsx` 13048–14897 (bootstrap, update-check, boot overlay, upload queue) | делегировано | субагент U | — |
| `capture-warm.ts` | reviewed | чтение целиком + тест | — |
| `pcm-worklet.js` | reviewed | чтение целиком + тест | — |
| `live-coverage.ts` | reviewed | чтение целиком | — |
| `transcript-merge.ts` | reviewed | структура + `textFromEnvelope`/`richerTranscript`/`candidateConfirms…`/константы; `chooseStopTranscript`/`mergeReadings` — по контракту вызовов из `stopLive` | 993 строки DP-выравнивания; арифметика LCS не переигрывалась вручную |
| `text-match.ts` | reviewed | чтение целиком | — |
| `envelope-deadline.ts` | reviewed | чтение целиком + тест | — |
| `live-source.ts` | partial | экспорты + использование из `main.tsx` | активно переписывается параллельным агентом |
| `mic-health.ts` | partial | экспорты, интеграция, отсутствие тестов | FSM-переходы не разбирались построчно — см. F-009 |
| `audio-levels.ts` | partial | использование из `pushCapturedFrame`/`captureSilenceSnapshot` + тест | — |
| `deepgram-dual.ts`, `recordings-list-reconciler.ts` | делегировано | субагент R | — |
| `gated-poll.ts`, `list-window.ts`, `update-check.ts` | делегировано | субагент U | — |
| `error-text.ts`, `shortcut-display.ts`, `transcription-catalog.ts`, `live-pane.ts` | делегировано | субагент C | — |
| `index.html` (CSP, id-контракт) | reviewed частично | CSP прочитан целиком; id-контракт делегирован субагенту C | — |
| `styles.css` (106 KB) | делегировано | субагент R (мёртвые классы) | — |
| `vite.config.ts` / `vitest.config.ts` / `tsconfig.json` / `eslint.config.js` / `package.json` | reviewed | чтение целиком | — |
| `tests/**` | reviewed | плотность ассертов по каждому файлу, поиск `vi.mock` | — |
| Контракт IPC `window.transcriptor` ↔ `desktop/preload.js` | reviewed | сверка полей в обе стороны | — |

### Где смотрел и НЕ нашёл дефектов

* **Безопасность.** `innerHTML` в `main.tsx` — 12 мест, из них 11 присваивают
  `""` (очистка контейнера) и одно (`14613`) пишет статический литерал без
  пользовательских данных. Ни одного `insertAdjacentHTML`, `outerHTML`,
  `document.write`, `eval`, `new Function`. Имена записей и текст транскрипта
  идут только через `textContent`. CSP в `index.html:22` жёсткий:
  `object-src 'none'`, `frame-src 'none'`, `base-uri 'none'`,
  `form-action 'none'`, `connect-src 'self' ws: wss: https://api.github.com`;
  `script-src 'unsafe-inline'` объяснён bootstrap-инъекцией бэкенда.
  `assetsInlineLimit` в `vite.config.ts` специально исключает воркelet, чтобы
  он не стал `data:`-скриптом и не был отбит этой же CSP. **Дефектов нет.**
* **Мёртвые функции в `main.tsx`.** Автоматически проверены все 400+
  объявлений `function`/`const … = (`: у каждой ≥1 вызов. **Дефектов нет.**
* **Контракт IPC.** `publishRecordingOutput` шлёт
  `{recordingId, text, final, source}`; `desktop/preload.js:92` копирует ровно
  эти четыре поля; `onSystemSuspend` отдаёт `{reason}`, `main.tsx:8984` читает
  ровно `reason`. **Расхождений нет.**
* **Качество тестов.** 253 теста в 17 файлах, у каждого файла ассертов больше,
  чем тестов (минимум 6/5 в `envelope-deadline`, максимум 39/8 в
  `recordings-list-reconciler`). `vi.mock`/`jest.mock` — **ноль вхождений**:
  ни один тест не подменяет предмет проверки. Тестов без `expect` нет.
* **Гонки сессий в live-пути.** `liveFinalSlots` / `liveTranscriptBuffers` /
  `liveStreamErrors` / `finalizeBudgetSlots` — все четыре Map’а ключуются
  токеном сессии и удаляются в `finally` у `stopLive` (12973-12995); поздний
  `ws.onopen` привязан к `sessionSocket`, а не к модульному `ws` (10297);
  `ws.onmessage` сверяет `activeUiSessionToken === sessionUiToken` перед
  проекцией в активное состояние. **Утечек и протечек между сессиями не нашёл.**
* **`envelopeCoversRecording` × `decideDeadStreamRecovery`.** Проверял
  асимметрию: первый предикат не требует доказательства речи в хвосте, второй
  требует. Ветка, где это могло бы дать лишнюю full-audio recovery на чистой
  тишине (`main.tsx:12205`), достижима только при
  `tailHasInterimSpeechEvidence === true`, то есть доказательство речи уже есть.
  **Дефекта нет.**
* **`acquireMicStream`.** Поздно приехавший stream останавливается
  (`4956-4959`), таймер гасится в `.finally` (4972-4974), отказ в правах не
  ретраится (4983). **Дефектов нет.**
* **`OpfsPcmSink` барьер `closing`.** `closing` ставится ДО `await close()`,
  `flushPending` и `scheduleFlush` проверяют именно его, а не `writable`;
  «отставшие» сэмплы считаются, а не теряются молча. **Дефекта нет**
  (это и есть фикс `1776969`).
* **`__transcriptorFinishedRecords`.** Ограничен `slice(-30)`, ключуется
  `recordingId`, чистится не через `clearRecordingOutput` намеренно и с
  объяснением. **Неограниченного роста нет.**

---

## P0

Дефектов класса P0 (потеря данных / безопасность / крэш-зависание на нормальном
пути / сломанная сборка) в коде HEAD **не найдено**. Сломанная сборка в рабочем
дереве — это незавершённая правка параллельного агента, а не дефект HEAD (см.
раздел «Состояние рабочего дерева»).

---

## P1

### F-001 · Тёплый захват микрофона и pre-roll не включались ни разу: треки останавливаются до решения о удержании

**Файл:** `frontend/src/main.tsx:11031` (`stopLive`, шаг 1 «tail-preserving stop
sequence») против `frontend/src/main.tsx:11274` (`holdWarmCapture`);
предикат — `frontend/src/capture-warm.ts:135` (`decideWarmHold`).

**Суть.** `stopLive` в самом начале безусловно глушит все треки:

```ts
// main.tsx:11030-11035
try {
  if (stream) stream.getTracks().forEach((t) => t.stop());
} catch (e) {
  console.debug("MediaStream stop failed (non-fatal)", e);
}
mark("stream.getTracks.stop");
```

`MediaStreamTrack.stop()` синхронно переводит трек в `readyState === "ended"`.
Через ~240 строк, уже в teardown, вызывается решение об удержании графа:

```ts
// main.tsx:11274
const warmHold = holdWarmCapture();
```

а внутри (`main.tsx:8851-8862`) оно спрашивает `streamHasLiveAudio(stream)`,
то есть «есть ли трек в состоянии `live`». Треков в `live` уже нет, поэтому
`decideWarmHold` всегда возвращает `{hold: false, reason: "track-ended"}`.
Следом `takeWarmCapture` на следующем старте не находит удержания, pre-roll-кольцо
воркlet’а никогда не «взводится» (сообщение `{type:"arm"}` отправляется только
из `holdWarmCapture`, `main.tsx:8883`), и `acceptPreRoll` не вызывается никогда.

**Как наблюдать.** Трасса в самом коде это и печатает. В логе установленной
сборки 1.6.0:

```
$ grep -o "warm hold=[01] reason=[a-z-]*" ~/Library/Application\ Support/transcriptor/main.log | sort | uniq -c
  15 warm hold=0 reason=track-ended
$ grep -o "\[trace startLive\] total=[0-9]*ms to first audio frame warm=[01] preRollMs=[0-9]*" … | sort | uniq -c
  14 записей, у ВСЕХ warm=0 preRollMs=0, total 139…412 ms
```

15 остановок из 15 — `track-ended`; 14 стартов из 14 — холодные, pre-roll = 0.

**Последствие.** Пункт 2 реестра долга («Pre-roll / тёплый микрофон — ✅ СДЕЛАНО,
`443cc7a`») и весь §4.7 аудита 2026-09-03 фактически не работают: каждый старт
по-прежнему платит `getUserMedia` + `AudioContext` + первый кадр (измерено
139-412 мс в этом же логе), и первый слог фразы, начатой на нажатии, по-прежнему
отсутствует и в WAV, и в стриме. Дополнительно: пункты 13 и 14 реестра долга
(«pre-roll засчитывается в guard короткой записи», «удержание отпускается по
`window-hidden`») описывают поведение, которого в продукте нет — они
диагностированы по коду, а не по данным.

**Severity:** **P1** · **подтверждено** (путь прослежен + подтверждён 15/15
записями продакшн-лога).

**Текущий код** — см. выше: `getTracks().stop()` на `11031`, решение на `11274`.

**Как надо.** Решение об удержании должно приниматься **до** остановки треков,
а собственно остановка — только на ветке «не удерживаем». Ownership уже
устроен так, что `holdWarmCapture()` при `hold: true` опустошает модульные
слоты, и все последующие шаги teardown находят `null` — значит перенос вызова
вверх безопасен и ничего не ломает на ветке «нет».

```ts
// main.tsx, вместо блока на 11030-11035:

  // §4.7: решение об удержании графа принимается ПОКА трек ещё живой —
  // decideWarmHold спрашивает `readyState === "live"`, а stop() гасит его
  // синхронно. На "yes" модульные слоты опустошаются здесь, микрофон
  // остаётся открытым, worklet взводит pre-roll-кольцо; на "no" трек
  // глушится немедленно, ровно как раньше.
  const warmHold = discarding
    ? { hold: false, reason: "discarded", deviceLabel: micTrackLabel(stream) }
    : holdWarmCapture();
  console.log(
    `[trace stopLive] warm hold=${warmHold.hold ? 1 : 0} reason=${warmHold.reason} ` +
    `ttlMs=${UI_TOKENS.capture.warmHoldMs} device="${warmHold.deviceLabel}"`,
  );
  if (!warmHold.hold) {
    try {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.debug("MediaStream stop failed (non-fatal)", e);
    }
  }
  mark("warmHoldDecision");
```

и на `11274` вызов `holdWarmCapture()` со своим `console.log` удаляется
(решение уже принято выше), а `tearDown("stream.getTracks.stop", …)` на
`11300-11302` остаётся как есть — при удержании `stream` уже `null`.

Дополнительно требуется, чтобы барьер `flushWorkletPort` (11066) и
`waitForCaptureDrain` (11070) продолжали работать: они опираются на
`captureLevel.frames`, а не на состояние трека, и при живом треке барьер
корректнее — ворклет отдаёт реальные кадры, а не тишину. Комментарий на
`10990-10993` («Stop the MediaStream tracks. This synchronously freezes the
microphone») надо переписать: замораживает не остановка трека, а `flush-ack`
воркlet’а, что тот же комментарий и утверждает двумя абзацами ниже
(`11052-11054`).

**Почему это не сознательное решение.** (а) `capture-warm.ts:132-143` целиком
написан ради ветки `hold: true`, а `pcm-worklet.js:142-180` реализует `arm`/
`start`/`pre-roll`, которые невозможно достичь; (б) `UI_TOKENS.capture.warmHoldMs`
снабжён абзацем про «видимую цену: оранжевая точка на macOS горит 30 с» —
цену, которую никто не платит, потому что механизм не включается;
(в) `tests/capture-warm.test.ts:86-89` явно проверяет именно
`{hold: false, reason: "track-ended"}` как ошибочный случай — в продакшне это
единственный случай; (г) коммит `89e07b8` вставил `holdWarmCapture()` в
teardown, не тронув `getTracks().stop()`, который стоит там с `1605d5a` —
классическое «поведение изменено в одном месте из двух».

---

### F-002 · Провал загрузки `/api/config` на старте не блокирует автосохранение, и первое же действие пользователя затирает его настройки дефолтами

**Файл:** `frontend/src/main.tsx:6459-6469` (`loadCfg`, `catch` + `finally`),
`frontend/src/main.tsx:13159` (вызов), `frontend/src/main.tsx:6173-6203`
(`buildUiPreferencesSavePlan`), `frontend/src/main.tsx:6244-6257`
(`queueUiPreferencesSave`).

**Суть.** `loadCfg` ловит собственную ошибку и в `finally` безусловно снимает
защиту от автосохранения:

```ts
// main.tsx:6459-6469
  } catch (configError) {
    console.warn("Initial config load failed, retrying backend preset catalog load", configError);
    try {
      await loadUpscalePresets(pendingUpscalePresetId);
    } catch (presetError) {
      console.warn("Backend preset catalog retry failed", presetError);
    }
  } finally {
    suppressUiPrefAutosave = false;
    if (shouldPersistShortcutMigration) queueUiPreferencesSave();
  }
```

Вызывается она fire-and-forget (`void loadCfg().then(…).catch(…)`,
`main.tsx:13159`), и внешний `.catch` для этого случая недостижим — ошибка уже
проглочена внутри. UI при этом полностью интерактивен и показывает **HTML-дефолты**:
`recordingsDirInput` пуст, `deepgramKeytermsInput` пуст, `deepgramDualStreamCheck`
не отмечен, `upscaleToggle` снят, `micSelect` пуст, `currentShortcuts` = платформенные
дефолты. Любое действие в Settings (или на тулбаре) вызывает
`queueUiPreferencesSave()`, а тот через 260 мс шлёт `POST /api/config` с
`buildUiPreferencesSavePlan()`, который читает **весь набор** предпочтений из DOM:

```ts
// main.tsx:6178-6199
      preferences: {
        recordings_dir: nextRecordingsDir,            // ""
        remote_provider: remoteProvider,
        openrouter: { model: openrouterModel || DEFAULT_OPENROUTER_AUDIO_MODEL },
        deepgram: {
          keyterms: readDeepgramKeyterms(),           // ""
          dual_stream: readDeepgramDualStream(),      // из пустого чекбокса
          dual_secondary_language: readDeepgramDualSecondaryLanguage(),
        },
        ui: collectUiPreferences(),                   // весь UI-блок из DOM
      },
```

Бэкенд делает `_deep_merge(current, update)` (`backend/config.py:960`), но
пришедшие ключи — не отсутствующие, а присутствующие с пустыми/дефолтными
значениями, поэтому merge их принимает.

**Как наблюдать.** Запустить рендерер, когда бэкенд ещё не поднялся (или
временно вернуть 500 на `GET /api/config`), затем щёлкнуть любой тумблер в
Settings и посмотреть `~/Library/Application Support/transcriptor/config.json`:
`preferences.deepgram.keyterms`, `preferences.recordings_dir`,
`preferences.ui.mic_id`, `preferences.ui.upscale_model` окажутся пустыми,
`shortcut_record`/`shortcut_paste` — платформенными дефолтами.

**Последствие.** Молчаливая потеря пользовательских настроек: keyterms
(которые по §1 аудита и есть главный рычаг качества распознавания), путь к
архиву записей, выбранный микрофон, модель апскейла, оба хоткея. Пользователь
не получает никакого сигнала — статус-строка `Settings save failed` не
показывается, потому что сохранение как раз **успешно**.

**Severity:** **P1** · **подтверждено** (вход — отказ `GET /api/config` на
старте; путь до записи прослежен по коду целиком).

**Как надо.** Автосохранение должно быть разрешено только после успешной
загрузки — ровно та же логика, которую комментарий у dual-stream
(`main.tsx:5352-5359`) уже формулирует для двух полей, распространённая на весь
набор:

```ts
// main.tsx, рядом с `let suppressUiPrefAutosave = false;` (≈1825):
/**
 * Настройки ни разу не были прочитаны с бэкенда успешно.
 *
 * Пока это так, DOM показывает разметочные дефолты, а не выбор
 * пользователя, и любой автосейв записал бы эти дефолты поверх реальной
 * конфигурации: `buildUiPreferencesSavePlan` собирает ВЕСЬ блок
 * preferences из DOM, а backend-овый deep-merge принимает присутствующий
 * пустой ключ как значение. Тот же аргумент, что и в комментарии к
 * dual-stream, только не для двух полей, а для всего набора.
 */
let uiPreferencesLoaded = false;

// main.tsx:6244, в начале queueUiPreferencesSave:
function queueUiPreferencesSave(): void {
  if (suppressUiPrefAutosave) return;
  if (!uiPreferencesLoaded) {
    console.warn("settings autosave suppressed: preferences were never loaded");
    return;
  }
  …
}

// main.tsx:6459-6469, loadCfg:
    …
    if (didMigrate) {
      publishShortcutUpdateToMain();
      shouldPersistShortcutMigration = true;
    }
    uiPreferencesLoaded = true;
  } catch (configError) {
    console.warn("Initial config load failed …", configError);
    const msg = sanitizeUiErrorMessage(configError, "Settings could not be loaded.");
    setSettingsArchiveStatus(
      `Settings are not loaded (${msg}). Changes are not being saved — reopen Settings after the backend is ready.`,
      "error",
    );
    showRecordSessionNotice(
      `Settings could not be loaded: ${msg}. Your saved preferences are intact; changes made now will not be saved.`,
      "error",
      9000,
    );
    try {
      await loadUpscalePresets(pendingUpscalePresetId);
    } catch (presetError) {
      console.warn("Backend preset catalog retry failed", presetError);
    }
  } finally {
    suppressUiPrefAutosave = false;
    if (shouldPersistShortcutMigration) queueUiPreferencesSave();
  }
```

и `loadCfg()` должен вызываться повторно из ретрая boot-overlay
(`main.tsx:13377`) и из `refreshNetworkState`, когда бэкенд впервые ответил —
чтобы «не сохраняем» не стало постоянным состоянием.

**Почему это не сознательное решение.** Комментарий на `main.tsx:5352-5359`
прямо формулирует именно эту опасность («persisting a value the user never chose
would turn a backend default off behind their back on the very first autosave»)
и решает её для `dual_stream`/`dual_secondary_language`; `keyterms` в том же
объекте такой защиты не имеет, а весь `ui`-блок — тем более. То есть проблема
опознана, но закрыта в одном месте из N.

---

### F-003 · Дефолты и границы «Auto stop on silence» записаны четырежды, в четырёх файлах, и ни разу — в `UI_TOKENS`

**Файлы и символы:**
* `frontend/index.html:713` — `min="1" max="120" step="1" value="2"`;
* `frontend/index.html:714-715` — `min="-80" max="-10" step="1" value="-42"`;
* `frontend/src/main.tsx:3122-3123` (`getAutoStopSilenceConfig`) —
  `clampNumber(… : 2, 1, 120)`, `clampNumber(… : -42, -80, -10)`;
* `frontend/src/main.tsx:6364-6377` (`loadCfg`) — те же `2`, `1`, `120`, `-42`,
  `-80`, `-10` ещё раз;
* `desktop/main.js:305` — `DEFAULT_RECORDING_AUTO_STOP_CONFIG = Object.freeze({
  enabled: false, seconds: 2, thresholdDb: -42 })`.

В `backend/config.py` этих ключей нет вовсе (`grep auto_stop_silence` — пусто),
то есть бэкенд их не валидирует; в `UI_TOKENS` (`main.tsx:907-1038`) — тоже нет.

**Суть.** Одно продуктовое решение («через сколько секунд тишины ниже скольких
дБFS останавливать запись») выражено четырьмя независимыми копиями трёх чисел
и двух диапазонов. Значение, которое реально применяется, вычисляет
`desktop/main.js:2022` (`Math.pow(10, cfg.thresholdDb / 20)`) из снапшота,
который отдаёт `liveStatusSnapshot()` → `getAutoStopSilenceConfig()`.

**Как наблюдать.** Поменять `value="2"` в `index.html` на `3` — поведение не
изменится: `getAutoStopSilenceConfig` подставит `2` при непарсящемся значении,
`loadCfg` — тоже `2`, а `desktop/main.js` — свой `2`. Обратно: поменять
`main.tsx:3122` на `5` — поле в UI по-прежнему покажет `2`, а при полном
отсутствии конфига desktop применит `2`.

**Последствие.** Изменение дефолта или границы требует четырёх синхронных
правок в трёх слоях; расхождение не ловится ни тестом, ни типом. Диапазон
`1..120` в HTML — это `min/max` у `<input type=number>`, которые Chromium
не применяет к вводу с клавиатуры, поэтому реально ограничивает только
`clampNumber` — то есть HTML-атрибуты уже сейчас декоративны.

**Severity:** **P1** (разъехавшиеся источники истины) · **подтверждено**.

**Как надо.** Один именованный блок в `UI_TOKENS`, из которого читают и
рендерер, и разметка (через инициализацию атрибутов при boot), и desktop
(через тот же `liveStatusSnapshot`, который он уже вызывает):

```ts
// main.tsx, в UI_TOKENS (рядом с capture):
  /**
   * Auto-stop-on-silence. Одно решение — «сколько секунд тишины ниже
   * какого уровня заканчивают запись» — и один набор чисел на все три
   * слоя, которые его сейчас дублируют (index.html-атрибуты,
   * getAutoStopSilenceConfig, loadCfg и desktop/main.js).
   *
   * 2 с: короче — обрывает обычную паузу между фразами (EMA-окно RMS
   * ~120 мс, см. CAPTURE_RMS_EMA_ALPHA), длиннее — пользователь успевает
   * решить, что автостоп не работает. −42 dBFS: между типичным уровнем
   * комнаты (−55…−48) и тихой речью (−35…−28) на записях 2026-09-03.
   */
  autoStopSilence: {
    defaultEnabled: false,
    defaultSeconds: 2,
    minSeconds: 1,
    maxSeconds: 120,
    defaultThresholdDb: -42,
    minThresholdDb: -80,
    maxThresholdDb: -10,
  },

// main.tsx:3118-3125:
function getAutoStopSilenceConfig(): AutoStopSilenceConfig {
  const t = UI_TOKENS.autoStopSilence;
  const enabled = !!($("autoStopSilenceEnabled") as HTMLInputElement).checked;
  const secondsRaw = Number(($("autoStopSilenceSeconds") as HTMLInputElement).value);
  const thresholdRaw = Number(($("autoStopSilenceDb") as HTMLInputElement).value);
  return {
    enabled,
    seconds: clampNumber(
      Number.isFinite(secondsRaw) ? Math.round(secondsRaw) : t.defaultSeconds,
      t.minSeconds, t.maxSeconds,
    ),
    thresholdDb: clampNumber(
      Number.isFinite(thresholdRaw) ? Math.round(thresholdRaw) : t.defaultThresholdDb,
      t.minThresholdDb, t.maxThresholdDb,
    ),
  };
}

// main.tsx, рядом с installAppearanceStateClasses() — один раз при boot:
function applyAutoStopSilenceBounds(): void {
  const t = UI_TOKENS.autoStopSilence;
  const sec = $("autoStopSilenceSeconds") as HTMLInputElement;
  sec.min = String(t.minSeconds);
  sec.max = String(t.maxSeconds);
  sec.defaultValue = String(t.defaultSeconds);
  const db = $("autoStopSilenceDb") as HTMLInputElement;
  db.min = String(t.minThresholdDb);
  db.max = String(t.maxThresholdDb);
  db.defaultValue = String(t.defaultThresholdDb);
}

// main.tsx:6364-6377 в loadCfg — те же токены вместо литералов:
  autoStopSecondsEl.value = String(clampNumber(
    Number.isFinite(Number(ui.auto_stop_silence_seconds))
      ? Number(ui.auto_stop_silence_seconds)
      : UI_TOKENS.autoStopSilence.defaultSeconds,
    UI_TOKENS.autoStopSilence.minSeconds,
    UI_TOKENS.autoStopSilence.maxSeconds,
  ));
```

и в `index.html:712-715` атрибуты `min/max/value` убираются (их выставляет
`applyAutoStopSilenceBounds`), а `desktop/main.js:305` перестаёт держать
собственную копию: `DEFAULT_RECORDING_AUTO_STOP_CONFIG` должен приходить из
того же `liveStatusSnapshot()`, который desktop уже читает
(`desktop/main.js:1025`), с падением на «выключено», а не на собственные числа.

**Почему это не сознательное решение.** `UI_TOKENS` в этом же файле существует
ровно для таких величин и содержит куда менее важные (`vuAmplify`,
`timer.tickMs`), причём каждая — с абзацем обоснования. Четыре копии без
единого перекрёстного комментария — это накопление, а не выбор.

---

### F-004 · `transcript-merge.ts` держит собственную копию `normalizeWords` из `text-match.ts` — модуля, который в своей же шапке объявлен единственным источником этого правила

**Файл:** `frontend/src/transcript-merge.ts:89-96` (`normalizeWordsCompat`)
против `frontend/src/text-match.ts:17-23` (`normalizeWords`).

**Суть.** Байт-в-байт одинаковые реализации:

```ts
// transcript-merge.ts:89-96
function normalizeWordsCompat(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}
```
```ts
// text-match.ts:17-23
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}
```

При этом `transcript-merge.ts:14` уже импортирует из того же модуля
`countWords, normalizeComparable, normalizeTranscriptWhitespace, stemKey,
tokensInOrder` — то есть импорт есть, просто одна функция скопирована.
А шапка `text-match.ts:1-14` говорит буквально: «These were previously
re-defined as inline closures inside three different functions of main.tsx.
Identical rules that live in N places are N opportunities to silently diverge…
This module is the single source of truth».

**Как наблюдать.** `grep -n "normalizeWordsCompat" frontend/src/transcript-merge.ts`
— единственный потребитель `candidateConfirmsTranscriptCoverage:82-87`, то есть
предикат «кандидат подтверждает покрытие», который в `stopLive:12419` решает,
завершать ли гонку остановки. Изменение regex в `text-match.ts` (например,
чтобы перестать съедать дефис в «из-за») это место не затронет.

**Последствие.** Расхождение правила нормализации между «подтверждает ли
кандидат покрытие» (гонка стопа) и всей остальной сравнительной логикой
(`mergeInterim`, `foldInterim`, `unionTranscripts`, `mergeReadings`) — то есть
ровно то, от чего `text-match.ts` был создан.

**Severity:** **P1** (разъехавшиеся источники истины) · **подтверждено**.

**Как надо.**

```ts
// transcript-merge.ts:14 — добавить в существующий импорт:
import {
  countWords, normalizeComparable, normalizeTranscriptWhitespace,
  normalizeWords, stemKey, tokensInOrder,
} from "./text-match";

// transcript-merge.ts:82-87 — использовать его:
  const currentSet = new Set(normalizeWords(current));
  const candidateNormWords = normalizeWords(candidate);

// transcript-merge.ts:89-96 — normalizeWordsCompat удалить целиком.
```

**Почему это не сознательное решение.** Имя `…Compat` намекает на временный
слой совместимости, но совместимость не с чем: сигнатуры и тела идентичны, а
`normalizeWords` уже экспортирован и уже покрыт `tests/text-match.test.ts`.
Это остаток переноса кода в модуль, который забыли дожать.

---

### F-005 · Ветка OpenRouter не проставляет `transcriptSource`, поэтому итоговая трасса `FINAL` врёт о происхождении доставленного текста

**Файл:** `frontend/src/main.tsx:12750`, `12759`, `12769`, `12772`
(ветка `else` — не-стриминговые провайдеры) против объявления
`frontend/src/main.tsx:11976-11981` и печати `frontend/src/main.tsx:12785`.

**Суть.** Объявление обещает инвариант:

```ts
// main.tsx:11976-11981
    // Provenance of ``transcriptRaw`` for the ``[trace stopLive] FINAL``
    // line … Defaults to "held" (the live/preview reading, untouched);
    // every site that changes ``transcriptRaw`` updates it alongside.
    let transcriptSource: StopTranscriptSource = "held";
```

Ветки `local` (`12017-12023`) и `deepgram` (`12136`, `12183`, `12257`, `12418`,
`12482`, `12553`, `12631`, `12637`, `12714`) его соблюдают. Ветка OpenRouter —
нет:

```ts
// main.tsx:12747-12773 — четыре присваивания transcriptRaw подряд,
// ни одно не трогает transcriptSource
      const syncOut = await remoteApiPromise;
      transcriptRaw = String(syncOut.text || "").trim();
      …
        const fallbackOut = await runLocalFinalPass();
        transcriptRaw = String(fallbackOut.text || "").trim();
      …
        const fallbackOut = await runLocalFinalPass();
        transcriptRaw = String(fallbackOut.text || "").trim();
      …
      if (!transcriptRaw && previewDraft) {
        transcriptRaw = previewDraft;
      }
```

**Как наблюдать.** Выбрать OpenRouter как провайдера, записать что-нибудь,
посмотреть `main.log`: `[trace stopLive] FINAL … source=held` при том, что текст
пришёл из REST-ответа OpenRouter или из локального Whisper-фолбэка.

**Последствие.** Поле `source`, добавленное коммитом `0de0c2d` именно чтобы
разбирать по логу, откуда взялся доставленный текст (после дефекта дублирования
клауз), для целого провайдера показывает заведомо ложное значение. Следующий
разбор инцидента по логу пойдёт не туда.

**Severity:** **P1** (наполовину сделанная фича / молчаливо неверные данные
наблюдаемости) · **подтверждено**.

**Как надо.**

```ts
// main.tsx:12747-12773
      if (remoteApiPromise) {
        try {
          const syncOut = await remoteApiPromise;
          transcriptRaw = String(syncOut.text || "").trim();
          transcriptSource = "envelope";   // полный REST-проход провайдера
        } catch (e) {
          …
          const fallbackOut = await runLocalFinalPass();
          transcriptRaw = String(fallbackOut.text || "").trim();
          transcriptSource = "recovery";
        }
      }
      if (!transcriptRaw && (previewDraft || latestSourceForSave())) {
        …
        const fallbackOut = await runLocalFinalPass();
        transcriptRaw = String(fallbackOut.text || "").trim();
        transcriptSource = "recovery";
      }
      if (!transcriptRaw && previewDraft) {
        transcriptRaw = previewDraft;
        transcriptSource = "held";
      }
```

(`"envelope"` здесь — «авторитетное чтение провайдера», ровно тот же смысл, что
у `decideLiveTranscriptAdoption` на локальной ветке; если нужен отдельный
ярлык, `StopTranscriptSource` в `transcript-merge.ts:831` расширяется одним
членом `"remote-rest"` и трасса становится точнее.)

**Почему это не сознательное решение.** Инвариант записан в комментарии на
шесть строк выше и соблюдён во всех остальных десяти точках изменения
`transcriptRaw`. Пропущена ровно та ветка, которую коммит `0de0c2d` не трогал.

---

### F-006 · Значение `diarize` для восстановительных проходов читается из DOM в момент восстановления, а не из снапшота сессии, и читается тремя копиями одного выражения

**Файл:** `frontend/src/main.tsx:11828`, `11885`, `12546`, `12742`
против `frontend/src/main.tsx:10277` (`wsQuery.set` при старте) и
`frontend/src/main.tsx:10181-10188` (`activeLiveSessionSnapshot`).

**Суть.** Live-сокет фиксирует диаризацию на старте:

```ts
// main.tsx:10271-10278
    const wsQuery = new URLSearchParams({
      …
      diarize: (($("diarizeCheck") as HTMLInputElement).checked ? "true" : "false"),
    });
```

но в снапшот сессии (`activeLiveSessionSnapshot`, где лежат `provider`,
`effectiveProvider`, `model`, `language`, `assistLocalModel`, `finalLocalModel`)
`diarize` не попадает. Все четыре восстановительных/финальных прохода читают
чекбокс заново, причём три из них — дословно одинаковым выражением с прямым
`document.getElementById` вместо `$()`:

```ts
// main.tsx:11828  (deepgramRestOnDisk)
        diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
// main.tsx:11885  (REST upload fallback)
              diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
// main.tsx:12546  (auto REST re-transcribe на подозрительно коротком результате)
                diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
// main.tsx:12742  (OpenRouter финальный проход)
            diarize: (document.getElementById("diarizeCheck") as HTMLInputElement).checked,
```

К этому моменту `activeLiveSessionSnapshot` уже обнулён (`main.tsx:11359`),
то есть даже если бы поле там было, его бы не прочитали.

**Как наблюдать.** Начать запись с включённым `Speaker …` (diarize), во время
записи выключить чекбокс, нажать Stop так, чтобы сработала recovery-ветка
(например, с отключённой сетью в момент финализации). Live-стрим шёл с
`diarize=true`, восстановительный REST-проход уйдёт с `diarize=false` — две
половины одной записи расшифрованы по разным настройкам, и сшивка
`chooseStopTranscript` сравнивает текст с разметкой говорящих и без неё.

**Последствие.** Одна запись — два несовместимых чтения; при `hasDiarization`
в `appendSegmentsToBuffer:9299` меняется даже разделитель отображения. Плюс
четыре копии одного чтения DOM, которые нельзя изменить одним движением.

**Severity:** **P1** (одно решение в двух местах, наполовину зафиксированный
снапшот сессии) · **подтверждено** (все пять точек в коде; сценарий смены
чекбокса во время записи ничем не заблокирован).

**Как надо.** `diarize` — часть снапшота сессии, как `language` и `model`:

```ts
// main.tsx:365-373, LiveSessionSnapshot:
interface LiveSessionSnapshot {
  provider: Provider;
  effectiveProvider: Provider;
  model: string;
  language: string;
  /** Диаризация, зафиксированная на старте: тем же снимком, что язык и
   *  модель. Восстановительные проходы должны расшифровывать ту же
   *  запись теми же настройками, что и live-стрим, иначе сшивка
   *  сравнивает два чтения с разной разметкой говорящих. */
  diarize: boolean;
  assistLocalModel: string;
  finalLocalModel: string;
}

// main.tsx, рядом с readProviderSelection() — один читатель DOM:
function readDiarizeEnabled(): boolean {
  return !!($("diarizeCheck") as HTMLInputElement).checked;
}

// main.tsx:10181-10188:
  activeLiveSessionSnapshot = {
    provider: selectedProvider,
    effectiveProvider: selectedEffectiveProvider,
    model: selectedModel,
    language: selectedLanguage,
    diarize: readDiarizeEnabled(),
    assistLocalModel: sessionLocalModels.assistLocalModel,
    finalLocalModel: sessionLocalModels.finalLocalModel,
  };

// main.tsx:10277:
      diarize: readDiarizeEnabled() ? "true" : "false",

// main.tsx:10850 (fallback-снапшот в stopLive) — добавить
    diarize: readDiarizeEnabled(),
// main.tsx:10856, рядом с languageValue:
  const diarizeValue = liveSnapshot.diarize;

// и во всех четырёх точках 11828 / 11885 / 12546 / 12742:
        diarize: diarizeValue,
```

**Почему это не сознательное решение.** `activeLiveSessionSnapshot` заведён
именно для того, чтобы стоп-путь не переспрашивал у DOM то, что решалось на
старте (`language`, `model`, `provider` там уже есть, и `stopLive:10839-10850`
строит из них резервный снимок). `diarize` — единственное поле того же класса,
которое туда не попало; три из четырёх чтений даже не используют местный
хелпер `$()`, что типично для копипасты.

---

## P2

### F-007 · `MemoryPcmSink` растёт без границы, хотя WebM-путь в той же функции окно имеет

**Файл:** `frontend/src/main.tsx:3777-3810` (`MemoryPcmSink`) против
`frontend/src/main.tsx:10544-10563` (`WEBM_WINDOW_CHUNKS`).

**Суть.** WebM-контейнер прямо в `startLive` защищён скользящим окном на 2 часа
и однократным предупреждением пользователю:

```ts
// main.tsx:10544
      const WEBM_WINDOW_CHUNKS = 60 * 120; // 2 hours @ 1 chunk/s
```

Каноническая же PCM-дорожка при недоступном OPFS попадает в
`MemoryPcmSink`, у которого `private chunks: Int16Array[] = []` растёт без
всякого предела:

```ts
// main.tsx:3784-3790
  append(samples: Float32Array): void {
    if (this.destroyed) return;
    if (!samples.length) return;
    const int16 = floatSamplesToInt16LE(samples);
    this.chunks.push(int16);
    this.totalSamples += int16.length;
  }
```

Комментарий на `main.tsx:10014-10016` при этом утверждает: «Either way the old
`chunks: Float32Array[]` consolidation / 2h rotating-window dance is gone — the
sink is bounded by definition». Для OPFS-варианта это правда, для
memory-варианта — нет. Тот же неограниченный рост включается и на
OPFS-варианте после первой же ошибки записи: `lastWriteError` никогда не
сбрасывается, `append:3622` перестаёт планировать флаши, и всё остальное
накапливается в `pendingChunks` до `finalize`.

**Как наблюдать.** `createPcmSink` логирует `PcmSink: OPFS unavailable, using
in-memory sink` (`main.tsx:3815`). 16 кГц × 2 байта = 32 КБ/с → 115 МБ за час,
230 МБ за два.

**Последствие.** Длинная диктовка на хосте без OPFS (или после одной ошибки
записи в OPFS) упирается в память рендерера; ни предупреждения, ни окна.

**Severity:** **P2** · **подтверждено** (путь достижим — `createPcmSink`
явно его выбирает; количественная оценка выведена из известных
`LIVE_SAMPLE_RATE_HZ` и Int16, не измерена).

**Как надо.** Дать memory-варианту ту же границу и то же однократное
уведомление, что уже есть у WebM, с одним общим токеном:

```ts
// main.tsx, в UI_TOKENS.capture:
    /**
     * Потолок памяти для in-memory PCM-приёмника (OPFS недоступен или
     * отказал в записи). 2 часа при 16 кГц/Int16 — ровно то же окно,
     * что WEBM_WINDOW_CHUNKS даёт контейнерному фолбэку, выраженное в
     * сэмплах, а не в чанках, потому что здесь чанк не равен секунде.
     */
    memorySinkMaxSamples: 16_000 * 60 * 120,

// main.tsx:3777-3790:
class MemoryPcmSink implements PcmSink {
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private truncationWarned = false;
  …
  append(samples: Float32Array): void {
    if (this.destroyed) return;
    if (!samples.length) return;
    const int16 = floatSamplesToInt16LE(samples);
    this.chunks.push(int16);
    this.bufferedSamples += int16.length;
    this.totalSamples += int16.length;
    const cap = UI_TOKENS.capture.memorySinkMaxSamples;
    while (this.bufferedSamples > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bufferedSamples -= dropped ? dropped.length : 0;
      if (!this.truncationWarned) {
        this.truncationWarned = true;
        showRecordSessionNotice(
          "Recording exceeds 2 hours and this system has no disk spool — only the last 2 h of audio is kept.",
          "warning",
          9000,
        );
      }
    }
  }
```

и `lastWriteError` в `OpfsPcmSink` должен либо сбрасываться при успешном
флаше, либо переводить приёмник в тот же ограниченный memory-режим, а не
копить `pendingChunks` без предела.

**Почему это не сознательное решение.** Ровно то же ограничение реализовано
для менее ценного WebM-фолбэка тридцатью строками кода, с текстом для
пользователя; комментарий у канонического пути утверждает, что граница есть,
хотя её нет.

---

### F-008 · Правило «заголовок записи из транскрипта» реализовано дважды, и вторая копия ведёт себя иначе

**Файл:** `frontend/src/main.tsx:10830-10835` (`_smartTitle` внутри `stopLive`)
против `frontend/src/main.tsx:8045` (путь Re-transcribe).

```ts
// main.tsx:10830-10835 — канонический вариант
  const _smartTitle = (text: string): string => {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return title;                       // ← фолбэк
    const preview = words.slice(0, 8).join(" ");
    return preview.length > 80 ? preview.slice(0, 77) + "..." : preview;  // ← потолок
  };
```
```ts
// main.tsx:8045 — вторая копия
          title: text.split(/\s+/).slice(0, 8).join(" "),
```

Вторая не имеет ни фолбэка на «Recording <дата>» при пустом тексте, ни
потолка в 80 символов, ни нормализации пробелов.

**Как наблюдать.** Открыть запись в History, нажать Re-transcribe на записи, у
которой первые восемь слов длиннее 80 символов (немецкие/составные слова, URL,
base64 в диктовке) — заголовок в списке станет длиннее любого, который
когда-либо писал `stopLive`. Re-transcribe с пустым результатом даст пустой
заголовок.

**Последствие.** Один и тот же архивный элемент называется по-разному в
зависимости от того, каким путём был получен транскрипт.

**Severity:** **P2** · **подтверждено**.

**Как надо.** Поднять `_smartTitle` из замыкания `stopLive` в модульную
функцию и вызывать её в обоих местах:

```ts
// main.tsx, рядом с recordingTitleFromName (≈2750):
/**
 * Заголовок записи по её тексту — одно правило для стоп-пути и для
 * Re-transcribe. Восемь слов, потолок 80 символов с многоточием, и
 * дата как фолбэк, когда текста нет: два места писали это по-разному,
 * и Re-transcribe переименовывал запись длиннее, чем это когда-либо
 * делал stopLive.
 */
const SMART_TITLE_MAX_WORDS = 8;
const SMART_TITLE_MAX_CHARS = 80;

function smartRecordingTitle(text: string, fallback: string): string {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return fallback;
  const preview = words.slice(0, SMART_TITLE_MAX_WORDS).join(" ");
  return preview.length > SMART_TITLE_MAX_CHARS
    ? `${preview.slice(0, SMART_TITLE_MAX_CHARS - 3)}...`
    : preview;
}

// main.tsx:10830-10835:
  const _smartTitle = (text: string): string => smartRecordingTitle(text, title);

// main.tsx:8045:
          title: smartRecordingTitle(text, audioState.savedName || "Recording"),
```

**Почему это не сознательное решение.** Ни одного комментария, объясняющего,
почему Re-transcribe должен именовать иначе; отличия — именно те три детали,
которые в каноническом варианте появились по одной (фолбэк, потолок,
нормализация), то есть вторая копия просто отстала.

---

### F-009 · `mic-health.ts` — 333 строки конечного автомата, экспортированного «для тестируемости», без единого теста

**Файл:** `frontend/src/mic-health.ts`; отсутствует `frontend/tests/mic-health.test.ts`.

**Суть.** Модуль экспортирует чистые, детерминированные единицы, специально
пригодные к юнит-тесту: `isDigitalSilence`, `nextMicHealth` (сам переход
автомата), `initialSnapshot`, пороги `DEAD_PEAK_FLOOR`, `DEAD_RMS_FLOOR`,
`PROBE_TIMEOUT_MS`, `SILENT_CONFIRM_MS`, `MAX_SAMPLE_GAP_MS` и тексты
`MIC_SILENT_HELP`/`MIC_MUTED_HELP`/`MIC_LOST_HELP`. Автоматическая проверка
показала, что **ни один** из этих десяти экспортов не используется вне модуля
и не упомянут ни в одном тесте:

```
UNUSED-OUTSIDE  mic-health :: SILENT_CONFIRM_MS / MAX_SAMPLE_GAP_MS /
                MIC_SILENT_HELP / MIC_MUTED_HELP / MIC_LOST_HELP /
                initialSnapshot / isDigitalSilence / nextMicHealth
```

При этом остальные 16 модулей `frontend/src/*.ts` имеют по тесту, а сам
автомат — единственный решатель того, какой текст увидит пользователь на стопе
пустой записи: `STOP_COPY` в `main.tsx:10911-10931` индексируется по
`finalMicHealth.state`, и членство в этой таблице — единственное определение
«виновата ли аппаратура» (`micHealthBad`, `main.tsx:10932`), которое читают
пять веток `stopLive`.

**Как наблюдать.** `ls frontend/tests | grep mic-health` — пусто; `npm --prefix
frontend test` прогоняет 253 теста, ни один не касается `mic-health`.

**Последствие.** Изменение порогов или порядка переходов не ловится ничем;
регрессия проявится как неверный текст ошибки у пользователя с молчащим
микрофоном — самый дорогой класс сообщения, потому что он говорит человеку,
куда идти чинить систему.

**Severity:** **P2** · **подтверждено**.

**Как надо.** Файл `frontend/tests/mic-health.test.ts` с покрытием переходов
`probing → live`, `probing → silent` (по `PROBE_TIMEOUT_MS`),
`live → muted → live` (по `track-muted`), `live → lost` (`track-ended`),
`force-silent` из pipeline-failsafe, и границы `isDigitalSilence` по
`DEAD_PEAK_FLOOR`/`DEAD_RMS_FLOOR`, плюс проверка, что `MAX_SAMPLE_GAP_MS`
не даёт двойного учёта времени при разреженных сэмплах. Форма — как в
`tests/capture-warm.test.ts`: чистые входы, `toEqual` на весь снапшот.

**Почему это не сознательное решение.** Экспорт `nextMicHealth`/
`isDigitalSilence`/`initialSnapshot` при наличии класса-обёртки
`MicHealthTracker` имеет ровно одно назначение — тестируемость; она не
использована. Все соседние модули с такой же формой (`capture-warm`,
`live-coverage`, `envelope-deadline`, `audio-levels`) тесты имеют.

---

### F-010 · `tests/` не типизируется ни `typecheck`, ни `build`; `vitest.config.ts` ссылается на tsconfig, который тесты исключает

**Файлы:** `frontend/tsconfig.json:12` (`"include": ["src", "vite.config.ts"]`),
`frontend/vitest.config.ts:8-10` (`typecheck: { tsconfig: "./tsconfig.json" }`),
`frontend/package.json:19-21` (`typecheck` = `tsc --noEmit`,
`build` = `tsc --noEmit && vite build`, `test` = `vitest run`).

**Суть.** `tsc --noEmit` компилирует только `src` и `vite.config.ts`. Vitest
исполняет `tests/**/*.test.ts` через esbuild (transpile-only, типы не
проверяются), а его собственная секция `typecheck` активируется лишь флагом
`--typecheck`, которого нет ни в одном npm-скрипте — и даже если бы был,
указанный ей tsconfig тесты не включает. Итог: 2992 строки тестов не
типизируются никогда, ни одной из четырёх команд верификации из `AGENTS.md`.

**Как наблюдать.** Изменить сигнатуру любой экспортированной функции без
правки её теста: `npm run typecheck`, `npm run build` и `npm test` останутся
зелёными, если тест всё ещё «работает» в рантайме.

**Последствие.** Тесты перестают быть страховкой контракта: они проверяют
поведение, но не форму. При рефакторинге модулей (тот самый, что идёт прямо
сейчас в рабочем дереве) устаревший тест не покраснеет от несовпадения типа.

**Severity:** **P2** · **подтверждено**.

**Как надо.**

```jsonc
// frontend/tsconfig.json
  "include": ["src", "tests", "vite.config.ts", "vitest.config.ts"]
```
```jsonc
// frontend/package.json
    "typecheck": "tsc --noEmit",
    "test": "vitest run --typecheck",
```

(`vitest.config.ts` уже указывает нужный tsconfig — после расширения `include`
он начнёт что-то значить.) Если `tests` тянут `vitest/globals`, добавить
`"types": ["vite/client", "node", "vitest/globals"]`.

**Почему это не сознательное решение.** `vitest.config.ts` содержит блок
`typecheck` — то есть намерение типизировать тесты было; он просто не
подключён ни к одному скрипту и указывает на конфиг, который тесты не видит.

---

### F-011 · Два `catch { }` без причины нарушают политику, записанную в самом `eslint.config.js`

**Файлы:** `frontend/src/main.tsx:10579`, `frontend/src/main.tsx:14140`.

`frontend/eslint.config.js:33-35` объявляет:

```js
      // Empty catch blocks are used deliberately to swallow best-effort
      // errors (71 sites; see BUGS_AUDIT BUG-10 policy — each must carry a
      // reason comment in new code).
      "no-empty": ["error", { allowEmptyCatch: true }],
```

Все прочие 21 пустых `catch` в `main.tsx` действительно несут причину
(`/* best effort */`, `/* already closed */`, `/* idempotent */`,
`/* port already dead */`, …). Эти два — нет:

```ts
// main.tsx:10576-10581 (startLive, откат полуинициализированного MediaRecorder)
      if (mediaRecorder) {
        try {
          mediaRecorder.ondataavailable = null;
        } catch { }
        mediaRecorder = null;
      }
// main.tsx:14138-14141
  } catch { }
```

**Severity:** **P2** · **подтверждено**. **Как надо** — дописать причину
(для `10579`: `catch { /* геттер свойства недоступен на сломанном рекордере */ }`),
либо, если причины нет, обработать ошибку. **Почему не сознательное решение:**
политика записана в конфиге линтера, но линтер её не проверяет
(`allowEmptyCatch: true` — бинарный флаг), поэтому нарушение прошло молча.

---

### F-012 · Пустая ветка `if` вместо кода в `publishRecordingOutput`

**Файл:** `frontend/src/main.tsx:9596-9602`.

```ts
    if (kind === "transcript" && pasteText) {
      // KEEP the live preview text after stop: … The pane clears when the
      // NEXT recording starts (resetLiveDraftState), not when the current
      // one ends.
    }
```

Условие вычисляется, ветка ничего не делает. Это не комментарий к решению, а
след удалённого поведения: заголовок «Channel 4» тремя строками выше обещает
действие («the Live Preview pane must no longer show the same text»), которого
нет.

**Severity:** **P2** · **подтверждено**. **Как надо** — удалить `if` целиком,
а объяснение перенести в докблок функции, к описанию Channel 3:

```ts
    // Channel 3: the DOM itself. Respects the active UI session …
    //
    // Живое превью НЕ очищается здесь: пользователь сравнивает
    // стримовое чтение с финальным транскриптом (Deepgram иногда
    // теряет слова — панель и есть улика). Панель очищает следующий
    // старт, через resetLiveDraftState.
    if (isCurrentUiSession(signal.sessionToken || "")) {
      $("finalOutput").textContent = domText;
    }
```

**Почему не сознательное решение.** Пустая ветка не выражает намерения — она
его прячет; ESLint её не ловит (`no-empty` не покрывает блоки с комментарием),
а читатель вынужден доказывать себе, что тут ничего не должно происходить.

---

### F-013 · Устаревшие ссылки на номера строк внутри комментариев

**Файлы:** `frontend/src/main.tsx:11733` («transcribeStartedAt is captured at
the top of stopLive — line ~6510», фактически `10828`),
`frontend/src/main.tsx:12065` («use `countWords` (the module-level helper at
line ~862)» — в `main.tsx` его нет вовсе, он импортируется из `./text-match`),
`frontend/src/main.tsx:11759` («`deferredSinkDestroy.destroy()` … around line
6754», фактически `11507`), `frontend/src/main.tsx:3716`
(«`flushPending`'s catch branch (line ~1789)», фактически `3661`).

**Последствие.** Комментарий, отправляющий читателя на несуществующую строку,
хуже отсутствия комментария: он тратит время и подрывает доверие к остальным
(а остальные здесь как раз очень хороши). **Severity:** P2 · **подтверждено**.
**Как надо** — ссылаться на имя символа, а не на номер строки: «captured at the
top of `stopLive`», «the module-level `countWords` (./text-match)», «where
`deferredSinkDestroy.destroy()` runs», «`flushPending`'s catch branch».

---

### F-014 · Ненужный псевдоним `wordCountOf = countWords`

**Файл:** `frontend/src/main.tsx:12069`.

```ts
      const wordCountOf = countWords;
```

с комментарием на пять строк выше о том, что это и есть SSOT-исправление
(«use `countWords` … instead of an inline lambda»). Псевдоним даёт ровно
одно: в теле ветки Deepgram имя функции отличается от того, каким она
называется во всём остальном файле, поэтому `grep countWords` не находит
восемь её использований. **Severity:** P2 · **подтверждено**. **Как надо** —
удалить строку `12069` и заменить восемь вхождений `wordCountOf(` на
`countWords(`.

---

### F-015 · `waitForLiveFinalEnvelope` не гасит свой таймер при раннем разрешении

**Файл:** `frontend/src/main.tsx:9462-9476`.

```ts
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: LiveFinalEnvelope | null): void => {
      if (settled) return;
      settled = true;
      slot.waiters = slot.waiters.filter((w) => w !== handler);
      resolve(value);
    };
    const handler = (envelope: LiveFinalEnvelope | null): void => done(envelope);
    slot.waiters.push(handler);
    window.setTimeout(() => done(slot.envelope), Math.max(0, timeoutMs));
  });
```

Хендл таймера не сохраняется и не гасится — при конверте, пришедшем на первой
секунде, таймер всё равно живёт положенные 4000 мс и просыпается впустую.
Функциональной ошибки нет (`settled` защищает), но это ровно то, чего
`waitForLiveEnvelopeWithAnnouncedBudget` (`9858-9868`) и `flushWorkletPort`
(`10097-10106`) в этом же файле старательно избегают. **Severity:** P2 ·
**подтверждено**. **Как надо** — как у соседей:

```ts
  return new Promise((resolve) => {
    let settled = false;
    let timerId: number | null = null;
    const done = (value: LiveFinalEnvelope | null): void => {
      if (settled) return;
      settled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      slot.waiters = slot.waiters.filter((w) => w !== handler);
      resolve(value);
    };
    const handler = (envelope: LiveFinalEnvelope | null): void => done(envelope);
    slot.waiters.push(handler);
    timerId = window.setTimeout(() => done(slot.envelope), Math.max(0, timeoutMs));
  });
```

---

### F-016 · Экспорты без внешних потребителей

**Файлы:** `frontend/src/live-source.ts:52` (`REDECODE_MAX_WINDOW_WORDS`),
`frontend/src/live-source.ts:187` (`foldInterim`),
`frontend/src/transcript-merge.ts:474` (`SEAM_STRADDLE_WINDOW_SEC`),
`frontend/src/transcript-merge.ts:482` (`SEAM_NGRAM_MAX_WORDS`),
плюс десять экспортов `mic-health.ts` (см. F-009).

Проверено автоматически: ни один из них не упоминается ни в `main.tsx`, ни в
другом модуле `src/`, ни в `tests/`. Остальные «экспортированные только для
теста» символы (`LIVE_PANE_STATUS_PREFIX`, `RECORDINGS_WINDOW_CHUNK`,
`normalizeAcceleratorForDisplay`, `MAX_ERROR_TEXT`, `needsErrorText`,
`describeError`, `transcriptionModelLabel`, `DUAL_STREAM_DEFAULT`) тестом
пользуются — это законное применение и дефектом не является.

**Severity:** P2 · **подтверждено**. **Как надо** — снять `export` (сделать
модуль-локальными) либо покрыть тестом, как соседние константы того же файла.
`foldInterim` — единственная нетривиальная из перечисленных: он реализует
`InterimFold` и вызывается из `mergeInterim`/`uncoveredInterimTail`; тест на
него дал бы больше, чем снятие экспорта.

---

### F-017 · `resolveEffectiveProvider` спрашивает достижимость строже, чем восстановительные пути

**Файл:** `frontend/src/main.tsx:4682` против `frontend/src/main.tsx:2448-2450`
и `frontend/src/main.tsx:10854`.

```ts
// main.tsx:2448
function isRemoteProviderReachable(provider: Provider, providerReachabilityHint = false): boolean {
  return isRemoteProvider(provider) && (providerReachabilityHint || isNetworkOnline);
}
// main.tsx:4682 — без подсказки
  if (isRemoteProviderReachable(preferred)) return preferred;
// main.tsx:10854 — подсказка «на старте Deepgram был достижим»
  const deepgramReachabilityHint = effectiveProvider === "deepgram";
```

Одно решение — «можно ли сейчас идти к удалённому провайдеру» — задаётся двумя
разными вопросами: на старте по текущему сетевому зонду, на восстановлении по
факту «на старте зонд был зелёным». Смысл понятен (не отменять recovery из-за
мигнувшего зонда), но нигде не записан, и подсказка передаётся не всюду:
`recoverFromEmptyTranscriptInner:11851` её учитывает, а
`runUpscaleIfEnabled`/`remoteJobSync` в OpenRouter-ветке (`12739`) — нет.

**Severity:** P2 · **гипотеза** (поведенчески расходятся, но сценарий, где
расхождение даёт неверный результат, я не проследил до конца).
**Как надо** — назвать это одним предикатом с явным аргументом времени:
`isRemoteProviderReachable(provider, { asOf: "session-start" | "now" })`,
и передавать `session-start` во всех стоп-путях одной сессии.

---

## Индекс «костыли / workarounds»

Явных маркеров (`TODO`, `FIXME`, `HACK`, `XXX`, `workaround`, `for now`,
`temporary`) в `frontend/**` — **ноль**. Ниже — то, что является костылём по
существу, а не по метке.

| # | Место | Что это | Находка |
|---|---|---|---|
| 1 | `main.tsx:11274` + `11031` | Фича «тёплый захват» вставлена после точки, которая делает её решение всегда отрицательным. Механизм присутствует, оплачен тестами и токенами, но не включается | **F-001** |
| 2 | `main.tsx:6466-6469` | `finally { suppressUiPrefAutosave = false }` без учёта того, что загрузка провалилась — снятие защиты «на всякий случай» вместо состояния «не загружено» | **F-002** |
| 3 | `transcript-merge.ts:89` `normalizeWordsCompat` | Локальная копия функции соседнего модуля с суффиксом `…Compat`, совместимость не с чем | **F-004** |
| 4 | `main.tsx:12069` `const wordCountOf = countWords` | Псевдоним, введённый вместе с комментарием об устранении дублирования | **F-014** |
| 5 | `main.tsx:9596-9602` | Пустая ветка `if` с комментарием вместо кода | **F-012** |
| 6 | `main.tsx:11828/11885/12546/12742` | Четыре прямых `document.getElementById("diarizeCheck")` вместо поля снапшота сессии | **F-006** |
| 7 | `main.tsx:11439-11503`, `11549-11571`, `11598-11619`, `11646-11667`, `11705-11727`, `12832-12855`, `12882-12894` | Семь почти одинаковых эпилогов выхода из `stopLive`: `saveRecordingText(…8 полей…)` + `clearLiveDraft` + `setBusy(false)` + `releaseStopTransitionAfterCaptureDetach` + `patchCurrentRecordingSummary` + `return`, различающиеся только текстом и `kind`. Один хелпер `finishStopWithoutTranscript({domText, kind, status, tone, statusScope})` убрал бы ~150 строк и сделал бы невозможным пропуск одного из пяти шагов | **см. ниже, «уровень инженерии»** |
| 8 | `main.tsx:11733`, `12065`, `11759`, `3716` | Ссылки на номера строк, которые давно уехали | **F-013** |
| 9 | `main.tsx:10579`, `14140` | `catch { }` в обход политики, записанной в `eslint.config.js` | **F-011** |
| 10 | `main.tsx:8045` | Вторая, урезанная реализация «умного заголовка» | **F-008** |
| 11 | `vitest.config.ts:8-10` | Секция `typecheck`, не подключённая ни к одному скрипту и указывающая на tsconfig без `tests` | **F-010** |

### Уровень инженерии: границы модуля

`main.tsx` — 14 897 строк, из них `stopLive` — 2312 (10736-13048), `startLive` —
593 (10125-10718). Это не находка сама по себе (файл дисциплинирован: чистые
решения вынесены в 17 тестируемых модулей, у каждой константы обоснование), но
у него есть измеримое следствие: **все семь продуктовых сценариев целиком живут
в непокрытом тестами файле**. 253 теста проверяют предикаты — `decideWarmHold`,
`decideDeadStreamRecovery`, `chooseStopTranscript`, `computeEnvelopeDeadlineMs` —
и ни один не проверяет их сцепление. F-001 — прямое доказательство: предикат
протестирован до последней ветки, включая ту самую `track-ended`, а интеграция
сломана с момента добавления. Логичный следующий шаг — вынести из `stopLive`
кооперацию (последовательность «барьер → finalize → конверт → доставка») в
модуль с инъектируемыми зависимостями, как это уже сделано с решениями.

---

## Индекс «хардкод → SSOT»

| # | Значение | Где сейчас | Куда | Находка |
|---|---|---|---|---|
| 1 | `2` с, `1..120`, `-42` dBFS, `-80..-10` (auto-stop-on-silence) | `index.html:713-715`, `main.tsx:3122-3123`, `main.tsx:6366/6373`, `desktop/main.js:305` — 4 копии | `UI_TOKENS.autoStopSilence` + инициализация атрибутов из него + снапшот в desktop | **F-003** |
| 2 | `normalizeWords` — правило нормализации слов | `text-match.ts:17` и `transcript-merge.ts:89` | импорт из `text-match` | **F-004** |
| 3 | 8 слов / 80 символов заголовка | `main.tsx:10833-10834` и `main.tsx:8045` | `SMART_TITLE_MAX_WORDS` / `SMART_TITLE_MAX_CHARS` + `smartRecordingTitle` | **F-008** |
| 4 | `4000` — бюджет ожидания конверта | `main.tsx:11133` (литерал в вызове) при том, что `LIVE_ENVELOPE_CONFIRM_MS`/`_DELIVERY_MARGIN_MS`/`_MAX_WAIT_MS` рядом (9821-9833) названы и обоснованы | `UI_TOKENS.finalize.envelopeWaitMs` рядом с остальными тремя | новая |
| 5 | `recordedSec * 2.5` (ожидаемых слов в секунду) и `* 0.3` (порог «подозрительно коротко»), `recordedSec > 5` | `main.tsx:12532-12533` | `UI_TOKENS.finalize.expectedWordsPerSec` / `.suspiciouslyShortRatio` / `.suspiciouslyShortMinSec` — это продуктовая эвристика, а не деталь реализации | новая |
| 6 | `0.9` (доля слов) и `0.85` (доля перекрытия) в `candidateConfirmsTranscriptCoverage` | `transcript-merge.ts:77`, `:87` — единственные безымянные числа в файле, где все остальные пороги названы (`UNION_MIN_SHARED_RATIO`, `UNION_ECHO_*`, `UNION_MAX_CELLS`) | `CONFIRM_MIN_WORD_RATIO` / `CONFIRM_MIN_OVERLAP_RATIO` с обоснованием | новая |
| 7 | `recordedSec < 1.25` («слишком коротко, чтобы доверять тишине») | `main.tsx:10889` | `UI_TOKENS.capture.silenceTrustMinSec` — соседние `minRecordingMs`/`stopTailHoldMs` уже там | новая |
| 8 | `tailActivityGapSec > 0.2` | `main.tsx:12073` | рядом с `TAIL_GAP_THRESHOLD_SEC` в `live-coverage.ts` — это второй порог того же измерения | новая |
| 9 | `provenUncoveredSec > 0.5` (порог показа предупреждения о дыре) | `main.tsx:12509` | `UI_TOKENS.finalize.reportUncoveredMinSec` | новая |
| 10 | `pcmCoverage >= 0.95` и веса `0.35 / 0.45 / 0.08 / 0.16` выбора канонического аудио | `main.tsx:3875`, `3901`, `3886`, `3888` | именованные константы у `selectCanonicalCapturedAudio` — сейчас решение «WAV или WebM станет каноническим» задано пятью безымянными числами | новая |
| 11 | `2` часа окна WebM (`60 * 120`) и отсутствие окна у `MemoryPcmSink` | `main.tsx:10544` / `main.tsx:3784` | `UI_TOKENS.capture.*MaxSamples`, оба фолбэка от одного числа | **F-007** |
| 12 | `slice(-30)` — глубина истории `__transcriptorFinishedRecords` | `main.tsx:9557`; desktop берёт `.slice(-30)` ещё раз (`desktop/main.js:2579`) | одна именованная константа, читаемая обеими сторонами контракта | новая |
| 13 | `13_000` / `8_000` / `20_000` / `6_000` мс восстановительных бюджетов | `main.tsx:2433-2442` — названы и прокомментированы, но живут вне `UI_TOKENS`, рядом с которым стоит `UI_TOKENS.finalize` | перенести в `UI_TOKENS.finalize`, чтобы «все бюджеты стопа» были одним объектом | новая, низкая |
| 14 | `version` приложения | `desktop/package.json` (SSOT по `AGENTS.md`) и `frontend/package.json:5` | вторая копия удерживается тестом `desktop/packaging.test.js`; `vite.config.ts` уже читает только desktop-манифест — `frontend/package.json.version` можно снять совсем | новая, низкая |
| 15 | Список Bluetooth-меток | `capture-warm.ts:73-89` — единственное место, обосновано, тестируется | **дефекта нет**, зафиксировано как проверенное | — |

---

## Гипотезы (проверить, прежде чем чинить)

1. **`recoverLiveDraftIfAny` публикует восстановленный черновик как paste-ready
   на загрузке.** `main.tsx:5321-5326` вызывает `publishRecordingOutput` с
   `kind: "transcript"` и `recordingId: 0`. IPC-push пропускается (`rid > 0`,
   `main.tsx:9569`), и в `__transcriptorFinishedRecords` запись не попадает
   (desktop фильтрует `recordingId > 0`, `desktop/main.js:2578`), но скаляры
   `__transcriptorLastFinishedText/At/RecordingId` выставляются. Нужно
   проверить на стороне desktop, использует ли какой-нибудь путь эти скаляры
   без сверки `recordingId` — если да, восстановленный при старте черновик
   прошлой сессии становится «готовым к вставке».
2. **`keyterms` затираются пустой строкой, если разметка старая.**
   `readDeepgramKeyterms()` (`main.tsx:5347-5350`) возвращает `""` при
   отсутствии `#deepgramKeytermsInput`, тогда как соседние
   `readDeepgramDualStream`/`readDeepgramDualSecondaryLanguage` в такой
   ситуации возвращают документированные бэкендовые дефолты — и комментарий
   на `5352-5359` объясняет, почему именно так надо. В текущем `index.html:656`
   элемент есть, поэтому путь недостижим; становится достижим на любой
   рассинхронизации разметки и рендерера. Симметрию стоит восстановить
   независимо от достижимости.
3. **`envelopeAudioEndSec` включает `stopTailHoldMs`.** `recordedSec`
   (`main.tsx:10805`) считается после 200 мс намеренного удержания микрофона,
   то есть содержит 200 мс гарантированной тишины, которую провайдер никогда
   не покроет финалом. `envelopeCoversRecording` сравнивает разницу с
   `TAIL_GAP_THRESHOLD_SEC = 0.6`. Прямого дефекта я не нашёл — единственная
   ветка, где это включало бы лишнюю full-audio recovery
   (`main.tsx:12205`), требует `tailHasInterimSpeechEvidence`, то есть речь в
   хвосте доказана. Но запас между «200 мс тишины по построению» и «порог
   600 мс» — 400 мс, и его стоит либо документировать, либо вычитать
   `stopTailHoldMs` из `recordedSec` в этом одном сравнении.
4. **`lastWriteError` в `OpfsPcmSink` необратим.** `main.tsx:3622` после первой
   ошибки записи навсегда прекращает планировать флаши, и всё оставшееся аудио
   копится в `pendingChunks` до `finalize`. Задумано как salvage (и `finalize`
   действительно склеивает spool + хвост, `3714-3745`), но для многочасовой
   записи это тот же неограниченный рост, что в F-007. Нужно измерить, бывают
   ли транзиентные ошибки OPFS на практике.
5. **`micTrackWatchersStream` не сбрасывается на «холодной» остановке.**
   `main.tsx:8836` обнуляет его только внутри `releaseWarmCapture`. При стопе
   без удержания (то есть — сегодня — при любом стопе, см. F-001) ссылка на
   мёртвый `MediaStream` остаётся в модульной переменной до следующего старта.
   Течёт один объект, слушатели на остановленных треках не вызываются;
   практического вреда не вижу, но инвариант «переменная описывает текущий
   поток» нарушен.
6. **`liveStartAttemptSeq` инкрементируется в `stopLive:10758`.** Это отменяет
   любой `startLive`, находящийся между `await`ами. Выглядит намеренно
   (отмена старта, если пришёл стоп), но `throwIfStartCancelled` бросает
   `AbortError`, который ловится общим `catch` на `10699` и уходит в
   `cleanupCancelledStartCaptureResources` — то есть отменённый старт
   освобождает ресурсы корректно. Не проследил только случай, когда `stopLive`
   вызван из `catch` самого `startLive` (`10712`): там `liveStartAttemptSeq`
   инкрементируется повторно уже после того, как ветка отмены отработала.

---

---

# Регион U — upload queue, boot overlay, update-check, gated polls

`main.tsx:13048-14897`, `update-check.ts`, `gated-poll.ts`, `list-window.ts`.
Регион в HEAD и в прочитанном дереве совпадает побайтово; ссылки — на HEAD.

## Покрытие региона U

| Под-область | Статус | Чем | Почему не полностью |
|---|---|---|---|
| `initRecordingsBootstrap` + гонка с таймаутом 15 с (13048-13066, 13209-13221) | reviewed | построчно | — |
| Версионный бейдж (13071-13083) | reviewed | построчно | — |
| Update-check UI (13085-13155) + `update-check.ts` + тест | reviewed | построчно + сверка со `styles.css`, `index.html:609-618`, `vite.config.ts` | — |
| `_networkPoll` / gated-poll wiring (13183-13208) + `gated-poll.ts` + тест | reviewed | построчно + трассировка `syncGatedPolls`, `refreshNetworkState` | — |
| Platform-marker, boot status/error, `classifyBootError`, retry (13222-13389) | reviewed | построчно + `hideBootOverlayOnce` | — |
| Типы очереди (13416-13486) | reviewed | построчно + сверка с `backend/main.py:2279-2356` | — |
| Валидация файла/пути/расширений/cap (13488-13601) | reviewed | построчно + `ALLOWED_AUDIO_EXTS` (`backend/main.py:637`) | — |
| Персистентность очереди (13785-13996) | reviewed | построчно + `GET/PUT /api/ui/upload-queue` | — |
| Reveal-мост (13647-13696) + reconcile (13698-13771) | reviewed | построчно + `desktop/preload.js`, `desktop/main.js:7418-7460` | — |
| `setupUploadView`, `enqueueUploadFile*` (13998-14203) | reviewed | построчно + `index.html:200-270` | — |
| `runUploadProcessor` / `processUploadItem` (14205-14429) | reviewed | построчно | — |
| Метки/remove/cancel/retry (14431-14594) | reviewed | построчно | — |
| `renderUploadQueue` (14596-14791) | reviewed | построчно + CSS-классы | — |
| `renderUploadResultPane` + хвост (14793-14897) | reviewed | построчно | — |
| `list-window.ts` + тест | reviewed | построчно + все вызовы | — |
| Backend `/api/jobs`, `/api/config` | partial | грепом как контракт | вне региона |

**Где смотрел и не нашёл:** `classifyBootError` — все 6 ветвей, `raw` рендерится
через `textContent`, порт не раскрывается (XSS/утечки нет); двойная защита от
path traversal в `normalizeTranscriptRecordingName` + `desktop/main.js:7433-7439`;
`UPLOAD_ALLOWED_EXTS` — живой алиас Set’а, не устаревшая копия; двойного запуска
одного элемента в `runUploadProcessor` нет (статус ставится до первого `await`);
рекурсии/двойного PUT в `flushUploadQueueSnapshotNow` нет; `gated-poll`
не копит таймеры, тесты честные (подменены только таймеры, не предмет);
`list-window` — все четыре функции чистые и корректные; CSP покрывает
`https://api.github.com` без ослабления политики.

## P0 (регион U)

### U-001 · Сорванный `GET /api/ui/upload-queue` затирает серверный снапшот пустым `PUT` — вся история загрузок и её транскрипты уничтожаются

**Файл:** `frontend/src/main.tsx:13939-13963` (`restoreUploadQueueSnapshot`),
точки `13947`, `13954`, `13955`.

```ts
async function restoreUploadQueueSnapshot(): Promise<void> {
  try {
    const payload = await apiGet<UploadQueueStoragePayload>("/api/ui/upload-queue");
    applyUploadQueueSnapshot(payload);
  } catch (e) {
    console.warn("Upload queue backend snapshot restore failed", e);
  }
  if (uploadQueue.length === 0) {
    const legacy = readLegacyUploadQueueSnapshot();
    if (legacy) applyUploadQueueSnapshot(legacy);
  }
  uploadQueueSnapshotLoaded = true;
  await flushUploadQueueSnapshotNow();      // ← безусловный PUT
  …
}
```

Проверено независимо (перечитан HEAD-снимок и бэкенд): `PUT /api/ui/upload-queue`
(`backend/main.py:1510-1514`) выполняет `atomic_write_json(UPLOAD_QUEUE_STATE_PATH,
_normalize_upload_queue_state(payload))` — **полную замену файла**, не слияние.
Значит после проваленного чтения на диск ложится `items: []`.

**Как наблюдать.** Поднять рендерер так, чтобы первый `GET` упал (бэкенд ещё
перезапускается, токен не проброшен → 401, сетевой сбой). В консоли —
`Upload queue backend snapshot restore failed`. Проверить
`~/Library/Application Support/transcriptor/ui/upload_queue.json` — перезаписан
пустым.

**Последствие.** Потеря данных: транскрипты завершённых загрузок (поле `text`,
до 200 000 символов на элемент) уничтожаются. Восстановления нет — legacy-ключ
в `localStorage` к этому моменту уже удалён (13958), а
`uploadQueueSnapshotLoaded = true` (13954) навсегда закрывает повторный restore
в этой сессии.

**Severity:** **P0** · **подтверждено** (путь `setupUploadView` → `13968` →
`13955` → `13877 apiPut`; семантика записи бэкенда проверена отдельно).

**Как надо.**

```ts
async function restoreUploadQueueSnapshot(): Promise<void> {
  let serverReadOk = false;
  try {
    const payload = await apiGet<UploadQueueStoragePayload>("/api/ui/upload-queue");
    applyUploadQueueSnapshot(payload);
    serverReadOk = true;
  } catch (e) {
    console.warn("Upload queue backend snapshot restore failed", e);
  }

  // Никогда не писать поверх состояния, которого мы не прочитали.
  // Пустая очередь после ПРОВАЛЕННОГО чтения — это «мы не знаем», а не
  // «пусто»; PUT здесь уничтожил бы чужие данные, потому что бэкенд
  // заменяет файл целиком (backend/main.py:1510).
  if (!serverReadOk) {
    uploadQueueSnapshotLoaded = false;
    setStatus(
      "Upload history is unavailable — the backend did not answer. Nothing was overwritten.",
      "warning",
    );
    return;
  }

  if (uploadQueue.length === 0) {
    const legacy = readLegacyUploadQueueSnapshot();
    if (legacy) applyUploadQueueSnapshot(legacy);
  }
  uploadQueueSnapshotLoaded = true;
  await flushUploadQueueSnapshotNow();
  if (uploadQueueLastSaveOk) {
    try { localStorage.removeItem(LEGACY_UPLOAD_QUEUE_STORAGE_KEY); }
    catch (e) { console.warn("Legacy upload queue snapshot cleanup failed", e); }
  }
}
```

(`beginUploadQueueSnapshotRestore:13965` уже обнуляет `uploadQueueRestorePromise`
в `finally`, поэтому после отказа повторный вызов честно перезапустит restore.)

**Почему это не сознательное решение.** Двадцатью строками ниже, в `13956`,
автор ЯВНО проверяет `uploadQueueLastSaveOk` перед удалением legacy-ключа —
принцип «не удаляй, пока не убедился» в этой же функции применён к менее
ценным данным. К серверному снапшоту его забыли применить. Комментарий
`13820-13823` отдельно фиксирует «backend owns the queue schema» — намерение
«сервер главный» есть, реализация его переворачивает.

## P1 (регион U)

* **U-002** · `frontend/styles.css` (весь файл) против `main.tsx:13093/13116` —
  **весь CSS проверки обновлений лежит в файле, который не подключён.**
  Единственный импорт стилей — `main.tsx:1 import "./styles.css"`, то есть
  `frontend/src/styles.css`; `index.html` не содержит ни одного `<link
  rel="stylesheet">`. Селекторы `.screen-header-update`, `.update-check-btn`,
  `.update-check-status[data-tone=…]`, `.update-check-status-link a` мертвы:
  `renderUpdateStatus` пишет `dataset.tone`, у которого нет читателя — «есть
  обновление» визуально неотличимо от «проверить не удалось». **подтверждено.**
  Как надо — перенести правила в конец `frontend/src/styles.css` и
  `git rm frontend/styles.css`. Не сознательное решение: `git log` показывает
  единственный содержательный коммит `f5c8a41 "Update detection (Level 1)"` —
  файл создан вместе с фичей и ровно под неё; никто не пишет атрибут, у
  которого сознательно нет читателя.
* **U-003** · `main.tsx:14606-14618` (`renderUploadQueue`, ранний выход) —
  **после «Clear done» правая панель продолжает показывать транскрипт удалённого
  элемента и живую кнопку «Reveal in folder».** `renderUploadResultPane()`
  вызывается только в конце функции (14790), а ветка пустой очереди делает
  `return` раньше; `uploadSelectedId` тоже не сбрасывается, а `onclick` кнопки
  замкнут на удалённый `item`. **подтверждено.** Как надо — перед `return`
  добавить `uploadSelectedId = null; renderUploadResultPane();`.
* **U-004** · `main.tsx:14280-14287` против `main.tsx:11726` — **Upload молча
  подменяет выбранного провайдера на local.** У Live-пути для ровно этого факта
  есть текст `localFallbackReason` (`main.tsx:4702`, единственный вызывающий —
  11726); очередь не говорит ничего, и при батче из двадцати файлов подмена
  тихая на всех двадцати. **подтверждено.** Как надо — поле
  `providerFallbackNote` в `UploadQueueItem`, заполняемое тем же
  `localFallbackReason(selectedProvider)`, и вывод его в строке `done`.
* **U-005** · `frontend/src/gated-poll.ts:132-136` (`refreshNow`) + `:108` —
  **`refreshNow()` молча ничего не делает, если tick уже в полёте.**
  `main.tsx:13202-13203` вешает его на `online`/`offline`; `tick` —
  `refreshNetworkState`, делающий два последовательных запроса. Если сеть
  отвалилась ровно во время tick’а, `refreshNow` сбрасывает отложенный wakeup и
  зовёт `run()`, который сразу выходит по `inFlight`. Индикатор и — что важнее —
  `isRemoteProviderReachable` (от которого зависит `resolveEffectiveProvider`)
  до 10 с держат заведомо неверное значение; ровно в этом окне запись уходит к
  недоступному облаку вместо local-фолбэка. JSDoc (`gated-poll.ts:56-60`)
  обещает «run a tick now if the gate is open» — `inFlight` в контракте не
  упомянут. **подтверждено.** Как надо — флаг `refreshQueued`, отработка
  догоняющего прохода в `finally` у `run()`, плюс тест «queued refresh runs
  once the in-flight tick finishes» (его в `gated-poll.test.ts` нет: покрыты
  только свободный гейт и закрытый).
* **U-006** · `main.tsx:13810-13818` против `13820-13826` — **путь чтения
  заводит `uploadQueueServerVersion` как SSOT версии схемы, путь записи всегда
  шлёт литерал `1`** (и тип `13442` объявляет `version: 1` литеральным).
  Комментарий `13821-13823` формулирует правило «сравнивай с истиной сервера, а
  не с продублированной константой», а функция строкой выше его нарушает.
  Сегодня скрыто тем, что `_normalize_upload_queue_state` перезаписывает поле
  своей константой. **подтверждено.** Как надо — `version:
  uploadQueueServerVersion`, тип `version: number`.

## P2 (регион U)

* **U-007** · `main.tsx:14896` + `13678` + `7610-7621` — мост reveal ставится
  безусловно на верхнем уровне модуля, поэтому гейт `typeof … === "function"`
  всегда истинен, а комментарий «Hidden in plain-browser dev preview» описывает
  поведение, которого нет: кнопка «Reveal in folder» показывается вне Electron и
  молча ничего не делает. Возвращаемое `revealUploadItem` значение
  отбрасывается обоими вызывающими. Как надо — проверять признак хоста
  (`window.__transcriptorFilePathForFile`), а не объект, который рендерер
  создаёт себе сам. **подтверждено.**
* **U-008** · `main.tsx:14285-14287` — недостижимая проверка ключа провайдера:
  строкой выше `resolveEffectiveProvider` уже вернул `"local"`, если ключа нет
  (`main.tsx:4676-4683`), и `await` между ними нет. Мёртвый код, создающий
  иллюзию защиты; бросок исключения за отсутствие ключа противоречит
  комментарию 14277-14279, который обещает не ронять элементы батча.
  **подтверждено.**
* **U-009** · `main.tsx:14643` + `index.html:238` — полная перестройка
  `<ul aria-live="polite">` через `innerHTML = ""` на каждый прогресс-тик:
  скринридер зачитывает всю очередь заново, фокус уходит на `<body>`,
  подтверждение «Copied» стирается вместе с самой кнопкой. Как надо —
  переиспользовать уже написанный в проекте keyed-реконсилятор
  (`reconcileRecordingsList`, применяется для History) и снять `aria-live` со
  списка в пользу отдельного статусного узла. **подтверждено.**
* **U-010** · `main.tsx:14770-14777` против `14863-14870` и `6994` — две
  механики и две длительности подтверждения копирования у двух кнопок одной
  фичи (`textContent` + 1200 мс против `flashButtonFeedback` + 900 мс с
  `aria-label` и классами состояния). **подтверждено.**
* **U-011** · `main.tsx:13116` — класс `update-check-status-link` добавляется и
  никогда не снимается; `renderUpdateStatus` (13093) — единственный писатель
  `textContent`/`dataset.tone`, но третий атрибут состояния мимо неё прошёл.
  **подтверждено.**
* **U-012** · `update-check.ts:61` + `:34` — проверяется `draft`, но не
  `prerelease`, хотя комментарий 54-56 говорит «drafts **and prereleases**»;
  плюс `compareVersions("1.3.0-rc1","1.3.0")` уходит в лексическую ветку
  (`Number("0-rc1")` → `NaN`) и объявляет предрелиз новее релиза. **гипотеза**
  по достижимости, **подтверждено** по арифметике. Как надо — проверять оба
  поля и отделять предрелизный суффикс сегмента, плюс два теста.
* **U-013** · `main.tsx:14833-14838` — длинное имя файла схлопывает заголовок
  панели результата до голого «Result» вместо усечения; магическое `60`.
  Соседняя `uploadDisplayPreviewFromText` (13626) ту же задачу решает
  правильно. **подтверждено.**
* **U-014** · `main.tsx:13655-13667`, `13019-13024`, `5432-5437` +
  `desktop/main.js:7405/7418` — идиома «сентинел в `document.title`,
  восстановление через `setTimeout(…,0)`» скопирована трижды; протокол задан
  четырьмя независимыми литералами в двух процессах; при двух reveal в одном
  тике второй захватывает сентинел первого как `prevTitle` и «восстанавливает»
  его, отчего main.js выполняет reveal дважды. Дублирование —
  **подтверждено**, гонка — **гипотеза**. Один из трёх экземпляров уже вынес
  префикс в `SHORTCUT_BRIDGE_TITLE_PREFIX` — направление выбрано, применено к
  одному случаю из трёх.
* **U-015** · `main.tsx:13493` + `13814-13816` — `uploadQueue` не ограничен в
  памяти, а при сохранении молча обрезается до 200
  (`UPLOAD_QUEUE_MAX_PERSISTED_ITEMS`); после перезапуска элементы 201+ вместе с
  транскриптами исчезают без уведомления. Для History ровно эта задача решена
  честно — `windowStatusText` в `list-window.ts:99-104` с комментарием «a
  silently truncated list reads as data loss». **подтверждено.**
* **U-016** · `main.tsx:13206-13208` + `5628-5635` — teardown опросов написан
  поэкземплярно, поэтому `localModelsPoll` не останавливается на `pagehide`
  вообще, хотя реестр `gatedPolls` (`main.tsx:122`) уже существует и для `sync`
  используется. **подтверждено.**
* **U-017** · `update-check.ts:112-115` — часы, переставленные назад, навсегда
  выключают фоновую проверку обновлений: `lastCheckedMs > nowMs` даёт
  отрицательную разность, а значение переживает перезапуски в `localStorage`.
  Первая строка функции уже защищается от мусора (`!Number.isFinite`, `<= 0`) —
  перебран не весь набор способов быть негодным. **подтверждено.**
* **U-018** · `main.tsx:14094-14107` — правило «что считать завершённым»
  продублировано литеральным сравнением трёх строк в DOM-обработчике и в
  `14620-14622`, при том что предикат `isUploadTerminalStatus` (13773)
  существует и используется в двух других местах. **подтверждено.**
* **U-019** · `main.tsx:13986-13991` — финальное сохранение снапшота идёт
  обычным `fetch` без `keepalive` в `pagehide`/`beforeunload`; браузер отменяет
  такой запрос при выгрузке, теряя до 180 мс дебаунса изменений — а терминальные
  статусы часто проставляются именно перед закрытием. Имя `…BestEffort`
  признаёт ненадёжность, но `keepalive` — ровно один флаг. **гипотеза** по
  таймингу, механизм — **подтверждено**.
* **U-020** · `main.tsx:13698-13771` — миграция reveal-целей сопоставляет
  обрезанное превью транскрипта с `display_name` записи и делает неограниченное
  число последовательных `apiGet` в цикле при старте. **подтверждено.**
* **U-021** · `main.tsx:7356-7364` — полная перерисовка списка и принудительный
  reflow синхронно в нетроттленном обработчике `scroll`; окно растёт по 200
  строк за событие. Противоречит цели `list-window.ts`. **подтверждено**
  по механизму, **гипотеза** по величине просадки. *(Пересекается с R-005 —
  чинить одним изменением.)*
* **U-022** · `frontend/tests/` против `main.tsx:13048-14897` — ни одна строка
  региона не покрыта тестами, хотя в нём двенадцать чистых, легко тестируемых
  функций (`classifyBootError`, `uploadFileValidationError`,
  `normalizeUploadSourcePath`, `applyUploadQueueSnapshot`,
  `uploadDisplayPreviewFromText`, `normalizeTranscriptRecordingName`,
  `uploadStatusLabel`, `formatUploadFileSize` и др.), ни одна из которых не
  экспортирована. U-001, U-003, U-012, U-017 были бы пойманы одним тестом
  каждый. **подтверждено.**
* **U-023** · `main.tsx:4754-4773` во взаимодействии с `13325-13332` —
  успешный `/api/health` может закрыть boot-оверлей вместе с уже показанной
  диагностикой: `hideBootOverlayOnce` не читает `dataset.state === "error"`,
  который `__setBackendBootError` специально выставляет. **гипотеза.**

## Индекс костылей (регион U)

| # | Место | Костыль |
|---|---|---|
| K-1 | `13655-13667`, `13019-13024`, `5432-5437` + `desktop/main.js:7405/7418` | IPC через `document.title` — три копии идиомы, четыре литерала протокола (U-014) |
| K-2 | `14258-14275` `_stageCrossoverDelay` | Придуманный переход «uploading → processing» по таймеру `size / 10000` с потолком 8 с, потому что `fetch` не отдаёт прогресс тела запроса; комментарий это признаёт |
| K-3 | `14530-14536` `pickUploadRetryFile` | «Пользователь отменил диалог» определяется по `window focus` + `setTimeout(250)`; при разрешении через `change` слушатель `{once:true}` висит до произвольного будущего фокуса |
| K-4 | `14084-14091` | Глобальные `dragover`/`drop` на `window` с `closest("#uploadLargeDrop")`, вешаются внутри `setupUploadView`, снятия нет |
| K-5 | `13698-13771` | Восстановление reveal-цели сопоставлением обрезанного превью с `display_name` (U-020) |
| K-6 | `13986-13991` | «Best effort» PUT на выгрузке без `keepalive` (U-019) |
| K-7 | `14137-14140` | `try { … } catch { }` без причины вокруг зеркалирования языка *(= F-011)* |
| K-8 | `13214-13219` | `Promise.race` с `setTimeout(15000)`, который не отменяется при выигрыше bootstrap’а |
| K-9 | `14285-14287` | Недостижимая проверка ключа как «страховка» (U-008) |
| K-10 | `update-check.ts:88` | `AbortSignal.timeout(8000)` инлайном — единственная невынесенная величина модуля, при вынесенной `CHECK_INTERVAL_MS` |

## Индекс хардкод → SSOT (регион U)

| # | Значение | Где | Куда |
|---|---|---|---|
| H-1 | `version: 1` при записи | `13812`, тип `13442` | `uploadQueueServerVersion` ← `backend/main.py:2280` (U-006) |
| H-2 | `"__app_reveal_recording__"`, `"__app_record_toggle__"` | `13663`, `13020`; `desktop/main.js:7418`, `7405` | общий набор констант моста (U-014) |
| H-3 | `1200` мс подтверждения Copy | `14775` | `flashButtonFeedback` (900 мс, `6994`) (U-010) |
| H-4 | `60` — предел заголовка результата | `14835` | именованная константа (U-013) |
| H-5 | `8000` мс таймаут к GitHub | `update-check.ts:89` | константа модуля рядом с `CHECK_INTERVAL_MS` |
| H-6 | `["auto","ru","en"]` — белый список языков | `14139` | опции `#uploadLanguage`/`#language` из разметки |
| H-7 | `"WAV · MP3 · M4A · FLAC · OGG · AAC · MP4 · WEBM · MOV · MKV"` — 10 расширений | `index.html:221` | `ACCEPTED_AUDIO_VIDEO_EXTS` ← `backend/main.py:637` (**там 18**; копия уже разошлась: нет `oga, opus, wma, m4v, avi, mpg, mpeg, 3gp`) |
| H-8 | `accept="audio/*,video/*"` | `index.html:213` и `14515` | одна константа |
| H-9 | Копия пустого состояния Upload | `index.html:240-243` и `14611`/`14613` (через `innerHTML`) | одно место, `replaceChildren` вместо `innerHTML` |
| H-10 | `"done" \|\| "error" \|\| "cancelled"` | `14100`, `14620-14622` | `isUploadTerminalStatus` (`13773`) (U-018) |
| H-11 | `"deepgram"` как дефолт провайдера | `13600`, `13856`, `14276` | `UPLOAD_DEFAULT_PROVIDER` |
| H-12 | CSS блока обновлений | `frontend/styles.css` (не собирается) vs `frontend/src/styles.css` | один файл (U-002) |
| H-13 | Поэкземплярный `pagehide`-teardown опросов | `13206`, `5628` | реестр `gatedPolls` (`122`) (U-016) |

---

# Регион R — History (список, поиск, статистика, плеер), `saveRecordingText`, DOM-обвязка

`main.tsx:6819-8360`, `recordings-list-reconciler.ts`, `deepgram-dual.ts`,
разметка плеера. Регион в рабочем дереве идентичен HEAD; ссылки — на HEAD.

## Покрытие региона R

| Под-область | Статус | Чем | Почему не полностью |
|---|---|---|---|
| `main.tsx` 6819-7130 (state, поиск, viewer-хелперы, ключи, bootstrap) | reviewed | построчно | — |
| 7131-7380 (empty-state, build/update/syncBadges, `renderRecordingsList`, windowStatus, scroll, moveSelection) | reviewed | построчно | — |
| 7381-7532 (`loadRecordings`, `loadRecordingsStats`) | reviewed | построчно + backend-контракты | — |
| 7533-7642 (`openRecording`) | reviewed | построчно | — |
| 7643-7772 (`saveRecordingText`) | reviewed | построчно | — |
| 7774-8360 (DOM-wiring, retranscribe, delete-all, popup, toggles, dual UI) | reviewed | построчно | — |
| `recordings-list-reconciler.ts` + тест | reviewed | построчно + ручной прогон алгоритма на 4 сценариях | — |
| `deepgram-dual.ts` + тест | reviewed | построчно | — |
| Аудиоплеер viewer’а | reviewed | `index.html:581-583`, `styles.css:1612-1655`, `main.tsx:1913-1954`, `7574-7608` | — |
| Жизненный цикл ObjectURL | reviewed | все 12 call-site’ов + трассировка гонок | — |
| Контракты `/api/recordings*`, `/api/config` | reviewed | `backend/main.py:6738-7090`, `config.py:495-660`, `deepgram_dual.py:134-175` | — |
| CSS-классы региона против разметки | reviewed | матрица grep по 17 классам | — |
| `window.desktop` / preload | partial | grep `__transcriptorRevealRecording` (7613-7621) | вне региона; единственная точка соприкосновения проверена |

**Где смотрел и не нашёл:** алгоритм реконсилятора (`refNode`-курсор, snapshot
перед удалением, `Array.from(list.children)`) — корректен; XSS в регионе нет
(имена, `display_name`, транскрипт, бейджи, чипы — всё `textContent`; три
`innerHTML = ""` только очищают; `data-recording-key` = `encodeURIComponent`,
читается через `cssEscape`); токен API нигде не попадает в query;
гонка `recordingOpenRequestSeq` проверена на всех трёх точках возобновления —
утечки ObjectURL при вытеснении нет; `deepgram-dual.test.ts` — 6 тестов с
ассертами, предмет не мокается; мёртвых CSS-классов, объявленных в
`styles.css`, в регионе нет.

## P0 (регион R)

Нет.

## P1 (регион R)

* **R-001** · `main.tsx:7413` (`loadRecordings`) + `6845` — **фоновое обновление
  History сбрасывает окно списка до 200 строк и выбрасывает пользователя с того
  места, где он читал.** `resetRecordingsWindow()` вызывается безусловно, в том
  числе на пути `{background:true}`, которым идёт `flushDeferredRecordingsRefresh`
  после **каждого** сохранения записи. Keyed-реконсилятор сохраняет DOM-узлы —
  а сброс окна их тут же удаляет: механизм, написанный против «я пролистал
  пятьсот элементов, а меня откидывает наверх» (`7243-7248`), работает, а
  симптом остался. **подтверждено** (трасса `saveRecordingText:7752` →
  `requestDeferredRecordingsRefresh:2955` → `flushDeferredRecordingsRefresh:2984`
  → `loadRecordings{background:true}` → `7413`). Как надо — сбрасывать окно
  только когда новый набор не пересекается со старым; комментарий 7410-7412
  («replaces the filtered set wholesale») верен для смены директории архива и
  неверен для фонового рефреша.
* **R-002** · `main.tsx:2222-2224` (`renderLatestSavedAudio`, `catch`) — **при
  ошибке загрузки аудио устаревший рендер побеждает свежий.** Guard
  `if (renderSeq !== currentRecordingAudioRenderSeq) return;` стоит **внутри**
  `try`, после `await`; отклонённый fetch уходит в `catch`, который проверку не
  повторяет, и выполнение доходит до перезаписи глобального
  `currentRecordingAudioObjectUrl` (2251) и `audioEl.src` (2253). Следствия:
  утечка ObjectURL свежего рендера (многомегабайтный WAV в памяти на весь
  сеанс), плеер «текущая запись» переключается на **предыдущую** запись — ровно
  тот репорт, против которого написан комментарий 6937-6946, — и
  `currentRecordingAudioSourceKey` закрепляет подмену через skip-guard
  2167-2180. Вход достижим штатно: бэкенд удаляет файлы по ретенции на каждом
  сохранении (`prunedAudioCount`, 7762). **подтверждено.** Как надо — повторить
  guard первой строкой `catch`; `openRecording:7593` в аналогичном месте это
  делает, то есть правильный образец в файле есть.
* **R-003** · `main.tsx:8188-8191` (`#deleteAllConfirmBtn`) — **результат
  «Удалить всё», включая частичный провал, не показывается вообще.**
  `showRecordSessionNotice` пишет в `#recordSessionNotice`, который лежит внутри
  `<section class="view" data-view="record">` — в момент нажатия эта секция
  `hidden`; а `$("recordingContent").textContent = summary` (8189) немедленно
  затирается следующей строкой `await loadRecordings(true)` → `resetRecordingViewer`
  → `textContent = ""` (6894). `setStatus` (видимая из любого вида плашка) не
  вызывается ни разу. Бэкенд честно считает `failed` (`backend/main.py:6907`) —
  и пользователь об этом не узнаёт. **подтверждено.** Как надо — сообщать через
  `setStatus` + `resetRecordingViewer(summary)` ПОСЛЕ перезагрузки списка.
* **R-004** · `main.tsx:8236-8255` против `5405` — **`#diarizeCheck` не
  сохраняется между запусками и читается шестью инлайновыми кастами без
  аксессора.** Два соседних переключателя того же поповера
  (`#autoTranscribeToggle`, `#livePreviewToggle`) имеют листенер,
  поле в `collectUiPreferences` и аксессор; третий — ничего. Близнец на вкладке
  Upload (`#uploadDiarize`) при этом **сохраняется** (`upload_diarize`, 5405) и
  читается через `?.`. Шесть чтений (`7999`, `10277`, `11813`, `11870`,
  `12553`, `12749`) — жёсткие касты без `| null`. **подтверждено.**
  *(Смыкается с F-006: там же показано, что значение к тому же не попадает в
  снапшот сессии и потому расходится между live-стримом и recovery.)*
* **R-005** · `main.tsx:7352-7365` + `6970-6984` — **на каждое событие скролла
  выполняется полная O(N) фильтрация архива, дважды за кадр при росте окна.**
  `getFilteredRecordings().length` вызывается первой строкой, до любого дешёвого
  выхода; при непустом запросе это N конкатенаций шести полей + `toLowerCase` +
  `includes` на архиве, для которого сам `list-window.ts:5-7` называет цифру
  ~5900. `{passive:true}` спасает только композитор, не главный поток.
  **подтверждено.** Как надо — мемоизировать отфильтрованный набор у его двух
  писателей (`setRecordingsSearchQuery`, `loadRecordings`) и поставить дешёвую
  проверку геометрии первой. *(Пересекается с U-021.)*
* **R-006** · `index.html:680` + `main.tsx:5369-5377`, `6194-6198`, `6282-6317`
  — **если `loadCfg` упал до строки 6314, следующий автосейв запишет
  `dual_stream: false` и сотрёт `keyterms`.** `readDeepgramDualStream()` защищён
  от отсутствующего элемента, но не от незаполненного: разметочный дефолт
  `#deepgramDualStreamCheck` снят, тогда как документированный дефолт бэкенда —
  `True` (`backend/config.py:512`, `deepgram-dual.ts:26`). **гипотеза** по
  воспроизводимости, код-путь — подтверждён. Не сознательное решение:
  `deepgram-dual.ts:14-20` формулирует правило «absent means the documented
  default, never off» и закрывает один из двух путей отсутствия.
  *(Это тот же класс, что F-002, и чинится тем же флагом «конфиг загружен» —
  плюс приведение разметочного дефолта к бэкендовому.)*

## P2 (регион R)

* **R-007** · `7260-7283` — строка «Showing N of M» остаётся висеть над пустым
  списком: `renderRecordingsWindowStatus` вызывается только на 7315, после обоих
  ранних `return`. **подтверждено.**
* **R-008** · `6994-7006` (`flashButtonFeedback`) — повторный клик по Copy
  навсегда оставляет `aria-label`/`title` = «Copied»: таймер не сохраняется и не
  отменяется, а прежние подписи читаются из живого DOM, где уже стоит «Copied».
  **подтверждено.** Как надо — `WeakMap<HTMLButtonElement, number>` с отменой
  предыдущего таймера.
* **R-009** · `7422` — `recordingsLoadRequestSeq` не перечитывается после
  `await refreshRecordingsStatsIfVisible()`; статистика делает полное чтение и
  токенизацию архива (документировано как «seconds», `backend/main.py:6991-7026`),
  за это время устаревший `loadRecordings` продолжит со снимком
  `selectedKeyAfterLoad`, взятым до ожидания. **подтверждено.** Плюс:
  «декоративной» статистике (7451) не место под `await` в горячем пути.
* **R-010** · `7445-7455` — провал загрузки статистики неотличим от пустого
  архива: `catch` только логирует, панель остаётся с разметочными нулями, и
  пользователь читает «Recordings 0, Words 0», видя слева список записей.
  **подтверждено.**
* **R-011** · `7488`, `7493`, `7501-7506` — список провайдеров задублирован
  дважды подряд и является третьей копией знания, канонизированного в
  `providerLabel` (2414-2422) и в типе `Provider`; статистика печатает сырой
  lowercase (`deepgram`), а бейджи списка — `providerLabel` (`Deepgram`), и обе
  надписи видны на одном экране. **подтверждено.**
* **R-012** · `7204` — мёртвая ветка `it.provider !== "unknown"`:
  `_build_recordings_list_payload` (`backend/main.py:6774`) возвращает `""`, а
  не `"unknown"`; строку `"unknown"` производит только payload статистики
  (`7013`), который в бейджи не попадает. **подтверждено.**
* **R-013** · `recordings-list-reconciler.ts:29` + `:104-108` — контракт
  «созданный узел обязан нести `data-recording-key`» не объявлен, не обеспечен и
  не покрыт тестом; проход очистки удалит любого ребёнка без ключа, включая
  только что созданный, — пустой список без единой ошибки. Как надо —
  реконсилятор должен ставить ключ сам. **подтверждено** (по будущей регрессии —
  гипотеза).
* **R-014** · `index.html:582` против `index.html:427-440` — два плеера для
  одной задачи: viewer использует нативные `<audio controls>`, «текущая запись» —
  собственный. Комментарий `main.tsx:2318-2321` прямо формулирует решение
  («native `<audio controls>` chrome looks like a web widget inside the Electron
  shell»), применено оно к одному из двух. **подтверждено.**
* **R-015** · `1951` + `7589-7591` — ошибка медиаэлемента в viewer’е глотается и
  трактуется как готовность: слушатель `"error"` вызывает тот же `finish`, что и
  `canplay`, после чего плеер показывается и ничего не воспроизводит. У плеера
  «текущая запись» такая ошибка хотя бы логируется (`2404-2411`).
  **подтверждено.**
* **R-016** · `deepgram-dual.ts:26-27` против `backend/config.py:512-513` — два
  дефолта в двух половинах репозитория без перекрёстной проверки; тест сравнивает
  результат с собственной константой, то есть относительно рассинхрона
  тавтологичен. **гипотеза.** Как надо — bootstrap-инъекция (как
  `LIVE_SAMPLE_RATE_HZ`) либо тест-сверка по образцу `desktop/packaging.test.js`.
* **R-017** · `backend/deepgram_dual.py:157-162` против `deepgram-dual.ts:52-68`
  — запрет «второй поток не может быть Auto» реализован только на фронте
  (дважды), бэкенд валидирует лишь тип и непустоту; конфиг с
  `"dual_secondary_language": "auto"` даст два одинаковых мультиязычных потока —
  «the multi stream twice at twice the price», против чего написаны оба
  комментария. **гипотеза** (из рендерера недостижимо).
* **R-018** · `recordings-list-reconciler.ts:91-94` — пустая ветка `if`,
  существующая только ради комментария. **подтверждено.** *(Тот же класс, что
  F-012.)*
* **R-019** · `6991` против `4310` — `disabled` кнопки Clear вычисляется
  одинаковым выражением `recordingsUiLoading || !hasQuery` в двух местах.
  **подтверждено.**
* **R-020** · `index.html:571` — класс `recording-reveal-btn` без единого
  CSS-правила (grep: 0 в `styles.css`, 0 в `main.tsx`). **подтверждено.**
* **R-021** · `7623-7639` — текст ошибки помещается в тело транскрипта и
  становится копируемым как транскрипт: `updateRecordingCopyState` (6885)
  смотрит именно на `recordingContent.textContent`, поэтому по кнопке «Copy
  recording text» в буфер уедет «Could not open this recording…».
  **подтверждено.** Как надо — писать в `data-placeholder`, тело оставить пустым.
* **R-022** · `8221-8232` — три недоделки в поповере настроек: недостижимая
  проверка `e.target !== transcribeSettingsBtn` (событие погашено
  `stopPropagation` строкой выше), отсутствие `aria-expanded`, отсутствие
  закрытия по Escape и при `switchView`. **подтверждено.**
* **R-023** · `7676-7678` — ранний выход `saveRecordingText` возвращает
  `SavedRecordingRef`, неотличимый от результата настоящего сохранения;
  вызывающий не может понять, что не записано ничего. **подтверждено.**
* **R-024** · `7700` против `7721`/`7740` — две схемы обработки HTTP-ошибок в
  одной функции: ветка с аудио идёт голым `fetch` + ручной `parseError`, две
  другие — через `apiPost`. **подтверждено.**
* **R-025** · `7381-7390` — «нормализатор» `normalizeLoadRecordingsOptions`
  приводит две формы входа к разным формам выхода (булева даёт `background` и
  `reopenSelected` = `undefined`). **подтверждено**, сейчас безвредно.
* **R-026** · `7367-7379` + `7810-7845` — удержание стрелки даёт по сетевому
  запросу и по полной перерисовке окна на нажатие (seq-guard отбрасывает
  результат, но запрос уходит); `End` через `resolveWindowSize` материализует
  весь архив — прямо против цели `list-window`. Плюс `Math.max(0, findIndex)`
  при отсутствии выделения делает `currentIndex = 0`, и ArrowDown перепрыгивает
  строку 0. **подтверждено.**
* **R-027** · `7783-7797` — фильтрация без дебаунса, дважды за нажатие клавиши
  (7785 и внутри `renderRecordingsList`), плюс реконсиляция до 200 строк на
  каждый символ; ср. `UI_TOKENS.settings.saveDebounceMs`, где дебаунс есть.
  **подтверждено.**
* **R-028** · `7554-7566` против `backend/main.py:6943` — `display_text`
  читается кастом мимо объявленного типа, хотя бэкенд возвращает его **всегда**;
  при этом `content` объявлен обязательным, хотя нужен только для экспорта.
  **подтверждено.**
* **R-029** · `6935-6968` — «свежайшая запись с аудио» определяется как первый
  элемент массива; корректно только потому, что бэкенд сортирует по
  `modified_at` убыв. (`backend/main.py:6808`), и это нигде не зафиксировано.
  **подтверждено.**
* **R-030** · `7999`, `11813`, `11870`, `12553`, `12749` — пять чтений
  `#diarizeCheck` жёстким кастом без `| null` уронят обработчик `TypeError`’ом
  при рассинхроне разметки, тогда как `#uploadDiarize` читается через `?.`
  (5405). Покрывается фиксом R-004/F-006. **подтверждено.**
* **R-031** · `index.html:529` — список с клавиатурной навигацией не имеет
  ролей: `role="listbox"`/`role="option"`/`aria-activedescendant` отсутствуют,
  а `aria-current="true"` (7156, 7186) — не та семантика (это «текущая
  страница/шаг»). **подтверждено.**

## Индекс костылей (регион R)

| # | Место | Костыль |
|---|---|---|
| 1 | `7573` | Каст `(r as { display_text?: string })` в обход собственного объявленного типа (R-028) |
| 2 | `7435-7441` | `finally` снимает состояние загрузки и для вытесненных запросов — лечит «permanent loading state» и создаёт «индикатор гаснет, пока новая загрузка идёт» |
| 3 | `6876-6879` | `refreshRecordingsStatsIfVisible` инкрементирует счётчик запросов в ветке «панель скрыта» — механизм отмены используется функцией, которая запроса не делает |
| 4 | `7901-7918`, `8144-8146` | Фантомный `activeUiSessionToken`, который Re-transcribe выдаёт сам себе, потому что `isCurrentUiSession("")` (1957) безусловно `true`. Обход дефектного предиката вместо его починки; в комментарии назван «legacy short-circuit» |
| 5 | `8110-8111` | Два `String.replace` с регулярками, вырезающими хвост «or switch Provider to "local" in Settings» из уже собранного сообщения — правка чужого текста постфактум вместо параметра у `explainNetworkError` |
| 6 | `8229` | Мёртвое условие, недостижимое из-за `stopPropagation()` строкой выше (R-022) |
| 7 | `recordings-list-reconciler.ts:91-94` | Пустая ветка `if` (R-018) |
| 8 | `8188` | Явная передача `7000` при том, что это уже дефолт параметра (2765) |
| 9 | `7485` | Хардкод-фильтр `key === "fal" \|\| key === "fal.ai" \|\| key === "falai"` — вычищение следов удалённого провайдера прямо в рендере статистики |
| 10 | `13214-13221` | `Promise.race` с `setTimeout`, который не отменяется при выигрыше bootstrap’а *(= K-8 региона U)* |

## Индекс хардкод → SSOT (регион R)

| Значение | Где | Куда |
|---|---|---|
| `["local","openrouter","deepgram"]` | `7488` и `7493` (две копии подряд) + `providerLabel` (2414-2422) + тип `Provider` | `PROVIDER_DISPLAY_ORDER` рядом с `providerLabel` (R-011) |
| Подпись провайдера | статистика — сырой lowercase (7504), бейджи — `providerLabel` (7205) | `providerLabel` в обоих (R-011) |
| `900` мс вспышки Copy | `7005` инлайном | `UI_TOKENS.feedback.flashMs` |
| `.slice(0,10)` провайдеров, `.slice(0,8)` языков | `7499`, `7523` (бэкенд отдаёт `[:25]` top_words) | `UI_TOKENS.stats.*` |
| `7000` мс уведомления | `8188` дублирует дефолт `showRecordSessionNotice` (2765); ещё 9000/6000 разбросаны | `UI_TOKENS.notice.*` |
| `160` / `220` / `120` мс дебаунсов фонового рефреша | `2944`, `2970`, `2997` | `UI_TOKENS.recordings.deferredRefresh*` |
| `15000` мс таймаута bootstrap | `13217` | `UI_TOKENS.recordings.bootstrapTimeoutMs` |
| `RECORDING_VIEWER_AUDIO_READY_TIMEOUT_MS = 1500` | `301` — именованная, но вне `UI_TOKENS` | `UI_TOKENS.recordings.*` (в `UI_TOKENS` нет ни одной записи про History — вся под-область живёт мимо него) |
| `"Choose a recording from the left list..."` | `6889` (дефолт параметра), `7433`, `index.html:584` — **3 копии** | одна константа копий |
| `"No recordings match the current search."` | `7270`, `7433`, `7792` — **3 копии** | то же |
| `"Choose a recording"` | `6890`, `index.html:567` | то же |
| `"Transcription will appear here..."` | `7572`, `index.html:425` | то же |
| `"Audio for this recording could not be loaded."` | `2240` и `2242` — две копии подряд в одном блоке | локальная константа |
| «costs 2× Deepgram minutes» | `index.html:687-688` и `8322-8324` — две формулировки одного факта | одна строка на обе поверхности |
| `DUAL_STREAM_DEFAULT` / `DUAL_SECONDARY_LANGUAGE_DEFAULT` | `deepgram-dual.ts:26-27`, `backend/config.py:512-513`, `backend/deepgram_dual.py` — 3 копии без перекрёстного теста | bootstrap-инъекция либо тест-сверка (R-016) |
| Дефолт `#deepgramDualStreamCheck` | `index.html:680` (unchecked) против `DUAL_STREAM_DEFAULT = true` | разметочный дефолт обязан совпадать (R-006) |
| `recordingsUiLoading \|\| !hasQuery` | `4310` и `6991` | `syncRecordingsSearchControls` как единственный писатель (R-019) |


---

# Регион C — типы, `UI_TOKENS`, каталог моделей, статусы, api, конфиги, `index.html`, `styles.css`

`main.tsx:1-3460`, `transcription-catalog.ts`, `error-text.ts`,
`shortcut-display.ts`, `live-pane.ts`, `vite.config.ts`, `vitest.config.ts`,
`tsconfig.json`, `eslint.config.js`, `package.json`, `index.html`, `styles.css`.
Все ссылки перепривязаны к `git show 0de0c2d:` (файл менялся в дереве во время
работы). `index.html`, `styles.css` и четыре модуля от HEAD не отличаются.

## Покрытие региона C

| Подобласть | Строки/файл | Прочитано | Найдено |
|---|---|---|---|
| Заголовок модуля, импорты, `installErrorAwareConsole` | 1-128 | 100 % | C-018 |
| Интерфейсы `AppConfig`/`RecordingItem`/… | 130-350 | 100 % | S-10…S-12 |
| `LiveFinalEnvelope`/`LiveFinalStats`/`LiveWsMessage` | 365-459 | 100 % | C-009, S-12, W-3 |
| `parseOptionalNonNegativeNumber`/`parseLiveFinalStats`/`parseLiveWsMessage` | 461-578 | 100 % | C-009, C-016 |
| Типы shortcut/model-catalog/bootstrap, `declare global` | 580-749 | 100 % | — |
| `$`, форматтеры времени/байт | 751-783 | 100 % | S-09/S-22 |
| `installAppearanceStateClasses` | 785-869 | 100 % | **ничего** |
| storage-ключи, `LIVE_SAMPLE_RATE_HZ`, `UI_TOKENS` | 871-1023 | 100 % | S-06, S-07, S-23 |
| LEGACY_*, лимиты очереди, каталоги моделей | 1024-1064 | 100 % | C-013, S-24 |
| Нормализаторы каталога | 1066-1107 | 100 % | **ничего** |
| Unified selection SSOT | 1109-1266 | 100 % | **C-001, C-002** |
| Local-model UI | 1268-1682 | 100 % | **C-003, C-004**, C-010…C-012 |
| `applyHealthModelCatalog`/`applyBackendBootstrap`/`applyBackendRuntimeConfig`/`applyRuntimeLimits` | 1684-1812 | 100 % | C-014 |
| Блок глобального состояния | 1814-1856 | 100 % | S-10 |
| auth / WS-протокол / `cssEscape` | 1858-1911 | 100 % | **C-015** |
| Object-URL helpers, аудио-хелперы, `setCurrentRecordingAudio` | 1913-2412 | 100 % | **C-005**, S-04, S-09 |
| Провайдер-хелперы, таймауты | 2414-2515 | 100 % | S-01, S-23 |
| `sanitizeUiErrorMessage` | 2517-2579 | 100 % | S-20 |
| Нормализаторы транскрипта | 2581-2748 | 100 % | C-019, C-020, S-06 |
| Статус-пайплайн | 2750-3113 | 100 % | C-017, S-08, S-21, S-25 |
| `setBusy`, deferred refresh, key-mask | 2918-3202 | 100 % | C-016, S-03 |
| `explainNetworkError`, `parseError`, `api*` | 3204-3350 | 100 % | C-021, S-20 |
| `downsample`, `PcmSink` | 3352-3460 | 100 % | **ничего** |
| `transcription-catalog.ts` + тест | 163+127 | 100 % | S-01, S-11 |
| `error-text.ts` + тест | 108+119 | 100 % | **ничего** |
| `shortcut-display.ts` + тест | 58+97 | 100 % | **ничего** |
| `live-pane.ts` + тест | 43+34 | 100 % | C-022 |
| Конфиги сборки/линта/типов | 100 % | 100 % | C-023 |
| `index.html` — CSP, inline-скрипты, сверка id ↔ `$()` | 842 | 100 % | **C-006, C-007**, C-024, S-02 |
| `styles.css` — токены, дубли | 4197, автоматический разбор | 100 % токенов | **C-008**, C-025, S-13…S-18 |
| Контракты с `backend/main.py`, `live.py`, `remote_deepgram_live.py`, `deepgram_dual.py`, `config.py`, `audio_mime.py` | грепом | — | C-009, S-04…S-06 |
| `desktop/preload.js` ↔ `Window.transcriptor` | 106 | 100 % | **ничего** — форма совпадает 1:1 |

**Где смотрел и не нашёл:** XSS — все 12 сайтов `innerHTML` либо `= ""`, либо
статический литерал; токен не утекает в URL (`websocketAuthProtocols` кладёт его
в sub-protocol, `latestRecordingAudioUrl` — только `archive_dir`);
`installAppearanceStateClasses` — все listener’ы в `cleanupFns`, `pagehide
{once:true}`, утечек нет; `waitForRecordingViewerAudioReady` — `{once:true}` +
явный `removeEventListener` + `clearTimeout` во всех трёх исходах;
`createLinkedAbortSignal` — `cleanup` снимает и таймер, и parent-listener;
`parseError` — однократное чтение `text()`, баг «body stream already read»
закрыт; `downsample`/`resetDownsampleState` — carry непрерывен, остаток не
теряется; **все 86 `$("…")` и 56 `getElementById("…")` разрешаются в
существующие id** в `index.html`, висячих ссылок нет.

## P1 (регион C)

* **C-001** · `main.tsx:1153-1183` (`renderTranscriptionSelectors`) — **guard
  идемпотентности `#providerSelect` сломан навсегда, селект полностью
  пересобирается каждые 10 секунд.** `signature` строится из 4 групп каталога, а
  `current` — из **всех** `sel.options`, куда после первой же перестройки
  добавляется пятая опция `None` (1175-1180); сравнение больше никогда не
  совпадёт. Проверено вычислением: `local-whisper:1|gigaam:1|deepgram:1|openrouter:1`
  против `…|:1`. В рантайме путь — `_networkPoll` (`UI_TOKENS.network.refreshIntervalMs`
  = 10 000) → `applyHealthModelCatalog` → сюда, плюс 2-секундный
  `localModelsPoll`. Открытый dropdown закрывается, фокус и hover теряются —
  ровно та регрессия, которую комментарий 1147-1152 обещает предотвратить
  («so the 2 s health poll never closes an open dropdown»). `#uploadProviderMirror`
  (без `None`) работает правильно — два поведения у одной функции.
  **подтверждено.** Как надо — включить `None` в подпись:
  `const wantsNone = id === "providerSelect"; …, ...(wantsNone ? [":1"] : [])`.
* **C-002** · `main.tsx:1182` — `if (uiProviderGroup) sel.value = uiProviderGroup;`
  пропускает присваивание для легитимного состояния «None» (`""`), и после
  пересборки (а она теперь происходит всегда, C-001) браузер выбирает первую
  опцию: **селект показывает «Local Whisper», хотя SSOT говорит «None»**, а
  модельный селект при этом скрыт. Модуль, объявленный в шапке как «эти селекты —
  ВИДЫ, никогда не переопределяющие состояние» (1109-1116), в одном состоянии
  перестаёт быть видом. **подтверждено.** Как надо — `sel.value = uiProviderGroup;`
  без условия.
* **C-003** · `main.tsx:1651-1660` — **кнопка «Download» в модальном окне не
  скачивает ничего.** Проверено независимо: все присваивания
  `pendingModelSelection` — это `null` (1282, 1447, 1458, 1645) и `= id` на 1658,
  то есть **внутри** самого confirm-обработчика под `if (id)`. Единственный путь,
  открывающий модалку (обработчик `change` на `#remoteModelSelect`, 1664-1680),
  кандидата никуда не записывает — только в `textEl.textContent`. Значит на 1653
  `id === null` всегда, и `requestModelDownload` из модалки не вызывается ни разу.
  Пользователь видит «`medium` is not on this machine yet (~1.4 GB download).
  Download it now?», жмёт «Download» — и не происходит **ничего**: ни запроса, ни
  статуса, ни ошибки, модалка просто закрывается. Работает только вторая,
  независимая точка входа — построчная кнопка Download в таблице Settings
  (1615-1616), которая идёт мимо модалки и мимо согласия. **подтверждено.**
  Как надо — держать кандидата отдельно (`pendingDownloadCandidate`), заполнять
  его в `change`-обработчике, а `pendingModelSelection` пинить только после
  успешного `requestModelDownload`. Не сознательное решение: комментарий
  1656-1658 («BUG-40: never pin on a failed request», «applied automatically once
  ready») описывает работающий поток скачивания — код, который должен был его
  питать, отсутствует.
* **C-004** · `main.tsx:1662-1681` — **выбор облачной модели Deepgram/OpenRouter
  открывает диалог о скачивании весов на диск.** Обработчик проверяет
  `isLocalModelReady(value)`, но не проверяет, что группа локальная, а
  `#remoteModelSelect` — единый селект для всех групп (`index.html:386-390`).
  Для `nova-3`: `findLocalModelRow` → `undefined` → `isLocalModelReady` → `false`
  → модалка «nova-3 is not on this machine yet. Download it now?». Плюс на этом
  элементе висят **два** `change`-обработчика (8262 — правильный, 1664 —
  ложный), и срабатывают оба. **подтверждено.** Как надо —
  `if (!isLocalGroup(readProviderGroup())) return;` первой строкой
  (`isLocalGroup` уже импортирована, `main.tsx:52`).
* **C-005** · `main.tsx:2213-2252` (`renderLatestSavedAudio`) — **то же, что
  R-002, найдено независимо**: guard устаревшего рендера стоит только на успешной
  ветке; `catch` и fallback-путь его не повторяют, из-за чего устаревший рендер
  перезаписывает `currentRecordingAudioObjectUrl` (утечка ObjectURL свежего
  рендера) и `audioEl.src` (в плеере оказывается аудио прошлой записи), а на
  ветке 2232-2247 ещё и показывает баннер «Audio … could not be loaded» для
  записи, которая уже не текущая. Правильный образец в том же файле —
  `openRecording:7581/7590/7592`, где seq-проверка стоит и в `try`, и после
  `await`, и в `catch`. **подтверждено.**
* **C-006** · `index.html:23` — **CSP `connect-src 'self' ws: wss:
  https://api.github.com` не ограничивает WebSocket ничем.** `ws:`/`wss:` —
  scheme-source, по CSP3 §6.6.2.6 они матчат **любой хост**; комментарий строкой
  выше (17-18) утверждает противоположное («connect-src stays same-origin so the
  renderer can only reach the local backend»). Слой defence-in-depth, ради
  которого CSP и добавлен (комментарий 7-12), для эксфильтрации через WebSocket
  не работает — а при обязательном `script-src 'unsafe-inline'` это
  единственный канал, который CSP тут вообще мог закрыть. **P1, не P0:** Electron
  дополнительно держит `contextIsolation` + `sandbox` + запрет навигации,
  эксплуатируемого пути прямо сейчас нет, но заявленная гарантия не выполняется.
  **подтверждено.** Как надо — `'self'` в CSP3 уже матчит `ws`/`wss` на том же
  origin: `connect-src 'self' https://api.github.com`.
* **C-007** · `index.html:35-102` против `styles.css:3426-3546` — **inline-фолбэк
  boot-оверлея написан через id-селекторы и потому побеждает дизайн-систему
  всегда.** Специфичность 1-0-0/1-1-0 против 0-1-0. Сопоставление: фон
  `#1a1a1a` вместо `rgba(12,12,12,0.88)`; z-index 99999 вместо 9999; padding
  `24px 32px` вместо `40px 56px`; max-width 460 вместо 420; спиннер 24×24
  border-ring вместо 40×40 conic-gradient + mask (последний не перекрыт и лежит
  внутри первого). Спроектированный вид оверлея не рендерится **никогда**, а
  `styles.css:3448-3546` — мёртвый код; `@keyframes boot-spin` объявлен дважды.
  Комментарий 25-34 явно ограничивает фолбэк окном загрузки — постоянное
  перекрытие этому противоречит. **подтверждено.** Как надо — фолбэк на классах
  (та же специфичность, объявлен раньше), без спиннера и без второго
  `@keyframes`.
* **C-008** · `styles.css:4117` против `:947-953` — **`.btn-primary` определён
  дважды, и однострочник с `!important` гасит дизайн-системное правило**, обращаясь
  к токену `--accent`, которого в файле нет (объявлены только `--accent-soft-*`,
  `--accent-strong-*`, 76-79) — рендерится литерал `#5b8cff`. Это единственный
  не-a11y `!important` в файле. Все четыре первичные кнопки
  (`#bootOverlayRetry`, `#upscalePresetSaveBtn`, `#upscalePromptSaveBtn`,
  `#modelDownloadConfirmBtn`) рисуются ярко-синими вне палитры.
  **подтверждено.** Как надо — удалить строку 4117; правило 947 уже полное и на
  токенах.

## P2 (регион C)

* **C-009** · `main.tsx:436`, `507-508` — `isFinal`/`speechFinal` парсятся из
  `is_final`/`speech_final` и **не читаются нигде** (3 упоминания на весь файл:
  объявление типа + два присваивания); `case "segments"` их игнорирует. При этом
  `backend/live.py:513` их вообще не шлёт, так что для локального assist они
  молча `false` — расхождение контракта, безвредное только из-за отсутствия
  читателей. **подтверждено.**
* **C-010** · `main.tsx:1461-1467` — `catch` в `refreshLocalModels` проглатывает
  причину полностью, без `console.warn`, а UI показывает «Model list unavailable
  — backend offline» (1307), утверждая причину, которую не проверял (`apiGet`
  бросает и `"API token is missing. Restart app."`). Иронично при наличии
  `installErrorAwareConsole`. **подтверждено.**
* **C-011** · `main.tsx:1533` против `1546`/`1575` — три действия одной строки
  таблицы моделей рендерят ошибки двумя способами: Delete через
  `sanitizeUiErrorMessage`, Download и Engine install — сырым `e.message`.
  Офлайн: Delete скажет «The computer appears to be offline…», Download —
  «Failed to fetch». **подтверждено.**
* **C-012** · `main.tsx:1621-1630` + `index.html:831/835` — модалка
  переиспользуется для установки движка, но меняется только тело: заголовок
  остаётся «Model not downloaded», кнопка — «Download», над текстом «Install the
  Russian GigaAM engine? …». **подтверждено.**
* **C-013** · `main.tsx:1026`, `1031` → `5275`, `13181`, `13195` — карантинные
  ключи `transcriptor.*.corrupt.<ts>` пишутся и **не читаются и не удаляются
  нигде**; каждый хранит полный JSON черновика/очереди. **подтверждено.**
* **C-014** · `main.tsx:1750-1751` — `renderTranscriptionSelectors()` вызван
  дважды подряд; с учётом C-001 это **две** полные пересборки на каждый
  health-поллинг. **подтверждено.**
* **C-015** · `main.tsx:1879-1897` — рукописный фолбэк `cssEscape` мёртв (в
  Electron `CSS.escape` есть всегда) **и** неправилен: регулярка `^-?\d` матчит
  два символа при ведущем дефисе, а callback экранирует только первый — цифра
  теряется (`"-5abc"` → `"\2d abc"` вместо `"-\\35 abc"`); ветка
  `offset === 1 && charAt(0) === "-"` недостижима; `\w` без флага `u`
  разваливает суррогатную пару. Отдельно: результат подставляется внутрь строки
  в кавычках селектора, а `CSS.escape` экранирует идентификатор — работает по
  совпадению правил. **подтверждено.**
* **C-016** · `main.tsx:2929`, `2940-2950` — (а) параметр `_reason` не
  используется, хотя вызывающие вычисляют пять разных меток и `reason`
  протаскивается через `flushDeferredRecordingsRefresh` в никуда
  (**подтверждено**); (б) `requestDeferredRecordingsRefresh` блокируется
  четырьмя условиями, а перевзвод после снятия блокировки существует только для
  двух — четверо ворот, два ключа (**гипотеза**).
* **C-017** · `main.tsx:3040-3058` — `statusKindToDotClass`: 19-строчный `switch`,
  тождественный `String(kind)`; класс `idle`, который он умеет вернуть, в
  `styles.css` не описан. **подтверждено.**
* **C-018** · `main.tsx:90-93` — комментарий «Installed before any other
  module-level code can throw or log» неверен: в ES-модулях тело импортирующего
  модуля выполняется **после** всех 20 импортов. Вреда нет только потому, что
  импортируемые модули чистые. **подтверждено.**
* **C-019** · `main.tsx:2735-2745` — `lastSpeaker` обновляется только в ветке со
  спикером, поэтому недиаризованный сегмент после нумерованного приклеивается к
  чужому абзацу. **гипотеза** (нужен смешанный поток, который бэкенд как раз и
  производит: `remote_deepgram_live.py:3285-3286` кладёт `speaker` в interim
  только `if speaker is not None`).
* **C-020** · `main.tsx:2738` — `Speaker ${seg.speaker}` печатает нуль-базовый
  индекс Deepgram: пользователь видит «Speaker 0:». **подтверждено.**
* **C-021** · `main.tsx:3317-3350` — `apiGet` принимает `signal`, остальные три
  — нет, и ни у одного нет таймаута, хотя `createLinkedAbortSignal` (2463) уже
  написан. Зависший `POST /api/config` висит бессрочно с заблокированной
  кнопкой. **подтверждено.**
* **C-022** · `live-pane.ts:26` + `live-pane.test.ts:17/19/21` — docstring и тест
  используют формат `"0:42"`, тогда как единственные часы приложения `fmtTime`
  (`main.tsx:757-760`) через `padStart(2,"0")` дают `"00:42"`, и именно этот
  результат подаётся в `livePaneDisplayText` (`main.tsx:9688-9692`). **Тест
  зелёный на формате, который продакшн не производит.** **подтверждено.**
* **C-023** · `tsconfig.json:14` + `vitest.config.ts:8-10` — **то же, что F-010,
  найдено независимо**: `tests` не входит в проект, `typecheck`/`build` их
  никогда не типизируют, `vitest typecheck` в скриптах не вызывается.
  **подтверждено.**
* **C-024** · `index.html:458-461` — строка «Exports TXT / JSON» мертва:
  `#downloadRow` упоминается ровно один раз (`main.tsx:9911`,
  `hidden = true`) и нигде не показывается; у `#dlTxt`/`#dlJson` нет ни
  обработчиков, ни стилей — это `<a href="#">`, клик просто скроллит.
  **подтверждено.**
* **C-025** · `styles.css` — **38 дизайн-токенов объявлены и ни разу не
  прочитаны.** Показательные: `--focus-ring` (107) переопределён в двух
  a11y-блоках на `Highlight`, но не читается нигде (работает только
  `--focus-ring-soft`), хотя комментарий 100-105 обещает, что forced-colors
  маппит **оба**; из семи `--record-stop-*` (148-154) используется один, а
  `.record-toggle-btn.is-recording` (539-541) берёт вместо них
  `var(--danger-border)`/`var(--danger-text)`; `--vu-low/-mid/-high` (168-170)
  при полном отсутствии VU-метра в разметке; `--space-1` и `--space-5` мертвы,
  `--space-2/3/4` живы — шкала с дырами по краям. **подтверждено**
  (автоматический разбор: объявления минус все `var(--x`, плюс сверка с
  `index.html`/`main.tsx`).

## Индекс костылей (регион C)

| # | Место | Что это |
|---|---|---|
| W-1 | `main.tsx:1750-1751` | двойной `renderTranscriptionSelectors()` подряд (C-014) |
| W-2 | `main.tsx:3259-3263` | комментарий «Must stay in lockstep with `sanitizeUiErrorMessage` above» — признание дублирования; списки **уже разошлись** (S-20) |
| W-3 | `main.tsx:417-421` | устаревшее NOTE «`backend/deepgram_dual.py` had not landed when this was written» — бэкенд уже пишет `stats["dual_stream"]` (`deepgram_dual.py:720`), предупреждение вводит в заблуждение |
| W-4 | `main.tsx:1879-1897` | рукописный фолбэк `CSS.escape` — недостижим и некорректен (C-015) |
| W-5 | `main.tsx:2314-2319` | локальная `fmt` в IIFE плеера — третий форматтер времени (S-22) |
| W-6 | `main.tsx:1613-1631` | click-listener на `#localModelsTable` замыкается на `modal`/`textEl`/`confirmBtn`, объявленные `const` **ниже** (1633-1636); работает только потому, что колбэк исполняется после TDZ |
| W-7 | `main.tsx:4715` | `fetch("/api/health")` мимо `apiGet`/`authHeaders()` — единственный запрос без общей обёртки; плюс `health.clone().json()` при однократном чтении |
| W-8 | `index.html:458-461` + `main.tsx:9911` | мёртвая строка Exports, зашитая в `hidden = true` (C-024) |
| W-9 | `index.html` | 12 id без единого потребителя (ни JS, ни CSS): `appVersionBadge`, `livePane`, `resultPane`, `upscalePane`, `splitGap`, `micDot`, `updateCheckRow`, `modelsNote`, `deepgramKeytermsNote`, `deepgramDualStreamNote`, `dlTxt`, `dlJson` |
| W-10 | `main.tsx:1026/1031 → 5275/13181/13195` | карантинные ключи: только запись (C-013) |
| W-11 | `main.tsx:2929` | `_reason` — пять вычисляемых меток, ни одного читателя (C-016а) |
| W-12 | `main.tsx:436/507-508` | `isFinal`/`speechFinal` — распарсено, не читается (C-009) |
| W-13 | `main.tsx:3040-3058` | `statusKindToDotClass` — тождественное отображение на 19 строк (C-017) |
| W-14 | `styles.css:4117` | единственный не-a11y `!important`, гасящий собственное правило 947 (C-008) |
| W-15 | `styles.css:4058-4068` | `.model-row-empty` объявлен дважды подряд, оба раза одинаково |
| W-16 | `styles.css:4106` | литерал `rgba(0,0,0,0.55)` при токене `--overlay-backdrop` **того же значения** (`:54`) |
| W-17 | `vite.config.ts:24-28` и `34-44` | `desktop/package.json` читается и парсится дважды в одном конфиге |
| W-18 | `vite.config.ts:89` | `cssMinify: false` без объяснения (комментарий выше объясняет только `cssTarget`) — в дистрибутив уезжает 4197 строк CSS |

## Индекс хардкод → SSOT (регион C) — основной результат региона

### C-D1. Списки и подписи, размноженные по слоям

| # | Что | Копии |
|---|---|---|
| **S-01** | Названия групп транскрипции | **×3**: `index.html:381-384` (зашитые `<option>`), `transcription-catalog.ts:80/89/98/106` (`label`), `main.tsx:2414-2422` (`providerLabel`). Разметка перерисовывается из каталога, то есть зашитые опции — только «анти-мигание», но они же формируют `current` в guard’е C-001. **Надо:** оставить `<select id="providerSelect"></select>` пустым, как уже сделано для `#uploadProviderMirror` (`index.html:175`) и `#remoteModelSelect` (`391`) |
| **S-02** | Список языков `auto/ru/en` | **×2**: `index.html:287-290` (`#language`) и `183-186` (`#uploadLanguage`). `main.tsx:8268-8272` прямо утверждает: «The language list is written out once, in index.html, on `#language`. Copying it into a second markup block … would be a second source that drifts» — второй блок уже существует. **Надо:** заполнять `#uploadLanguage` из `#language` тем же способом, что `fillDualSecondaryLanguageOptions` |
| **S-03** | Границы и дефолты auto-stop-on-silence | **×3-4** — независимое подтверждение F-003: `index.html:713/715`, `main.tsx:3122-3123`, `desktop/main.js:305` (и, как показано в F-003, ещё раз в `main.tsx:6366/6373`). Бэкенд `preferences.ui` вообще не валидирует (`config.py:485-516` не содержит ветки `ui`), то есть арбитра нет. **Надо:** один манифест по образцу `desktop/shortcut-defaults.json`, который уже инжектится через `vite.config.ts:46-49` |
| **S-04** | MIME ↔ расширение аудио | **×2, неполная инверсия**: `main.tsx:1976-1989` (`MIME_TO_AUDIO_EXT`, 12 записей) против `backend/audio_mime.py:16-35` (`AUDIO_EXT_TO_MIME`, 19). Фронт не знает `.wma`, всех видео-типов и `.oga`, и содержит `audio/x-wav`/`audio/wave`/`audio/x-m4a`/`audio/x-flac`, которых бэкенд не отдаёт. У бэкенда для своей пары **уже есть** startup-guard против дрейфа (`main.py:3074-3078`), фронтовая копия ничем не связана. **Надо:** отдавать карту в бутстрапе рядом с `accepted_audio_exts` |
| **S-05** | Дефолты dual-stream | **×2**: `deepgram-dual.ts:24-25` против `backend/config.py:512-513`. Дублирование осознанное и задокументированное, но синхронность ничем не проверяется. *(= R-016.)* |
| **S-06** | Эпсилон «два сегмента — одно время» | **×2 с разными значениями**: `UI_TOKENS.finalize.segmentEpsilonSec = 0.08` (`main.tsx:1016`, используется в `mergeTranscriptSegments:2637`) против `backend/live.py:29 emit_epsilon_sec = 0.05`. Обе применяются к одному потоку сегментов; связь нигде не документирована. **гипотеза** |
| **S-07** | `LIVE_SAMPLE_RATE_HZ` | `main.tsx:891` как fallback для dev-shell, корректно перезаписывается в `applyBackendRuntimeConfig`. Известный литерал, не дефект |

### C-D2. Типы, объявленные дважды

| # | Что |
|---|---|
| **S-10** | `RemoteProvider` (`main.tsx:88`) и `KeyProvider` (`:89`) — **побайтово одинаковые** объединения `"openrouter" \| "deepgram"`, оба используются как ключ `Record<>` |
| **S-11** | `Provider` (`main.tsx:87`) и `WireProvider` (`transcription-catalog.ts:28`) — одинаковый набор членов, связаны кастом `as Provider` (`main.tsx:1247`); `WireProvider` экспортируется и **не импортируется никем** — каст стоит вместо импорта |
| **S-12** | `LiveFinalEnvelope` (`main.tsx:382-402`) и `final`-ветка `LiveWsMessage` (`:438-450`) — те же 10 полей объявлены дважды. **Надо:** `type LiveFinalEnvelope = Omit<Extract<LiveWsMessage, { type: "final" }>, "type">` |

### C-D3. CSS: токены и дублирующие литералы

| # | Что |
|---|---|
| **S-13** | **5 токенов, нигде не объявленных** — рендерится литеральный fallback: `--accent` → `#5b8cff` (C-008); `--ok` → `#4ade80`; `--err` → `#f87171`; `--surface` → `#16181d`; `--text-dim` → **два разных литерала** `#9aa` и `#aab` |
| **S-14** | **9 объявленных токенов со взаимно противоречащими fallback-литералами**: `--surface-3` → 5 вариантов; `--surface-2` → 4; `--text-2` → 4 (`#a0a0a0` ×11, `#777777` ×5, `#c4c4c4` ×1, `#6b7280` ×1) при реальном `#c4c4c4`; `--danger-text` → 3 при реальном `#ff8080`; `--surface-1`, `--text-1` → 3; `--text-3`, `--danger-border`, `--danger-bg` → 2 |
| **S-15** | Статус «идёт запись» — два цветовых набора: `--record-stop-*` (7 токенов) фактически мёртв, а `.record-toggle-btn.is-recording` берёт `--danger-*` |
| **S-16** | `.btn-primary` ×2 (C-008) |
| **S-17** | `.model-row-empty` ×2 подряд |
| **S-18** | Затемнение модалки — литерал при существующем токене того же значения |
| **S-19** | Boot-overlay стилизован дважды, `@keyframes boot-spin` объявлен дважды (C-007); inline-блок вдобавок повторяет литералами значения токенов `--text`, `--text-2`, `--danger-text`, `--line-2` |

### C-D4. Логика и копия, написанные дважды

| # | Что |
|---|---|
| **S-20** | Определение «это обычный сетевой сбой» ×2, и списки **уже разошлись**: `sanitizeUiErrorMessage` (`:2532-2547`) ловит `=== "networkerror when attempting to fetch resource."` и `includes("typeerror: failed to fetch")`; `explainNetworkError` (`:3255-3269`) — `includes("networkerror")` и `includes("typeerror: fetch")` плюс `=== "typeerror: load failed"`, которого нет в первом. Комментарий `:3263` требует «lockstep». **Надо:** один предикат `isGenericFetchFailure(raw)` |
| **S-21** | Обрезание строки статуса ×2 механизма: `STATUS_PILL_MAX_CHARS = 42` (`:3064`) и CSS `max-width: min(360px, 42vw)` + `text-overflow: ellipsis` (`styles.css:575/610`). Числа не связаны: 42 символа при `font-size: 10px` ≈ 250 px, поэтому на широком окне CSS-эллипсис не срабатывает никогда, а на узком обрезается уже обрезанная строка — два многоточия подряд |
| **S-22** | Форматирование времени ×3: `fmtTime` (`:757-760`) и `fmtDur` (`:766-769`) — **побайтово идентичны**; локальная `fmt` в IIFE плеера (`:2314-2319`) с другим форматом. Плюс литерал `"0:00"` в `index.html:433`, `435`, `main.tsx:2183-2184` |
| **S-23** | Таймауты и интервалы **вне** `UI_TOKENS`: `RECORDING_VIEWER_AUDIO_READY_TIMEOUT_MS` (`:301`), `UPLOAD_QUEUE_SAVE_DEBOUNCE_MS` (`:1032`), пять констант `:2447-2457`, голые литералы `30_000` (`:2392`), `6000` (`:2244`), `7000` (`:2765`, `:2887`), `4000` (`:12419`). Периоды поллов: `2000` литералом в `localModelsPoll` (`:1496`) и `_shortcutConflictPoll` (`:5621`), но `UI_TOKENS.network.refreshIntervalMs` в `_networkPoll` — три поллинга, два способа задать период |
| **S-24** | Версионирование ключей localStorage: три ключа несут `.v1`, `UPDATE_CHECK_CACHE_KEY` (`:13089`) — без версии |
| **S-25** | Дефолт длительности session-notice `7000` написан дважды (сигнатура `:2765` и литерал на вызове `:2887`); рядом `6000` (`:2244`) и `9000` (`:12429`) без обоснования разницы |
