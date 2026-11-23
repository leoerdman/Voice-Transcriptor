# Ultra-Audit · DISCOVERY · секция DESKTOP + REPO-PLUMBING

- **Дата:** 2026-09-04
- **HEAD:** `0de0c2d3f09fe3c980c6e849debc70ffad77a52e` («A complete envelope now replaces the live preview…»), версия 1.6.0
- **Рабочее дерево:** `M backend/remote_deepgram_live.py` — чужая правка, другие агенты работают в `backend/`/`frontend/`. Ничего не редактировалось, не коммитилось.
- **Область:** `desktop/**` (main.js 8976 строк, preload, чистые модули и их `node --test`, scripts/, package.json build, entitlements, afterPack), плюс repo-level: `BUILD.command`, `INSTALL*.command`, `.github/`, `.gitignore`, `PROJECT_STRUCTURE.md`/`README`/`CONTRIBUTING` против реальности, requirements-файлы против `desktop/scripts/prepare-runtime.sh`.

## Как проверялось

**Три обязательных прохода, все выполнены.**

1. **HISTORY.** `git log -p -40 -- desktop BUILD.command .github`, плюс `git log -S/-G/-L` и `git show <sha>` для датировки конкретных строк. Каждый кандидат перепроверен `grep` на HEAD — в отчёт попало только живое сейчас. Отдельно: `BUILD.command` и `.github` в этих 40 коммитах **не участвуют** (последние касания — `d675dbb` и `f795293`, заметно раньше); вся работа десктопа за период — `main.js` и выделяемые из него чистые модули.
2. **STRUCTURE.** Карта регионов получена обязательным `grep -n "^async function\|^function\|^const [A-Z_]* =\|^ipcMain\.\|^app\.on" desktop/main.js`; `main.js` прочитан целиком, 43 региона (таблица покрытия). Контракт renderer↔main проверен встречным `grep` каждого из 20 глобалов `window.__transcriptor*`, 6 DOM-id и 3 мостов preload по `frontend/src`.
3. **PRODUCT SCENARIOS.** Сквозные проходы: boot → spawn бэкенда/порт/nonce → окно → хоткеи → toggle → post-stop hand-off (IPC-слот × poll-фолбэк) → лестница вставки по платформам → контракт восстановления буфера → статус/капсула → quit; установка движка; ротация логов; single-instance; sleep/lock; мультидисплей; пути Windows/Linux; сборка и подпись; нотаризация; CI. Швы пройдены отдельно: capability-probe × paste-budget × verification-policy; IPC final × poll fallback × timeout recovery; capsule window × main window focus; warm mic hold × system-suspend IPC; миграция шорткатов × конфиг пользователя.

**Эмпирика, а не оценка:** `npm --prefix desktop test` → `tests 153 / pass 153 / fail 0 / skipped 0`, duration 1907 мс. Оба `osacompile`-теста на этой машине (darwin) реально исполнялись. Ни одна находка ниже не ловится существующими тестами.

**Ограничения, которые обязан назвать.** Аудит статический, на darwin. Ветки win32/linux и путь нотаризации разобраны по коду и документированному поведению внешних инструментов (`cscript //U`, `SetForegroundWindow`, `notarytool`, sandbox `network.server`) — не исполнены. Там, где вывод опирается на поведение внешнего инструмента, это сказано в самой находке. `frontend/src/main.tsx` правился другим агентом во время работы, поэтому его цитаты даются по содержимому, а не по номерам строк.

---

## Таблица покрытия

### `desktop/main.js` — по регионам (обязательная разбивка)

| Регион | Содержание | Статус | Чем проверено | Найдено |
|---|---|---|---|---|
| 1–95 | require-и, SSOT-импорты, `BACKEND_RUNTIME_IMPORTS`, `shortcutDefaultsForPlatform` | reviewed | чтение + встречный grep каждого модуля | чисто |
| 97–138 | `exitAfterFatalMainProcessError`, uncaught/unhandledRejection | reviewed | чтение | чисто |
| 140–234 | `_relocateUserDataOffOneDrive` | reviewed | чтение, разбор маркера миграции | чисто |
| 236–378 | модульное состояние, single-instance | reviewed | чтение | чисто |
| 380–562 | ротация/архивы/`appendMainLog`/`logPasteTrace` | reviewed | чтение + grep потребителей | D-040 |
| 564–671 | `safeExec`, нормализация текста, trace | reviewed | чтение | чисто |
| 673–859 | жизненный цикл главного окна, dock | reviewed | чтение | чисто |
| 861–946 | repoRoot, сигнатура фронтенд-сборки | reviewed | чтение | чисто |
| 948–1042 | зонды рендерера с таймаутом | reviewed | чтение | чисто |
| 1044–1244 | константы капсулы, геометрия, `recordingStatusMode`/`Tone` | reviewed | чтение + прогон всего словаря статусов через оба классификатора | **D-013**, D-012 |
| 1245–1694 | HTML/CSS/JS капсулы (data:, CSP, canvas) | reviewed | чтение целиком | D-012 (мёртвый `.autostop`), H-1, H-5 |
| 1696–1946 | окно капсулы: create/update/hide/teardown, seq-номера | reviewed | чтение | чисто |
| 1948–2107 | монитор записи, автостоп по тишине, stale-frames | reviewed | чтение + grep всех start/stop | **D-017**, D-046, D-050 |
| 2109–2237 | публикация статуса, `dispatchRendererTogglePress` | reviewed | чтение | чисто |
| 2238–2430 | `toggleRecordingFromShortcut` | reviewed | чтение, разбор `keepCapturedTarget` | чисто |
| 2432–2542 | `guardedStopFromRecordingStatus`, `stopRecordingFromMainProcess` | reviewed | чтение, разбор ветки `stale` | **D-017** |
| 2544–2666 | `queryRendererState`, подтверждение старта | reviewed | чтение | D-050 |
| 2668–2837 | цель вставки, `last_transcript.json` | reviewed | чтение | чисто |
| 2839–2953 | политика верификации, статусы отказов | reviewed | чтение + сверка с producer-ами `ERR:` | **D-005**, D-034, D-036 |
| 2955–3218 | Linux X11, macOS `lsappinfo` | reviewed | чтение | **D-041** |
| 3220–3395 | постоянный PowerShell-хелпер | reviewed | чтение протокола FIFO | чисто |
| 3397–3664 | `getFrontmostAppInfo`, активация | reviewed | чтение + сверка трёх сиблингов | **D-006** |
| 3666–3846 | Accessibility trust, capability probe | reviewed | чтение + grep потребителя глобала | **D-009** |
| 3848–3971 | диалоги разрешений | reviewed | чтение | **D-005** |
| 3973–4166 | снимок/восстановление буфера, ref-counting | reviewed | чтение, разбор контракта `verified` | **D-004** (следствие) |
| 4168–4260 | `resolvePasteDestination`, `awaitModifierRelease` | reviewed | чтение | **D-008** |
| 4262–4960 | `runPasteLadder`: win32 / linux / darwin + menu-fallback | reviewed | чтение целиком + сверка с `paste-result.js`, `paste-capability.js`, `paste-script.js` | **D-002**, **D-019**, D-035, D-039, D-042 |
| 4962–5060 | `sendCommandEnterToFocusedApp` | reviewed | чтение, сверка аккордов по платформам | **D-007**, D-047 |
| 5062–5185 | очередь post-stop, два уровня dedup | reviewed | чтение | чисто |
| 5187–5730 | `processPostStopTask`, §6.9-recovery | reviewed | чтение целиком, обе ветки | D-013, H-3 |
| 5732–5824 | `getLatestTranscriptText`, paste-last | reviewed | чтение | D-036 |
| 5826–5989 | `runCommand`, реестр дочерних процессов | reviewed | чтение (кодировки, settleOnce, границы) | вход для **D-002**, D-049 |
| 5991–6317 | выбор Python | reviewed | чтение | чисто |
| 6319–6340 | broadcast boot status/error | reviewed | чтение | чисто |
| 6342–6732 | установка движка, staging-swap, sweep | reviewed | чтение + сверка с `engine-deps.planEngineSitePrune` | **D-010**, D-030, D-043, D-044, D-045 |
| 6734–6893 | `ensureBackendRuntime`, атрибуция импортов | reviewed | чтение | **D-026** (вход) |
| 6895–7121 | `startBackend`, single-flight, рестарт-политика | reviewed | чтение + grep присваиваний счётчика | **D-018** |
| 7123–7183 | `waitForBackendHealth` | reviewed | чтение | чисто |
| 7185–7264 | трекинг загрузки окна, reveal | reviewed | чтение | чисто |
| 7266–8099 | `createWindow`: title-канал IPC, навигация, permissions, страница ошибки | reviewed | чтение целиком, проверка обходов path-traversal | D-037, D-048 |
| 8101–8140 | `window-all-closed`/`browser-window-focus`/`activate` | reviewed | чтение | чисто |
| 8142–8355 | `killBackendHard`, `before-quit`, `process.on("exit")` | reviewed | чтение | чисто, H-4 |
| 8356–8976 | сигналы, `whenReady`: трей, ipcMain, миграции шорткатов, powerMonitor | reviewed | чтение + `git -L` блейм | **D-001**, **D-014**, **D-015** |

### Прочие поверхности

| Область | Статус | Чем проверено |
|---|---|---|
| `desktop/preload.js` + `ipc-contract.test.js` | reviewed | целиком; вся поверхность сверена с `ipcMain`-хендлерами и потребителями во frontend (таблица в D-014/D-030) |
| `paste-result.js`, `paste-script.js`, `paste-verification-policy.js`, `paste-capability.js`, `recording-final-slot.js`, `renderer-console.js`, `accelerator.js`, `engine-deps.js`, `shortcut-defaults.json` | reviewed | все прочитаны целиком; для каждого прослежены call sites в `main.js` |
| 12 файлов `desktop/*.test.js` | reviewed | целиком; суита реально прогнана (153/153); отдельно измерено покрытие сканера `applescript.test.js` на живых исходниках |
| `package.json` build-блок, `afterPack.js`, `afterAllArtifactBuild.js`, `unlockDist.js`, 4 entitlements, `scripts/**` (8 файлов), `build/**` | reviewed | построчно; эффективный конфиг сверен с собранным `dist/mac-arm64/Transcriptor.app` и `builder-debug.yml`; точечно прочитан `node_modules/app-builder-lib` (гейт `identity:null`, слияние `extraResources`) |
| `BUILD.command`, `INSTALL.command`, `INSTALL_ON_OTHER_MAC.command`, `.github/workflows/tests.yml`, `.gitignore`, три requirements-файла, `ENABLE_GIGAAM`, `.nvmrc`/`.node-version` | reviewed | целиком |
| `PROJECT_STRUCTURE.md`, `README.md`, `README.en.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/INSTALL_OTHER_MAC.md` | reviewed | целиком, сверены с `ls`/`grep` по реальному дереву |
| `frontend/src/main.tsx`, `frontend/vite.config.ts` | partial (умышленно) | только как встречная сторона контракта: 20 глобалов, 6 DOM-id, 3 моста, миграции `loadCfg`, `SHORTCUT_DEFAULTS`. Полный аудит фронтенда — вне секции |
| `backend/**` | partial | только `config.py` (не ломает ли read-only lock из afterPack) и сверка сниппета из `docs/INSTALL_OTHER_MAC.md` |
| `desktop/runtime/**`, `package-lock.json`, `.mcode/`, `assets/`, `LICENSE`, `NOTICE.md` | not reviewed | сгенерированные артефакты / не в git / логики не содержат |
| `CHANGELOG.md`, `BUGS_AUDIT*.md`, `docs/*AUDIT*.md`, `docs/COMPARISON*`, `docs/NEXT_SESSION*` | not reviewed как объект | прочитаны как вход (§6, статус, реестр долга) для отсечения закрытого; аудиту не подлежат |

---

# P0

## D-001 · Оба powerMonitor-обработчика вложены в обработчик отмены захвата шортката и на нормальном запуске не регистрируются

**Файл:** `desktop/main.js:8690–8727`, символ `restoreShortcutsAfterCaptureAbort` · **подтверждено**

**Суть.** Блок `powerMonitor.on("resume", …)` и цикл `powerMonitor.on(reason, …)` для `"suspend"`/`"lock-screen"` физически лежат **внутри тела** `restoreShortcutsAfterCaptureAbort(reason)`. Функция вызывается из пяти мест (8685 таймаут захвата, 8899 `capture-cancel`, 7665 `render-process-gone`, 7744 `did-fail-load`, 7886 `window-hide`) и делает ранний выход `if (!shortcutsSuspendedForCapture) return;` — то есть до тела доходит **только если пользователь открыл Settings, начал захват хоткея и прервал его**. В обычной сессии `powerMonitor` не подписан ни на что.

**Как наблюдать.** Запустить приложение, не открывая захват шортката; усыпить и разбудить машину. В `main.log` нет ни `[power] resume — re-registering global shortcuts`, ни `[power] suspend — notifying renderer to release any warm capture`.

**Следствие — два выпущенных исправления мертвы:**

- **BUG-81** «resume hotkey re-claim» (коммит `5dbb006`): после сна глобальные хоткеи, отобранные другим приложением или сброшенные ОС, не переклеймливаются.
- **Warm-mic release на suspend/lock** — заголовочная фича коммита `2868689` («…and a held microphone no longer survives sleep») и релиза **1.6.0**. Рендерер держит тёплый capture, `notifyRendererSystemSuspend` не вызывается, канал `system-suspend` не публикуется, и после сна следующая запись идёт в трек, привязанный к устройству, которого может уже не быть: тишина без ошибки, без волны, без объяснения. Это потеря надиктованного.

Плюс при повторных отменах захвата подписки **накапливаются** (N отмен → N вызовов `registerGlobalShortcuts` на одно пробуждение). Плюс `for (const reason of …)` на 8721 затеняет параметр функции.

**Текущий код**
```js
  function restoreShortcutsAfterCaptureAbort(reason) {
    clearShortcutCaptureFailsafe();
    if (!shortcutsSuspendedForCapture) return;
    shortcutsSuspendedForCapture = false;
    appendMainLog(`[shortcuts] settings capture aborted by ${reason}; restoring registered shortcuts`);
  registerGlobalShortcuts();

  // Re-claim global shortcuts after system resume (BUG-81): …
  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => { … });

  for (const reason of ["suspend", "lock-screen"]) {
    powerMonitor.on(reason, () => {
      appendMainLog(`[power] ${reason} — notifying renderer to release any warm capture`);
      notifyRendererSystemSuspend(reason);
    });
  }
  }
```

**Исправленный код.** Функция закрывается сразу после восстановления:
```js
  function restoreShortcutsAfterCaptureAbort(reason) {
    clearShortcutCaptureFailsafe();
    if (!shortcutsSuspendedForCapture) return;
    shortcutsSuspendedForCapture = false;
    appendMainLog(`[shortcuts] settings capture aborted by ${reason}; restoring registered shortcuts`);
    registerGlobalShortcuts();
  }
```
а подписки регистрируются один раз, после `registerGlobalShortcuts();` на 8916:
```js
  // Re-claim global shortcuts after system resume (BUG-81) …
  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    appendMainLog("[power] resume — re-registering global shortcuts");
    try {
      registerGlobalShortcuts();
    } catch (e) {
      appendMainLog(`[power] shortcut re-register failed: ${e?.message || e}`);
    }
  });
  // Warm-capture release …
  for (const powerReason of ["suspend", "lock-screen"]) {
    powerMonitor.on(powerReason, () => {
      appendMainLog(`[power] ${powerReason} — notifying renderer to release any warm capture`);
      notifyRendererSystemSuspend(powerReason);
    });
  }
```

**Почему это не намеренно.** Отступ выдаёт шов вставки: `registerGlobalShortcuts();` на 8695 — на **2 пробелах**, всё остальное тело функции — на 4. `git show 5dbb006:desktop/main.js` показывает ту же аномалию в момент появления блока: код писался для уровня `whenReady`, но попал внутрь предыдущей функции. Комментарии внутри написаны от лица кода уровня `whenReady` и не описывают отмену захвата шортката. Привязка перерегистрации хоткеев и релиза микрофона к отмене UI-захвата не имеет смысла ни в одной формулировке.

