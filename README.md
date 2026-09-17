# Transcriptor

<p align="center">
  <img src="assets/demo.gif" alt="Transcriptor — демо" width="800" />
</p>

Десктопное приложение для транскрибации речи: запись с микрофона, загрузка файлов, ИИ-очистка текста, локальная история, глобальные хоткеи, автовставка.

## Возможности

- **Живая транскрибация** — Local Whisper (офлайн) или Deepgram (облако).
- **Файловая транскрибация** — Whisper / Deepgram / OpenRouter.
- **История** — сохранённые транскрипты и исходный аудио, поиск, статистика, повторная транскрибация.
- **ИИ-апскейл** — пресеты через OpenRouter.
- **Автовставка** — результат сразу в фокусное поле (Enter после вставки — опционально).
- **Командная строка** — любой скрипт, терминал или ИИ-агент может транскрибировать через приложение.
- **Платформы** — macOS Apple Silicon, Windows x64, Linux x64.

## Режимы работы

### 1. Live — запись с микрофона в реальном времени

- Запуск: кнопка в интерфейсе, трей-меню или глобальный хоткей (`Option`+`←` на macOS, `Ctrl`+`Alt`+`Shift`+`R` на Windows/Linux).
- Движки: **Local Whisper** (полностью офлайн, быстрее на Apple Silicon) или **Deepgram Nova-3** (облако, выше качество на шумных записях).
- Автоопределение пауз — сегменты фиксируются по тишине, финальный текст собирается без дублей.
- Индикатор здоровья микрофона (пилюля в топбаре): зелёно — звук есть, жёлто — тишина, красный — нет доступа/устройство занято.
- Результат сразу вставляется в фокусное поле (автовставка), копируется в буфер, сохраняется в историю.

### 2. Upload — загрузка своих аудио/видео файлов

- Перетащите файл в окно или нажмите «Загрузить».
- Поддерживаемые форматы: **аудио** — wav, mp3, m4a, flac, ogg, opus, webm; **видео** — mp4, mov, mkv, webm, avi (аудиодорожка извлекается автоматически).
- Лимит: **до 500 МБ** на файл.
- Движки: Local Whisper / Deepgram / OpenRouter (на выбор в настройках провайдера).
- Прогресс и статус видно в списке загрузок; по завершении — тот же пайплайн: автовставка, копирование, сохранение в историю.

### 3. История — всё, что вы записали или загрузили

- Каждая запись: текст, исходный аудио, метаданные (длительность, движок, дата, модель).
- Поиск по тексту, фильтр по движоку/дате.
- Действия: **открыть папку**, **повторно транскрибировать** (другой движок/модель), **ИИ-апскейл**, **удалить**.
- Статистика: общее время, количество сессий, использованные модели.

### 4. ИИ-апскейл (Upscale)

- Пресеты промптов через OpenRouter: «очистить от воды», «сделать протокол», «выделить задачи», «перевести», кастомный.
- Работает над любым текстом из истории.

### 5. Командная строка — приложение как транскрайбер для скриптов и агентов

Включается в **Настройки → Command line**. Приложение выпускает отдельный токен,
пишет файл подключения и готовую команду; выключатель отзывает доступ сразу, не
перезапуская приложение. Токен командной строки открывает только маршруты
транскрибации — он не читает конфиг, ключи провайдеров и архив.

```bash
transcriptor transcribe talk.mp4                  # текст в stdout
transcriptor transcribe talk.mp4 --json --out t.json
transcriptor transcribe call.wav --engine deepgram --diarize --save
transcriptor submit long-call.wav                 # в очередь, печатает job id
transcriptor result <job-id> --wait               # забрать готовый результат
transcriptor status <job-id>
transcriptor cancel <job-id>
transcriptor info                                 # адрес приложения и текущие умолчания
```

Транскрипт идёт в **stdout**, прогресс и ошибки — в **stderr**, код возврата
говорит, что произошло: `0` — готово, `1` — задание упало, `2` — ошибка в команде,
`3` — приложение недоступно или доступ выключен, `4` — задание отменено.
Команда без опций транскрибирует так же, как вкладка Upload прямо сейчас.

Карточка «For an agent» в настройках — готовый абзац для CLAUDE.md, AGENTS.md или
системного промпта: любой агент, умеющий запускать shell-команду, работает с ним
как есть.

## Скриншоты

<p align="center">
  <img src="assets/screenshot-1.jpg" alt="Transcriptor — главный экран" />
  <img src="assets/screenshot-2.png" alt="Transcriptor — настройки и история" />
</p>


## Установка

