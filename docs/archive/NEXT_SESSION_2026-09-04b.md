# Хендофф 2026-09-04 (вечер): единый владелец текста, Ultra-Audit, что дальше

Точка входа для следующей сессии. Предыдущий хендофф (`docs/archive/NEXT_SESSION_2026-09-04.md`) выполнен полностью: три хотфикса, три worktree-ветки слиты, релиз 1.6.0 собран и установлен. Этот документ описывает всё, что случилось после, и где остановились агенты.

## 1. Где мы

- **Установлено:** Transcriptor **1.6.0** (сборка из `373ce84`). Всё, что ниже, в `/Applications` ещё НЕ попало — нужен релиз 1.6.1.
- **`main`:** `3b8f5a8`, рабочее дерево чистое, всё запушено. С релиза 1.6.0 — 25 коммитов (список в §3), каждый закоммичен своим агентом после зелёных сьютов его домена. Полный прогон всех трёх сьютов на HEAD — см. `BUGSAUDIT-2026-09-04.md` §1.
- **Ветка `wip/ultra-audit-2026-09-04`** (запушена): снимок незакоммиченных правок трёх остановленных фикс-агентов (18 файлов, ~+1050/−300). НЕ проверено, НЕ сливать как есть — разбирать по журналам (§4).
- **Улики и транскрипты:** `~/Library/Application Support/transcriptor/evidence-2026-09-03/session-2026-09-04-ultra-audit/` — полные JSONL-транскрипты всех 124 агентов сессии (включая рассуждения) и разделы аудита; `…/session-2026-09-04-dual-stream/` — эксперимент с двумя потоками (REPORT.md, merge.py).

## 2. Архитектурные решения этой сессии (почему так)

1. **Один владелец текста — бэкенд-конверт** (`889c91a`, `bf84d6b`). До этого текст на стопе собирали три источника (live-буфер рендерера, конверт, REST-восстановление) с тремя разными склейками → дубли целых фраз и обрывы. Теперь: рендерер показывает превью и вставляет конверт дословно; конверт полон по построению — финалы + пословная сшивка interim + объединение двух потоков + REST-дорасшифровка непокрытых участков из собственного спула (дыры, хвост с речью, всё после смерти сокета, «нет финалов вовсе»). Единственный запасной путь рендерера — полная расшифровка файла, если конверт не пришёл совсем.
2. **Двухпоточный Auto** (`f187139`): `multi` + `ru`, объединение по таймстампам слов. Измерено: закрывает обе дыры смены языка на трёхъязычной записи (128 слов против 105/119), детерминировано, латентность та же, цена ×2 минут Deepgram. Переключатель в Settings → Deepgram (`preferences.deepgram.dual_stream`, `dual_secondary_language`).
3. **Tail guard только по свидетельствам речи** (`e8f1632`, `3b8f5a8`): ожидание хвоста — только если interim слышал ≥0.25 с речи в непокрытом участке или окно interim выходит за последний финал; пустой `is_final` — штатный ответ Deepgram на `Finalize` — больше не выбрасывается (это была корневая причина трёх «подобранных» констант ожидания).
4. **Скорость** не страдает: стриминг = чанковая транскрипция во время записи; на стопе дорасшифровывается только последняя фраза (0.3–0.8 с); REST только для непокрытых участков (+1–3 с, редко); второй поток конверт не задерживает.

## 3. Коммиты после 1.6.0 (`373ce84..3b8f5a8`)

Стоп-цепочка и владелец текста: `022fd27` (события фасада после замены сокета), `0de0c2d` (полный конверт заменяет превью), `e8f1632` (tail guard по свидетельствам; частичный secondary), `889c91a` (рендерер не собирает текст), `bf84d6b` (восстановление внутри конверта), `3b8f5a8` (пустой финал — ответ на Finalize).
Ultra-Audit, рендерер: `74ff589` (P0: очередь загрузок не затирается), `0c916b9` (тесты типизируются, mic-health покрыт), `3ee4cb9` (тёплый микрофон/pre-roll реально включаются), `585b45f` (неудачная загрузка настроек не перезаписывает конфиг), `9afe53e` (кнопки/пикеры делают то, что обещают), `06f3330` (CSP на origin бэкенда), `58bafe8` (History без перефильтрации на скролле), `27fba8d` (SSOT авто-стопа, диаризация), `0bf8ed7` (капсула не гадает состояние по словам), `f09c904` (именованные числа стопа, границы, правило заголовка), `b0eecd1` (одна проверка «сеть?», 8 мёртвых кусков).
Ultra-Audit, desktop: `a152ec7` (P0: powerMonitor подписан при старте), `317b4ca` (P0: Windows-вставка UTF-16 → не двоится), `1d9fda2` (P0: подпись Developer ID/нотаризация), `22c6e3d` (верификация вставки реально верифицирует, буфер возвращается), `86d63d3` (запрос Accessibility, авто-отправка, бюджет вставки), `966bcf7` (мониторы, бюджет рестарта, ошибка установки движка), `19b0235` (engine-site prune).
Ultra-Audit, бэкенд: `d590a4e` (P0: финал без слов — чтение; слияние O(P+S)), `3b8f5a8` (B-005).

