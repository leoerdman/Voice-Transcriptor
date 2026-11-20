# Transcriptor

<p align="center">
  <img src="assets/demo.gif" alt="Transcriptor — demo" width="800" />
</p>

Desktop speech-to-text app: record from the microphone, transcribe your own files, clean the text up with an LLM, keep a local history, drive it all from global hotkeys, and have the result pasted straight into whatever you were typing in.

## Features

- **Live transcription** — Local Whisper (offline) or Deepgram (cloud).
- **File transcription** — Whisper / Deepgram / OpenRouter.
- **History** — saved transcripts and their source audio, search, statistics, re-transcription.
- **AI upscale** — prompt presets via OpenRouter.
- **Auto-paste** — the result goes into the focused field (optional `Enter` after pasting).
- **Command line** — any script, terminal or AI agent can transcribe through the app.
- **Platforms** — macOS Apple Silicon, Windows x64, Linux x64.

## How it works

### 1. Live — record from the microphone in real time

- Start it from the in-app button, the tray menu, or a global hotkey (`Option`+`←` on macOS, `Ctrl`+`Alt`+`Shift`+`R` on Windows/Linux).
- Engines: **Local Whisper** (fully offline, faster on Apple Silicon) or **Deepgram Nova-3** (cloud, better on noisy recordings).
- Pauses are detected automatically — segments are committed on silence and the final text is assembled without duplicates.
- A microphone health pill in the topbar: green means audio is flowing, amber means silence, red means no access or the device is busy.
- The result is pasted into the focused field, copied to the clipboard, and saved to history.

### 2. Upload — transcribe your own audio or video

- Drag a file into the window or press **Upload**.
- Supported formats: **audio** — wav, mp3, m4a, flac, ogg, opus, webm; **video** — mp4, mov, mkv, webm, avi (the audio track is extracted automatically).
- Limit: **500 MB** per file.
- Engines: Local Whisper / Deepgram / OpenRouter, selected in the provider settings.
- Progress is visible in the upload list; when it finishes the same pipeline runs — auto-paste, clipboard, history.

### 3. History — everything you recorded or uploaded

- Every entry keeps the text, the source audio, and metadata (duration, engine, date, model).
- Full-text search, filtering by engine and date.
- Actions: **reveal in folder**, **re-transcribe** with a different engine or model, **AI upscale**, **delete**.
- Statistics: total time, session count, models used.

### 4. AI upscale

- Prompt presets through OpenRouter: strip the filler, turn it into minutes, extract action items, translate, or your own prompt.
- Works on any text in the history.

### 5. Command line — the app as a transcriber for scripts and agents

Switched on in **Settings → Command line**. The app mints a token of its own,
writes the connection file and a ready-made command, and switching it off revokes
that access at once without restarting the app. The command-line token opens only
the transcription routes — it cannot read the config, the provider keys or the
archive.

```bash
transcriptor transcribe talk.mp4                  # the text on stdout
transcriptor transcribe talk.mp4 --json --out t.json
transcriptor transcribe call.wav --engine deepgram --diarize --save
transcriptor submit long-call.wav                 # queue it, print the job id
transcriptor result <job-id> --wait               # collect the finished result
transcriptor status <job-id>
transcriptor cancel <job-id>
transcriptor info                                 # the app's address and current defaults
```

The transcript goes to **stdout**, progress and errors to **stderr**, and the exit
code says what happened: `0` done, `1` the job failed, `2` the command line was
wrong, `3` the app is unreachable or access is off, `4` cancelled. A command with
no options transcribes exactly as the Upload tab would right now.

The "For an agent" card in Settings is a paragraph ready to paste into CLAUDE.md,
AGENTS.md or any system prompt: any agent that can run a shell command uses it as
is.

## Screenshots

<p align="center">
  <img src="assets/screenshot-1.jpg" alt="Transcriptor — main screen" />
  <img src="assets/screenshot-2.png" alt="Transcriptor — settings and history" />
</p>

## Install

