# Хендофф сессии 2026-11-20 — режим экрана (1.6.6) и Ultra-Audit 2026-11-20

Сессия Claude Code (desktop, Code tab), Voice Transcriptor. Документ — для следующей сессии: что сделано, что открыто, что сломано, с чего начать. Всё перечисленное проверено на момент записи (main = `712943a`, запушен, `origin/main` совпадает).

---

## 0. С чего начать следующей сессии (по порядку)

1. **Влить ветку стоп-полосы ревью** `worktree-agent-a2f9e91fa1a6d3247` (на origin). Там: #1 и #2 ревью готовы и проверены (коммиты `9c2ba71`, `67469a4`), #3 — WIP `d874dce`, НЕ прогнан. Дальше доделать #3–#7 (§3.1). Ворктри: `.claude/worktrees/agent-a2f9e91fa1a6d3247`.
2. **Починить бэкенд-набор**: сейчас на main падает `backend/tests/test_live_coverage_policy.py` (setUpClass копирует `frontend/src/live-coverage.ts` во временную папку, а он теперь импортирует `./live-envelope`) — это проблема #5 ревью (дублированная матрица покрытия): сделать ОДИН источник матрицы (фикстура в `contracts/`, читаемая обоими наборами) или удалить Python-копию, если она не проверяет ничего бэкендового. Остальные 3 набора на main зелёные (§2.4).
3. **Междоменная полоса** (§3.2): половины фиксов, которые полосы не имели права трогать. Начать с P1: FQ-04, BM-01, швы режима экрана D1–D3, `screens_error`, `screen_session_id` в WS-запросе.
4. **Сборка → установка → живая проверка** (`./BUILD.command`; чек-лист §5). Пользователь прямо просил: «ВСЕ ДОДЕЛАЙ ПОДКЛЮЧИ В МЕЙН И ПЕРЕУСТАНОВИ И ПРОВЕРЬ». После аудита приложение НЕ пересобиралось — установлена сборка до аудита (`acbf737`).
5. **Отчёт** `BUGSAUDIT-2026-11-20.md`: заполнить §5 «Журнал правок», §6 «Не сделано», финальный раздел «Требует решения пользователя» (§4 ниже).
6. Обновить `CHANGELOG.md` (запись о фиксах аудита; версия — решить, 1.6.7), push.

Правила проекта: `AGENTS.md` (корень). Команды проверки — там же. Бэкенд гонять в venv: `python3 -m venv /tmp/vt-tests && /tmp/vt-tests/bin/pip -q install websockets requests numpy soundfile fastapi huggingface_hub cryptography python-multipart httpx`, затем `/tmp/vt-tests/bin/python -m unittest discover -s backend/tests`.

---

## 1. Все реплики пользователя — дословно, по порядку

1. (первая, вставкой)
> Значит, смотри, сейчас нужно сделать такую хуйню. Мы Добавляем новый режим записи на другую кнопку, на другое сочетание клавиш. Это режим screen mode, так его давай назовем screen mode. Так вот, что делает screen mode? Когда мы появляется, ну, он доступен будет наверное, только для MacBook, но может быть и для всех. Вот, что он делает? Когда я нажимаю другое сочетание клавиш, то включается режим screen mode в капсуле справа от циферок времени она расширяется, и справа от циферок времени появляется еще значок, белый значок компьютера. И появляется рамка, красная рамка. Вокруг всего экрана. Также появляется плавающее окошко рядом с капсулой. Справа от капсулы и еще 1 капсула или над капсулой. Да, над капсулой, пускай появляется 2-ое плавающее окошко. С выбором цветов. По умолчанию там 1 цвет и, ну, 1 цвет, и им можно рисовать на экране. Прям экран становится доступный для рисования. А Когда мы нажимаем на кнопку компьютера, то у нас сохраняется этот снимок экрана с нарисованной хуйней но рамка остается, и запись продолжает идти. Дальше мы снова, ну, мы можем кликать, переключаться, между разными разделами. По сайтам ходить и так далее. Когда мы нажимаем на кнопку на компьютер, значок компьютера, сохраняется скриншот скриншоты с экрана, все исчезает, становится чисто. Но скриншот со всеми рисунками остается, и таймфреймы значит, в моей обратной связи, то, что я говорю, встроены какие-то, значит, пометки. Которые говорят, когда я на экране, что нарисовал когда была проведена линия в таком-то месте. когда была проведена другая линия в таком-то месте и так далее. Вот. Значит, и также скриншот можно в этом режиме сделать. Нажав на Not значок Ну то есть мы либо на компьютер нажимаем, либо нужно еще нажать на допустим, над есть такая кнопочка, где нарисована. Давай попробуем эту кнопку. Тоже это все в этих в кнопках этих, как его. Горячих клавиш должно быть указано 1 кнопка или сочетание клавиш для того, чтобы делать скриншот во время этого. И все, соответственно, я могу простой клик дает, ну, простой клик никак не учитывается. а вот если я сделал клик, зажал и протащил, тогда рисуется. Даже как я мог переходить между разными разделами просто кликом, а рисовать долгой линией. Вот я считаю, что это будет режим. Реализуй его полностью и пересобери приложение.
2. > и также сохраняем это все
   > скрины все и так далее
3. > последние 5 записей аудио должны храниться и последние 5 пачек скриншотов
4. (вставкой)
> ПЕРЕПИСКУ ПЕРЕЧИТАЙ
>
> Ты потерял часть моих задач - полный анализ
> Еще ты допустил несколько костылей в своей работе - найди их все и устрани
>
> Все что потерялось - запиши в текущий список задач, актуализируй!
>
> Все найденные задачи которые ты потерял ПОЛНОСТЬЮ Доделай до конца -  В ФОРМАТЕ ENTERPRISE решений, без костылей — самые лучшие и продуманные, очень глубокие, SSOT, гениальные решения.
5. > So Когда я делаю двойной этап и начинаю вести, у меня тоже должна должно производиться рисование. Потому что я таким образом рисую не хочет. Я веду, это тоже drag and drop вот эта штука, чтобы я какую-то хреню рисовал. Это важно.
6. (вставка результата теста)
> [✏️ 00:00 линия справа (72%, 51%) → скрин 1] [📸 00:03 скрин 1: /Users/leoerdman/Library/Application Support/Transcriptor/screen-sessions/screen-20261120-161137-697/shot-01.png] Ir galgenas я žamanas tačiau kompiuterių у net окно транскиллера, Мне эта хуйня не нужна.
7. > Так Также, когда я нажимаю на значок транскриптора, у меня ой, на значок компьютера в капсуле, у меня открывается окно транскриптора Это неправильная хуйня, это нужно исправить.
8. (вставкой; повторено ещё два раза позже)
> ДОДЕЛЫВАЕМ ВСЕ ПОСТАВЛЕННЫЕ и ОБНАРУЖЕННЫЕ ЗАДАЧИ - ТЫ МНОГОЕ ПОТЕРЯЛ, И ЧИНИМ ВСЕ ТОЛЬКО В ФОРМАТЕ ENTERPRISE решений, без костылей — самые лучшие и продуманные, очень глубокие, SSOT, гениальные решения. Глубже и логичнее сделай, пройдись по всем моим запросам, ничего не упускай и сделай все идеально.
>
> Все фиксы должны попасть в мейн ветку а не потеряться - все должно быть ахуенно интегрировано!
>
> Смотри все ворктри чтобы ничего не потерялось!
9. > не починилось
10. > не починилось ни то не другое - убери все костыли из проекта вообще
11. (вызов скилла) «Прочитай `.agents/skills/ultra-audit/SKILL.md` и выполни его процедуру целиком для области `Focus: crutches (костыли) across the whole Voice Transcriptor project — …`. Второй копии правил здесь нет намеренно: единственный источник правды для этой процедуры — этот файл. Инструментом Skill его не вызывай…»
12. > НАЙДИ ВСЕ КОСЯКИ, костыли и хардкод в нашем приложении, посмотри все логи бекенда и максимально его оптимизируй и почини
13. > все доделай автономно без остановки до конца
14. > долго еще?
15. > посмотри чтобы они все нормально делали и без костылей
16. > ВСЕ ДОДЕЛАЙ ПОДКЛЮЧИ В МЕЙН И ПЕРЕУСТАНОВИ И ПРОВЕРЬ
17. (этот запрос) «Напиши полный хендофф этой сессии…»

**Жалобы пользователя** (дословно выше): №4 (потеряны задачи, костыли), №6 («окно транскиллера… Мне эта хуйня не нужна» + мусорный литовский текст), №7 (окно Транскриптора открывается по значку компьютера), №8 ×3 («ТЫ МНОГОЕ ПОТЕРЯЛ… Смотри все ворктри»), №9 «не починилось», №10 «не починилось ни то не другое» (окно И двойной тап), №15 «посмотри чтобы они все нормально делали и без костылей».

---

## 2. Закрытые задачи

