# Участие в разработке

Спасибо, что хочешь помочь! Приветствуются: баг-репорты, идеи, PR с исправлениями/фичами, улучшения документации.

## Как начать

1. Форкни репозиторий.
2. Создай ветку: `git checkout -b feat/моя-фича` или `fix/мой-баг`.
3. Внеси изменения.
4. Проверь: `npm --prefix frontend run lint && npm --prefix frontend run typecheck && npm --prefix frontend test`.
5. Отправь PR с понятным описанием: что и зачем.

## Правила

- Один PR — одна логическая задача.
- Коммиты: читаемые сообщения (Conventional Commits приветствуются).
- Не коммить собранные артефакты (`dist/`, `*.dmg`, `*.exe`, `*.AppImage`, `node_modules/`).
- Код должен проходить линтеры и типы.
- Тесты (если добавил логику) — в соответствующие `backend/tests/` или frontend-тесты.

## Сборка под все платформы

### Предварительные требования

- **Node.js** `>=22.12.0` (`.nvmrc` — SSOT)
- **npm** `>=10`
- **Python** версии из `.python-version` (SSOT — её же ставит CI и из неё собирается bundled runtime) + `pip`
- **macOS**: Xcode Command Line Tools, `codesign`, `bash`
- **Windows**: Git Bash / WSL / Linux/macOS хост (сборка Windows делается из Bash)
- **Linux**: `xdotool`, `wmctrl`, `zenity` (для интеграции в AppImage)

---

### macOS (Apple Silicon) — релизный DMG

```bash
# 1. Зависимости
npm --prefix frontend ci
npm --prefix desktop ci

# 2. Подготовка runtime + билд frontend + упаковка DMG
npm --prefix desktop run dist
# → desktop/dist/Transcriptor-<версия>-arm64.dmg
```

**Для публичной раздачи** (Developer ID + нотаризация):

```bash
export TRANSCRIPTOR_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npm --prefix desktop run dist

export NOTARYTOOL_KEYCHAIN_PROFILE="TranscriptorNotaryProfile"
npm --prefix desktop run notarize:dmg
# → подписанный, нотаризованный, застейпленный DMG
```

**Ad-hoc (для своих машин, без Developer ID):**

```bash
npm --prefix desktop run dist:adhoc
```

**Установка на другую маку (из собранного zip):**

```bash
unzip Transcriptor-<версия>-arm64-macos-install.zip
cd Transcriptor-<версия>-arm64-macos-install
bash INSTALL_ON_OTHER_MAC.command
```

---

### Windows x64 — NSIS инсталлятор

Сборка **только из Bash-окружения** (Git Bash, WSL, или с macOS/Linux хоста):

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:win
# → desktop/dist/Transcriptor Setup <версия>.exe
```

> `desktop/scripts/prepare-runtime.sh win-x64` готовит бандл — это Bash-скрипт, не PowerShell.

---

### Linux x64 — AppImage

```bash
# На Linux-машине
npm --prefix frontend ci
npm --prefix desktop ci
./INSTALL.command
# → Transcriptor-<версия>.AppImage
```

Запуск:
```bash
chmod +x Transcriptor-<версия>.AppImage
./Transcriptor-<версия>.AppImage
```

Для автовставки на Wayland нужны `wtype` или `ydotool`.

---

### Dev-режим (горячая перезагрузка)

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix frontend run build
npm --prefix desktop run dev
```

Электрон сам поднимает бэкенд — отдельный `uvicorn` не запускай.

---

## Структура репозитория (кратко)

```
backend/       # Python FastAPI + Whisper/Deepgram/OpenRouter
desktop/       # Electron main + упаковка (DMG, NSIS, AppImage)
frontend/      # Vanilla TypeScript + Vite UI
```

## Полезные скрипты

| Задача | Команда |
|--------|---------|
| Линт frontend | `npm --prefix frontend run lint` |
| Типы frontend | `npm --prefix frontend run typecheck` |
| Тесты frontend | `npm --prefix frontend test` |
| Тесты desktop (весь `node --test` сьют) | `npm --prefix desktop test` |
| Тесты бэкенда (интерпретатор из `.python-version`) | `python -m unittest discover -s backend/tests -p "test_*.py"` — сначала `npm --prefix frontend ci`, иначе кросс-тесты live-coverage тихо скипаются (нужен node + tsc) |
| Сборка `.app` без DMG (macOS arm64) | `npm --prefix desktop run dist:dir` |
| Сборка DMG (macOS arm64) | `npm --prefix desktop run dist` |
| Полная проверка как в CI | три команды выше + `npm --prefix frontend run build` |

## Лицензия

MIT — см. [LICENSE](LICENSE). Автор: **Leo Erdman**.

Присылай PR — буду рад хорошим идеям и фиксам.