---

## D-002 · `cscript //U` отдаёт UTF-16, детектор успеха ищет UTF-8 → на Windows успешная вставка считается провалом и текст вставляется дважды

**Файлы:** `desktop/main.js:4537`, `desktop/main.js:5957`, `desktop/paste-result.js:73` · **подтверждено по коду** (поведение `cscript //U` документировано; Windows-ветку в этой среде исполнить не мог — сказано прямо)

**Суть.** VBS печатает `WScript.Echo "OK:vbs-paste"` (4512). Запускается с `//U` — «использовать Unicode для перенаправлённого ввода-вывода», то есть stdout в UTF-16LE. `runCommand` безусловно декодирует поток как UTF-8 (5957). Байты `4F 00 4B 00 3A 00 …` дают строку `"O\x00K\x00:\x00v…"`. Детектор:
```js
function isVbsPasteSuccess({ ok, stdout }) {
  return !!ok && outcomeOf(stdout).includes("OK:vbs-paste");
}
```
`.includes("OK:vbs-paste")` на такой строке — **всегда `false`**.

**Как наблюдать.** Статически: сравнить строку, которую production подаёт в `isVbsPasteSuccess`, с той, что подаёт тест `desktop/paste-result.test.js:21` — тест кормит чистый UTF-8 `"OK:vbs-paste"`, форму, которую конвейер физически не производит. На Windows: `traceStep(… "method_begin", {method:"win_paste"})` без последующего `traceEnd(… "success", {method:"vbs_paste"})`, зато с `traceEnd(… "success", {method:"pwsh_paste_fallback"})`, и текст в цели — дважды.

**Следствие.** Каждая удачная VBS-вставка помечается провалом → управление уходит в блок 4567–4605, где PowerShell-фолбэк шлёт **второй** `SendKeys "^{v}"` (и вот он детектируется корректно: `pwshOutcome` ищет просто `"OK:"`, а вывод PowerShell форсирован в UTF-8 прелюдией на 5881). Пользователь получает удвоенный транскрипт. Это ровно тот симптом, что зафиксирован в комментарии 5066–5069 («Telegram screenshot showed duplicated text») и который тогда объяснили двойной постановкой в очередь и закрыли дедупом по `recordingId` — дедуп не мог его закрыть, потому что обе вставки происходят внутри одной задачи.

**Текущий код (4537)**
```js
        const check = await runCommand("cscript", ["//Nologo", "//B", "//U", vbsPath], {
          timeoutMs: pasteMethodTimeoutMs(process.platform, 0),
        });
```

**Исправленный код.** `//U` здесь ничего не даёт — скрипт печатает только ASCII-маркеры, а имя целевого окна уже защищено UTF-16LE BOM самого `.vbs` (4522–4525):
```js
        // No //U: the script's own output is ASCII protocol markers, and
        // //U would make cscript emit them as UTF-16LE while runCommand
        // decodes every child stream as UTF-8 — the "OK:vbs-paste"
        // receipt would then never match (paste-result.js isVbsPasteSuccess)
        // and every successful paste would fall through to the PowerShell
        // fallback, pasting the transcript a second time. The .vbs file
        // itself stays UTF-16LE with a BOM (see the write below), which is
        // what makes non-ASCII window titles work.
        const check = await runCommand("cscript", ["//Nologo", "//B", vbsPath], {
          timeoutMs: pasteMethodTimeoutMs(process.platform, 0),
        });
```
Тест `paste-result.test.js:20–33` обязан получить кейс с реально возможной формой вывода, иначе он и дальше будет зелёным на сломанном конвейере.

**Почему это не намеренно.** Комментарий 4514–4520 объясняет **только** запись файла в UTF-16LE ради кириллических заголовков окон и ни словом не упоминает кодировку stdout. Соседняя ветка (5877–5887) специально форсирует UTF-8 в выводе — то есть в файле уже принято решение «весь вывод дочерних процессов — UTF-8», и `//U` ему противоречит. Шапка `paste-result.js:9–16` описывает `"OK:vbs-paste"` как обычную ASCII-строку.

---

## D-003 · Все dylib и Python-расширения подписываются ad-hoc — Developer ID сборка не может пройти нотаризацию

**Файл:** `desktop/scripts/macos-signing-utils.js:294–304`, символ `preSignRuntimeBinaries` · **подтверждено по коду**; отказ notarytool — **гипотеза высокой уверенности** (нотаризацию не запускал)

**Суть.** Mach-O внутри `Contents/Resources/runtime` подписываются двумя разными идентичностями: исполняемые — запрошенной, всё остальное (`MH_DYLIB`=6, `MH_BUNDLE`=8 — то есть все `*.so` из site-packages и `libpython`) — жёстко ad-hoc `"-"`. И `--options runtime` добавляется только для `executable`.

```js
  const signOne = (filePath, kind) => {
    const signIdentity = kind === "executable" ? identity : "-";
    const args = ["--force", "--sign", signIdentity];
    if (signIdentity !== "-") args.push(timestampArg);
    if (kind === "executable") {
      args.push("--options", "runtime", "--entitlements", entitlements);
      execCount += 1;
    } else {
      dylibCount += 1;
    }
    args.push(filePath);
```

**Как наблюдать.** `TRANSCRIPTOR_SIGNING_IDENTITY="Developer ID Application: …" npm --prefix desktop run dist`, затем `codesign -dv --verbose=4` на любом `.so` внутри `Resources/runtime/python/lib/python3.12/site-packages/` → `Signature=adhoc`, без `flags=…runtime`. Далее `npm run notarize:dmg`.

**Следствие.** notarytool отвергает пакет по каждому такому файлу («not signed with a valid Developer ID certificate» / «does not have the hardened runtime enabled»). Единственный публичный путь релиза — Developer ID + нотаризация, ради которого написаны `isDeveloperIdIdentity`, `--timestamp` и весь `notarize-dmg.sh`, — недостижим. Локально это невидимо: `afterPack.js:311` проверяет только `codesign --verify --deep --strict`, а он ad-hoc подписи принимает.

**Исправленный код**
```js
  const signOne = (filePath, kind) => {
    // Notarization requires EVERY Mach-O (executables, dylibs and Python
    // extension bundles alike) to carry the same Developer ID signature
    // plus the hardened runtime. Ad-hoc is only acceptable when the whole
    // build is ad-hoc.
    const args = ["--force", "--sign", identity, "--options", "runtime",
                  "--entitlements", entitlements];
    if (identity !== "-") args.push(timestampArg);
    if (kind === "executable") execCount += 1; else dylibCount += 1;
    args.push(filePath);
```

**Почему это не намеренно.** `afterPack.js:140` специально вычисляет `runtimeTimestampArg` для Developer ID и передаёт его в `preSignRuntimeBinaries` (`afterPack.js:224–230`) — автор рассчитывал, что рантайм подписывается настоящим сертификатом. Для dylib этот аргумент отбрасывается строкой 297. Комментарий `afterPack.js:217–223` объясняет только *порядок* подписи, не разделение идентичностей.

---

# P1

## D-004 · AX-верификация вставки читает результат без задержки → `verified` не бывает `true` → буфер обмена пользователя не восстанавливается никогда

**Файл:** `desktop/paste-script.js:263–274` (ветка меню) и `:281–289` (ветка `key code 9`) · **подтверждено**

**Суть.** Между действием вставки и чтением длины сфокусированного элемента нет паузы:
```applescript
      tell p
        key code 9 using {command down}
      end tell

      -- Same reasoning as the menu path: the settle allowance lives with
      -- the caller that needs it, not in front of the return.
      log "${PASTE_SENT_PREFIX}robust-paste"
      ${afterRead}
      return "OK:robust-paste" & activationTag & ${verifiedTagExpr}
```
`grep -n "delay " desktop/paste-script.js` даёт только 210 (после активации) и 229 (после AXRaise). `key code 9 using {command down}` — асинхронная посылка события; приложение обработает её позже, поэтому `afterLen - beforeLen` почти всегда `0`, а не `pastedTextLen`, и `pasteVerifiedTag` возвращает `":unverified"`.

Комментарий, оправдывающий отсутствие задержки, к HEAD стал ложным дословно: «nothing this script does afterwards observes the result» — а `${afterRead}` стоит следующей строкой и именно наблюдает результат. Причина известна из истории: коммит `2b8f638` вырезал `delay 0.16`/`delay 0.10`, а следующий, `26d5b4f`, вставил в освободившееся место AX-чтение, не вернув задержку.

**Как наблюдать.** macOS, вставка в TextEdit: в `main.log` `verified=0`, stdout `OK:robust-paste:unverified`, и после двух вставок в одно приложение — `[paste-verification] disabled for app="…" after 2 consecutive unverified pastes`.

**Следствие — двойное.**
1. Верификация, ради которой добавлены `axFocusedValueLength`, `AX_READ_TIMEOUT_SEC`, `verificationAllowanceMs: 1500` и весь `paste-verification-policy.js`, отключает сама себя на любом приложении после двух вставок. Конструкция платит сложностью и латентностью и не даёт сигнала.
2. `scheduleSmartClipboardRestore` (`main.js:4100–4105`) открывает восстановление **только** при `verified === true`. Значит прежний буфер обмена пользователя не восстанавливается никогда — каждая диктовка безвозвратно затирает то, что он копировал. Это ровно та потеря пользовательских данных, которую контракт §6.4/§6.6 должен был ограничить редким случаем.

**Исправленный код** — платить задержку только там, где есть кому её наблюдать:
```js
  // The settle allowance is not "in front of the return" any more: the
  // after-read IS an observer of the paste, and a keycode is delivered
  // asynchronously. Paid only when the read is emitted, so a paste that
  // will not be verified is exactly as fast as it was.
  const settleBeforeAfterRead = wantVerify ? "delay 0.12" : "";
```
и в обеих ветках `${settleBeforeAfterRead}` перед `${afterRead}`. Ветка `click pasteMenuItem` (AXPress синхронна) может остаться без паузы, но тогда это должно быть написано явно, а не унаследовано от комментария, писавшегося, когда после `click` вообще ничего не было.

**Почему это не намеренно.** Шапка `paste-verification-policy.js` приводит измерение: в приложении Claude «AXValue и AXNumberOfCharacters оба падают с -1728» — автор считал `:unverified` признаком **приложения, которое не отдаёт значение**, а не признаком раннего чтения. Модель `entry.unverifiedStreak = 0` при `VERIFIED` прямо предполагает, что успешная верификация возможна.

---

## D-005 · Capability-preflight убрал единственный запрос разрешения Accessibility на macOS

**Файлы:** `desktop/main.js:4298–4303` против `:5629` и `:5811`; классификатор `:2886` · **подтверждено**

**Суть.** До коммита `f37fe55` на машине без Accessibility лестница доходила до AppleScript, тот возвращал `ERR:no-accessibility`, и оба вызывающих места по этой строке звали `scheduleMacPastePermissionsPrompt` → `promptMacPastePermissions`, где `refreshMacAccessibilityTrustState({ prompt: true })` поднимает системный TCC-диалог, а `dialog.showMessageBox` предлагает «Open Privacy Settings». Теперь preflight обрывает раньше и возвращает `reason = "paste-capability-untrusted"`. Статусную строку под новый reason починили (`main.js:2913`), а **триггер диалога — нет**: он по-прежнему ищет `no-accessibility` / `not authorized` / `-1743`.

`grep -n 'paste-capability-' desktop/main.js` → две строки: 2913 (статус) и 4299 (генерация reason). Второго пути тоже нет: загрузочный `checkAccessibility` (`main.js:8451–8454`) зовёт `refreshMacAccessibilityTrustState()` **без** `{ prompt: true }`.

**Как наблюдать.** macOS, свежая установка (или снять Transcriptor из Privacy & Security → Accessibility), записать фразу. В `main.log`: `[paste-capability] WARN: state=untrusted …`, затем `[paste-trace] start_skip reason=paste-capability-untrusted`. Ни одной строки `[permissions] paste prompt`, диалога нет.

**Следствие.** Первый запуск на новой машине больше никогда не показывает системный запрос разрешения. Пользователь видит только строку статуса в капсуле и должен сам дойти до System Settings.

**Исправленный код** — расширить сам классификатор, чтобы обе стороны шва читали одно и то же (`main.js:2886`):
```js
function looksLikeAutomationPermissionError(reason) {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("system events got an error") ||
    r.includes("-1743") ||
    // The capability preflight refuses BEFORE the ladder can produce
    // ERR:no-accessibility, so its verdict has to be recognised here too
    // — otherwise the only macOS permission prompt in the app is dead.
    r.includes(`paste-capability-${PASTE_CAPABILITY.UNTRUSTED}`) ||
    r.includes(`paste-capability-${PASTE_CAPABILITY.BROKEN}`)
  );
}
```
плюс в `promptMacPastePermissions` считать `accessibilityFailure` истинным и для `paste-capability-untrusted`, чтобы маршрут был `"accessibility"` и TCC действительно поднялся.

**Почему это не намеренно.** Тот же коммит специально научил `recordingStatusForPasteFailure` понимать префикс `paste-capability-` — автор осознавал появление нового класса reason, обновил одного потребителя из двух и не тронул второй.

---

## D-006 · На Windows `activateAppByName` рапортует успех, игнорируя собственный ответ скрипта — исправление §6.2 применено к двум веткам из трёх

**Файл:** `desktop/main.js:3485–3488` · **подтверждено**

**Суть.** Скрипт печатает `"1"` при удачной активации и `"0"`, когда процесс не найден или у него нет главного окна (3479–3483). Возврат читается так:
```js
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    if (!res.ok) return false;
    await sleep(350);
    return true;
```
`res.ok` — только «powershell завершился с кодом 0»; ответ `"0"` выбрасывается. Два сиблинга той же лестницы читают его правильно: `activateAppByPid` — `=== "1"` (3524), `activateWindowsWindowByHwnd` — то же (3579), причём у последнего в комментарии 3562–3569 буквально описан этот класс ошибки как исправленный по §6.2.

**Следствие.** Последняя ступень лестницы активации на Windows всегда «успешна». `activateCapturedPasteTarget` (3635–3647) вернёт `true`, даже если ничего не подняли; в `processPostStopTask` ветка `if (!restored) effectiveTarget = emptyCapturedPasteTarget();` (5568) никогда не сработает, и `SendKeys` уйдёт в приложение, которое не удалось поднять — чаще всего в сам Transcriptor.

**Исправленный код**
```js
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], { timeoutMs: 5000 });
    // BUGS_AUDIT §6.2, same rule as activateAppByPid / activateWindowsWindowByHwnd:
    // a zero exit code says PowerShell ran, not that the window came
    // forward. The script writes "1"/"0" precisely so the caller can tell
    // the two apart — read it.
    if (!res.ok) return false;
    if (String(res.stdout || "").trim() !== "1") return false;
    await sleep(350);
    return true;
```

**Почему это не намеренно.** Скрипт специально печатает `"1"`/`"0"`. Два соседних сиблинга читают его. Комментарий в `activateWindowsWindowByHwnd` описывает исправление ровно этого паттерна — правку внесли в две ветки и не довели до третьей.

---

## D-007 · Авто-отправка на macOS шлёт Cmd+Ctrl+Return, а правильный Cmd+Enter недостижим

**Файл:** `desktop/main.js:5030–5058`, символ `sendCommandEnterToFocusedApp` · **подтверждено**

**Суть.** Функция называется «send **Command+Enter**», и её fallback шлёт `key code 36 using command down` — Cmd+Enter, стандартную «отправку» в Telegram, Slack, Messages, Discord. Но первым выполняется:
```js
  const primary = `
    tell application "System Events"
      keystroke return using {command down, control down}
    end tell
  `;
  const res1 = await runCommand("osascript", ["-e", primary], { timeoutMs: 5000 });
  if (res1.ok) {
    return { ok: true, reason: "cmd-ctrl-return-sent" };
  }
```
`keystroke` в System Events успешен всегда, когда есть разрешения: обратной связи о реакции приложения у него нет. Значит `res1.ok` практически всегда истинно, и fallback с корректным аккордом не исполняется никогда — кроме падения `osascript`; а единственная массовая причина падения (нет Automation/Accessibility) отсекается отдельным ранним выходом на 5046–5048.