> There are no GitHub releases yet. `./BUILD.command` signs with a real
> identity (`TRANSCRIPTOR_SIGNING_IDENTITY`; ad-hoc is the separate
> `dist:adhoc` target), but without a Developer ID signature and
> notarisation macOS still blocks a downloaded app. For now the app is built
> from source — see [Development](#development). The steps below describe
> installing a kit you have already built.

### macOS (Apple Silicon)

1. Take `Transcriptor-<version>-arm64-macos-install.zip`, produced by
   `./BUILD.command` in `desktop/dist/release/`.
2. Unpack it and run `bash INSTALL_ON_OTHER_MAC.command`.
3. Grant **Microphone**, **Accessibility** and **Automation** in
   System Settings → Privacy & Security.

### Windows x64

1. Take `Transcriptor Setup <version>.exe` from `desktop/dist/`
   (produced by `npm --prefix desktop run dist:win`).
2. Run the installer.
3. Allow microphone access (Settings → Privacy & security → Microphone).

### Linux x64

```bash
sudo apt install xdotool wmctrl zenity
chmod +x Transcriptor-<version>.AppImage
./Transcriptor-<version>.AppImage
```

On Wayland use `wtype` / `ydotool` instead of `xdotool`.

## Global hotkeys

| Action | macOS | Windows / Linux |
|--------|-------|-----------------|
| Record / stop | `Option`+`←` | `Ctrl`+`Alt`+`Shift`+`R` |
| Paste the last transcript again | `Option`+`Shift`+`V` | `Ctrl`+`Alt`+`Shift`+`V` |
| Screen mode (record with drawing and screenshots) | `Option`+`→` | — |
| Screenshot in screen mode | `` ` `` (the key under Esc; only while screen mode runs) | — |

**Screen mode** (macOS): a red frame around the screen and a bar above the capsule — the tools (a rectangle, which every take starts with, and a pen), a divider, then the colours — and a screen button right of the capsule timer. Press and drag draws with the chosen tool; each stroke shows its number in a circle beside where it began. A plain click still reaches the app underneath, so you can keep browsing while you talk. The screen button (or `` ` ``) saves a screenshot of the front window with the drawings — no menu bar, no Dock — and clears the screen; the recording goes on, and stopping it shoots whatever is still drawn. The transcript gets a stroke mark where the stroke began in speech (`[✏️3 скрин 7: жёлтый прямоугольник, вверху слева]`, closed by `[/3]` where it was released) and a mark for each screenshot, under a header that names the screenshots' folder once and says how to read the marks, and above a summary with one item per screenshot and its files. Beside each screenshot the app writes a downscaled copy and a close-up of every stroke, so an agent reading the feedback looks at far fewer pixels. A trackpad double-tap-and-drag draws too. Screenshots are saved beside the recording (`<name>.screens/`) and shown in History under the player; screen-mode recordings (`Screen Sessions` collection) keep audio and screenshots for the newest 5, transcripts always. Needs Accessibility (drawing) and Screen Recording (screenshots).

Rebind them under **Settings → Shortcuts**. A red highlight means another
application already owns that combination.

## Development

```bash
cd "Voice Transcriptor"

# macOS
./BUILD.command          # build the DMG and replace the installed app

# Linux
./INSTALL.command

# Windows (from Git Bash / WSL / a macOS host)
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist:win
```

### Running in dev mode

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix frontend run build
npm --prefix desktop run dev
```

Electron manages the backend itself — you do not need to start `uvicorn`
separately.

## Configuration

```bash
cp .env.example .env
# edit .env as needed
```

Variables cover the API token, backend port, Deepgram host, result TTL,
Whisper thread counts, cache paths and more. The full list is in
`.env.example`.

## Troubleshooting

- **Logs**: `~/Library/Application Support/Transcriptor/main.log` (macOS) or
  `%APPDATA%\Transcriptor\main.log` (Windows).
- **Microphone records silence**: toggle the **Microphone** permission off and
  back on in macOS settings, or run
  `tccutil reset Microphone local.transcriptor.app`. The build is signed
  without a Team ID, so macOS ties the grant to the exact binary and a
  reinstall can leave it stale while still reporting "granted".
- **Port 8321 is busy**: Electron picks another one by itself.
- **The app window**: while the process runs the Dock always shows the running
  indicator. Clicking the Dock icon (or `open -a`, or the tray) opens the window
  filling the desktop — if you resized or moved it yourself, it comes back the
  way you left it. The yellow button minimises and the app keeps working:
  hotkeys, the recording capsule and the backend stay alive, and a Dock click
  brings the window back. The red button and `Cmd+W` quit: closed means not
  running, and the backend child and the capsule stop with the app. Nothing else
  hides or reorders the window — the recording capsule is a separate panel that
  never takes focus.

## Documentation

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — code layout.
- [VERIFIED_AUDIT.md](docs/VERIFIED_AUDIT.md) — bug audit and fixes.
- [AUDIT_2026-08.md](docs/AUDIT_2026-08.md) — release audit: 30 defects with code and fixes.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [INSTALL_OTHER_MAC.md](docs/INSTALL_OTHER_MAC.md) — installing an internal build on another Mac.

---

**Русская версия:** [README.md](README.md)

## Support the project

If Transcriptor turned out useful, you can say thanks:

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