> Готовых релизов на GitHub пока нет. `./BUILD.command` подписывает сборку
> реальной идентичностью (`TRANSCRIPTOR_SIGNING_IDENTITY`; ad-hoc — только
> отдельная цель `dist:adhoc`), но без Developer ID и нотаризации macOS всё
> равно заблокирует скачанное приложение. Пока что приложение собирается из
> исходников — см. [Разработка](#разработка). Команды ниже описывают
> установку **уже собранного** комплекта.

### macOS (Apple Silicon)

1. Возьмите `Transcriptor-<версия>-arm64-macos-install.zip` — его создаёт
   `./BUILD.command` в `desktop/dist/release/`.
2. Распакуйте и запустите `bash INSTALL_ON_OTHER_MAC.command`.
3. Разрешите **Микрофон**, **Universal Access**, **Автоматизацию** (Системные настройки → Приватность и безопасность).

### Windows x64

1. Возьмите `Transcriptor Setup <версия>.exe` из `desktop/dist/`
   (создаётся командой `npm --prefix desktop run dist:win`).
2. Запустите установщик.
3. Разрешите доступ к микрофону (Параметры → Приватность → Микрофон).

### Linux x64

```bash
sudo apt install xdotool wmctrl zenity
chmod +x Transcriptor-<версия>.AppImage
./Transcriptor-<версия>.AppImage
```

На Wayland — `wtype`/`ydotool` вместо `xdotool`.

## Глобальные хоткеи

| Действие | macOS | Windows / Linux |
|----------|-------|-----------------|
| Запись / Стоп | `Option`+`←` | `Ctrl`+`Alt`+`Shift`+`R` |
| Вставить последний текст повторно | `Option`+`Shift`+`V` | `Ctrl`+`Alt`+`Shift`+`V` |

Настройка: **Настройки → Ярлыки**. Красная подсветка = комбинация занята другой программой.

## Разработка

```bash
cd "Voice Transcriptor"

# macOS
./BUILD.command          # сборка DMG + замена установленного приложения

# Linux
./INSTALL.command

# Windows (из Git Bash / WSL / macOS хоста)
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:win
```

### Запуск в dev-режиме

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix frontend run build
npm --prefix desktop run dev
```

Электрон сам управляет бэкендом — отдельный `uvicorn` не нужен.

## Конфигурация

```bash
cp .env.example .env
# отредактируйте .env при необходимости
```

Переменные: токен API, порт бэкенда, Deepgram хост, TTL результатов, Whisper-потоки, пути кэша и др. Полный список в `.env.example`.

## Траблшутинг

- **Логи**: `~/Library/Application Support/Transcriptor/main.log` (macOS) или `%APPDATA%\Transcriptor\main.log` (Windows).
- **Микрофон тишина**: переключите разрешение **Микрофон** выкл/вкл в настройках macOS или `tccutil reset Microphone local.transcriptor.app`.
- **Порт 8321 занят**: Electron сам выберет другой.
- **Окно приложения**: пока процесс запущен, в Dock всегда горит точка. Клик по иконке в Dock (или `open -a`, или трей) открывает окно на весь рабочий стол — если вы сами меняли его размер или положение, оно восстановится таким, каким вы его оставили. Жёлтая кнопка сворачивает окно, приложение продолжает работать: хоткеи, капсула записи и бэкенд живы, клик по Dock возвращает окно. Красная кнопка и `Cmd+W` — это выход: закрыто значит не запущено, бэкенд и капсула останавливаются вместе с приложением. Ничто другое окно не прячет и не переставляет; капсула записи — отдельная панель, она не забирает фокус.

## Документация

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — структура кода.
- [VERIFIED_AUDIT.md](docs/VERIFIED_AUDIT.md) — аудит багов и фиксы.
- [AUDIT_2026-08.md](docs/AUDIT_2026-08.md) — релиз-аудит: 30 дефектов с кодом и фиксами.
- [CHANGELOG.md](CHANGELOG.md) — история релизов.
- [INSTALL_OTHER_MAC.md](docs/INSTALL_OTHER_MAC.md) — установка внутренней сборки на другой Mac.

---

**English version:** [README.en.md](README.en.md)

## Поддержать проект

Если Transcriptor пригодился — можно сказать спасибо копейкой:

**USDT (TRC20)**
```
TVan3h93wZKeHt4Na4zsU3mVHnjpbKoghE
```

## Storage & privacy

Recordings are stored locally in your chosen archive folder as `.txt` transcripts.
**Audio retention policy:** the app keeps the audio file of the most recent recording only;
on every new save the audio of older recordings is deleted automatically to bound disk
usage. Transcripts are kept forever. The status line shows how many older audio files were
removed after each save.