Разнобой по платформам: win32 — `^{ENTER}` (Ctrl+Enter, 4972), linux — `ctrl+Return` (5000/5008), macOS primary — Cmd+**Ctrl**+Return, macOS fallback — Cmd+Enter. Четыре аккорда на три платформы для одной фичи.

**Как наблюдать.** macOS, включить «Auto-send Enter», продиктовать в Telegram. Текст вставится, сообщение не уйдёт. В `main.log`: `[cmd-enter] … ok=1 reason="cmd-ctrl-return-sent"`, статус капсулы станет `Sent`.

**Следствие.** Фича на macOS не работает в большинстве целевых приложений и при этом рапортует успех — UX-ложь, а не тихий отказ.

**Исправленный код**
```js
  // Cmd+Enter is the "send" chord in every target this feature exists for
  // (Telegram, Slack, Messages, Discord, most web composers).
  // `keystroke`/`key code` give no feedback about whether the target acted
  // on it — a zero exit code only says the event was posted — so there is
  // exactly one attempt and its reason names the chord sent.
  const primary = `
    tell application "System Events"
      key code 36 using command down
    end tell
  `;
  const res1 = await runCommand("osascript", ["-e", primary], { timeoutMs: 5000 });
  if (res1.ok) return { ok: true, reason: "cmd-enter-keycode-sent" };
  return { ok: false, reason: String(res1.stderr || res1.stdout || "cmd-enter-failed").trim() };
```

**Почему это не намеренно.** Имя функции и имя reason-строки fallback-а (`cmd-enter-keycode-sent`) говорят про Cmd+Enter. Комментарий 5040–5045 объясняет, почему fallback бесполезен при отказе разрешений — автор рассуждал о нём как о живой ветке и не заметил, что при успешном `osascript` она недостижима. Cmd+Ctrl+Return не является «отправкой» ни в одном приложении из целевого списка.

---

## D-008 · Ожидание отпускания модификаторов — только для darwin, хотя win/linux дефолт стал трёхмодификаторным аккордом в том же наборе коммитов

**Файл:** `desktop/paste-capability.js:506`; дефолты — `desktop/shortcut-defaults.json` · **подтверждено**

**Суть.** Модуль сам объясняет проблему: хоткей paste-last срабатывает, пока аккорд физически зажат, и синтезированный Cmd+V наследует реальные флаги модификаторов. На Windows это буквальнее: `SendKeys "^{v}"` посылается, пока зажаты Ctrl+Alt+Shift, — приложение получает Ctrl+Alt+Shift+V. Но `planModifierRelease` отсекает всё не-darwin первой строкой, без единого слова о том, почему Windows иммунен:
```js
function planModifierRelease({ platform = "", accelerator = "", trigger = "" } = {}) {
  const none = { needed: false, holdMs: 0, deadlineMs: 0, pollIntervalMs: MODIFIER_POLL_INTERVAL_MS };
  if (platform !== "darwin") return none;
  if (trigger !== "hotkey") return none;
```
При этом `shortcut-defaults.json` задаёт `"default": { "record": "Control+Alt+Shift+R", "paste": "Control+Alt+Shift+V" }` — то есть тот же набор коммитов, что ввёл ожидание, только что **создал** этот класс проблемы там, где его раньше не было (одиночный `F10` модификаторов не имел).

**Следствие.** На Windows/Linux paste-last на дефолтном аккорде отдаёт цели `Ctrl+Alt+Shift+V`, приложение это игнорирует, а `main.log` пишет `ok=true`.

**Исправленный код** — план нужен на всех платформах, различаться должен только механизм ожидания:
```js
  if (trigger !== "hotkey") return none;
  const accel = String(accelerator || "");
  if (!accel.includes("+")) return none;
  // Windows/Linux have no NSEvent.modifierFlags to poll, so they get the
  // fixed floor only: never inject sooner than MODIFIER_HOLD_MS after the
  // hotkey. macOS additionally waits for the flags to actually clear.
  const canPoll = platform === "darwin";
  return {
    needed: true,
    canPoll,
    holdMs: MODIFIER_HOLD_MS,
    deadlineMs: canPoll ? MODIFIER_WAIT_DEADLINE_MS : MODIFIER_HOLD_MS,
    pollIntervalMs: MODIFIER_POLL_INTERVAL_MS,
  };
```
а в `awaitModifierRelease` (`main.js:4238`) при `!plan.canPoll` — `await sleep(plan.holdMs)` вместо spawn; код на этот случай уже есть как fallback при неразобранном выводе JXA.

**Почему это не намеренно.** В шапке раздела написано «The paste-last hotkey (**Alt+Shift+V on macOS**) pastes IMMEDIATELY» — автор рассуждал в терминах macOS-дефолта и не сопоставил с только что изменённым win/linux дефолтом.

---

## D-009 · `__transcriptorAccessibilityStatus` не читает никто: 30-секундный опрос и реплей на каждую загрузку окна работают в пустоту

**Файлы:** `desktop/main.js:3666–3679`, `:7841–7850`, `:8451–8457` · **подтверждено**

**Суть.** Main публикует состояние доверия Accessibility в глобал рендерера. Во всём `frontend/` нет ни одного чтения этого глобала и вообще ни одного вхождения подстроки `accessibility` (`grep -rn "AccessibilityStatus\|accessibilityStatus\|accessibility" frontend/src frontend/index.html frontend/tests` → ноль строк). Симметричный `__transcriptorShortcutStatus` потребителя имеет.

**Следствие.** Половина фичи. Комментарии обещают конкретный интерфейс, которого нет: 8443–8450 «surface the state to the renderer»; 7836–7840 «leaving the **F9-collision badge** and other dependent UI in a stale state»; 8836–8845 описывает бейдж «macOS is intercepting this key». Бейджа нет. `setInterval` на 30 с крутится всю жизнь процесса, каждая смена — межпроцессный `executeJavaScript`. Пользователь, у которого разрешение отвалилось после переустановки (главный сценарий, ради которого написан весь `paste-capability`), узнаёт об этом только по факту неудачной вставки.

**Исправление** — два честных варианта, выбор продуктовый:
1. **Довести фичу.** Рендерер читает глобал там же, где читает `__transcriptorShortcutStatus`, и рисует обещанный бейдж. Это то, что описывают комментарии, и единственный вариант, при котором опрос оправдан.
2. **Свернуть недостижимое.** Убрать инъекцию и реплей, оставить `lastAccessibilityTrusted` как внутренний кэш для лога, а опрос заменить на `browser-window-focus` — `ensurePasteCapabilityFresh` (8114) уже даёт ровно этот момент.

Enterprise-корректный — вариант 1: `paste-capability` уже умеет отличать «грант мёртв» от «гранта нет», не хватает только поверхности.

**Почему это не намеренно.** Три отдельных комментария описывают потребителя в настоящем времени и обосновывают через него и реплей, и интервал. Ни один не помечен как план.

---

## D-010 · «Прунинг» engine-site удаляет только `.dist-info`, сам пакет остаётся и продолжает затенять bundle

**Файл:** `desktop/main.js:6397–6409`, символ `reconcileEngineSiteWithBundle` · **подтверждено**

**Суть.** `engineDeps.planEngineSitePrune` возвращает **имена пакетов**, которые должны исчезнуть из engine-site (`desktop/engine-deps.js:220`, `prune.push(name); // bundle wins`). Реализация удаляет только каталог метаданных:
```js
      const distInfo = `${siteDir}/${spelling}-${staged[name]}.dist-info`;
      try {
        if (fs.existsSync(distInfo)) {
          fs.rmSync(distInfo, { recursive: true, force: true });
          appendMainLog(`[engine-policy] pruned duplicate ${name} (${staged[name]}) — bundle ${bundle[name]} satisfies all declared needs`);
        }
      } catch { /* non-fatal: shadowing risk logged below */ }
```
Каталог пакета (`<siteDir>/numpy/`, `numpy.libs/`, `.so`/`.pyd`) не трогается. А `buildPythonEnv` (6017–6026) **предваряет** `PYTHONPATH` каталогом engine-site — `import numpy` по-прежнему резолвится в копию из engine-site. Ровно то затенение, ради предотвращения которого политика написана.

**Как наблюдать.** После установки движка: строки `[engine-policy] pruned duplicate <name>` в логе есть, каталоги `<name>/` на месте; `python -c "import numpy; print(numpy.__file__)"` из-под `buildPythonEnv` покажет путь внутри `engine-site`.

**Следствие.** Пиннинг релиза не действует для всех пересекающихся пакетов: бэкенд исполняется на версиях из `requirements-gigaam.txt`, а не на протестированных. Это объясняет, зачем понадобился диагностический блок «атрибуции» на 6761–6787 («engine-site is shadowing the bundle») — симптом лечится сообщением, причина остаётся. Плюс лог активно врёт.

**Исправленный код**
```js
  for (const name of prune) {
    let removedAny = false;
    for (const spelling of new Set([name, name.replace(/-/g, "_")])) {
      // The metadata AND the code it describes: removing only the
      // .dist-info leaves the package itself on PYTHONPATH, where
      // buildPythonEnv puts engine-site AHEAD of the bundle — the exact
      // shadowing this policy exists to prevent (BUG-46).
      const victims = [
        path.join(siteDir, `${spelling}-${staged[name]}.dist-info`),
        path.join(siteDir, spelling),
        path.join(siteDir, `${spelling}.libs`),
        path.join(siteDir, `${spelling}.py`),
      ];
      for (const victim of victims) {
        try {
          if (fs.existsSync(victim)) { fs.rmSync(victim, { recursive: true, force: true }); removedAny = true; }
        } catch (e) {
          appendMainLog(`[engine-policy] could not remove ${path.basename(victim)}: ${e?.message || e}`);
        }
      }
    }
    appendMainLog(removedAny
      ? `[engine-policy] pruned duplicate ${name} (${staged[name]}) — bundle ${bundle[name]} satisfies all declared needs`
      : `[engine-policy] WARN: ${name} planned for prune but nothing was removed from ${siteDir}`);
  }
```

**Почему это не намеренно.** Docstring (6382–6389) говорит буквально: «prune every engine-site **copy of a package** the release-pinned bundle also ships». Копия пакета — это его код, не метаданные. Комментарий 6398–6399 («Remove **both spellings** defensively») показывает, что автор думал о каталоге пакета, но подставил суффикс `.dist-info`.

---

## D-011 · `engine-deps` трактует environment marker как разрешение вырезать пакет — нарушен собственный инвариант модуля

**Файл:** `desktop/engine-deps.js:56–58`, символ `parseRequirementLine` · **гипотеза** (воспроизводится напрямую в node, но реальный `METADATA` с маркером в текущем `requirements-gigaam.txt` не проверялся)

**Суть.**
```js
function parseRequirementLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.includes(";") || raw.includes("[")) return null;
```
Doc-комментарий (53–55) утверждает, что маркеры «skipped by the CALLER because they do not constrain this platform» — но, во-первых, они отбрасываются **здесь**, а не вызывающим; во-вторых, «не ограничивают эту платформу» верно лишь для `platform_system`/`platform_machine`/`sys_platform` и неверно для `python_version`, `implementation_name` и прочих, которые на нашей платформе действуют.

Дальше `collectRequirementIndex` такого требования не увидит, `planEngineSitePrune:218–220` получит пустой `specs`, `unsatisfied.length === 0` и уйдёт в `prune`:
```js
    const unsatisfied = specs.filter((s) => !specifierSatisfied(s, bundle[name]));
    if (unsatisfied.length === 0) {
      prune.push(name); // bundle wins: satisfies everyone who cares
```
То есть staged-копия, требуемая под маркером, будет вырезана в пользу bundle-копии, которая требование **не** удовлетворяет.

**Как наблюдать.** Положить в staging `METADATA` со строкой `Requires-Dist: sympy>=1.14; python_version >= "3.11"` и bundle с `sympy 1.12` — `planEngineSitePrune` вернёт `prune: ["sympy"]`, `conflicts: []` вместо конфликта. Воспроизводится в чистом node.

**Исправленный код**
```js
function parseRequirementLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.includes("[")) return null;      // extras: satisfied by installing the extra
  const [head, marker] = raw.split(";");
  const match = head.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
  if (!match) return null;
  const name = match[1].toLowerCase().replace(/_/g, "-");
  const spec = (match[2] || "").trim().replace(/\s+/g, "");
  // A platform-scoped marker does not apply here; anything else we cannot
  // evaluate must be reported, never treated as permission.
  const scoped = /platform_system|platform_machine|sys_platform/.test(marker || "");
  return { name, spec, unevaluatedMarker: !!marker && !scoped };
}
```
и в `planEngineSitePrune` отправлять имена с `unevaluatedMarker` в `conflicts`.

**Почему это не намеренно.** Модуль объявляет: «Every overlapping name is pruned … UNLESS a staged distribution explicitly requires it» и предпочитает громкий отказ догадке (24–27); строкой 189 честно сформулирован правильный принцип для соседнего случая: `// malformed dist-info: absence of declarations ≠ permission`. Тихое отбрасывание маркеров — единственное место, где принцип нарушен.

---

## D-012 · Режим капсулы `autostop` недостижим: автостоп по тишине срабатывает без единого предупреждения

**Файлы:** `desktop/main.js:1208`, `:1390–1398` (CSS), `:1529/1552/1568/1605`, `:1833`, `:2017–2041` · **подтверждено**

**Суть.** Капсула умеет отдельное состояние `autostop` — янтарный индикатор, янтарная волна, продолжающий идти таймер. Оно включается ровно одним способом: если текст статуса содержит `"auto stop"`. `grep -rno "\"[^\"]*[Aa]uto [Ss]top[^\"]*\"" frontend/src desktop/main.js` даёт **единственное** вхождение — сам классификатор на 1208. Ни main.js, ни рендерер такого статуса не публикуют.

При этом механизм живой: `startRecordingStateMonitor` копит тишину (2027–2038) и по достижении `cfg.seconds` зовёт `guardedStopFromRecordingStatus("autostop")`.

**Следствие.** Механика без своей UI-обратной связи: запись обрывается на паузе в мысли без предупреждения и без возможности отменить отсчёт, продолжив говорить. Плюс мёртвый код: CSS-класс, ветка цвета волны, ветка `activeWave`, ветка `timerCanRun`.

**Исправленный код** — публиковать состояние в момент начала отсчёта и снимать при прерывании тишины (`main.js:2027–2041`):
```js
          if (consideredSilent) {
            if (!recordingSilenceStartedAt) {
              recordingSilenceStartedAt = now;
              // The capsule has a dedicated "autostop" mode (amber icon,
              // amber wave, running timer) that nothing ever reached:
              // recordingStatusMode keys it off the substring "auto stop"
              // and no status carried it. Announce the countdown, so a
              // recording is never killed by silence without warning — and
              // so the user can cancel it by speaking again.
              void publishRecordingStatus(`Auto stop in ${Math.ceil(Number(cfg.seconds))}s`).catch(() => { });
            }
            …
          } else {
            if (recordingSilenceStartedAt) void publishRecordingStatus("Recording").catch(() => { });
            recordingSilenceStartedAt = 0;
          }
```
(Строка содержит `"auto stop"` после `toLowerCase()` и попадает в существующую ветку без её правки. Это временно; правильная развязка — D-013. И одновременно надо решить H-1: сейчас клик по капсуле в режиме `autostop` был бы no-op.)

**Почему это не намеренно.** Полный набор оформления состояния — отдельный CSS-класс с анимацией `okHalo`, отдельный цвет волны `rgba(255,196,74,.92)`, отдельное поведение таймера — не пишут для недостижимой ветки. Комментарий 2043–2049 показывает, что автор внимательно работал именно с этим блоком (выносил fail-safe из-под `cfg.enabled`); публикацию статуса просто не добавили.