### 2.1 Режим экрана (релиз 1.6.6, `70273a0` + `acbf737`)
- Хоткей `Option+→` (screen), `Option+↓` (скриншот, бинд только пока идёт режим); слоты в Settings → Shortcuts (скрыты, если платформа не поддерживает).
- Красная рамка на каждом дисплее (оверлеи, `setIgnoreMouseEvents`, content-protected → не попадают в скриншот — проверено на реальном снимке пользователя).
- Палитра из 6 цветов над капсулой; кнопка-компьютер справа от таймера (капсула 110 → 134 px).
- Нативный хелпер `desktop/native/screen-input/` (CGEventTap): клик проходит в приложение, протяжка рисует; правило — `PressClassifier.swift`, тест `desktop/screen-input.test.js` (компилирует Swift).
- Скриншот = `screencapture -R` + наложение штрихов в масштабе изображения; при стопе автоснимок, если есть ненарисованное.
- Пометки в тексте `[✏️ 00:12 линия вверху справа (82%, 14%) → скрин 1]` / `[📸 00:15 скрин 1: <путь>]`, ставятся по таймингам слов (или доле длительности), повторно вставляются в апскейл без прохода через модель (`frontend/src/screen-annotations.ts`).
- Хранение: скрины переезжают к записи как `<stem>.screens/` (бэкенд, `backend/screen_sessions.py`), коллекция `Screen Sessions`, одно правило хранения для аудио и скринов — newest 5 (`TRANSCRIPTOR_SCREEN_AUDIO_KEEP_COUNT`). История показывает скрины под плеером. Контракт имён: `contracts/screen-session.json`.
- Две тестовые записи пользователя от 16:10 и 16:11 — скрины прикреплены к записям вручную тем же `adopt_session`, пути в текстах исправлены.

### 2.2 Dual-merge (Auto, Deepgram multi+ru) — «литовский» мусор
- Причина доказана повтором реальной записи: `multi` слышал русскую речь как `lt` (уверенность 0.71–0.91), `ru` — правильно; пословное слияние смешало оба. На сентябрьской трёхъязычной — `uk`, `bg`, `de`.
- Правило «спорного отрезка»: владелец всего отрезка — чтение с бо́льшей средней уверенностью, и только если партнёр реально покрывает отрезок (после аудита: доля покрытия ≥ `SPANLESS_SHADOW_MIN_FRACTION`); победитель «осаживается» до пословного спаривания. В реальном времени запись пользователя 3/3 даёт правильный русский. Инструменты: `python -m backend.tools.deepgram_live_ab <wav> --language multi --dual ru --words --full` (ТОЛЬКО реальное время; `--speed 2` обманывает) и офлайн-повтор `backend/tools/dual_replay.py` (после аудита).
- Re-transcribe сохраняет пометки (manifest хранит `audioStartedAt` и `endedAt`), заголовок записи — из сказанного.

### 2.3 Окно всплывает по значку компьютера — `acbf737`
- `type: "panel"` НЕ помог (лог 09:45:15) — удалён. Корень: клик, доставленный оконным сервером в окно неактивного приложения, активирует его. Решение: хелпер забирает нажатия по нашим контролам и сообщает `tap`; клик выполняется внутри страницы → активации нет. Проверено e2e (тап по палитре → штрих зелёный). **Живой проверки пользователем после этого не было.**
- Двойной тап с протяжкой: протяжка рисует всегда, даже без увиденного нажатия; на нажатие — строка лога `[screen-mode] press outcome=… clicks=… drags=…`. После аудита (DX-07): при отключении тапа macOS классификатор сбрасывается, лог `[screen-mode] tap disabled reason=… abandoned=…`. **Пользователь сообщил «не починилось ни то не другое» до DX-07 и до сборки с аудитом; новая сборка не ставилась** — первое, что проверить (§5).

### 2.4 Ultra-Audit 2026-11-20 (процедура: `/Users/leoerdman/Programming - Main/M Code/.agents/skills/ultra-audit/SKILL.md`)
- 12 проходов, **275 находок** (257 код + 18 логи), отчёт `BUGSAUDIT-2026-11-20.md`, полные блоки §5 — `docs/audit-2026-11-20/*.md`.
- 6 полос починки (Opus, отдельные ворктри) — **все слиты в main и запушены**:
  | Полоса | Журнал | Итог |
  |---|---|---|
  | desktop/main.js | `fix-journal-desktop-main.md` | DM P1 9/9; P2 23/26 |
  | desktop модули/скрин/Swift/скрипты | `fix-journal-desktop-modules.md` | P1 3/3; P2 20 + 4 частично; найдена реальная shell-инъекция DX-22 |
  | рендерер UI (main.tsx ≤ ~9285) | `fix-journal-frontend-ui.md` | P1 3/3 |
  | рендерер live + Upload | `fix-journal-frontend-live.md` | P1 4/5 (FQ-04 → междоменно); D-13 (7 эпилогов stopLive → 1) |
  | бэкенд архив/CLI/логи | `fix-journal-backend-archive.md` | **P0 BM-03** (удаление чужих файлов) — fixed; BL-01 (spool удалялся до finalize — 25% записей теряли recovery) — fixed; P1 10/11 (BM-01 → междоменно) |
  | бэкенд live WS + движки | `fix-journal-backend-engines.md` | P1 7/7; 37 P2 |
- Мой шов-фикс `2d7872c`: готовность к вставке решается по `kind`, а не по словам («HTTP …» диктовки не вставлялись); удалены 5 глобалов без читателя.
- `712943a`: PROJECT_STRUCTURE — 12 новых модулей desktop.
- Состояние наборов на `712943a`: desktop **422/422**, frontend **593/593** + typecheck/lint/build, `node --check` ок, бэкенд — **1 ошибка** (`test_live_coverage_policy`, §0 п.2).

### 2.5 Ворктри и ветки
- Две старые сентябрьские ветки (`wip/ultra-audit-2026-09-04`, `origin/worktree-agent-a90710620c8f16c09`) — проход истории доказал: целиком в main, вторая ещё и с порядком до фикса. Не сливались. Удаление — решение пользователя (§4).
- Ворктри полос в `.claude/worktrees/agent-*` — все ветки слиты в main, КРОМЕ `worktree-agent-a2f9e91fa1a6d3247` (ревью-фикс, §0 п.1). Остальные можно удалить (`git worktree remove`) после проверки `git rev-list --count main..<branch>` = 0.

---

## 3. ВСЕ открытые задачи — детально

### 3.1 Ревью-фикс (ветка `worktree-agent-a2f9e91fa1a6d3247`; ревью сохранено: `docs/audit-2026-11-20/review-merged.md`, ревью веток: `docs/audit-2026-11-20/review-branches.md` — короткое, полный текст в §3.2 этого файла)
Независимый ревьюер слитых полос (desktop/main.js и renderer live) нашёл:
1. ✅ **P1 регрессия** (коммит `d975368`): `saveSessionMetadata` писал `title: latestSourceTitle()` — записи с пустым/иным live-текстом сохранялись как «Recording <дата>». Починено `9c2ba71`.
2. ✅ Потеряно состояние капсулы «Upscaling» (коммит `a0be23d` удалил единственного вызывающего). Починено `67469a4` (фаза из IPC-сигнала).
3. ⏳ WIP `d874dce`: `desktop/engine-install-flight.test.js` тестировал свою копию логики → вынести single-flight хелпер (`desktop/single-flight.js`), который вызывает `installGigaamEngine`, тест под конкуренцией. **Не прогнан. Проверить, что `main.js` действительно вызывает хелпер.**
4. ☐ «Доказательства» грепом исходника вместо поведения: `desktop/quit-path.test.js` (`assert.ok(calls.length >= 1)` — пустое), `timing-budgets.test.js`, `main-dead-code.test.js` (только отрицательные регэкспы), `ipc-sender.test.js` (260-символьный срез main.js), `renderer-main-contract` (считает `saveRecordingText({`). Заменить на поведенческие тесты вынесенных решений; межфайловые контракты-имена каналов оставить.
5. ☐ Дубли/мёртвое: матрица покрытия в `frontend/tests/live-coverage.test.ts` и `backend/tests/test_live_coverage_policy.py` (сейчас ещё и ломает бэкенд-набор!); `main.js` ~1551 перепечатывает `t.width + t.pillGap + t.screenIconSize` вместо `t.maxWidth`; `RECORDING_STATUS_CAPSULE.minWidth/minHeight/maxHeight` не читаются.
6. ☐ Устаревшие комментарии: main.js ~1472 и `desktop/capsule-geometry.js:10` (126 px, а реально 134 — писать через константу), «Channel 1b» в main.tsx, комментарий `win.on("closed")`.
7. ☐ `handlePostStopTranscriptTimeout` (main.js ~6382) пишет буфер обмена мимо clipboard-lease; дедлайн рендерера 1750 мс против 2000 мс в main — сделать один именованный дедлайн.

### 3.2 Междоменная полоса (половины фиксов на чужой стороне)
Полные списки дословно — в Приложении А (из журналов). Главное, сгруппировано по владельцу:

**P1 / заметное пользователю:**
- **FQ-04 (P1)**: `waitForBackendJob` (main.tsx ~4760–4776) — повторять при сетевых ошибках/5xx/429, 404/4xx — терминально; `waitForQueued*Job` в `finally` вызывает `cancelBackendJob`, если задача не дошла до конца (иначе задача висит, занимая 1 из 2 воркеров, а Retry запускает вторую).
- **BM-01 (P1, безопасность)**: держатель CLI-токена получает полный токен рендерера с неаутентифицированного `GET /` (`backend/main.py index()` вшивает токен в страницу). Отдавать токен окну через preload/IPC (desktop) и перестать вшивать (backend). `BACKEND_BOOT_NONCE` не годится — `/api/health` отдаёт его публично.
- **Швы режима экрана (ревью веток, D1–D3 + S-04)**:
  - D1: контроллер шлёт `onWarning("helper")`, `onWarning("capture-failed")`, `"start-failed"` — в `SCREEN_MODE_WARNINGS` (main.js ~2321) нет текста → пользователь ничего не видит. Добавить копии.
  - D2: при неудачном старте уведомление дважды (контроллер + `decideAfterScreenStart` main.js ~2961). Один владелец уведомления.
  - D3: быстрый стоп даёт `{ok:false, error:"ended"}` → main показывает «Screen mode didn't start». Отдельный результат «ended» = норма; также `endedIds` контроллера дублирует `END_ORPHAN` в main (`cb31c13`) — один механизм.
  - S-04: при `ok:false` main должен сказать рендереру, что дубль голосовой (иначе он уходит в Screen Sessions с хранением 5).
  - S-02: вызывать `screenMode.start` до await'ов / до старта записи рендерером; `endScreenModeForLostRenderer` передаёт id дубля.