## 4. Кто на чём остановился (фикс-волны Ultra-Audit)

Журналы правок (коммит → ID → файлы → проверка → решения → не сделано): `docs/archive/audit-2026-09-04/*-fix-journal.md`. Находки: `docs/archive/audit-2026-09-04/*-findings.md` (бэкенд 90: 2 P0/23 P1/65 P2; рендерер 96: 1/23/67; desktop 84: 3/26/55).

- **Рендерер** (агент остановлен на «W-9 — the ids in the markup that nothing reads»): P0 и большая часть P1 закоммичены; шёл по индексу workaround'ов (W-1…W-49) и хардкоду (68 строк). Незакоммиченное — в `wip/…` (frontend-файлов там нет? проверить `git diff main..wip/ultra-audit-2026-09-04 --stat -- frontend`).
- **Desktop** (остановлен на «a packaging test covering the new plumbing invariants»): P0 все, P1 большинство; в `wip/…` — `desktop/main.js`, `package.json`, `packaging.test.js`, `scripts/{prepare-runtime.sh,notarize-dmg.sh,generate-dmg-background.py}`, `shortcut-defaults.test.js`, плюс репо-уровень: `.github/workflows/tests.yml`, `.gitignore`, `.python-version` (новый), `AGENTS.md`, `README*.md` — это SSOT-работа «Python 3.12 в 9 местах», «три набора пинов», CI. Довести: тест packaging → прогнать `npm --prefix desktop test` → коммит.
- **Бэкенд** (остановлен на «Both repros now behave correctly. Committing this group» — группа B-005/B-007 успела попасть в `3b8f5a8`): в `wip/…` — `deepgram_dual.py`, `deepgram_recovery.py`, `remote_deepgram_live.py`, три теста finalize/seam. Довести: прогнать сьют, коммит, дальше по индексу SSOT (20) и workaround (39).

## 5. Порядок следующей сессии

1. `git checkout main && git pull`; убедиться, что сьюты зелёные (см. §1 отчёта).
2. Три Sonnet/Opus-агента по доменам: `git diff main..wip/ultra-audit-2026-09-04 -- <домен>` → перечитать журнал домена → довести незавершённую группу → сьюты → коммит в `main`. Дальше по журналу «не сделано» и индексам.
3. Контракт `stats.recovery`: рендерер читает `spans_sec` и `ms` (`889c91a`), бэкенд отдаёт `spans/ms/words` (`bf84d6b`) — добавить `spans_sec` на бэкенде, закрепить тестом формы.
4. Собрать `BUGSAUDIT-2026-09-04.md` §4–§7 из журналов (решения, правки, не сделано, подготовлено-не-выполнено).
5. Релиз 1.6.1: CHANGELOG в стиле файла за все коммиты §3, версия в `desktop/package.json` и `frontend/package.json`, PROJECT_STRUCTURE (новые модули: `backend/deepgram_recovery.py`, `frontend/src/envelope-deadline.ts` изменён, `desktop/paste-script.js`…), реестр долга; `./BUILD.command`; `osascript -e 'tell application "Transcriptor" to quit'`; `open -a /Applications/Transcriptor.app`; проверить boot-лог.
6. Проверка на живых записях: в `[trace stopLive] FINAL` — `source=envelope`, `dual=1`, `recovery=…`; `warm=1 preRollMs=500` на второй записи подряд; вставка ≤0.5 с; `verified=1` и восстановление буфера.

## 6. Долг (не делаем без решения пользователя / нельзя здесь)
См. `BUGS_AUDIT_2026-09-03.md` «Реестр долга» + «Не сделано» в журналах: TransientType и явные key-up требуют нативного кода; Windows/Linux пути не проверены на железе; нотаризация не запускалась (нет notarytool здесь); `Alt+Left` на macOS.

## 7. Статус на 2026-09-05 (обновление)

Все три фикс-волны Ultra-Audit завершены и в `main` (бэкенд 15 коммитов → 803 теста; рендерер 10 → 327; desktop 13 → 255). Отчёты агентов дословно и соответствие id → задача: `docs/archive/audit-2026-09-04/AGENT_REPORTS.md`; полные транскрипты — userData `evidence-2026-09-03/session-2026-09-04-ultra-audit/agent-transcripts/`.

Идёт агент «швы между доменами» (первый коммит `52dab76`: одна схема конверта `final`, один конструктор, фикстура, ломающая сборку при расхождении сторон); остальное из его задания — дефолты dual-stream и факты бэкенда из bootstrap, половинки D-009/013/015/053, один эпилог `stopLive`, изоляция тестов от `HOME` — результат в `backend-fix-journal.md`, раздел «Швы (2026-09-05)».