---

## D-013 · Статус — свободный текст, разбираемый двумя параллельными подстрочными классификаторами; они расходятся между собой и с реальным словарём

**Файл:** `desktop/main.js:1188–1215` (`recordingStatusMode`), `:1217–1243` (`recordingStatusTone`); потребители — 1829 и 1861 · **подтверждено**

**Суть.** Единственный канал состояния капсулы — человекочитаемая строка, из которой машинное состояние добывается двумя независимыми лестницами `includes`/`startsWith`. Прогон реального словаря (12 литералов в `setRecordingStatus`/`publishRecordingStatus` + строки из `recordingStatusForPasteFailure`, `recordingStatusBadgeForPasteFailure`, `recordingStatusForAutoSendFailure`, `pasteCapabilityStatusText`, `handlePostStopTranscriptTimeout` + строки рендерера):

| Статус (где рождается) | `mode` | `tone` | Что не так |
|---|---|---|---|
| `"Starting"` (2314) | `recording` | `neutral` | режим «идёт запись» с нейтральным тоном |
| `"App Loading"` (2282, 2352, 2514) | `fail` | `warning` | расхождение |
| `"Grant Access"` (2344) | `fail` | `warning` | расхождение |
| `"App Not Ready"` (2249) | `transcribing` (default) | `warning` | терминальная ошибка выглядит как обработка |
| `"Mic Not Started"` (2372) | `transcribing` (default) | `neutral` | **терминальная ошибка показывается как «идёт транскрибация»** |
| `"Pasting"` (5762) | `transcribing` | `neutral` | расхождение |
| `"In Clipboard · Accessibility"` (2938) | `fail` | `warning` | расхождение |
| `"Timed out, but transcript is on your clipboard — press X…"` (5725) | `transcribing` (default) | `neutral` | **финальный статус восстановления §6.9 показывается как незавершённая обработка** |
| `"Timed out with no transcript to recover."` (5729) | `transcribing` (default) | `neutral` | то же |

Второй пласт: классификаторы содержат подстроки, которых main.js не производит вовсе — `"recording with "`, `"recording audio only"`, `"recording exceeds "`. Их источник — рендерер (`frontend/src/main.tsx`: «Recording audio only. No transcription provider is selected.», «Recording with live preview enabled.», «Recording exceeds 2 hours — …»). То есть **UI-копирайтинг рендерера де-факто является API капсулы**, продублированным литералами в main.js, без единого теста на стыке.

**Следствие.** Терминальные состояния выглядят как «идёт работа»: пользователь ждёт, ничего не происходит. Правка формулировки в `main.tsx` молча меняет цвет и режим капсулы. Один факт («это провал») закодирован дважды с разными ответами.

**Исправленный код** — убрать разбор строк; состояние передаётся вместе со статусом:
```js
// SSOT for "what state is the capsule in": an explicit kind travels WITH
// the text instead of being re-derived from it by two independent
// substring ladders that had drifted apart (a terminal "Mic Not Started"
// classified as `transcribing`, an "App Loading" that was `fail` to one
// ladder and `warning` to the other). Mode and tone are now two views of
// one value, so they cannot disagree.
const RECORDING_STATUS_KIND = Object.freeze({
  IDLE: "idle", STARTING: "starting", RECORDING: "recording",
  AUTOSTOP: "autostop", TRANSCRIBING: "transcribing", UPSCALING: "upscaling",
  OK: "ok", WARN: "warn", FAIL: "fail",
});
const RECORDING_STATUS_PRESENTATION = Object.freeze({
  [RECORDING_STATUS_KIND.IDLE]:         { mode: "idle",         tone: "neutral"    },
  [RECORDING_STATUS_KIND.STARTING]:     { mode: "recording",    tone: "recording"  },
  [RECORDING_STATUS_KIND.RECORDING]:    { mode: "recording",    tone: "recording"  },
  [RECORDING_STATUS_KIND.AUTOSTOP]:     { mode: "autostop",     tone: "warning"    },
  [RECORDING_STATUS_KIND.TRANSCRIBING]: { mode: "transcribing", tone: "processing" },
  [RECORDING_STATUS_KIND.UPSCALING]:    { mode: "upscaling",    tone: "processing" },
  [RECORDING_STATUS_KIND.OK]:           { mode: "ok",           tone: "success"    },
  [RECORDING_STATUS_KIND.WARN]:         { mode: "fail",         tone: "warning"    },
  [RECORDING_STATUS_KIND.FAIL]:         { mode: "fail",         tone: "error"      },
});
```
и `setRecordingStatus(text, kind)` вместо `setRecordingStatus(text)`, где каждый из ~20 вызовов называет свой kind. Классификатор по подстрокам остаётся ровно одной совместимостной функцией для строк рендерера и покрывается тестом, перечисляющим весь словарь. Как только рендерер начнёт передавать `statusKind` (он уже вычисляет его для себя — `queryRendererState` читает `liveSnapshot?.statusKind` на 2586), совместимостная функция удаляется.

**Почему это не намеренно.** Лестницы копированы дословно (`"recording completed"`, `"final transcript is ready"`, `"recording with "`, `"recording exceeds "` совпадают в обеих). Расхождения (`access` → fail/warning, `loading` → fail/warning, отсутствие `"ready"` в `mode`) — дрейф двух копий: никакой смысл не требует, чтобы статус был провалом по режиму и предупреждением по тону. `AGENTS.md` п.2 прямо запрещает «duplicated logic, or parallel sources of truth».

---

## D-014 · `engine:install` возвращает объект без `phase` на двух путях из трёх — ошибка установки движка проглатывается молча

**Файл:** `desktop/main.js:8393–8404` · **подтверждено**

**Суть.**
```js
  ipcMain.handle("engine:install", async () => {
    const repoRoot = getRepoRoot();
    try {
      const python = await resolvePython(repoRoot);
      if (!python) return { ok: false, status: "no-python", reason: "no usable Python runtime" };
      return await installGigaamEngine(python, repoRoot);
    } catch (e) {
      appendMainLog(`[engine-install] handler error: ${e?.message || e}`);
      return { ok: false, status: "error", error: e?.message || String(e) };
    }
  });
```
Только третий путь возвращает `{ ok, ...engineInstallSnapshot() }`, то есть с `phase`. Потребитель во `frontend/src/main.tsx` (`requestEngineInstall`) ветвится исключительно по `result.phase === "done"` / `=== "failed"`; объявленный там же тип требует `phase` обязательным.

**Как наблюдать.** На машине без пригодного Python нажать Settings → Local models → «Install engine». Не появится никакого статуса; при этом `engineInstallState` станет объектом без `phase`, из-за чего `syncEngineInstallState` перестанет считать `needsWatch`, а `renderLocalModels` получит невалидное состояние.

**Следствие.** Тихо проглоченная ошибка установки + порча состояния рендерера.

**Исправленный код**
```js
      const python = await resolvePython(repoRoot);
      if (!python) {
        setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.FAILED, { reason: "no usable Python runtime" });
        return { ok: false, status: "no-python", ...engineInstallSnapshot() };
      }
```
и симметрично в `catch`.

**Почему это не намеренно.** `installGigaamEngine` в том же файле уже возвращает полный снапшот — два ранних выхода просто не привели к контракту.

---

## D-015 · Миграция win/linux хоткеев есть в main.js и отсутствует в рендерере — Settings и реальность расходятся навсегда

**Файлы:** `desktop/main.js:8614–8632` (Migration 3) против `loadCfg` во `frontend/src/main.tsx` · **подтверждено**

**Суть.** `shortcut-defaults.json:19–22` задаёт `legacy.winLinuxFunctionPair`. Его читает только `main.js:8577–8579` и `shortcut-defaults.test.js:39`; `grep -rn "winLinuxFunctionPair" frontend/` — пусто. Migration 3 в main.js переписывает пару F9/F10 на `Control+Alt+Shift+R/V` **только в памяти** (`readShortcutsFromConfig` возвращает значение и ничего не пишет на диск). Рендерер в своём `loadCfg` реализует миграции 1 (`unpressablePaste`) и 2 (`macFunctionPair`) — win/linux-пары там нет.

**Как наблюдать.** Windows-конфиг с `shortcut_record:"F9"`, `shortcut_paste:"F10"`. Main зарегистрирует `Control+Alt+Shift+R/V`; Settings покажет `F9/F10`; автосейв ui-preferences перезапишет на диск снова `F9/F10`.

**Следствие.** В Settings написан один хоткей, работает другой, состояние не сходится никогда — main мигрирует заново на каждом старте.

**Исправленный код** — зеркальная миграция в рендерере:
```ts
    if (!_isMacRenderer &&
        rawRecord === LEGACY_SHORTCUTS.winLinuxFunctionPair.record &&
        rawPaste === LEGACY_SHORTCUTS.winLinuxFunctionPair.paste) {
      rawRecord = DEFAULT_SHORTCUTS.record;
      rawPaste = DEFAULT_SHORTCUTS.paste;
      didMigrate = true;
    }
```

**Почему это не намеренно.** Комментарий `main.js:8600` у миграции 1 прямо говорит «Mirror the renderer's loadCfg one-time migration» — инвариант «обе стороны мигрируют одинаково» задекларирован, а для §6.10 половину забыли.

---

## D-016 · Префикс `SENT:` определён в двух файлах; расхождение = двойная вставка транскрипта

**Файлы:** `desktop/paste-script.js:102` и `desktop/paste-result.js:66` · **подтверждено**

**Суть.** `paste-script.js:102` — `const PASTE_SENT_PREFIX = "SENT:";`, экспортируется (`:363`). `paste-result.js:66` — `const m = /(^|[\r\n])(SENT:[A-Za-z0-9_.+-]+)/.exec(haystack);` — и `paste-result.js` не импортирует ничего вообще.

**Как наблюдать.** Переименовать маркер в `paste-script.js` на `"PASTED:"`. Оба теста продолжат проходить: `paste-script.test.js` собирает ожидание из того же экспорта, `paste-result.test.js` жёстко пишет `"SENT:robust-paste"` (:60, :96). В проде `pasteSentReceipt` вернёт `""`, `parseMacPasteOutcome` при wall-clock kill во время AX-чтения даст `success:false`, и лестница (`for attempt < maxAttempts`, `main.js:4747`) повторит вставку.

**Следствие.** Ровно тот дефект, ради которого квитанция и появилась: транскрипт вставляется в цель дважды. Ни один тест этого не поймает.

**Исправленный код** (`paste-result.js`)
```js
const { PASTE_SENT_PREFIX } = require("./paste-script");
const SENT_RECEIPT_RE = new RegExp(`(^|[\\r\\n])(${PASTE_SENT_PREFIX}[A-Za-z0-9_.+-]+)`);
```

**Почему это не намеренно.** Шапка `paste-result.js:51` прямо ссылается на скрипт как на источник маркера («The macOS script emits ``log "SENT:<method>"``») — автор считал это одним фактом, но оставил две копии. `PASTE_SENT_PREFIX` экспортируется именно затем, чтобы его импортировали.

---

## D-017 · После «stale stop» монитор состояния записи не перезапускается: капсула, автостоп и защита от мёртвого пайплайна умирают до конца записи

**Файлы:** `desktop/main.js:2516–2520`, `:2035`/`:2058`, `:1955`/`:2080` · **подтверждено по коду** (вход в ветку `stale` требует смены `recordingId` между двумя соседними запросами — редкий, но достижимый)

**Суть.** Автостоп (2034–2037) и клик по капсуле (1789–1791) ставят `recordingStopInFlight = true`, вызывают `stopRecordingStateMonitor()` и уходят в `guardedStopFromRecordingStatus`. Внутри `stopRecordingFromMainProcess` стоп может быть признан устаревшим:
```js
    } else if (result?.stale) {
      appendMainLog(`[recording-stop] stale stop ignored current=… expected=…`);
      await setRecordingStatus("Recording");
    }
```
Запись продолжается, `guardedStop.finish("resolve")` снимает `recordingStopInFlight`, но `startRecordingStateMonitor()` не вызывается. `grep` по всем вызовам: он есть ровно в одном месте — `beginRecordingStatusSession` (2080), которое на этом пути не исполняется.

**Следствие.** До конца записи мертвы все три функции монитора: уровень для волны капсулы (капсула замирает), автостоп по тишине (настройка молча перестаёт работать) и fail-safe по мёртвым аудиокадрам (2050–2061) — тот самый, о котором комментарий 2043–2049 говорит, что без него «a dead mic/worklet left the capsule recording indefinitely with no way out but quitting the app».

**Исправленный код**
```js
    } else if (result?.stale) {
      appendMainLog(`[recording-stop] stale stop ignored current=${Number(result.recordingId || 0)} expected=${Number(result.expectedRecordingId || 0)}`);
      // The recording continues, so the monitor must too: both callers that
      // reach a stale stop (autostop, capsule click) stopped it before
      // calling in, and beginRecordingStatusSession — the only other place
      // that starts it — does not run on this path. Without the restart the
      // capsule level, the silence auto-stop and the dead-pipeline
      // fail-safe all stay dead for the rest of the take.
      startRecordingStateMonitor();
      await setRecordingStatus("Recording");
    }
```

**Почему это не намеренно.** Ветка специально возвращает статус в `Recording` — автор осознавал, что запись живёт дальше; симметричное восстановление монитора пропущено. Ни один комментарий не объясняет, почему мониторинг должен остаться выключенным.

---

## D-018 · Счётчик рестартов бэкенда не обнуляется после успешного авторестарта — потолок в 8 попыток становится бюджетом на всю сессию

**Файлы:** `desktop/main.js:7064–7101`, `:7972–7975` · **подтверждено**

**Суть.** `backendRestartAttempts` инкрементируется на каждом аварийном выходе (7064–7065) и при `attempt > 8` рестарты прекращаются навсегда (7071–7077). Обнуляется он в двух местах: 7100 — только на **чистом** выходе (собственный комментарий 7967–7971 констатирует, что такой «never fires outside shutdown»); 7974 — внутри `createWindow`, после успешного `waitForBackendHealth`. Путь авторестарта (7080–7098) зовёт `startBackend()` напрямую и `createWindow` не переисполняет. `grep -n "waitForBackendHealth("` даёт только 7962 (в `createWindow`) и 8086 (в `pollRecovery`, ветка ошибки).

**Следствие.** Восемь несвязанных, полностью восстановленных падений бэкенда за сессию — и девятое даёт окончательный отказ («giving up») с сообщением «after 8 restart attempts». Задержка бэкоффа тоже растёт монотонно (`Math.min(800 * attempt, 5000)`). Дополнительный вход: `installGigaamEngine` намеренно зовёт `killBackendHard("gigaam-engine-installed")` (6652), чтобы перезапустить бэкенд с новым `PYTHONPATH`, — штатная операция расходует попытку из бюджета.

**Исправленный код**
```js
      backendRestartTimer = setTimeout(() => {
        startBackend()
          .then(async () => {
            appendMainLog("[backend-restart] attempted");
            // Confirm the restart actually produced a healthy backend and
            // clear the attempt counter. Without this the cap above is a
            // per-SESSION budget rather than a per-incident one: the only
            // other resets are a clean exit (which, per the comment above,
            // never fires outside shutdown) and createWindow's health wait,
            // which does not re-run on the restart path.
            try {
              await waitForBackendHealth(`${BASE_URL}/api/health`, 30_000);
              if (backendRestartAttempts !== 0) {
                appendMainLog(`[backend-recovery] healthy after ${backendRestartAttempts} attempt(s); resetting counter`);
                backendRestartAttempts = 0;
              }
            } catch (e) {
              appendMainLog(`[backend-restart] health not confirmed: ${e?.message || e}`);
            }
          })
          .catch((e) => appendMainLog(`[backend-restart-error] ${e?.message || e}`))
          .finally(() => { backendRestartTimer = null; });
      }, delay);
```