- **M3 `screens_error`**: бэкенд отдаёт его при сбое адопции (save и promote), рендерер (`frontend/src/recording-save.ts` `parseRecordingSaveResponse`) не читает → сбой молча, а пометки падают на staging-пути, которые потом подметаются. Показать ошибку и не подставлять staging-пути.
- **FL-12/S-01 (рендерер-половина)**: черновик/восстановление шлют `recording_collection: live` (main.tsx ~5126, 5811, 6003) — брать коллекцию дубля (`liveRecordingCollection(mode)`); в WS-запрос `/ws/transcribe` (~11474) добавить `screen_session_id` (бэкенд-половина готова: sidecar хранит `screen_session_id`, promote адоптирует).
- **BL-02 (остаток приватности)**: desktop создаёт `main.log` с правами 0600; access-log фильтр редактирует `/api/recordings/<name>/audio`; (движки и архив уже не пишут продиктованный текст).

**P2 (по владельцу):**
- *Рендерер*: delete-all обработчик (~9242) — убрать мёртвый `showRecordSessionNotice`, ошибку — в плейсхолдер через `historyFailureSurfaces`, `apiDelete`; кнопки копирования Upload (~15517, ~15610) → `flashCopyOutcome`, удалить `flashButtonFeedback`; **M1**: `runUpdateCheck` вызывает `updateCheckOutcome(result, trigger)` (сейчас функция мертва, правило продублировано inline); «2 часа» — через `capturedHoursLabel` и `UI_TOKENS.notice.longMs`; FG-08 — `startLive` ждёт чтения черновика; FL-07 бюджеты стопа в `UI_TOKENS.finalize`; FL-08 общий `decodeSavedRecording` для Re-transcribe и стопа; FQ-06(b,c) `onJobCreated`; FQ-12 `applyRuntimeLimits`; S-15 History-плеер стримит `<audio src>`; мёртвый CSS `.is-determinate` (`styles.css` ~3911); BL-16 — лишний discard после save-with-audio; BL-12 дебаунс переключения сети перед прогревом local.
- *Desktop*: DM-10 (главное окно) — рендерер шлёт `shortcuts:message`, `record:toggle`, `recording:reveal` через preload, main удаляет обработчик `page-title-updated` (у капсулы и палитры title-канал уже убран); DM-14/S-10 push `shortcut-status` вместо 2 с поллинга (FU-08 `_shortcutConflictPoll`); явные `kind`/`phase` в `recording-final-slot.js`+preload+рендерер; `"OK:vbs-paste"`/`"OK:pwsh-paste"` (main.js ~5417–5507) из констант `paste-protocol.js`; DX-12 геометрия/уровни капсулы — один владелец (литерал `54`); путь dev-хелпера `mac-${process.arch}` → `mac-arm64`; H-03 голосовая капсула всё ещё на 700 мс подавлении activate (у режима экрана — тапы в процессе); DX-28 п.1–2 в `ipc-contract.test.js`; FQ-14 desktop шлёт ошибки загрузки как `{code, raw}`, FQ-22(5) `setBackendBootStatus("")` на пути сбоя.
- *Бэкенд*: FG-04 `_normalize_live_draft` хранит `schema_version`; FG-06 хвост длинного черновика; FG-11 убрать алиасы `remote_model`/`openrouter_model`; FU-13a/b, FG-10 опубликовать лимит пресетов и порог Deepgram 1 MiB / 13 с вместо копий в рендерере; BW-13 буферизованная запись recovery-чанков (`_record_recovery_chunk` ~4308); BE-22 дубль `_env_int` (~637); BM-13 `OpenRouterError.status_code`; BM-24 `retries`→`attempts` с вызывающими; BM-29 `estimated_*` в статистике (вместе с рендерером); BL-11 GigaAM помнит сбойный хост.
- *Docs/конфиг*: `.env.example` — убрать `NOTARYTOOL_*` пароли (тогда `notarize-dmg.sh` без `--password`); CHANGELOG — записи всех полос.

### 3.3 Не сделано полосами (с причинами — Приложение А)
Кратко: DM-18 (Windows-хелпер, нельзя проверить без Windows), DM-30/S-14 (close=quit — решение), DM-33 (локализация), FL-11/FL-19/S-16 (гипотезы, меняют поведение), FU-22/FU-26 остаток (тесты-пины), FG-13(b) общий дедлайн задачи (нет продуктового числа), FG-09, BE-09/BE-10 (доказано на реальной записи — фикс ухудшает), BE-16/18/23, BW-07, DX-05 (находка неверна), DX-15/19/27, BM-20 (`--token`), BM-21 (пиннут тестом B-020), BL-13 (не измерено), BL-18 (очередь хранит текст).

---

## 4. Требует решения пользователя
1. **BL-03 — обрезка архивов логов** сломана: 25 архивов, 131.6 МБ, никогда не удаляются. Починка начнёт удалять логи, а `AGENTS.md` п.3 запрещает это без явного разрешения. Предложение: хранить 10 архивов / 50 МБ.
2. **DX-17 / DM-17-подобное — глобальные хоткеи по умолчанию** `Option+→` (всегда) и `Option+↓` (во время режима) отбирают у всех приложений переход по слову/абзацу. Оставить или сменить дефолт?
3. **FU-15 — провайдер «None»** в тулбаре после перезапуска читается как Whisper. Убрать опцию или хранить `""` (выключает транскрипцию)?
4. **DM-30/S-14** — закрытие окна во время работы (close=quit без защиты при незавершённой записи/вставке).
5. **Удаление веток** (§7 отчёта, команды готовы): две сентябрьские + слитые `worktree-agent-*`.
6. **Версия** фиксов аудита (1.6.7?).

---

## 5. Живая проверка после сборки (чек-лист)
- Режим экрана: `Option+→` → рамка, палитра, кнопка-компьютер; клик проходит; протяжка рисует; **двойной тап с протяжкой на трекпаде рисует** (если нет — `grep "press outcome\|tap disabled" ~/Library/Application\ Support/transcriptor/main.log`); **клик по кнопке-компьютеру НЕ поднимает окно Транскриптора** (`grep "main-window\] event=focus"` рядом с `shot … reason=capsule`); выбор цвета; `Option+↓`; стоп → пометки в тексте, скрины в Истории под плеером.
- Голосовая запись + авто-вставка; диктовка «HTTP server returns 500» вставляется; исходный буфер обмена восстанавливается (DM-02).
- Auto (dual): русская фраза не превращается в литовскую; в логе нет продиктованных слов.
- Re-transcribe записи режима экрана — пометки на месте, заголовок из сказанного.
- Upload; История: «удалить всё» не трогает чужие файлы в пользовательской папке (BM-03).
- Холодный старт и старт со сбоем бэкенда (страница ошибки в окне).

---

## 6. Допущенные ошибки и уроки
1. **Объявлял «готово» без живой проверки.** Пользователь дважды сказал «не починилось». `type: "panel"` выглядел правильным по документации, но не работал. Урок: поведение, завязанное на macOS (активация, тапы, TCC), проверять по логу/живому прогону, а не по документации; в ответе прямо говорить «не проверено вживую».
2. **Терял задачи из реплик** («сохраняем всё», «5 и 5»): сначала два счётчика хранения в двух процессах. Урок: после каждой реплики пользователя сверять список задач со всеми репликами; хранение — один владелец.
3. **Сам вносил костыли** (поллинг 400 мс зон исключения, сторож 1 с, дублированные пороги, русские слова в desktop, магическое `136`, мёртвый `type: "panel"`). Урок: перед коммитом искать в своей правке поллинг, дубли правил, числа без источника.
4. **Merge-правило на одном слове** (BE-01): забрать отрезок, если у партнёра есть хоть одно слово. Урок: правило решения — с порогом покрытия, проверять на реальных данных (`deepgram_live_ab` в реальном времени) и офлайн-повтором.
5. **`--speed 2` в A/B** голодит второй поток и даёт ложный вывод. Только реальное время.
6. **Не гонял бэкенд-набор после слияния рендерерной полосы** — `test_live_coverage_policy` сломан на main с `50ddf43`. Урок: после КАЖДОГО слияния — все три набора.
7. **Общий scratchpad у параллельных полос**: скрипты `prove.sh` перезаписывали друг друга. Урок: каждой полосе — своя подпапка.
8. **Агентские «доказательства» грепом исходника** проходят, а регрессия (заголовок записи) — пролезает. Урок: требовать поведенческий тест вынесенного решения, которое вызывает отгружаемый код; ставить независимого ревьюера до слияния.
9. Скилл ultra-audit лежит в другом репо (M Code) с путями того репо — отступления записаны в журнале решений отчёта (Р-1, Р-2).

---