Дальше строго по §5 (пункты 4–6): сборщик отчёта `BUGSAUDIT-2026-09-04.md` §4–§7 из журналов; релиз 1.6.1 — CHANGELOG за все коммиты после `373ce84`, версия в обоих `package.json`, PROJECT_STRUCTURE (новые модули: `backend/async_tasks.py`, `backend/deepgram_language.py`, `backend/deepgram_recovery.py`, `backend/deepgram_envelope.py` если создан, `frontend/src/ui-copy.ts`, `frontend/src/button-feedback.ts`, `desktop/python-version.js`), реестр долга из трёх журналов; `./BUILD.command` (диск теперь свободен, 30 ГБ); перезапуск; проверка boot-лога и первых записей.

## 8. Релиз 1.6.1 (2026-09-05)

Выполнено (§5 пункты 4–6):

- **BUGSAUDIT-2026-09-04.md** собран из журналов: §1 обновлён (HEAD `b2ea2c5`, сьюты бэкенд 819 / рендерер 363 / desktop 256 — перепрогнаны на релизной ревизии), §4 «Журнал решений» и §5 «Журнал правок» консолидированы по доменам с таблицами коммит → ID → файлы → проверка (бэкенд 15 коммитов, 631 → 819; рендерер 18, 196 → 363; desktop 20, 208 → 256; швы 5 коммитов), §6 «Не сделано» поимённо с причиной, §7 «Подготовлено, но не выполнено» (релиз выполнен; нотаризация и Windows/Linux на железе — остаются).
- **BUGS_AUDIT_2026-09-03.md**: «Реестр долга» консолидирован из долгов этого файла и трёх журналов — один нумерованный список (35 позиций: что · почему · где · статус); позиция «Статус на 2026-09-04 вечер» заменена на «Состояние на 2026-09-05 (релиз 1.6.1)».
- **CHANGELOG.md**: `## [1.6.1] - 2026-09-05` — все коммиты после `373ce84` в голосе файла (дефект → механизм → измерение → что изменилось), сгруппированы: единый владелец транскрипта, Ultra-Audit P0, ресурсы/жизненный цикл, движки/языки, конфигурация, ошибки, SSOT, тесты/CI/упаковка, документация; `[Unreleased]` пуст.
- **Версии**: `desktop/package.json` и `frontend/package.json` → `1.6.1` (drift-тест `desktop/packaging.test.js` держит их вместе).
- **PROJECT_STRUCTURE.md**: новые модули с `373ce84` — `backend/{async_tasks,deepgram_language,deepgram_recovery,live_envelope}.py`, `frontend/src/{live-envelope,upload-queue-restore,settings-autosave,recording-title,button-feedback,ui-copy}.ts`, `desktop/{paste-protocol,power-events,recording-status,child-io,python-version,shortcut-migration,linux-wm-class}.js`, `desktop/entitlements.mac.selfsigned*.plist`, `contracts/`, `.python-version`, `BUGSAUDIT-2026-09-04.md`.
- **Сьюты на релизной ревизии `main`** (все зелёные): бэкенд 819 OK; рендерер typecheck/lint чисто, 363 passed, build ok; desktop 256 pass / 0 fail; `node --check` обеих точек входа — чисто.

Живые проверки после установки (выполнить после сборки и перезапуска):

1. `osascript -e 'tell application "Transcriptor" to quit'` (≤15 с, без kill -9), затем `open -a /Applications/Transcriptor.app`, подождать 20 с.
2. `~/Library/Application Support/transcriptor/main.log` — чистый старт: бэкенд поднялся, нет Traceback, хоткеи зарегистрированы, paste-capability `state=active`, тёплый сокет подключён, строка подписки `powerMonitor`.
3. `GET /api/config` (`x-api-token` из `api_token.txt`) — в ответе keyterms и `dual_stream: true`.
4. Артефакты: `CFBundleShortVersionString` = 1.6.1; `codesign --verify --deep --strict` проходит; `app.asar` содержит desktop-модули из `build.files` (`power-events.js`, `paste-protocol.js`, `child-io.js`, `recording-status.js`, `shortcut-migration.js`, `python-version.js`, `linux-wm-class.js`); `Resources/runtime` содержит `deepgram_recovery.py`, `deepgram_language.py`, `async_tasks.py`; `requirements.runtime-lock.txt` в extraResources (desktop-фикс заставил его попадать в бандл).
5. Первые живые записи: в `[trace stopLive] FINAL` — `source=envelope`, на dual-записи `recovery=…`; на второй записи подряд `warm=1 preRollMs=500`; вставка ≤0.5 с, `verified=1`, буфер восстановлен.