**Почему это не намеренно.** Комментарий 7967–7971 описывает ровно эту проблему и заявляет её решённой. Решение поставили в `createWindow`, который на пути авторестарта не исполняется — исправление применено к одной из двух точек, где бэкенд признаётся здоровым.

---

## D-019 · «Все wall-clock границы приходят из ОДНОЙ таблицы» — неверно: активация, зонд и spawn-allowance вне бюджета

**Файлы:** `desktop/main.js:4262–4267` (заявление) против `:3485/3497/3522/3540/3576/3627` (активация, шесть раз `5000`), `:4293` (зонд до `PASTE_PROBE_TIMEOUT_MS = 1000`), `desktop/paste-capability.js:354` (`preflightMs: 500`) и `:561–566` (реальный бюджет ожидания модификаторов = `deadlineMs + MODIFIER_SPAWN_ALLOWANCE_MS` = 500 + 600) · **подтверждено**

**Суть.** Комментарий утверждает: «Every wall-clock bound this function spends comes from ONE table (./paste-capability PASTE_BUDGET), so "how long can a paste take" has a single answer, and a test can check that answer against the deadline». Вне таблицы остались три вещи:

1. **Активация цели.** Внутри каждой итерации лестница зовёт `activateCapturedPasteTarget` (4448 win32, 4646 linux), который спускается в три последовательных `runCommand(..., { timeoutMs: 5000 })`. Плюс `preflightSettleMs`-активация на 4407 до цикла. Худший случай win32: 3 попытки × (до 3 × 5000 мс активации + VBS + PowerShell).
2. **Пред-пастовый зонд.** `ensurePasteCapabilityForPaste()` (4293) в блокирующем случае тратит до 1000 мс; поля `probeMs` в таблице нет.
3. **Spawn-allowance ожидания модификаторов.** `preflightMs: 500` описан как «worst case spent before the ladder starts», но `modifierReleaseCommand` даёт `deadlineMs + 600` = 1100 мс.

Расчёт `pasteBudgetWorstCaseMs` (`paste-capability.js:425–432`) складывает только `attemptDelaysMs`, `preflightSettleMs`, методы и `tailFallbackTimeoutMs`. Тест, который должен это ловить, ловит не то — `paste-capability.test.js:311–314` сравнивает `plan.deadlineMs <= preflightMs`, то есть `500 <= 500`: deadline скрипта, а не бюджет спавна.

**Следствие.** Сегодня прямого ущерба нет — `pasteBudgetWorstCaseMs("darwin")` ≈ 19 435 мс, реальный ≈ 21 035 мс, оба ниже `PASTE_POST_STOP_DEADLINE_MS = 32 000`. Но на Windows с недоступной целью пользователь ждёт вставку значительно дольше расчётного — это часть той самой «лестницы повторов до ≈30 с» из §6.4, которую считали закрытой; а заявленный инвариант ложен, и следующий, кто будет ужимать бюджет, получит неверную цифру.

**Исправленный код** (`paste-capability.js`, в каждую платформенную запись):
```js
    // Every wall-clock bound the ladder spends, including the target
    // activation spawns it makes per attempt (activateCapturedPasteTarget
    // → activateWindowsWindowByHwnd / activateAppByPid / activateAppByName)
    // and the pre-paste capability probe, so worstCasePasteMs is the whole
    // cost and not just the keystroke methods.
    activationTimeoutMs: 1500,
    activationLadderSteps: 3,
    probeMs: PASTE_PROBE_TIMEOUT_MS,
    preflightMs: MODIFIER_WAIT_DEADLINE_MS + MODIFIER_SPAWN_ALLOWANCE_MS,
```
в `main.js` — заменить `{ timeoutMs: 5000 }` в трёх активаторах на `pasteBudgetFor(process.platform).activationTimeoutMs`; в `pasteBudgetWorstCaseMs` добавить `b.probeMs + b.maxAttempts * b.activationLadderSteps * b.activationTimeoutMs`; тест переписать на `assert.ok(modifierReleaseCommand(plan).timeoutMs + PASTE_PROBE_TIMEOUT_MS <= pasteBudgetFor("darwin").preflightMs)`.

**Почему это не намеренно.** Комментарий написан как инвариант, и вся волна paste-capability была про сведение бюджетов в одно место. Активация осталась вне ревизии: её `timeoutMs: 5000` — литералы, унаследованные от кода до появления таблицы (та же константа стоит в `openPrivacyAccessibilitySettings` и в микрофонном диалоге, где к вставке отношения не имеет).

---

## D-020 · `identity: null` делает весь блок подписи в `package.json` мёртвым — расходящаяся правда о том, чем подписано приложение

**Файлы:** `desktop/package.json:96–99` и `:157–160` против `desktop/afterPack.js:92–96` и `desktop/scripts/sign-mas.js:140–141` · **подтверждено**

**Суть.** `mac.identity: null` / `mas.identity: null` заставляют electron-builder полностью пропустить подпись, а вместе с ней — чтение `entitlements`, `entitlementsInherit`, `hardenedRuntime`, `preAutoEntitlements`, `notarize`. Подтверждено в `desktop/node_modules/app-builder-lib/out/macPackager.js:294–297`:
```js
        const qualifier = config.identity;
        if (qualifier === null) {
            return this.helper.handleNullIdentity();
        }
```
`buildSignOptions` (310) и `notarizeIfProvided` (316) недостижимы. Реальные значения задаются заново и независимо, захардкоженными именами файлов в `afterPack.js:92–96` и `sign-mas.js:140–141`.

**Как наблюдать.** Поменять `mac.entitlements` на несуществующий файл и собрать: сборка пройдёт, приложение подпишется прежними entitlements. `dist/builder-debug.yml` не содержит ни одной записи о подписи.

**Следствие.** Два независимых объявления одной истины. Правка `package.json` (очевидное место) молча ничего не делает; чтение `package.json` даёт ложную картину.

**Исправленный код** — один источник; либо убрать мёртвые ключи, либо читать их в хуке:
```js
  // package.json build.mac is the SSOT for entitlements even though
  // identity:null keeps electron-builder itself out of the signing path.
  const buildCfg = context.packager.config;
  const platformCfg = isMas ? (buildCfg.mas || {}) : (buildCfg.mac || {});
  const entitlements = path.join(projectDir, platformCfg.entitlements);
  const inheritEntitlements = path.join(projectDir, platformCfg.entitlementsInherit);
```

**Почему это не намеренно.** `afterPack.js:1–58` подробно объясняет, *почему* подпись отобрана у electron-builder, но нигде не сказано, что ключи в `package.json` оставлены как декорация. `entitlements.mac.plist:32–36` при этом называет себя «SSOT для top-level app».

---

## D-021 · `mac.extendInfo` перетирается хуком — usage-строки продублированы трижды

**Файлы:** `desktop/scripts/macos-signing-utils.js:216–234` против `desktop/package.json:102–103` и `:163–164` · **подтверждено**

**Суть.** `normalizeMacPrivacyUsageDescriptions` безусловно удаляет и заново записывает `NSMicrophoneUsageDescription` и `NSAppleEventsUsageDescription` в `Info.plist` уже после того, как electron-builder положил туда значения из `extendInfo`:
```js
  const microphoneUsage = "Transcriptor records microphone audio when you start a live transcription.";
  plistSetString(infoPlist, "NSMicrophoneUsageDescription", microphoneUsage);
  plistSetString(infoPlist, "NSAudioCaptureUsageDescription", microphoneUsage);
  plistSetString(infoPlist, "NSAppleEventsUsageDescription",
    "Transcriptor uses Apple Events to paste transcripts into the app you are working in.");
```
Микрофонная строка живёт в трёх местах, Apple-Events — в трёх.

**Как наблюдать.** Изменить `package.json:102`, собрать, `plutil -p Transcriptor.app/Contents/Info.plist | grep Microphone` → старый текст из JS.

**Следствие.** Сейчас строки совпадают, дефект латентный. Первая же правка текста разрешения (локализация, требование App Review) не доедет до пользователя и будет выглядеть как «изменение не применилось».

**Исправленный код**
```js
function normalizeMacPrivacyUsageDescriptions(appPath, { extendInfo, log = console.log } = {}) {
  …
  for (const key of ["NSMicrophoneUsageDescription", "NSAppleEventsUsageDescription"]) {
    const value = extendInfo && extendInfo[key];
    if (!value) throw new Error(`build.<platform>.extendInfo.${key} is required`);
    plistSetString(infoPlist, key, value);
  }
  plistSetString(infoPlist, "NSAudioCaptureUsageDescription", extendInfo.NSMicrophoneUsageDescription);
```
с передачей `context.packager.platformSpecificBuildOptions.extendInfo` из `afterPack.js:106`.

**Почему это не намеренно.** Комментарий 236–239 объясняет только *удаление* Camera/Bluetooth; про перезапись микрофона и Apple Events объяснения нет, а `extendInfo` в `package.json` явно задан — автор считал его действующим.

---

## D-022 · `entitlements.mas.plist` не даёт `network.server` — MAS-сборка не сможет поднять локальный бэкенд

**Файл:** `desktop/entitlements.mas.plist:5–20` · отсутствие ключа — **подтверждено**; отказ `bind` в песочнице — **гипотеза** (правило sandbox документировано, MAS-сборку не запускал)

**Суть.** Приложение поднимает uvicorn на loopback (`main.js:365`, `:6034–6051`, `:6053`). В App Sandbox право *слушать* сокет даёт `com.apple.security.network.server`; `network.client` покрывает только исходящие. В файле есть `app-sandbox`, `network.client`, `device.microphone`, `files.user-selected.read-write`, `files.bookmarks.app-scope`, `automation.apple-events`, `cs.allow-jit`, `cs.allow-unsigned-executable-memory` — и нет `network.server`. Дочерний процесс наследует песочницу через `entitlements.mas.inherit.plist:5–8`, то есть тоже без права слушать.

**Следствие.** MAS-ветка нерабочая: `bind()` на 127.0.0.1 упадёт с `EPERM`, приложение уйдёт в экран ошибки бэкенда (`main.js:8011`). Дополнительно `com.apple.security.automation.apple-events` в App Store принимается только как temporary exception с обоснованием — даже собравшись, сборка почти наверняка не пройдёт review.

**Исправленный код**
```xml
	<key>com.apple.security.network.client</key>
	<true/>
	<key>com.apple.security.network.server</key>
	<true/>
```

**Почему это не намеренно.** `entitlements.mas.plist` — единственный из четырёх plist без объясняющего комментария (ср. `entitlements.mac.plist:5–37`, `entitlements.mac.inherit.plist:5–12`). Он выглядит как шаблон типовых MAS-entitlements, в который не заглядывали через призму архитектуры приложения.

---

## D-023 · Дефолт релиза — самоподписанный сертификат конкретного разработчика; `./BUILD.command` неработоспособен на любой другой машине

**Файлы:** `desktop/afterPack.js:73` и `desktop/afterAllArtifactBuild.js:12` — `const DEFAULT_INTERNAL_SIGNING_IDENTITY = "AntigravityTelegramDev";`; применение — `afterPack.js:126–138`; упоминание — `desktop/entitlements.mac.plist:21` · **подтверждено**

**Суть.** Имя ключа стороннего проекта захардкожено в двух файлах и является дефолтом. `BUILD.command` называет себя «one-click macOS release build», собирает `release/` с `SHA256SUMS.txt`, инструкцией и `INSTALL_ON_OTHER_MAC.command` — и нигде не задаёт `TRANSCRIPTOR_SIGNING_IDENTITY` и не предупреждает, что артефакт не нотаризован. Следствие — `INSTALL_ON_OTHER_MAC.command:161,173,216,234`: `xattr -dr com.apple.quarantine "$dmg_path" 2>/dev/null || true`.

**Как наблюдать.** `./BUILD.command` на машине без этого ключа в связке → `afterPack.js:133` бросает исключение, сборка падает. С ключом → `spctl -a -vv -t open --context context:primary-signature <dmg>` → rejected.

**Следствие.** (а) Сборка невозможна ни для кого, кроме владельца keychain-ключа, а CI сборку вообще не выполняет (D-027) — регрессия в упаковке ловится только на одной машине. (б) Публичный релиз распространяется с обходом Gatekeeper, а не с нотаризацией.

**Исправленный код**
```js
// afterPack.js — no built-in identity. Internal builds opt in explicitly.
const requestedIdentity = String(process.env.TRANSCRIPTOR_SIGNING_IDENTITY || "").trim();
const useAdhocIdentity = process.env.TRANSCRIPTOR_ALLOW_ADHOC_SIGN === "1";
if (!useAdhocIdentity && !requestedIdentity) {
  throw new Error(
    "afterPack: set TRANSCRIPTOR_SIGNING_IDENTITY (Developer ID Application: … for public " +
    "releases), or TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1 for a throwaway local build.",
  );
}
```
плюс вынести константу и вычисление `isDeveloperIdIdentity`/`timestampArg` в `scripts/macos-signing-utils.js` (обе копии — см. D-038), и добавить в `BUILD.command` явную ветку «release» (требует Developer ID + `notarize:dmg`) против «internal».

**Почему это не намеренно.** `afterPack.js:44–50` описывает env-переменную как способ «point this at a real Developer ID certificate without editing source» — публичный релиз подразумевается через неё. Но ни один скрипт релиза её не устанавливает и не проверяет. Ни один документ репозитория (`README`, `CONTRIBUTING`, `.env.example`, `docs/INSTALL_OTHER_MAC.md`) имя `AntigravityTelegramDev` не упоминает и не объясняет, где его взять.

---

## D-024 · `disable-library-validation` и `allow-unsigned-executable-memory` уезжают и в Developer ID сборку

**Файлы:** `desktop/entitlements.mac.plist:38–43`, `desktop/entitlements.mac.inherit.plist:13–18` · **подтверждено**

**Суть.** Оба ключа включены безусловно и обоснованы в комментариях только пустым Team ID у самоподписанного сертификата (`entitlements.mac.plist:6–30`). При настоящем Developer ID Team ID непустой, и оба послабления не нужны; `allow-unsigned-executable-memory` существенно шире требуемого Electron `allow-jit`, который присутствует отдельно (40–41).

**Следствие.** Публичный бинарь получает постоянное отключение library validation — любая подгружаемая dylib принимается. Обоснование, записанное в самом файле, к этой сборке не относится.

**Исправление** — развести два профиля вместо одного:
```
entitlements.mac.plist            # Developer ID: allow-jit + audio-input +
                                  # automation.apple-events + network.client
entitlements.mac.selfsigned.plist # + disable-library-validation
                                  # + allow-unsigned-executable-memory
```
и выбирать в `afterPack.js` по уже вычисленному `isDeveloperIdIdentity` (`afterPack.js:131`).

**Почему это не намеренно.** `isDeveloperIdIdentity` уже используется для развилки timestamp (140) и логов (147–149), но не для entitlements — послабление, введённое ради одного сценария, не сняли для другого.

---

## D-025 · Приложение шлёт `app-update.yml` в бандле, хотя апдейтера нет

**Файлы:** `desktop/package.json:8–11` (`repository`), `:151` (`writeUpdateInfo: false`) · **подтверждено**

**Суть.** Ключа `publish` в конфиге нет, но `repository` есть, и electron-builder выводит из него GitHub-провайдер. В собранном бандле лежит `Contents/Resources/app-update.yml` с `provider: github`, при том что `grep -n "autoUpdater\|electron-updater" desktop/main.js` не даёт ни одного совпадения, а `writeUpdateInfo: false` явно гасит вторую половину механизма.

**Следствие.** Половина фичи: метаданные апдейтера кладутся в бандл, метаданные релиза — нет, кода апдейтера нет вовсе. Плюс сборка в CI-окружении с тегом попыталась бы опубликовать артефакты на GitHub Releases.

**Исправленный код** — `desktop/package.json`, в блок `build`: `"publish": null,`

**Почему это не намеренно.** `writeUpdateInfo: false` показывает, что авто-обновление сознательно выключалось; `app-update.yml` — незамеченный побочный эффект `repository`.

---