## 7. Находки модели, важные для продукта
- 25% ноябрьских записей теряли восстановление пропущенных слов (BL-01) с 2026-09-05 — исправлено, проверить в логе: строк `live recovery spool not readable at finalize` быть не должно.
- `multi` систематически «слышит» русскую речь как lt/uk/bg/de с высокой собственной уверенностью — различает уверенность партнёра на том же отрезке (обновлена память `deepgram-multi-drops-russian-speech`).
- Продиктованный текст лежал в `main.log` (44k строк) — убран из бэкенда; остались права файла и пара URL (§3.2).
- Удержание могло удалить пользовательский `talk.mp4` рядом с `talk.txt` в зарегистрированной папке (P0) — исправлено проверкой заголовка, записанного приложением.
- Shell-инъекция в проверке подписи при сборке (DX-22) — исправлено.

---

## 8. Документы и ссылки
- Отчёт: `BUGSAUDIT-2026-11-20.md`; находки: `docs/audit-2026-11-20/{history,desktop-main,desktop-modules,frontend-ui,frontend-gaps,frontend-live,frontend-upload,backend-main,backend-live-ws,backend-engines,backend-logs,scenarios}.md`; журналы фиксов: `docs/audit-2026-11-20/fix-journal-*.md`.
- Прошлый аудит: `BUGSAUDIT-2026-09-04.md`, `docs/audit-2026-09-04/`; прошлые хендоффы: `docs/NEXT_SESSION_2026-09-04.md`, `docs/NEXT_SESSION_2026-09-04b.md`.
- Процедура аудита: `/Users/leoerdman/Programming - Main/M Code/.agents/skills/ultra-audit/SKILL.md`.
- Правила: `AGENTS.md`; продукт: `docs/PRODUCT.md`; структура: `PROJECT_STRUCTURE.md`; env: `.env.example`; CHANGELOG `CHANGELOG.md` (1.6.6).
- Режим экрана: `desktop/screen-mode.js`, `desktop/screen-mode-controller.js`, `desktop/native/screen-input/{main.swift,PressClassifier.swift}`, `desktop/scripts/build-native.sh`, `backend/screen_sessions.py`, `frontend/src/screen-annotations.ts`, `contracts/screen-session.json`.
- Dual-merge: `backend/deepgram_dual.py` (`_settle_contested_stretches`), `backend/tools/deepgram_live_ab.py`, `backend/tools/dual_replay.py`.
- Данные пользователя: `~/Library/Application Support/transcriptor/` (`main.log`, `recordings/Screen Sessions/`, `screen-sessions/` — staging, `evidence-2026-09-03/` — WAV для A/B).
- Память проекта: `~/.claude/projects/-Users-leoerdman-Programming---Main-Voice-Transcriptor/memory/` (`transcriptor-fix-waves-status.md`, `deepgram-multi-drops-russian-speech.md`).
- Тег точки отката аудита: `audit-2026-11-20-start` (`acbf737`).

---

## Приложение А — «Not done» и «Cross-domain» из журналов полос (дословно)

### `fix-journal-desktop-main.md`

## Not done (ID → reason)
- **DM-10, main-window half** (`__app_shortcuts__`, `__app_record_toggle__`, `__app_reveal_recording__` over
  document.title) → the renderer sets those titles (frontend/src/main.tsx `postTitleBridgeMessage`,
  `TITLE_BRIDGE_PREFIX` ≈ :931); switching needs the renderer to call preload sends. Main + preload side is a
  15-line change once the renderer moves (spec below). The capsule half is done (37bb6e5).
- **DM-14, push half** → the renderer must publish `{isRec, vu, rms, lastFrameAt, recordingId}` (≤10 Hz) over a
  preload send; until then main keeps the poll, now with a single probe in flight (eba196a).
- **DM-18** (four copies of SetForegroundWindow C#, per-call `Add-Type`) → the fix is new verbs (`ACTIVATE <hwnd>`,
  `SENDKEYS`) on the persistent PowerShell helper's FIFO protocol; it cannot be verified without Windows, and a broken
  activation verb types transcripts into the wrong window. The false "no C# compilation" comment went with DM-04.
- **DM-30 / S-14** (quit/close during a take or post-stop work) → hypothesis; any fix (confirm dialog, minimise
  instead) changes rule 4 of `window-lifecycle.js` ("close = quit", tested) — a product decision for the user.
- **DM-33** (English-only main-process copy) → needs a shared locale catalog and the UI language in main (renderer
  `ui-copy.ts` owns the strings and the language); cross-domain and a product decision on which strings move.
- **S-10** (shortcut status pushed into a window global, polled every 2 s) → needs the renderer to subscribe to a
  preload event and drop `_shortcutConflictPoll` (main.tsx ≈ :6355); a sender with no receiver is not added.
- **H-03** (voice-mode capsule click still lets macOS raise the main window) → needs the screen-mode tap-in-process
  approach for the voice capsule (native helper) or a CHANGELOG/lifecycle-doc correction — both outside this lane and
  needing macOS. main.js's own overclaiming comment is corrected (3cb32fc).
- **H-04, main.js part** → nothing to fix: no "non-activating panel", "exclusion rectangle", "prune list" or
  "non-focusable panel" wording exists in main.js (grep, verified); the stale wording is in PROJECT_STRUCTURE.md,
  screen-mode-controller.js, main.swift, window-lifecycle.js.
- **DM-21, docs part** → `docs/VERIFIED_AUDIT.md` cites `desktop/main.js:NNNN`; historical audit, not this lane's file.

## Cross-domain, for the lead
1. **frontend/src/main.tsx `recordingOutputIsInvalidTranscript`** (≈ :10720): `lower.startsWith("http ")` (and
   `lower === "error"`) refuses a dictation such as "HTTP server returns 500" as paste-ready — the renderer half of
   DM-01. Delete the text sniffing; mark non-transcripts with `kind`/`phase` at the publish site.
2. **Explicit kind/phase on the hand-off**: `recording-final-slot.js validateRecordingFinalPayload` + `preload.js
   recordingFinal` + the renderer's `publishRecordingOutput` should carry `kind` ("transcript"|"status"|"error") and
   `phase` as validated fields; then `transcript-signal.js parseSignalSource` reads them instead of the `source` label.
3. **Renderer globals main no longer reads** (DM-15): `__transcriptorFinishedRecords`,
   `__transcriptorLastFinishedAt/RecordingId`, `__transcriptorLastUiFinalAt/RecordingId`, and the snapshot fields
   `status`/`statusKind`/`busy` + DOM ids `finalOutput`/`liveOutput`/`progressRow` for post-stop. Main still reads
   `__transcriptorLastFinishedText`, `__transcriptorLastUiFinalText`, `__transcriptorLastUiFinalKind` (paste-last).
4. **DM-10 main-window half**: renderer → `window.transcriptor.shortcuts(message)` (`ipcRenderer.send("shortcuts:message", {action, record, paste, screen, screenShot})`),
   `recordToggle()` (`"record:toggle"`), `revealRecording({name, archiveDir})` (`"recording:reveal"`); main then
   `ipcMain.on` each with the main-window sender check and deletes its `page-title-updated` handler (main.js ≈ :8100).
5. **DM-14 + S-10 push channels**: renderer publishes recording state and subscribes to `shortcut-status`
   (main sends on change, like `system-suspend`); drop `window.__transcriptorShortcutStatus` and the 2 s poll.
6. **S-09 renderer special case**: main now fills `status.screenShot.{active,error}`; main.tsx ≈ :6325
   (`id === "screenShot" ? !entry.error : !!entry.active`) can use the same rule as the other slots.
7. **ipc-contract.test.js:195** pins the inline sender check of `screen-mode:finish`; relax it to accept
   `isFromMainWindow(event)` so all six preload channels share one predicate (DM-28).
8. **DX-03 / S-02 controller half**: `screen-mode-controller.js` should tombstone a finished id so a late
   `start(id)` no-ops; main now ends an orphaned session after start (cb31c13), the controller guard closes the race.
9. **H-03**: CHANGELOG.md:75 / window-lifecycle.js:39,136 overclaim ("the capsule never moves the main window");
   state the voice-mode limit or extend the tap-in-process approach to the voice capsule.
10. **recording-status.js `presentation.tone`**: no longer sent to the capsule (the capsule never read it).
11. **user-data-dir.test.js:134** decides "nothing reads userData before the spelling fix" by the first TEXTUAL
    occurrence; it forced `dataDir()` to be declared after the boot calls (hoisting makes position irrelevant).
12. **DM-16/DM-20**: the activation settle values (`APP_/WINDOW_ACTIVATION_SETTLE_MS`, `AUTO_SEND_ACTIVATION_SETTLE_MS`)
    belong in `paste-capability.js PASTE_BUDGET` with the other paste-path wall-clock numbers.

### `fix-journal-desktop-modules.md`

## Not done (ID → reason)
- **DX-05** (P2) → refuted on reading, not changed. The overlay stores points relative to
  the display's origin AT THE TIME they were drawn. A display that moves in the arrangement
  keeps its pixels where they are physically, so a stroke at local (100,100) must stay at
  local (100,100) — which is exactly what the current code does. Re-basing (the audit's
  fix) would move every existing stroke off the place it was drawn. The only real residue
  is a ≤16 ms window where ops queued before `__setOrigin` are applied after it; too small
  to justify converting ops in the controller.
- **DX-12** (P2) → needs main.js: the `54` fallback is capsule `bottomMargin 16` + height
  30 + palette margin 8, and the overlay < palette < capsule levels are `"screen-saver"`
  0/1 here and 2 in main.js. One constants object must be owned by one side and injected
  into the other (see Cross-domain).
