# The desk in its shell, on Windows

The browser page is not the product any more. Since 1.6.42 the renderer gets
its API token from the shell over IPC (`backend/main.py:1998-2005`), so a tab
at `http://127.0.0.1:8321/` runs without API access by design. The shell is the
only way in.

## Run it

    powershell -ExecutionPolicy Bypass -File <workspace>\.mcode\start-shell.ps1

`-DebugPort` additionally opens 9222 so the page can be read from outside
(`.mcode/cdp-eval.py`, `.mcode/cdp-verify.py`). Off by default: a debug port on
a window that holds the token is a door.

The script does three things, and each of them is a fact measured on this
machine on 2026-11-25:

1. **Electron 33.4.11, not 42.4.1.** 42.4.1 exits `0xC0000005` with an empty
   stdout even for `--version` (Windows 11 build 26300), so the shell died
   before it parsed a line of app code. 33.4.11 starts and runs the same code.
   `desktop/package.json` pins it.
2. **The runtime lives outside the workspace.** The same 33.4.11 binary that
   runs from `%LOCALAPPDATA%\Programs\vt-el33` exits `0xC0000005` from inside
   the checkout, byte for byte identical. The script copies it out.
3. **The backend interpreter is `%APPDATA%\Transcriptor\.venv`.** The shell
   uses that venv when it exists (`desktop/main.js:7579`), so the script creates
   it and installs `requirements.txt`. Without it the shell tries to build one
   and "gives up after 40 attempts".

Log: `%APPDATA%\Transcriptor\main.log` (backend stdout and stderr included).

## What the shell does on boot

Window, backend on `127.0.0.1:8321`, microphone permission granted to the app
origin, Deepgram warm sockets. Verified by reading the page over CDP: the token
is present, the voice card lists the tracks, the active one says "Catching now".

## Known failures that are not ours

`python -m unittest discover -s backend/tests` fails the same 20 tests on a
clean 1.6.42 checkout on this machine (chmod, symlinks, atomic writes, the data
directory fallback) plus one test that is flaky *upstream*: 2 failures in 6
runs on both trees. Parity, not regressions - compare the two lists rather than
the raw count.