## D-026 · Три разных набора pin-ов Python-зависимостей; lock вообще не попадает в бандл

**Файлы:** `desktop/scripts/prepare-runtime.sh:212–217` (с lock), `.github/workflows/tests.yml:30` (без), `desktop/main.js:6827` (без, и это уже на машине пользователя) · **подтверждено**

**Суть.** `requirements.txt` намеренно держит диапазоны для пяти прямых зависимостей (`numpy>=1.26.4,<3`, `urllib3>=2.6.3,<3`, `cryptography>=49.0.0`, `httptools>=0.5.0`, `websockets>=13.0`), а точные значения живут в `requirements.runtime-lock.txt` (`numpy==2.0.2`, `urllib3==2.6.3`, `cryptography==49.0.0`, `httptools==0.7.1`, `websockets==15.0.1`) плюс ~50 транзитивных. Lock применяется **только** при сборке бандла.

Хуже: `requirements.runtime-lock.txt` **не попадает в бандл** — `desktop/package.json:81–87` кладёт в `extraResources` только `requirements.txt` и `requirements-gigaam.txt`. Проверено на собранном 1.6.0: в `Contents/Resources/` есть `requirements.txt`, `requirements-gigaam.txt`, `ENABLE_GIGAAM`, lock отсутствует. То есть ремонтная установка (`main.js:6804` «Installing dependencies (first launch)…») **физически не может** применить lock.

**Следствие.** (а) Зелёный CI ничего не говорит о наборе версий, который едет в DMG. (б) Ремонтная ветка может подменить в пользовательском окружении numpy/onnxruntime на версии, с которыми связка `faster-whisper==1.0.3` / `ctranslate2==4.7.1` / `onnxruntime==1.20.1` не проверялась — рантайм-регрессия, а не сборочная.

**Исправление.**
1. `desktop/package.json` `extraResources` — добавить `{"from": "../requirements.runtime-lock.txt", "to": "requirements.runtime-lock.txt"}`.
2. `main.js:6827` → `["-m","pip","install","-c", lockPath, "-r", requirementsPath]` с проверкой наличия lock рядом с `requirements.txt`, как в `prepare-runtime.sh:212`.
3. `.github/workflows/tests.yml:30` → `pip install -c requirements.runtime-lock.txt -r requirements.txt`.

**Почему это не намеренно.** Шапка `requirements.runtime-lock.txt:1–8` объявляет файл ограничениями «для release runtime», `PROJECT_STRUCTURE.md:164` называет его «Release runtime constraints» — он и задуман как описание поставляемого рантайма.

**Отдельно, как проверенное и чистое:** расхождения *между* `requirements.txt` и `requirements.runtime-lock.txt` нет. Политика из `requirements.runtime-lock.txt:5–8` соблюдена без нарушений: точные прямые pin-ы в lock отсутствуют, все пять диапазонных зафиксированы точно.

---

## D-027 · Desktop-суита гоняется на ubuntu — единственные тесты, компилирующие поставляемый AppleScript, в CI не выполняются никогда

**Файл:** `.github/workflows/tests.yml:64–73` · **подтверждено**

**Суть.** `desktop: runs-on: ubuntu-latest`, при этом `desktop/applescript.test.js:202` и `desktop/paste-script.test.js:159` объявлены как `{ skip: process.platform !== "darwin" }`. Продукт поставляется прежде всего на macOS (`BUILD.command:43–45` отказывается собирать не-arm64), автовставка целиком построена на AppleScript. Шапка воркфлоу `:1` утверждает: «Runs every suite the repo ships» — неверно.

**Следствие.** Синтаксическая ошибка в генерируемом AppleScript доезжает до пользователя. Ни один прогон CI никогда не компилировал `robustPasteScript()`.

**Исправление.** `runs-on: macos-latest` для джобы `desktop` (тесты чистые, `npm ci` там и сейчас не нужен), либо матрица `[ubuntu-latest, macos-latest]`.

**Почему это не намеренно.** Оба теста написаны специально для `osacompile` и снабжены развёрнутыми комментариями о том, зачем нужна компиляция (`paste-script.test.js:5–11`); гейт по платформе — защита от локального прогона на Linux, а не решение не проверять их в CI.

Смежно и того же рода: **ни одна джоба не выполняется на macOS и ни одна не трогает релизный путь** — `prepare-runtime.sh`, `afterPack.js`, `macos-signing-utils.js`, `sign-mas.js`, `notarize-dmg.sh`, `build-mas.sh`, `BUILD.command` в CI не запускаются никогда. Именно поэтому D-003 и D-020 могли дожить до сегодня.

---

## D-028 · README (обе локали) документируют хоткеи Windows/Linux, противоречащие SSOT

**Файлы:** `README.md:22, 91–92`, `README.en.md:22, 91–92` против `desktop/shortcut-defaults.json` · **подтверждено**

**Суть.** README указывают `F9` / `F10` для Windows/Linux. SSOT задаёт `"default": { "record": "Control+Alt+Shift+R", "paste": "Control+Alt+Shift+V" }`, а `F9`/`F10` перенесены в секцию `legacy` с абзацем обоснования (конфликт F10 с меню-мнемониками Win32, F9 с отладчиками и Excel). Даты подтверждают направление дрейфа: `shortcut-defaults.json` — 2026-09-03, README — 2026-08-23.

**Следствие.** Пользователь Windows/Linux читает документацию, жмёт F9 — ничего не происходит.

**Исправление.** Привести таблицы к SSOT; лучше — генерировать их из `desktop/shortcut-defaults.json`, который уже читается `frontend/vite.config.ts:46–49` как источник.

**Почему это не намеренно.** Смена дефолтов была осознанной (в JSON лежит абзац обоснования), README просто не тронули.

---

## D-029 · `AGENTS.md` — указатель SSOT ведёт в несуществующий файл

**Файл:** `AGENTS.md:11–13` · **подтверждено**

**Суть.** «Product vision lives in `PRODUCT.md`». `ls PRODUCT.md` → нет такого файла. Реальные — `docs/PRODUCT.md` и `docs/VISION.md`, и какой из них главный, документ не говорит.

**Следствие.** Правило, устанавливающее границы SSOT и адресованное агентам и людям, само указывает на несуществующий путь.

**Исправление.** `Product vision lives in \`docs/PRODUCT.md\` (\`docs/VISION.md\` — the one-paragraph statement it expands)`.

---

# P2