- **DX-15** (P2, hypothesis/perf) → not measured; the suggested "composite from the file
  URL" is not available (overlay page is a sandboxed `data:` page with CSP `img-src data:`).
  Left until a measurement shows the cost.
- **DX-16** (P2, UX) → product decision (pen toggle / pass-through modifier); not a defect
  of the stated product rule.
- **DX-17** (P2) → product decision per the lead's brief (global Option+Right / Option+Down
  defaults); `shortcut-defaults.json` untouched.
- **DX-19** (P2, hypothesis) → adding `ScreenCapture` to paste-capability's repair table
  changes behaviour (it would reset a TCC grant) on an unverified macOS assumption.
- **S-03 rest** (P1, hypothesis) → the wallpaper-only probe (compare against a one-pixel
  probe window) and the TCC repair need macOS behaviour verified on a machine; only the
  capture-side parts were fixed (C3: warn on every non-"granted" state, no regex, no
  screenshot claimed for a failed capture).
- **DX-21 notarytool half** (P2) → `notarytool --password` has no env/keychain-reference
  form; removing the Apple-ID password path means changing `.env.example` (another lane's
  SSOT). See Cross-domain.
- **DX-23 manifest half** (P2) → `app_id=` in the manifest beside the installer is written
  by BUILD.command into the same kit as the DMG; replacing it requires the same access as
  replacing the DMG, so it is not a trust boundary. The identity guard (C7) is what protects
  the user's grants.
- **DX-24** (P2, known items) → D-023 (default internal identity name), D-063 (mutable
  osxexperts ffmpeg URL: hosting decision), D-061, D-034, DMG artwork text, костыль 1
  (main.js title channels), костыль 8 (afterPack read-only / unlockDist cycle), PowerShell
  helper, BUGS_AUDIT_2026-09-03 §8 #30 `Alt+Left` — decisions or other lanes, unchanged.
  H-8 was fixed (C9).
- **DX-27** (P2, hypothesis) → re-enabling a disabled verification target changes observable
  paste behaviour (clipboard restore) on an unverified premise.
- **DX-28 bullets 1–2** (P2) → `ipc-contract.test.js` tests only main.js; main.js lane.
- **DX-29 / H-03 behaviour** (P1/P2) → the 700 ms activate suppression lives in main.js;
  only the documentation half was done here (C6).

## Cross-domain, for the lead
1. **main.js — screen-mode warnings copy** (C3): `SCREEN_MODE_WARNINGS` must gain copy for
   the new kinds the controller now raises: `start-failed` ("Screen mode could not start"),
   `helper` ("Screen mode stopped drawing" — the mouse helper died mid-take),
   `capture-failed` ("A screenshot could not be taken" — the strokes stay on screen for the
   next one). Until then they are only logged as `[screen-mode] warning <kind>`.
2. **main.js + renderer — S-04 / DX-08 renderer side**: `screenMode.start()` now answers
   `{ok:false, error}` on failure (`"ended"`, `"unsupported"`, helper/overlay errors).
   main.js L2891 only traces it; it must tell the renderer to demote the take to a voice
   take (`liveRecordingMode = "voice"`, Live collection, not Screen Sessions), so retention
   is not downgraded for a take with no screen session.
3. **main.js — S-02 / DM-31 main side**: the controller refuses a start whose id already
   ended. main should also stop awaiting `frontAtHotkeyPromise` / `beginRecordingStatusSession`
   before `screenMode.start` (or start it before the renderer is told to record), and
   `endScreenModeForLostRenderer` should pass the take's id
   (`screenMode.finish({ id, discard:false })`) so a renderer lost before main's start ran
   retires that id too.
4. **main.js — DX-12**: export the capsule geometry (`bottomMargin`, `pillHeight`) and the
   window levels (overlay 0 < palette 1 < capsule 2 on `"screen-saver"`) from one place and
   inject them into the controller (`deps.capsuleLayout`, `deps.levels`); the controller then
   computes its palette fallback instead of the literal `54`.
5. **main.js — DX-26 markers**: the VBS/PowerShell scripts main.js builds still type
   `"OK:vbs-paste"` (L5417, L5453) and `"OK:pwsh-paste"` (L5499, L5507); build them from
   `PASTE_OK_PREFIX` + `VBS_PASTE_METHOD` / `PWSH_PASTE_METHOD` (paste-protocol.js).
6. **main.js — DX-29 / H-03**: decide `capsuleInteraction` from the capsule being the clicked
   target (or route voice-mode capsule clicks through the same in-process tap path) instead of
   `RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS`; then drop the limit paragraph from
   window-lifecycle.js's header.
7. **main.js — DX-25 tail**: the dev helper path `native/build/mac-${process.arch}` can name
   `mac-arm64` (the only target build-native.sh builds).
8. **desktop/ipc-contract.test.js (main.js tests) — DX-28 bullets 1–2**: assert the power
   events registration through power-events.js with a fake `powerMonitor` and its whenReady
   depth, not a text match; drop the indentation-exact match at L195.
9. **.env.example — DX-21 notarytool half**: remove `NOTARYTOOL_APPLE_ID` /
   `NOTARYTOOL_TEAM_ID` / `NOTARYTOOL_PASSWORD` (keychain profile or API key only); then
   `desktop/scripts/notarize-dmg.sh` drops the `--password` branch (my lane can do that part
   once `.env.example` changes).
10. **CHANGELOG.md** — user-visible changes in this lane worth an entry: screen mode no longer
    reports a failed start as started; a stroke finished during a screenshot goes to the next
    one; a failed capture keeps its strokes; the helper logs `tap disabled …` lines; the
    other-Mac installer refuses ad-hoc builds and certificate changes over a granted copy.
11. **Not verified on a machine**: DX-07's main.swift half (replaying a held press when macOS
    switches the tap off) — type-checked and its rule unit-tested, but a live disabled tap
    was not reproduced. The new `[screen-mode] tap disabled reason=… abandoned=…` line in
    main.log is what will show whether the user's trackpad double-tap-drag failure is a
    disabled tap.

### `fix-journal-frontend-ui.md`

### d9dbf0d · FG-13 (a, c, d; b not done — see below)
- Files: new `frontend/src/job-poll.ts` (`waitForJob`, `nextJobPollDelayMs`) + `frontend/tests/job-poll.test.ts`; `frontend/src/main.tsx` (`waitForBackendJob`, `sleepUnlessAborted`, `UI_TOKENS.polling.backendJob`).
- Check: `npx vitest run tests/job-poll.test.ts`.
- Before (pre-fix behaviour in the module: first poll failure throws, no cancel, backend `cancelled` → AbortError), exit 1:
  ```
       × survives a transient poll failure instead of abandoning a running job 3ms
       × gives up after the tolerated run of failures and cancels the job it leaves behind 2ms
       × reports a job the backend cancelled as an error, not as the user's abort 1ms
        Tests  3 failed | 3 passed (6)
  ```
- After, exit 0: `      Tests  6 passed (6)`

### 0f657c3 · FU-03, FU-04 (Refresh; delete-all half cross-domain), FU-05, FU-07, FU-20
- Files: new `frontend/src/notice-surface.ts` (`noticeSurfaces`, `historyFailureSurfaces`), new `frontend/src/recovery-summary.ts`, their tests; `frontend/src/main.tsx` (`showRecordSessionNotice`, Refresh handler, preset modals/delete, `recoverBackendAudioSessions`, `openRecording` audio catch).
- Check 1: `npx vitest run tests/notice-surface.test.ts`. Before (banner only / body write), exit 1:
  ```
       × never writes a failure into the transcript body Copy copies 3ms
       × keeps an open transcript and reports through the status pill 1ms
       × uses the empty viewer's placeholder when nothing is open 0ms
       × shows a notice raised from Settings or History in the status pill too 0ms
       × does not drop a notice when no view could be identified 0ms
        Tests  5 failed | 1 passed (6)
  ```
  After, exit 0: `      Tests  6 passed (6)`
- Check 2: `npx vitest run tests/recovery-summary.test.ts`. Before (failures only when nothing succeeded, "Recordings"), exit 1:
  ```
       × reports a partial failure next to the successes instead of hiding it 2ms
       × reports a full success as a success, naming the History tab 1ms
       × reports a full failure and that it will be retried 1ms
        Tests  3 failed | 1 passed (4)
  ```
  After, exit 0: `      Tests  4 passed (4)`
- Check 3 (FU-05, FU-04): grep for `msg.textContent = e.message;`, the `#upscaleOutput` delete-error write and the Refresh body write — HEAD: 7424, 7456, 7474, 7502, 8843; after: none. FU-20 (meta line) is DOM-only: grep shows the new write at 8650; no test.

### 92132ce · FU-12 (part — two Upload callers remain, cross-domain)
- Files: `frontend/src/button-feedback.ts` (`flashCopyOutcome`, private `flash`), `frontend/src/ui-copy.ts` (`UI_COPY.copyFeedback`), `frontend/src/main.tsx` (3 callers), `frontend/tests/button-feedback.test.ts`.
- Check: `npx vitest run tests/button-feedback.test.ts`. Before (class from `flashLabel === "Copied"`), exit 1:
  ```
       × keeps a success a success when the copy is reworded 6ms
        Tests  1 failed | 9 passed (10)
  ```
  After, exit 0: `      Tests  10 passed (10)`