| ID | Файл:строка · символ | Суть | Следствие | Статус |
|---|---|---|---|---|
| **D-030** | `main.js:6515–6519` `broadcastEngineStatus`; `preload.js:18–19` | канал `engine:status` рассылается 4 раза, но preload его не экспонирует, а рендерер осознанно опрашивает (`syncEngineInstallState`: «pull beats push here») | мёртвая ветка; комментарий 6486–6488 объявляет broadcast частью SSOT-контракта — вторая поверхность не существует. Плюс рассылка идёт и в песочничную капсулу | подтверждено |
| **D-031** | `paste-verification-policy.js:56–60` `pasteVerificationKey` | ветка `bundleId` живёт только в юнит-тесте: `grep -c "bundleId" desktop/main.js` → **0** | обещанное «переименованное приложение не обманет память» не выполняется; ключ — отображаемое имя, поэтому два приложения с одним именем делят вердикт | подтверждено |
| **D-032** | `paste-result.js:135–141` против `:143–145`; `main.js:4544` | квитанция `SENT:` есть только на macOS; для `vbs_paste` `sent:false` захардкожен, `stderr` вообще не передаётся | kill `cscript` по 3500 мс между `SendKeys` и `WScript.Echo` (Defender съедает 1–3 с — признано в соседнем комментарии) даёт retry → вторая вставка. Ровно то, ради чего квитанция и сделана | подтверждено |
| **D-033** | `paste-script.js:86`, `paste-verification-policy.js:158`, `main.js:4763` | префикс `AXT:` определён трижды | переименование в скрипте не сломает ни один тест и молча обнулит `axReadMs`/`axReads` — исчезнет измерение, ради которого вводился 0.25 s bound | подтверждено |
| **D-034** | `main.js:4838–4841`, `:2939`, `paste-capability.js:183` | `ERR:secure-field` не эмитит ни один скрипт (`grep -n '"ERR:'` по `paste-script.js`/`main.js`: только `no-accessibility`, `no-process`, `no-focus`, `menu-paste:`, `activate`) | статус «In Clipboard · Secure Field» не покажется никогда; реальная вставка в поле пароля уходит в `paste-return-unknown`. Три площадки + два теста проверяют строку, которую система не производит | подтверждено |
| **D-035** | `main.js:4877–4906` | вторичный menu-paste — второй, ручной экземпляр AppleScript, построчно дублирующий `paste-script.js:168–186` вместе с литералами `ERR:` | не проходит через `safeInt()`/`escapeAppleScriptString` модуля (сейчас безопасен только потому, что `pid` санитизирован выше, на 4420) и не эмитит `SENT:` | подтверждено |
| **D-036** | `main.js:2906` объявление против вызовов `:5637`, `:5811` | второй параметр `recordingStatusForPasteFailure(reason, pasteAccel)` не передаёт ни один вызов | на пути paste-last совет получается круговым: вставка по `Alt+Shift+V` не удалась → статус «— press Alt+Shift+V». Шов для различения вызывающего построен и не использован | подтверждено |
| **D-037** | `main.js:8045` | `cd ~/Downloads/Voice\\\\ Transcriptor` — в JS-литерале это два обратных слэша | инструкция восстановления, которую пользователь копирует в терминал, не работает | подтверждено |
| **D-038** | `afterPack.js:73,131,140` ↔ `afterAllArtifactBuild.js:12,68–69` | продублированы и константа идентичности, и развилка `isDeveloperIdIdentity`/`timestampArg` | оба хука уже импортируют `scripts/macos-signing-utils.js` — обеим копиям место там (`resolveSigningPlan()`) | подтверждено |
| **D-039** | `main.js:4653–4698` | каждый элемент `attempts` создаётся с `timeoutMs: 2000`, после чего `forEach` перезаписывает его из `pasteMethodTimeoutMs` | второй источник правды в теле функции; комментарий 4693–4695 обещает, что литералов больше нет — они остались, просто перезаписываются | подтверждено |
| **D-040** | `main.js:391, 484, 506` `mainLogSizeCached` | присваивается дважды, не читается нигде | мёртвая переменная, намекает на несуществующий кэш размера лога | подтверждено |
| **D-041** | `main.js:3003` `parseLinuxWmClass` | `raw.split(".", 2)` — JS-`split` с лимитом **отбрасывает** хвост: `"org.gnome.Nautilus.Org.gnome.Nautilus"` → instance `"org"`, class `"gnome"` | сопоставление окна для reverse-DNS WM_CLASS (все современные GNOME/Flatpak) деградирует до мусорных ключей, которые `scoreLinuxWindowMatch` взвешивает с весами 400/340. Правильно: `indexOf(".")` + `slice` | подтверждено |
| **D-042** | `main.js:4361` `preferTypedFirst` | `const preferTypedFirst = false;` используется только в собственном trace-логе | мёртвая константа, остаток удалённой стратегии | подтверждено |
| **D-043** | `main.js:6585–6586` | `ENGINE_MIN_FREE_BYTES / (1024 ** 3)` в `Error.message` и захардкоженное `"8 GB needed"` в `userReason` — соседние строки | смена константы меняет одно сообщение и не меняет второе; пользователю показывается второе | подтверждено |
| **D-044** | `main.js:6517` | `for (const win of BrowserWindow.getAllWindows())` затеняет модульную `let win` (237) | ловушка при любой правке тела цикла | подтверждено |
| **D-045** | `main.js:6401` | путь собран строкой `` `${siteDir}/…` `` вместо `path.join` | единственное место в файле, где путь строится вручную | подтверждено |
| **D-046** | `main.js:2082` | `recordingAutoStopConfig = await getRendererAutoStopSilenceConfig();` без проверки `recordingAutoStopConfigGen`, тогда как рефреш в мониторе (2006–2015) её делает | сессия, сброшенная во время await, может получить конфиг предыдущей | подтверждено (гонка узкая) |
| **D-047** | `main.js:4974, 4988–5016, 5035, 5054` | таймауты авто-отправки (`3200`, пять раз `2000`, дважды `5000`) не проходят через `PASTE_BUDGET` | вторая, неучтённая шкала времени на том же пользовательском пути | подтверждено |
| **D-048** | `main.js:8081–8096` `pollRecovery` | `while (win && !win.isDestroyed())` без проверки `isQuitting` и без потолка попыток, шаг 3 с | бесконечный фоновый опрос на ветке отказа бэкенда; `recoveryAttempt` растёт неограниченно и печатается пользователю | подтверждено |
| **D-049** | `main.js`, `runCommand` → `emitLines` | `const at = Date.now() - spawnedAt;` берётся один раз на chunk, а не на строку | если `osascript` сбросит `AXT:before:begin\nAXT:before:end\n` одним куском, `summarizeAxReadTrace` даст `ms: 0` для реально длившегося чтения — портится ровно то измерение, ради которого маркеры введены | гипотеза |
| **D-050** | `main.js:2018` (`1500`), `2055` (`8000`), `2004` (`1200`), `1125` (`700`), `2579` (`slice(-30)`), `5610` (`380`), `4966` (`110`), `3487/3500` (`350`), `3123/3132/3578` (`180`) | голые числа на поведенческих путях без имени | каждое — необъявленный параметр продукта; часть уже описана в комментариях, но не вынесена в константу | подтверждено |
| **D-051** | `main.js:184, 4463–4464, 7539` | комментарии рассуждают про «Electron 30 ships Node 20.x» / «safe in our Electron 30 build», тогда как `package.json:35` пинит `electron: 42.4.1` | обоснование доступности API через версию рантайма, который больше не используется, — подпорка, которая молча переживёт следующий апгрейд | подтверждено |
| **D-052** | `paste-capability.js:436–457` `PASTE_TRANSIENT_TYPE`, `PASTE_TRANSIENT_TYPE_SUPPORTED` | сорок строк комментария, объясняющих, почему `org.nspasteboard.TransientType` не реализуем без нативного аддона, и заканчивающихся «Documented, and skipped»; константы экспортируются, нигде не читаются, тест `paste-capability.test.js:286–287` утверждает, что константа равна себе | комментарий вместо реализации; транскрипты навсегда оседают в истории любого clipboard-менеджера. Либо реализовать, либо убрать константу и оставить запись в реестре долга | подтверждено |
| **D-053** | `preload.js:84–90` ↔ `frontend/src/main.tsx` (`onSystemSuspend`) | preload возвращает unsubscribe, рендерер его отбрасывает; при этом `ipc-contract.test.js:32–36` охраняет наличие `removeListener` фразой «a subscription with no way off leaks across renderer reloads» | тест охраняет механизм, которым система не пользуется | подтверждено |
| **D-054** | `engine-deps.js:87–91` `versionKey`/`compareVersions` | `"1.0rc1"` → `[1, "0rc1"]`; сравнение с `"1.0"` → `[1, 0]` даёт `"0rc1" < "0"` = false → `1.0rc1 > 1.0`, вопреки PEP 440 | bundle на `X.Yrc1` будет признан удовлетворяющим `>=X.Y`, и staged-копия финального релиза окажется вырезана. Тест `engine-deps.test.js:55–59` проверяет только числовые случаи | гипотеза (pre-release в релиз-пинненом bundle сегодня, вероятно, отсутствуют) |
| **D-055** | `accelerator.js:38` | `acc.split("+").map(t=>t.trim()).filter(Boolean)` — `"Control++"` (клавиша `Plus`) → `["Control"]`, регистрируется голый модификатор | модуль объявлен «SSOT boundary every accelerator passes through» (10–13), то есть местом, где неверный ввод должен быть замечен, а не тихо перекроен | гипотеза |
| **D-056** | `main.js:4424` ↔ `paste-script.js:352` | `pastedTextLen` считается как `String(text).length` (единицы UTF-16), а `count of` в AppleScript — символы Unicode | любой символ вне BMP (эмодзи) ломает сверку длины → `:unverified` → после двух подряд политика вообще выключает верификацию для приложения. Правильно: `[...String(text || "")].length` | гипотеза |
| **D-057** | `macos-signing-utils.js:133–144` `hasSigningIdentity` | любая ошибка (`execSync` со строкой, заблокированный keychain, отсутствие `security`) превращается в «идентичности нет»; сравнение — `includes`, а не точное | пользователю с правильно заданной `TRANSCRIPTOR_SIGNING_IDENTITY` выдаётся совет её задать. Плюс ложное совпадение для имени-подстроки | подтверждено |
| **D-058** | `macos-signing-utils.js:306–319` | retry-цикл ×5 вокруг `codesign`, каждая итерация молча зовёт `--remove-signature` и `xattr -d` (пустые `catch`, 279–281 и 288–291), stderr предыдущих попыток отбрасывается; `sleepMs` — блокирующий `Atomics.wait` | цикл всё-таки кидает на пятой попытке, поэтому P2, но диагностика теряется полностью | подтверждено |
| **D-059** | `unlockDist.js:11,22` | `catch { return; }` не различает `ENOENT` и нечитаемое поддерево | обход тихо обрывается, падение приходит позже из electron-builder без указания на причину. Костыль сам по себе следствие `afterPack.js:301` (chmod `0o555`/`0o444`), из-за которого нужны ещё `chmod -R u+w … \|\| true` в `BUILD.command:17` и `prepare-runtime.sh:122` | подтверждено |
| **D-060** | `notarize-dmg.sh:84` | `xcrun notarytool log … \| tee "$LOG_PATH" >&2 \|\| true` при `set -euo pipefail` гасит весь конвейер | при отказе нотаризации скрипт сообщит «did not succeed: Invalid» без причины и без указания, что лог получить не удалось | подтверждено |
| **D-061** | `BUILD.command:146` против комментария `:180–184` | комментарий утверждает, что install kit уже содержит internal-zip и потому корневую копию можно удалить; kit собирается на `:151–157` из DMG, инсталлятора, документа и манифеста — zip туда не кладётся, зато `:146` копирует его в `release/` целиком | `ls -la desktop/dist/release`: DMG 248 МБ + internal.zip 257 МБ + install.zip 247 МБ ≈ 752 МБ вместо обещанных ~470 МБ. Ровно «три полные копии одной версии», которых комментарий обещал избежать | подтверждено |
| **D-062** | `BUILD.command:176` | имя документа захардкожено (`"INSTALL_OTHER_MAC.md"`) там, где путь резолвится динамически на `:121–122` | комментарий `:117–120` прямо говорит, что имя уже разъезжалось «в шести местах» и его свели в переменную — в список `shasum` попал литерал. Должно быть `"$(basename "$INSTALL_DOC")"` | подтверждено |
| **D-063** | `prepare-runtime.sh:42` | `FFMPEG_MAC_ARM64_URL="https://www.osxexperts.net/ffmpeg71arm.zip"` — единственный из трёх платформенных URL без версии в имени (win — `autobuild-2026-06-18-14-21`, linux — `ffmpeg-7.0.2-amd64-static.tar.xz`) | подмена бинаря закрыта пинненым SHA256, но в день обновления файла на сайте **каждая** сборка macOS-релиза упадёт на checksum mismatch, и починка требует ручного пересчёта хеша с непроверяемого источника | подтверждено (когда сломается — гипотеза) |
| **D-064** | `prepare-runtime.sh:238` | `find … -name "ffmpeg.exe" -exec cp {} …` — при нескольких совпадениях побеждает последнее | для macOS (`:264–274`) и linux (`:301–309`) эта ситуация обработана явно, для Windows — нет | подтверждено |
| **D-065** | `desktop/scripts/generate-dmg-background.py` | `grep -rn "generate-dmg-background"` по всему репозиторию — **ноль** ссылок; импортирует PIL, которого нет ни в одном requirements-файле; захардкожены `/System/Library/Fonts/SFNS.ttf`, строка «Install for macOS Sonoma» и координаты `(178, "APP")`/`(482, "APPLICATIONS")`, дублирующие `package.json:139–149` | мёртвый скрипт с недекларированной зависимостью и продублированной геометрией DMG. `PROJECT_STRUCTURE.md:135–141` перечисляет 6 скриптов из 8 — этого и `notarize-dmg.sh` там нет | подтверждено |
| **D-066** | `desktop/package.json:84–91` ↔ `:116–122` ↔ `:207–214` ↔ `:228–235` | `../requirements-gigaam.txt` и `../ENABLE_GIGAAM` перечислены четырежды; проверено по `app-builder-lib/out/fileMatcher.js:251–253`, что списки **складываются**, а не заменяются | чистое мёртвое дублирование — каждый файл копируется дважды в один путь; четыре места надо править синхронно, причём `mas` (`:166–176`) их не содержит вовсе | подтверждено |
| **D-067** | `.gitignore:80` (`desktop/build/`) ↔ `package.json:135` (`"background": "build/dmg-background.png"`) | `git check-ignore -v --no-index desktop/build/dmg-background.png` → игнорируется; файл выживает только как уже отслеживаемый (`git ls-files -i -c` показывает его) | любой новый или перегенерированный ассет в этом каталоге git не покажет. Нужно `!desktop/build/dmg-background.png` | подтверждено |
| **D-068** | `.gitignore:13` (`.python-version`), `:29` и `:78` (дубль `desktop/dist/`), `:75` (`!desktop/scripts/prepare-runtime.sh` — мёртвое отрицание: предыдущий паттерн `desktop/runtime/` этот путь не покрывает никогда), `:102` (`.claude/` при отслеживаемом `.claude/launch.json`) | четыре дефекта игнор-файла | главный — `:13`: Node-версия зафиксирована коммитом (`.nvmrc`, `.node-version`), а Python-версии быть зафиксированной **запрещено**, что блокирует лечение D-069 | подтверждено |
| **D-069** | `prepare-runtime.sh:32` (`PBS_PYVER="3.12.13"`), `:181, :187, :205, :324, :334, :346`; `tests.yml:24`; `main.js:8026`; `CONTRIBUTING.md:27`; `AGENTS.md:19` | Python 3.12 захардкожен в девяти местах без единого источника; SHA256 трёх тарболов (`:126–142`) привязаны к паре `PBS_TAG`/`PBS_PYVER` без проверки согласованности | бамп минорной версии требует девяти согласованных правок; при рассинхроне сборка падает громко («could not find site-packages»), а CI продолжает тестировать на старой версии. Лечится файлом `.python-version` — который сейчас запрещён `.gitignore` (D-068) | подтверждено |
| **D-070** | `BUILD.command:63,70–71`; `notarize-dmg.sh:46–47`; `sign-mas.js:130`; `INSTALL_ON_OTHER_MAC.command:17–18`; `docs/INSTALL_OTHER_MAC.md:12` | имена артефактов и путей вывода electron-builder воспроизведены пятью независимыми строками; `artifactName` в конфиге **не задан** — все полагаются на дефолтный шаблон | смена `productName` или дефолта апстримом ломает релиз на «Built DMG not found» (`BUILD.command:109–112`). Контраст: `afterPack.js:85` делает правильно — `context.packager.appInfo.productFilename` | подтверждено |
| **D-071** | `tests.yml` целиком (96 строк) | нет ни `permissions:`, ни `concurrency:`; отсутствует объявленная в `AGENTS.md:47` обязательной проверка `node --check desktop/main.js && node --check desktop/preload.js` | токен джобы получает дефолтные права репозитория; параллельные пуши не отменяются; 376 КБ `main.js` синтаксически не проверяются нигде (`packaging.test.js` читает его как текст, не парсит как модуль) | подтверждено |
| **D-072** | `AGENTS.md:26` («368 tests»), `:46` (перечень desktop-сьютов), `CONTRIBUTING.md:138–139`, `PROJECT_STRUCTURE.md:7–26/38–60/77–98/113–141` | документация разошлась с деревом: `grep -c "^    def test_" backend/tests/*.py` → **484** метода в 43 файлах; desktop-сьютов не 3, а 12; «Сборка DMG» указывает на `dist:dir`, который DMG не собирает (нужен `dist`); «Полная проверка как в CI» перечисляет только frontend-команды; все четыре дерева в `PROJECT_STRUCTURE.md` неполны (нет `AGENTS.md`, `CONTRIBUTING.md`, `README.en.md`, `NOTICE.md`, `ENABLE_GIGAAM`, `.github/`, `assets/`; в backend нет `audio_mime.py`, `deepgram_format.py`, `model_catalog.py`; во frontend — `live-pane.ts`, `live-source.ts`, `shortcut-display.ts`, `transcription-catalog.ts`; в desktop из 12 тестов перечислен один) | файл начинается словами «This file documents the current source layout» | подтверждено |
| **D-073** | `README.md:58–61`, `README.en.md:57–60` | «сборки подписываются ad-hoc» — дефолтный путь `./BUILD.command` → `npm run dist` ad-hoc **не** использует: `afterPack.js:129` требует `TRANSCRIPTOR_ALLOW_ADHOC_SIGN=1`, который выставляет только `dist:adhoc` | без сертификата сборка не ad-hoc-подписывается, а падает (следствие D-023) | подтверждено |
| **D-074** | `desktop/paste-script.test.js:156` | в исходнике **сырой байт 0x00** (проверено: NUL на байте 6861, `file` → `data`) вместо escape-последовательности: `assert.equal(escapeAppleScriptString("a\0b"), "ab");` | git считает файл бинарным (`git show --stat` → `Bin 6213 -> 7700 bytes`), `git log -p` бесполезен, code review невозможен, `grep` требует `-a`; форматтеры могут его потерять, и утверждение «управляющие символы вырезаются» останется зелёным, ничего не проверяя. Правильно: `"a\x00b"` | подтверждено |
| **D-075** | `ipc-contract.test.js:46–56` | `/exposeInMainWorld\([^)]*ipcRenderer\s*\)/` не пересекает `)`, поэтому реальную утечку `exposeInMainWorld("bad", { raw: ipcRenderer })` не ловит; цикл по `match(...) \|\| []` без anti-zero guard пройдёт вхолостую, если preload перейдёт на обёртку; не покрыты `once`, `sendSync`, `postMessage`, `sendTo` | security-тест, который может пройти, ничего не проверив. Контраст: `applescript.test.js:171–181` защищается явным `assert.ok(scripts.length >= 4)` | подтверждено |
| **D-076** | `ipc-contract.test.js:39–44` | `assert.match(mainSource, /for \(const reason of \["suspend", "lock-screen"\]\)/)` — привязка к точному форматированию исходника | любое переформатирование уронит тест ложно; проверять надо факт, а не текст. Отдельная ирония: тест зелёный, при том что этот цикл недостижим (D-001) — он проверяет наличие строки, а не регистрацию обработчика | подтверждено |
| **D-077** | `paste-capability.test.js:218–226, 254–268` | тест переизлагает формулу самой функции (`b.methodTimeoutsMs[0] + b.verificationAllowanceMs`) и проверяет `pasteBudgetWorstCaseMs`, которая нигде, кроме теста, не вызывается | если обе стороны неверны, тест зелёный; проверяется модель, а не система (см. D-019). Лечится абсолютными числами | подтверждено |
| **D-078** | `shortcut-defaults.test.js:23–37` | `assert.notEqual(record, "F9")` пропустит `record: "F10"`; тест назван «3+ modifier chords», но проверяет `parts.length >= 3` (2 модификатора + клавиша); не проверено, что новые дефолты не равны `legacy.unpressablePaste` | слабые утверждения на SSOT, от которого зависит работоспособность хоткеев | подтверждено |
| **D-079** | `packaging.test.js:65–81` | `positiveWhitelist()` отбрасывает `!`-паттерны, хотя electron-builder применяет их по порядку; самодельный `coveredByWhitelist` понимает только точное имя и `dir/**` | сегодня ложного прохода нет (единственный негативный паттерн — `!runtime/**/*`), риск отложенный; реальные glob-ы (`*.js`, `**/*.json`) тест посчитал бы непокрытыми и уронил бы сборку ложно | гипотеза |
| **D-080** | весь signing/packaging-код | `packaging.test.js` — единственный тест этой поверхности, и он проверяет ровно две вещи (покрытие `build.files` графом `require`, совпадение версий desktop/frontend). `afterPack.js`, `afterAllArtifactBuild.js`, `unlockDist.js`, `macos-signing-utils.js`, `sign-mas.js` не покрыты ничем, хотя чистые функции `classifyMacho`, `shouldIgnoreOsxSignPath`, `pathIsInside`, `assertNoBundledBytecode` экспортируются и тестируемы без macOS | D-003 и D-020 не мог поймать никакой автоматический контроль | подтверждено |
| **D-081** | `shortcut-defaults.json:2` | ключ `_comment` длиной ~740 символов попадает в продакшн-бандл рендерера через `frontend/vite.config.ts:94` (`__SHORTCUT_DEFAULTS__: JSON.stringify(SHORTCUT_DEFAULTS)`) | комментарию место в тесте или в md | подтверждено |
| **D-082** | `renderer-console.js` ↔ `main.js:7656` | зеркало не имеет ни rate limit, ни дедупликации; обосновано тем, что warn/error «low volume by definition» | рендерер в цикле `console.error` (ретраи fetch) даст неограниченный **синхронный** `appendMainLog` ровно на латентно-критичном пути, которого модуль в случае трейсов избегает флагом | гипотеза |
| **D-083** | `require-bash.js` ↔ `package.json:23,25,30,31` | гард подключён только к `dist:win`; `dist`, `dist:adhoc`, `dist:linux` зовут `bash` напрямую | на macOS не проявляется; для кросс-хостовой сборки — асимметрия без причины | подтверждено |
| **D-084** | `engine-deps.js:176–178`; `paste-verification-policy.js:184` | незавершённая правка комментария (строка `//` внутри блока `/** */`); незавершённые чтения дописываются в `reads` в конце, ломая хронологию массива в трейсе | косметика | подтверждено |

---

## Индекс «костыли / workarounds»

Прямых маркеров `TODO`/`FIXME`/`HACK`/`XXX` в `desktop/*.js` и `BUILD.command` **нет** (`grep` даёт три вхождения, все — описания механики: «temporary .vbs script» на `main.js:4433`, «the canonical workaround» на `:7369`, «placeholder» на `paste-script.js:143`). Долг спрятан не в маркерах, а в швах:

1. **Title-канал как IPC** (`main.js:7367–7510`, `:1780–1798`). `document.title = "__app_<verb>__<payload>"` вместо `ipcRenderer`, потому что окно в песочнице. Ограничен закрытым списком глаголов, защищён от path-traversal — сделано аккуратно, но остаётся обходом. **Корень:** у капсулы нет preload; у главного окна preload есть, и три из четырёх глаголов могли бы быть обычными `ipcRenderer.send`, как уже сделано для `recording-final`.
2. **`executeJavaScript`-опрос как API рендерера** — ~20 глобалов `window.__transcriptor*` и 6 DOM-id. Poll-фолбэк в `processPostStopTask` — наследие §6.7; IPC-слот сделан, но старый путь оставлен целиком и живёт параллельно. Плюс `getRendererProviderChoice`/`getRendererLocalModelChoice` читают `document.getElementById('providerSelect').value` — main-процесс парсит DOM рендерера как источник конфигурации.
3. **Постоянный PowerShell-хелпер** (`main.js:3220–3395`) — обход стоимости `Add-Type` на каждый вызов. Инженерно оправдан; фиксирую как долг: живой дочерний процесс PowerShell на всё время работы приложения.
4. **Два уровня дедупликации вставки** (`_enqueuedRecordingIds` + `_pastedRecordingIds`) — «belt-and-braces» по признанию комментария 5171–5175, потому что первопричину (две точки входа с раздельными in-flight-флагами) не устранили. См. D-002: настоящий источник наблюдавшегося дублирования на Windows лежит вообще не здесь.
5. **`//U` у cscript** (D-002) — костыль под кириллические заголовки окон, поставленный не туда: за кодировку файла уже отвечает BOM.
6. **Ветка `stale` в `stopRecordingFromMainProcess`** (D-017) — компенсация того, что два входа в стоп не сериализованы.
7. **Блок «атрибуции» сломанных импортов** (`main.js:6761–6787`) — повторный прогон импорта в чистом окружении, чтобы понять, виноват ли engine-site. Симптом D-010: если бы прунинг работал, затенения бы не было.
8. **`unlockDist.js` + `chmod -R u+w … || true` в двух скриптах** (D-059) — обход read-only, который сам же `afterPack` и ставит.
9. **`xattr -dr com.apple.quarantine` в четырёх местах инсталлятора** (D-023) — обход Gatekeeper вместо нотаризации.
10. **`preferTypedFirst = false`** (D-042) — вырожденный флаг вместо удаления ветки.
11. **`activateAppByName` возвращает `true` безусловно** (D-006) — работает как оптимистичная заглушка.
12. **«Documented, and skipped»** (D-052) — сорок строк комментария вместо реализации, закреплённые тестом-тавтологией.