### 02c3508 · FU-17 (decision half; wiring is cross-domain)
- Files: `frontend/src/update-check.ts` (`updateCheckOutcome`), `frontend/tests/update-check.test.ts`.
- Check: `npx vitest run tests/update-check.test.ts`. Before (stamp and render every result, the current `runUpdateCheck` behaviour), exit 1:
  ```
       × does not stamp the daily throttle for a check that learned nothing 3ms
       × keeps the passive boot check silent when it could not tell, but answers the button 0ms
        Tests  2 failed | 18 passed (20)
  ```
  After, exit 0: `      Tests  20 passed (20)`
- The user-visible behaviour changes only once `runUpdateCheck` adopts it (cross-domain below).

## Not done (ID → reason)
- **FU-10** (`document.title` as IPC, = DM-10 = K-1) — needs a preload/`ipcMain` channel in desktop; transport left as is per lane brief. Cross-domain below.
- **FU-13 (a, b, c)** and **FG-10** (= FU-13b) — the renderer copies backend/desktop constants (custom preset limit 3, Deepgram small-audio 1 MiB / 13 s UI timeout, desktop auto-stop defaults). The fix is to publish them from the owner; a renderer-only change would just move the copy. Cross-domain below.
- **FU-15** — the Live toolbar offers "None", `loadCfg` reads a stored `""` back as Whisper. Both remedies (drop the option, or persist and restore "") change what the user sees, and a restored `""` silently disables transcription if it was ever written by accident; no source of truth (test, product doc, decision log) picks one. Only the two false comments were corrected (bf3cb2f). Needs a product decision.
- **FU-22 (rest)** — `CliAccessStatus.cliDir`, `CliDefaults.engines/localModels`, `CliCard.id` are parsed but unread; removing them means deleting existing assertions in `tests/cli-section.test.ts`, which §7 forbids as a "fix". `transcription-catalog.ts` `engines.whisper !== false` vs `engines.gigaam === true`: asymmetric on purpose (Whisper ships with the app, GigaAM is an optional install) — not a defect. `WHISPER_LABELS` degrades to `Whisper <id>` — not a defect.
- **FU-26 (rest)** — `renderer-main-contract.test.ts` asserts on source text (hypothesis). Rewriting it would remove existing checks; out of a fix lane's remit. The untested decisions the finding names are now covered where they were extracted: `keyEventToAccelerator`, the conflict badge, the screenshot strip copy, `saveRecordingText`'s request plan.
- **FU-11 (related named constants)** — `MIC_ACQUIRE_TIMEOUT_MS`, `PIPELINE_FAILSAFE_MS`, `WAVE_METER_INTERVAL_MS`, `STATUS_PILL_MAX_CHARS`, `MEDIA_RECORDER_STOP_FALLBACK_MS` are named, single-use and documented in place (S-23); moving them into `UI_TOKENS` is churn with no defect. The literal `320` (CSS transition length, `main.tsx` ~5462) and `250` (mic retry pause) remain as audited.
- **FG-02 (platform half)** — whether Chromium's `createWritable()` loses the committed prefix when `close()` rejects is unverified (needs a real Chromium with a forced write failure). Its consequence is closed by 959e7f5 (duration read off the file); the close failure is a warning now.
- **FG-04** — backend drops `schema_version` in `_normalize_live_draft`; renderer comment corrected (55e46b4). Cross-domain below.
- **FG-06** — backend keeps the FIRST 200 000 chars of a draft; the renderer does not know the limit. A renderer-side cap would be a copy of a backend number. Cross-domain below.
- **FG-08** (hypothesis) — a recording started before `recoverLiveDraftIfAny` runs can overwrite the single draft slot; the gate belongs in `startLive` / bootstrap (other lane). The empty-owner DELETE half: skipping it would re-offer an owner-less stale draft at every start; left with the gate. Cross-domain below.
- **FG-09** (hypothesis) — spool recovery and draft recovery for the same crash may yield two recordings; unverified that the ids coincide; no reproduction. Left as a hypothesis.
- **FG-13 (b)** — no overall deadline on a backend job wait: there is no product number for the longest legitimate job (a multi-hour file on CPU); an invented deadline would kill real work. (a, c, d) fixed in d9dbf0d.
- **FG-17 (rest)** — the "exceeds 2 hours" text at `main.tsx` ~11755 is in the other lane's range (cross-domain); `MEDIA_RECORDER_STOP_FALLBACK_MS` stays a named constant (its header explains why).
- **FG-19 (rest)** — `resolveFastLocalLanguage` vs `|| "auto"` in `localJobSync`: a defensive default at a wire boundary, no observable defect; not worth churn.
- **R-023** (early "nothing to save" exit looks like a save) — its callers are outside this lane; unchanged.

## Cross-domain, for the lead
1. **Delete-all handler** (`main.tsx` `#deleteAllConfirmBtn`, starts ~9242 — the function containing line 9285, so outside this lane) — FU-03/FU-04:
   - delete the dead `showRecordSessionNotice(summary, tone);` (the banner is invisible from History; `setStatus` above already reports, and since 0f657c3 `showRecordSessionNotice` would ALSO write the status pill, i.e. twice);
   - in the `catch`, replace `$("recordingContent").textContent = msg;` with `if (historyFailureSurfaces(!!selectedRecordingName).placeholder) resetRecordingViewer(msg);` (import from `./notice-surface`, already imported in main.tsx);
   - the raw `fetch("/api/recordings", { method: "DELETE", headers: authHeaders() })` + manual `r.ok` can be `apiDelete<{ deleted?: unknown; failed?: unknown }>("/api/recordings")`.
2. **Upload copy buttons** (`main.tsx` ~15517 and ~15610) — FU-12: replace `flashButtonFeedback(copyBtn, ok ? "Copied" : "Copy failed", "Copy transcript", {…})` with `flashCopyOutcome(copyBtn, ok, "Copy transcript", {…})` (already imported); then delete `flashButtonFeedback` from `button-feedback.ts` and its tests that exercise the label path move to `flashCopyOutcome`.
3. **Update check wiring** (`main.tsx` `runUpdateCheck` ~13654 and the boot IIFE ~13698) — FU-17 (= FQ-13): give `runUpdateCheck(trigger: UpdateCheckTrigger)`; after `checkForUpdate`, `const outcome = updateCheckOutcome(result, trigger)`; write `UPDATE_CHECK_CACHE_KEY` only if `outcome.stamp`; if `!outcome.render` restore the idle status text and return (re-enable the button); the button passes `"user"`, the boot IIFE `"boot"`.
4. **"exceeds 2 hours" copy** (`main.tsx` ~11755, live lane) — FG-17: build it with `capturedHoursLabel(UI_TOKENS.capture.fallbackWindowSec)` from `./pcm-capture` (already imported) and `UI_TOKENS.notice.longMs` instead of `9000`.
5. **FG-08** (live lane / bootstrap): gate `startLive` on `recordingsBootstrapReady` (or read the stale draft once before the first session can start), so `persistLiveDraft(true)` cannot overwrite a crash draft before `recoverLiveDraftIfAny` reads it.
6. **Backend** —
   - FG-04: add `schema_version` (int) to `_normalize_live_draft` (`backend/main.py` ~2650) and echo it, so the renderer's newer-schema gate can work for backend drafts.
   - FG-06: keep the TAIL, not the head, when a draft exceeds `LIVE_DRAFT_MAX_TEXT_CHARS` (`[-max_len:]`), or publish the limit in bootstrap so the renderer can trim the tail itself.
   - FG-11: remove the `remote_model` / `openrouter_model` aliases from `_remote_model_from_payload`, `/api/remote/jobs`, `/api/remote/jobs/from-path`, `/api/remote/transcribe-sync` (the renderer sends only `model` since bf3cb2f).
   - FU-13a: publish `UPSCALE_MAX_CUSTOM_PRESETS` (e.g. `runtime_limits.upscale_custom_preset_limit`); the renderer then reads it instead of `customCount >= 3` in `loadUpscalePresets`.
   - FU-13b / FG-10: publish `_DEEPGRAM_SMALL_AUDIO_BYTES` and the small-audio connect+read timeout in bootstrap; the renderer derives `REMOTE_SMALL_AUDIO_BYTES` and `UI_TOKENS.finalize.smallAudioUiMs` (= timeout + margin) from them.
7. **Desktop** —
   - FU-10 (= DM-10, K-1): expose `transcriptor.shortcuts.{update,captureStart,captureCancel}`, `toggleRecording()`, `revealRecording()` through `preload.js` + `ipcMain.handle`; then the renderer drops `TITLE_BRIDGE_PREFIX`, the nonce and the restore timer.
   - FU-08: dispatch `window.dispatchEvent(new CustomEvent("transcriptor:shortcut-status"))` in the same `executeJavaScript` that writes `window.__transcriptorShortcutStatus` (`desktop/main.js` ~8866, ~9956); the renderer then listens for it and deletes `_shortcutConflictPoll`.
   - FU-13c: `DEFAULT_RECORDING_AUTO_STOP_CONFIG` (`desktop/main.js` ~474) is a second copy of `UI_TOKENS.autoStopSilence`, held only by a test; main should read the renderer's published snapshot.

### `fix-journal-frontend-live.md`