---

## Индекс «хардкод → SSOT»

| Что продублировано | Где | Куда свести |
|---|---|---|
| Классификация статуса записи | `main.js:1188–1215` и `1217–1243` | одна карта `kind → {mode, tone}` (D-013) |
| Словарь статусов рендерера | `main.js:1202–1204, 1231–1233` ↔ строки в `frontend/src/main.tsx` | явный `statusKind` в пейлоаде (D-013) |
| Префикс `SENT:` | `paste-script.js:102` ↔ `paste-result.js:66` | импорт `PASTE_SENT_PREFIX` (D-016) |
| Префикс `AXT:` | `paste-script.js:86` ↔ `paste-verification-policy.js:158` ↔ `main.js:4763` | импорт `AX_TRACE_PREFIX` (D-033) |
| AppleScript разрешения процесса | `paste-script.js:168–186` ↔ `main.js:4877–4906` | `menuPasteFallbackScript()` в модуле (D-035) |
| Миграция win/linux хоткеев | `main.js:8614–8632`, в рендерере отсутствует | обе стороны читают `legacy.winLinuxFunctionPair` (D-015) |
| Таймауты активации цели | `main.js:3485, 3497, 3522, 3540, 3576, 3627` — шесть раз `5000` | `PASTE_BUDGET.activationTimeoutMs` (D-019) |
| Зонд + spawn-allowance в бюджете | `main.js:4293`, `paste-capability.js:354` vs `:561–566` | `probeMs`, исправленный `preflightMs` (D-019) |
| Таймауты Linux-каскада | `main.js:4659–4689` — `2000`, затираются | удалить литералы (D-039) |
| Таймауты авто-отправки | `main.js:4974, 4988–5016, 5035, 5054` | та же таблица `PASTE_BUDGET` (D-047) |
| Аккорд «отправить» | четыре разных: `main.js:4972`, `5000/5008`, `5032`, `5051` | один аккорд на платформу, объявленный в одном месте (D-007) |
| Минимум свободного места | `main.js:6585` (из константы) и `:6586` (`"8 GB needed"`) | одно форматирование из `ENGINE_MIN_FREE_BYTES` (D-043) |
| entitlements-файлы | `package.json:96–97, 157–158` (мёртво) ↔ `afterPack.js:92–96` ↔ `sign-mas.js:140–141` | package.json как SSOT, читаемый хуком (D-020) |
| usage descriptions | `package.json:102–103, 163–164` (мёртво) ↔ `macos-signing-utils.js:227, 233` | `extendInfo` как SSOT (D-021) |
| signing identity | `afterPack.js:73` ↔ `afterAllArtifactBuild.js:12` ↔ `entitlements.mac.plist:21` | env-переменная, без дефолта (D-023, D-038) |
| `isDeveloperIdIdentity`/`timestampArg` | `afterPack.js:131,140` ↔ `afterAllArtifactBuild.js:68–69` | `resolveSigningPlan()` в `macos-signing-utils.js` (D-038) |
| Python 3.12(.13) | 9 мест (D-069) | `.python-version` — сейчас запрещён `.gitignore:13` (D-068) |
| Pin-ы зависимостей | `prepare-runtime.sh:212–217` (с lock) ↔ `tests.yml:30` ↔ `main.js:6827` (оба без) | lock во всех трёх + в `extraResources` (D-026) |
| Имя артефакта DMG | 5 мест, `artifactName` не задан вовсе | закрепить шаблон в `package.json` (D-070) |
| appId `local.transcriptor.app` | `package.json:40` ↔ `INSTALL_ON_OTHER_MAC.command:20` ↔ `README.md:136` / `README.en.md:143` | манифест |
| productName `Transcriptor` | `package.json:41` + 10 копий | `appInfo.productFilename`, как уже делает `afterPack.js:85` |
| Порт 8321 | `main.js:365` (назван SSOT) ↔ `.env.example:12` ↔ `README.md:137` ↔ `README.en.md:146` | `.env.example` по правилу `AGENTS.md` п.4 |
| copyright | `package.json:39` ↔ `:101` ↔ `:162` | один ключ |
| Геометрия DMG | `package.json:138–150` ↔ `generate-dmg-background.py:115,122–127` | генератор читает манифест (D-065) |
| `extraResources` gigaam-файлов | `package.json:84–91, 116–122, 207–214, 228–235` | только top-level (D-066) |
| Хоткеи в документации | `README.md:22,91–92`, `README.en.md:22,91–92` | генерация из `shortcut-defaults.json` (D-028) |

**Что уже сведено правильно** (чтобы отличать сделанное от несделанного): акселераторы — `shortcut-defaults.json` + `accelerator.js`; порт бэкенда — `DEFAULT_BACKEND_PORT` и четыре бывших литерала; решения о вставке — `paste-result.js`, `paste-script.js`, `paste-verification-policy.js`, `paste-capability.js`; форма IPC-хендоффа — `recording-final-slot.js`; зеркалирование консоли — `renderer-console.js`; список рантайм-импортов — `BACKEND_RUNTIME_IMPORTS`; ключи очистки Python-окружения — `PYTHON_ENV_SCRUB_KEYS`; геометрия капсулы — `RECORDING_STATUS_CAPSULE`; версия приложения — `desktop/package.json`, защищена тестом `packaging.test.js:106–120`, рендерер берёт её через `vite.config.ts`; `.nvmrc`/`.node-version`/`engines.node`/CI — согласованы.

---

## Гипотезы (проверить, не докладывать как факт)

- **H-1.** `main.js:1667–1672`: клик по капсуле останавливает запись только при `waveMode === "recording"`. После исправления D-012 состояние `autostop` станет достижимым, и в нём капсула будет выглядеть активной (`#stateIcon.autostop` с анимацией `okHalo`), а клик окажется no-op. Решить одновременно с D-012, иначе исправление внесёт новый дефект.
- **H-2.** `main.js:4445` (win32) и `:4749` (darwin): `clipboard.writeText(String(text))` выполняется заново на каждой попытке лестницы. Если пользователь скопировал что-то своё между попытками, его копия затирается транскриптом до того, как `scheduleSmartClipboardRestore` получит шанс это заметить. Требует прогона по времени.
- **H-3.** `main.js`, `processPostStopTask`: `heardIpcSignal` выставляется в `true` навсегда первым же сигналом, включая `final:false`. Обратного пути нет — если рендерер прислал один provisional и упал, задача спит до дедлайна 32 с вместо того, чтобы вернуть poll в строй; комментарий рядом описывает симметрию только в одну сторону. Воспроизведение требует падения рендерера строго между provisional и final. Разумная правка — считать `heardIpcSignal` истекающим по `POST_STOP_IPC_GRACE_MS`.
- **H-4.** `main.js:8285–8348`: `before-quit` не дожидается `killAllTrackedChildren`/`killBackendHard`. При quit во время многогигабайтного pip-инстолла SIGKILL уходит, staging-дерево остаётся и подбирается `sweepEngineSiteLeftoversAtBoot`. Выглядит корректно; требует проверки на реальном прерывании.
- **H-5.** Капсула грузится как `data:text/html` с `script-src 'unsafe-inline'` (`main.js:1251`). Партишен отдельный, `sandbox: true`, `devTools: false`, внешних ресурсов нет — поверхность закрыта. Но весь HTML собирается конкатенацией с интерполяцией; если в шаблон когда-нибудь попадёт строка из пользовательских данных, `unsafe-inline` станет исполняемым каналом. Сейчас — не дефект, а хрупкость.
- **H-6.** `INSTALL_ON_OTHER_MAC.command:56–62`: `run_privileged` читает `${NEEDS_SUDO}` под `set -u`, а присваивается переменная только в `main()` (`:260`/`:261`). Все нынешние вызовы идут после; сегодня недостижимо. Профилактика — инициализировать в блоке глобалов.
- **H-7.** `INSTALL_ON_OTHER_MAC.command:187–198`: после `pkill -x` идёт `sleep 1; break`, и установка продолжается независимо от того, умер ли процесс; `ditto`/`mv` работают поверх, возможно, живого приложения. Вероятно безопасно, но гарантии в коде нет.
- **H-8.** `prepare-runtime.sh:152`: URL python-build-standalone указывает на `github.com/indygreg/python-build-standalone`; проект переехал под `astral-sh`. Редирект пока работает; сеть не трогал.

---

## Что проверено и признано корректным

Чтобы отчёт не читался как «всё плохо» и чтобы не искать здесь повторно:

- **`recording-final-slot.js`.** Гонка set/wait закрыта корректно: быстрый путь читает `slot.last` до создания таймера; `set` будит только waiter-ов с `signal.seq > waiter.sinceSeq`; `settle` идемпотентен; вытеснение защищено от самовытеснения и освобождает waiter-ов `null`, а не подвешивает. `peek` отличает «слот создан ожидающим» от «есть данные». Валидатор не приводит типы (`Number.isSafeInteger`, `typeof final !== "boolean"`) — §6.8 закрыт по существу.
- **`paste-result.parseMacPasteOutcome`.** Порядок «ERR: побеждает квитанцию → OK: → квитанция → !ok» правильный; `/:verified$/` не ловит `:unverified`; `lastLineOf` устраняет затенение вердикта квитанцией.
- **`paste-capability`.** Машина состояний согласована: `transition` двигает `since`/`changedAt` только при смене, `probedAt` — всегда; успешная вставка повышает любое состояние до `active`; одиночный silent не осуждает грант; `untrusted` не апгрейдится в `broken`. Петли «отказ лестницы → деградация состояния» нет (проверено специально).
- **`paste-script`.** `escapeAppleScriptString` экранирует backslash до кавычки (порядок верен); `safeInt` режет отрицательные и нечисловые; `with timeout` действительно оборачивает `tell`; квитанция эмитится строго после инъекции и строго до `afterRead`.
- **`renderer-console`.** Обе сигнатуры Electron нормализованы, `ALWAYS_MIRRORED_PREFIXES` — префиксное сравнение, клип считает остаток корректно.
- **`packaging.test.js`** реально проходит по всему графу локальных `require` обоих entrypoint-ов (включая ленивый `require("./engine-deps")` на `main.js:6353`); все 9 модулей и `shortcut-defaults.json` присутствуют в `build.files`.
- **`applescript.test.js`** не деградировал: сканер измерен вживую — находит 356 шаблонов в `main.js`, из них 7 AppleScript, и 2 из 2 в `paste-script.js`; порог `>= 4` с запасом.
- **`afterPack.js`** — порядок операций корректен и это его главное достоинство: Info.plist → MAS-гейт → выбор идентичности → предподпись рантайма → osx-sign → запрет байткода и chmod → `codesign --verify --deep --strict`. `chmod` после подписи безопасен (режимы файлов не хешируются в `CodeResources`), и повторная верификация это подтверждает. Ошибки, ломающие сборку, кидаются, а не глушатся.
- **`asarUnpack`/`extraResources` против рантайма.** Ключа `asarUnpack` нет и он не нужен: нативных модулей нет, production-зависимостей нет вовсе, всё загружаемое через `__dirname` лежит в `app.asar` и перечислено в `build.files`. Всё загружаемое через `process.resourcesPath` покрыто `extraResources` и проверено на реальном бандле. Расхождений dev↔packaged, ломающих поведение, нет; два намеренных задокументированы в коде.
- **Квотирование путей с пробелами** — во всех семи shell-скриптах корректно, несмотря на пробел в имени самого репозитория. `set -euo pipefail` присутствует везде. Все `rm -rf` идут через обёртки с проверкой существования; пустыми пути быть не могут. Из 14 вхождений `|| true` тринадцать стоят на идемпотентных best-effort операциях; единственное пограничное — D-060.
- **`_relocateUserDataOffOneDrive`** — маркер миграции пишется только при полном копировании всех детей; частичный сбой корректно оставляет миграцию для повтора.
- **`waitForBackendHealth`** — проверяет `boot_nonce`, имеет per-request timeout и границу тела ответа.
- **Path-traversal защиты в title-канале** (`main.js:7426–7502`) — `..` и разделители отвергаются, `archiveDir` проверяется и на вхождение в home с границей по разделителю, и на вхождение в разрешённые recording-roots.
- **CI-джоба backend** ставит frontend-зависимости, поэтому `backend/tests/test_live_coverage_policy.py` не самопропускается.
- **`ENABLE_GIGAAM`** — файл-маркер; читателей ровно два (`main.js:6548`, `:6677`), едет в бандл, автоустановки при загрузке нет — поведение соответствует комментарию 6343–6351.
- **`docs/INSTALL_OTHER_MAC.md:56–61`** — верификационный сниппет всё ещё валиден (`_deepgram_http_policy`, `DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC`, `DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC` существуют).
- **Из истории:** `__transcriptorRecordingTooShort` реально объявлен в рендерере (фикс `bff20b1` работает); `activationTag` пережил вынос скрипта в модуль; `recordingFinal` действительно вызывается рендерером и принимается `ipcMain.on`; удалённый poll шорткатов не оставил осиротевшего канала; ни один из последних 15 коммитов не обещает в сообщении больше, чем отдаёт в диффе.

---

## Итог по секции

- **Занумеровано находок: 84** — D-001…D-084. По тяжести: **P0 — 3** (D-001…D-003), **P1 — 26** (D-004…D-029), **P2 — 55** (D-030…D-084).
- Из них **подтверждено 77**, помечено «гипотеза» **7** (D-011, D-049, D-054, D-055, D-056, D-079, D-082).
- Отдельным списком **8 гипотез** к проверке (H-1…H-8) — они не входят в 84 и требуют прогона, а не чтения.
- Три находки подтверждены по коду, но их внешнее следствие не исполнялось в этой среде и помечено внутри себя: D-002 (поведение `cscript //U`), D-003 (отказ `notarytool`), D-022 (отказ `bind` в App Sandbox).
- Регионов `main.js`: 43, все reviewed. Тестовая суита прогнана вживую: 153/153, 0 пропусков.

**Самое дорогое, по убыванию:**

1. **D-001** — два выпущенных исправления (BUG-81 и warm-mic release из 1.6.0) не исполняются вообще, потому что обработчики вложены не в ту функцию.
2. **D-004** — верификация вставки никогда не срабатывает, из-за чего буфер обмена пользователя не восстанавливается **ни разу**: каждая диктовка безвозвратно затирает то, что он копировал.
3. **D-002** — на Windows каждая удачная вставка рапортуется провалом и текст вставляется дважды; существующий тест зелёный, потому что кормит форму, которой конвейер не производит.
4. **D-003** — единственный публичный путь релиза (Developer ID + нотаризация) сломан на уровне кода и не проверяется ничем.
5. **D-005** — на macOS исчез единственный запрос разрешения Accessibility: первый запуск на новой машине больше не показывает его никогда.

Пункты 1–3 и 5 — один класс: **исправление применено к одному из двух мест**. Все четыре датируются конкретными коммитами последней волны (`5dbb006`, `2b8f638`+`26d5b4f`, `bab3744`, `f37fe55`), и ни одно не ловится существующими 153 тестами.