## Not done (ID → reason)
- **FL-07** (stop budgets in three places, two envelope waiters) — the four numbers belong in
  `UI_TOKENS.finalize` (`ui-copy.ts`, the other lane's file), and putting the local path on the
  announced-budget waiter changes its budget from 4 s to 1.5 s (the backend sends `finalizing` only for
  Deepgram): a product decision, not a refactor. Left as found.
- **FL-08** (two "decode the saved recording" chains) — only the false comment in stopLive fixed
  (db7b76b). The shared `decodeSavedRecording` needs the Re-transcribe handler at ~8988–9200, above this
  lane's boundary. See cross-domain.
- **FL-10** (screen session finished-kept on startup-abort / all-saves-failed) — hypothesis (disk, bounded
  by the 24 h sweep). The renderer has no renderer-only fix: `finishScreenSession` runs at the top of stopLive
  (so the overlays leave with the press), and a second `screenFinish({discard:true})` after the session ended
  finds no session in the controller and removes nothing. Needs desktop — cross-domain.
- **FL-11** (silent fallback to staged screenshot paths when adoption fails) — hypothesis; the fix changes what
  the transcript says (marks become "not saved") and the staged files exist until the sweep. Per §7: hypothesis
  with observable change → described, not changed.
- **FL-12 / S-01 / H-01 / BM-04** (screen take recovered as Live) — renderer half is `buildLiveDraftPayload`
  (~5811), `recoverLiveDraftIfAny` (~6003) and `recoverBackendAudioSessions` (~5126): all above line 9285.
  No renderer-side change stands alone in this lane's range. Cross-domain.
- **FL-13** (too-short verdict computed twice) — needs desktop/main.js to put `discard` in the event detail.
  Cross-domain.
- **FL-16 (last bullet)** — `mediaRecorder.start(1000)` vs `fallbackWindowSec` coupled only by a comment: the
  window constant is computed from `UI_TOKENS` (other lane); naming the timeslice alone would add a third
  number. Left as found; the other FL-16 comments are fixed (db7b76b, d975368).
- **FL-19** (`mergeInterim` normalises the whole committed text per interim) — hypothesis (perf); the finding
  itself says to measure with a 2 h recording before changing. Not measured here.
- **FQ-03 (a)** (keepalive dropped above 60 KB) — needs either a compact payload the backend can merge (its PUT
  replaces the file wholesale, so a payload without `text` would erase transcripts) or `sendBeacon` with auth
  the backend accepts. Backend — cross-domain. **(b)** (unload flush chained behind an in-flight PUT) —
  hypothesis on timing; sending in parallel instead risks the older in-flight PUT landing last and overwriting
  the newer state (wholesale replace). Left as found.
- **FQ-04** (one failed job poll fails the item and leaves the backend job running) — `waitForBackendJob`,
  `waitForQueuedLocalJob`, `waitForQueuedRemoteJob` are at ~4774–4930. Cross-domain.
- **FQ-06 (b, c)** (local jobs get no "job created" moment; the size/10 000 timer — known U/K-2) — needs an
  `onJobCreated` hook from the transport (~4669–4930). Cross-domain. (a) — dead `uploadProgress` — fixed.
- **FQ-12** — (a) the renderer bounds are in `applyRuntimeLimits` (~2255); (b) hypothesis (pause uploads while
  recording) is a product decision. Cross-domain / not done.
- **FQ-14 (a, e)** — (a) a boot-error code instead of English prose needs desktop/main.js to send `{code, raw}`;
  (e) inline `style.*` on the disclosure needs classes in `styles.css` (other lane). Cross-domain.
- **FQ-17** (transcripts persisted in the queue file and the archive) — design change spanning the backend
  normaliser and the K-5/U-020 reveal reconcile (known product decision in BUGSAUDIT-2026-09-04 §6). Not done.
- **FQ-19 (scoped static copy)** — `applyStaticUiCopy(document)` takes a `Document`; scoping it to the empty-state
  node needs a `ui-copy.ts` signature change (other lane). Cross-domain. The rest of FQ-19 is fixed.
- **FQ-22 (5)** (`setBackendBootStatus("")` on the failure path) — desktop/main.js. Cross-domain.
- **S-15** (History audio fetched whole as a Blob) — `fetchSavedAudioFromBackend` at ~2583. Cross-domain.
- **S-16** (Russian marks, absolute paths that retention deletes) — hypothesis ("may be intended for a
  Russian-first product"); changing the mark language changes every pasted transcript, and the "screens
  removed" note is a backend retention change. Not done.
- **U-009** (queue rebuilt via `innerHTML` under aria-live) — known debt (BUGSAUDIT-2026-09-04 §6); FQ-07 removes
  its per-tick trigger, the reconciling render is not done here.

## Cross-domain, for the lead
Import lines: every new module is imported at the top of `main.tsx` (lines ~14–60) — the only edits above
line 9285 in this lane: `./stop-epilogue`, `./upload-item`, `./upload-queue-persist`, `./boot-error`, and
`liveCloseOwesErrorEnvelope` added to the existing `./live-envelope` import. Mechanical on merge.

1. **FQ-04 (P1)** — `main.tsx` `waitForBackendJob` (~4774): treat a rejected poll `fetch`, 5xx and 429 as
   transient (bounded retries on the same 0.9 s / 3 s cadence), 404/other 4xx as terminal; in
   `waitForQueuedLocalJob` / `waitForQueuedRemoteJob` (~4840–4925) call `cancelBackendJob(created.job_id)` in
   the `finally` when the wait ended without a terminal job status and not by abort (abort already cancels).
2. **FL-12 / S-01 (P1 dup of H-01/BM-04)** — renderer: `buildLiveDraftPayload` (~5811) must put
   `recording_collection: liveRecordingCollection(liveRecordingMode)`; `recoverLiveDraftIfAny` (~6003) and
   `recoverBackendAudioSessions` (~5126) must send the draft's collection / nothing instead of the
   `RECORDING_COLLECTIONS.live` literal. Backend: `promote_live_recovery` default `""` so the recovery meta wins;
   WS open stores `screen_session_id` in the meta; `_promote_live_recovery` calls `screen_sessions.adopt_session`.
3. **FL-08** — extract `decodeSavedRecording({name, archiveDir, language, diarize, signal, models})` and call it
   from the Re-transcribe handler (~8988–9200) and stopLive's `recoverFromEmptyTranscriptInner`; Re-transcribe
   should snapshot `diarize` and get the timeout/abort the stop path has.
4. **FL-07** — move `LIVE_ENVELOPE_CONFIRM_MS` / `_DELIVERY_MARGIN_MS` / `_MAX_WAIT_MS` and the inline "short
   recording ≤ 30 s" into `UI_TOKENS.finalize` (`ui-copy.ts`); decide the local-assist envelope budget explicitly
   before routing it through `waitForLiveEnvelopeWithAnnouncedBudget`.
5. **FL-10** — desktop `screen-mode-controller.js`: accept `discard` for an already-finished id (remove the
   staging dir of the last manifest when ids match); then stopLive's startup-abort and all-saves-failed exits
   can discard the kept session.
6. **FL-13** — desktop/main.js: put `discard` (its own `__transcriptorRecordingTooShort()` verdict) in the
   `transcriptor-hotkey-toggle` / `-stop` event detail; the renderer handlers (~13705–13725, this lane) then read
   `detail.discard` instead of re-evaluating `recordingIsTooShortToKeep()`.
7. **FL-20** — backend: `backend/tests/test_live_coverage_policy.py` now duplicates
   `frontend/tests/live-coverage.test.ts` (same ten cases); dropping the Python copy is the backend's call
   (same shape as the `test_mic_health.py` item that BUGSAUDIT-2026-09-04 §6 left to the user).
8. **FQ-03 (a)** — backend: accept a merge PUT (statuses without `text`) or a beacon-authenticated write, so the
   unload flush fits the 64 KiB keepalive budget.
9. **FQ-06 (b, c)** — transport (~4669–4930): give `localJob*`/`remoteJob*` an `onJobCreated` callback (the
   creation POST resolves only after the body is sent); the processor then sets `stage = "processing"` there and
   `_stageCrossoverDelay` / `_stageTimer` (U/K-2) can be deleted.
10. **FQ-12** — `applyRuntimeLimits` (~2255): accept any positive integer the backend reports for
    `uploadParallel` / `persistedItems` (log when clamping).
11. **FQ-14 (a, e)** — desktop/main.js: send boot errors as `{code, raw}` (`PYTHON_MISSING`, `PORT_IN_USE`, …);
    `frontend/src/boot-error.ts` then classifies on the code. `styles.css`: classes for the boot-error
    disclosure to replace the inline `style.*` in `__setBackendBootError`.
12. **FQ-19** — `ui-copy.ts`: let `applyStaticUiCopy` take a `ParentNode` so the empty-queue branch re-applies only
    its own copy.
13. **FQ-22 (5)** — desktop/main.js:7931: do not call `setBackendBootStatus("")` (documented as "boot finished
    successfully") on the Python-missing failure path.
14. **S-15** — `fetchSavedAudioFromBackend` (~2583): stream History playback via `<audio src>` on a short-lived
    URL; keep the File fetch for re-transcribe.
15. **Dead CSS** — `styles.css:3911` `.upload-queue-item-progress-bar.is-determinate` has no producer since FQ-06 (a).

### `fix-journal-backend-archive.md`

## Not done (ID → reason)
- **BL-03** (P2) — log archive pruning: not done, user decision. AGENTS.md rule 3 forbids deleting logs without the user's explicit request, and the fix starts deleting them (it is also desktop code).
- **BM-01** (P1) — `GET /` serves the renderer token unauthenticated. The backend cannot close it alone: refusing the token on `GET /` breaks the app until the desktop shell delivers the token to its window another way. Documented honestly in `cli_access.py` (C7); the fix is listed under Cross-domain.
- **BM-29** (P2) — `*_duration_sec` in the stats are word-count estimates: renaming the fields (or switching semantics) is a contract change with the renderer → Cross-domain.
- **BM-20** (P2, hypothesis) — partly: `TRANSCRIPTOR_CLI_TOKEN` added (C7); `--token` kept, removing a documented flag is an observable behaviour change.
- **BM-21**, non-empty invalid keyfile — kept by the pinned rule `test_a_keyfile_with_content_is_never_replaced` (B-020); only the whitespace case and the false "regenerating" message were fixed (C9).
- **BM-24**, the `retries`-means-attempts naming — the callers are engine modules; resource half fixed (C9) → Cross-domain.
- **BM-13**, upscale model fallback on `"HTTP 404"`/`"not found"` prose and the `http_retry` hint substrings — needs `OpenRouterError.status_code` (engine) → Cross-domain; ffmpeg half fixed (C10).
- **BL-13** (P2, hypothesis, perf) — three directory walks per dictation: unmeasured (no timings in the logs); the redesign it proposes (incremental list cache, retention from the list index) changes cache semantics and has no failing check to prove. BL-14's dedupe (C10) halves the walks on the user's machine.
- **BL-18**, second half (`upload_queue.json` persists item transcripts, 1.58 MB): persisting metadata only would lose the queue's text after the 24 h results sweep — an observable change; left.
- **BL-17** — no separate change: its cause (BL-01's race) is removed in C2; the WARNING now reports a genuinely abnormal state.
- **BM-27** (tests gap) — no own change; closed by the tests added with C3, C4, C5, C8 (adoption with failures, malformed events, CLI scope, recovery of a screen take, divergent mtimes).
- **H-11** (hypothesis, perf) — fixed in C8 without a failing check (behaviour-identical; the per-recording calls went from three to one).

## Cross-domain, for the lead
1. **Renderer (`frontend/src/main.tsx`)** — S-01/H-01/BM-04: add `screen_session_id: liveScreenSessionId` to the `/ws/transcribe` query (`wsQuery`, ~11474); `recoverBackendAudioSessions` (~5126) must stop sending `recording_collection: RECORDING_COLLECTIONS.live` to `/api/live/recoveries/{id}/promote` (send nothing: the sidecar decides); the live-draft snapshot (~5811/~6003) should use `liveRecordingCollection(mode)`.
2. **Renderer** — BM-05: `save-with-audio` and promote now answer `screens_error` (string, "" on success); show it, and do not fall back to `stagedScreenManifest` when it is set (~12682).
3. **Renderer** — BL-16: after a successful `save-with-audio` with `live_session_id`, the extra `POST /api/live/recoveries/{id}/discard` is redundant (the backend now defers/executes the delete itself).
4. **Renderer** — S-17: the comment near `main.tsx:380` restates "newest five" (an env-tunable default).
5. **Renderer** — BL-12: debounce the network-state flip after resume before `scheduleLocalWarmup()` (Whisper loaded ~50×/18 days on wake blips while the provider is Deepgram).
6. **Renderer + backend** — BM-29: rename `avg/min/max_duration_sec` to `estimated_*` on both sides (or read real durations where audio exists).
7. **Desktop + backend + renderer** — BM-01: stop injecting `window.__TRANSCRIPTOR_API_TOKEN` in `GET /` (`backend/main.py` `index`). The desktop shell already knows a per-launch secret (`BACKEND_BOOT_NONCE`, but `/api/health` serves that one publicly, so a new secret is needed): pass the token to the window via preload/IPC (or `loadURL` `extraHeaders` checked by `index`), then remove the injection.
8. **Desktop** — BL-02: create `main.log` with mode 0600 in `appendMainLog`. BL-03 stays a user decision.
9. **Engines** — BL-02: `remote_deepgram_live.py` `_handle_result` logs `text=%r`; the coverage-hole report logs up to `_HOLE_REPORT_TEXT_CHARS` of speech; `deepgram_recovery.py` logs the unplaced decoded words. Drop or gate them.
10. **Engines** — BL-04: `deepgram_warm.py:103` `logging.getLogger("transcriptor.deepgram_warm")` → `__name__` (all warm-pool INFO is invisible today).
11. **Engines** — BL-11: `transcribe_gigaam.py` should remember a failed checkpoint host for a while instead of re-downloading on every trigger (the warmup endpoint now reports it as unreachable instead of 500).
12. **Engines** — BM-13: give `OpenRouterError` a `status_code`; then `upscale_text` (backend/main.py) can fall back on `status_code == 404` instead of prose.
13. **Engines** — BM-24: rename `request_with_retry(retries=…)` to `attempts=` together with its callers in `remote_deepgram.py` / `remote_openrouter.py`.
14. **Live-WS lane (merge note)** — this lane touched the `ws_transcribe` handler in two small places outside the 4560–6030 block: the `finally` now calls `_end_live_session_ownership(session_id, recovery_ctx)` (BL-01) and `_open_live_recovery(...)` gets `screen_session_id=qp.get("screen_session_id") or ""` (S-01). `_open_live_recovery`, `_finalize_live_recovery`, `_recovery_spool_bytes` (BW-13 overlaps) were edited here too.

### `fix-journal-backend-engines.md`

## Not done
- BE-09 (P2, hypothesis) — rivals by overlap instead of midpoint. Measured
  against it: on the trilingual take `ru`'s "Да," (17.14-17.46 s) overlaps the
  `en` stretch ending 17.30 s by 50 % of its duration; an overlap rule at
  `SPLICE_COVERAGE_OVERLAP_FRACTION` (25 %) would remove it when multi wins —
  the exact loss the midpoint rule was chosen to prevent. Needs a rule that
  tells an edge word apart from a duplicate; not a mechanical fix.
- BE-10 (P2, hypothesis) — split a contested run at every language change.
  Measured against it: multi interleaves `lt`/`en`/`uk` tags word by word inside
  ONE hallucinated stretch (trilingual 22.59-24.48 s: і uk, tai lt, Ти en,
  mažaš lt, можеш en, detect en, taip lt …); splitting fragments it into 1-2-word
  runs decided by single-word confidences — the failure BE-01 fixes.
- BE-16 (P2, hypothesis) — three definitions of `uncoveredSpeechSec`. Unifying
  changes the number the renderer reads on every stop shape; needs a decision
  on which definition is the contract (0.25 s floor or not) and a renderer check.
- BE-18 (P2, hypothesis) — the tail-guard retry can exceed the announced budget.
  Deciding the retry only when budgeted would drop tail recoveries that happen
  today; re-announcing needs the renderer's re-armable deadline semantics
  checked. Behaviour change → left.
- BE-20 (c) (P2) — OpenRouter/Deepgram HTTP timeout tiers as one policy: design
  consolidation, no defect observed.
- BE-22 (part) — `_env_int` defined in `transcribe.py` AND `main.py`: the
  `main.py` copy is outside this lane (see cross-domain).
- BE-23 (P2, hypothesis) — GigaAM per-chunk text fallback when other chunks have
  words: changes transcripts; needs a measured chunk-seam case first.
- BW-07 (P2) — polling watchdogs (0.1 s probe, 0.5 s wedge). Correct outcome,
  cost is two wakeups/s; replacing them with an event on the session changes
  wedge latency and every test that patches `_WARM_PROBE_POLL_SEC` /
  `_SEND_WEDGE_POLL_SEC`. Design, not a defect.
- BW-08 (part, hypothesis) — the post-finalize drain is moot with a renderer
  that always sends counts; removing the legacy no-counts branch depends on the
  renderer protocol (frontend main.tsx:12415), left as is.

## Cross-domain, for the lead
- BW-13 (writer half): `backend/main.py` `_record_recovery_chunk` (~4308, outside
  the live-WS block) does an UNBUFFERED `write()` per renderer frame on the event
  loop (`open(..., buffering=0)` at ~4276). Change to a buffered writer flushed by
  `_finalize_live_recovery` (the spool is read back only at finalize, after a flush).
- BL-02 (rest): `backend/main.py:_prune_recording_audio` logs `audio retention:
  removed <file name with the dictation's first words>` → log `entry.stem[:26]`
  (timestamp part) only; `_MutedPollingAccessFilter` should redact the name
  segment of `GET /api/recordings/<name>/audio`; `desktop/main.js appendMainLog`
  should create main.log with mode 0600.
- BE-22: drop `main.py`'s own `_env_int` (~637) and import `backend.transcribe._env_int`
  (or move it to one shared helper module).
- BW-11 / BL-01 interplay: the WS handler (`ws_transcribe`, main.py ~4041-4212,
  outside this lane) runs `_finalize_live_recovery` after the session returns.
  A client-gone session now marks the spool `had_error` so it is retained; BL-01's
  single-owner fix must keep that retention.
- Renderer (no change required for parsing — frontend suite green): the
  envelope's `stats` now also carries `dual_secondary_failed`,
  `dual_duplicates_removed`, `dual_contested_to_secondary`,
  `dual_contested_to_primary`; `stats.dual_stream` now means "the text is a
  merge" (true when the second reading contributed words, even if it later
  failed). BW-01: after a fatal `error` the backend keeps reading audio until the
  renderer's `finalize`; the renderer must keep streaming the mic after a fatal
  (frontend main.tsx:11553-11560 says it does) — worth a live check.
- BL-16: renderer `discardLiveRecovery` after `saveRecordingText` (frontend).
- Live verification not done here: the stop path changes (BW-01, BW-03/BL-09
  abort, BE-05 secondary feeder) are proven by unit tests against fakes; one real
  dictation with dual on (and one with a pulled network cable mid-recording)
  would confirm them end to end.
