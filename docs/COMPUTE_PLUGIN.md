# Compute plugin — `transcriptor-compute/1`

A machine that can transcribe faster or better than the app's CPU-only
faster-whisper engine supplies one **local child process**; the app speaks to
it and keeps its own engine as the fallback. Nothing else in the app knows the
plugin exists: the whole seam is `backend/compute_plugin.py`, and a plugin that
is absent, slow, broken or dishonest costs one slow transcription, never a
failed one.

## Transport

* the app launches the plugin once (argv from `TRANSCRIPTOR_COMPUTE_PLUGIN` plus
  `TRANSCRIPTOR_COMPUTE_PLUGIN_ARGS`), keeps it warm, and restarts it after a
  crash;
* both directions are **UTF-8 JSON, one object per line** (NDJSON) over stdin /
  stdout; stderr is ignored, so log freely there;
* one request is in flight at a time — the app serialises calls;
* every request gets `TRANSCRIPTOR_COMPUTE_PLUGIN_TIMEOUT_SEC` (default 120);
  silence past that is a failure and the process is killed.

## Versioning

Every answer carries nothing versioned except the handshake. A plugin must
answer `hello` with `"protocol": "transcriptor-compute/1"` — the app accepts any
`transcriptor-compute/1…` string and refuses every other major, which is what
makes this contract stable: a plugin may add fields and operations, and a
client may ignore fields it does not know, but neither may change the meaning of
what is written here.

## Operations

### `hello`

```json
{"op": "hello", "host": {"protocol": "transcriptor-compute/1",
  "audio": {"sample_rate_hz": 16000, "channels": 1, "sample_format": "pcm_s16le",
            "bytes_per_second": 32000},
  "models": ["small", "medium", "large-v3"],
  "default_model": "small", "capabilities": {"word_timestamps": true, "language_auto": true},
  "timeout_sec": 120}}
```
```json
{"ok": true, "protocol": "transcriptor-compute/1", "device": "cuda",
 "models": ["small", "medium"], "max_audio_sec": 600}
```

Sent once after the process starts. `host` is the host's configuration: the
exact audio shape every `transcribe` will carry, the model ids it may ask for,
and the deadline it enforces. It is **one-way** — read it, never treat it as
something to answer or adjust; the app never reads host fields back from the
answer, so a plugin cannot change the host, only refuse or comply.

`models` is what the plugin will accept; an empty or missing list means "any id
the host lists". `device` is free text for logs. The answer identifies the
implementation; the app records it and nothing more.

### `transcribe`

```json
{"op": "transcribe", "audio": "/abs/path/to/16k-mono.wav", "model": "small",
 "language": "ru", "vad_filter": true, "word_timestamps": false,
 "beam_size": 1, "best_of": 1}
```
```json
{"ok": true, "language": "ru", "language_probability": 0.98, "duration": 12.5,
 "segments": [{"start": 0.0, "end": 2.4, "text": "привет"}], "text": "привет"}
```

* `audio` is an absolute path to **16 kHz mono PCM WAV**, written by the app in
  its own temporary directory and deleted after the answer — read it, do not
  keep it, do not move it;
* `language` is an ISO-639-1 code or `"auto"`;
* `segments[].words` is expected only when `word_timestamps` is true, and is a
  list of `{"start", "end", "word", "prob"}`;
* `text` may be omitted — the app concatenates segment texts then;
* `language`, `language_probability` and `duration` may be omitted (nulls and
  zeros are the defaults).

### `ping` and `shutdown`

```json
{"op": "ping"}      → {"ok": true}
{"op": "shutdown"}  → {"ok": true}, then exit
```

`shutdown` is the app's courtesy, not a guarantee: it also kills the process.

## Failures

An error is `{"ok": false, "error": "why"}` for the request that caused it. A
malformed line, a non-object, a missing `segments` list, a non-numeric time, a
crash, or a missed deadline all end the same way: the app logs once, kills the
process, uses its local engine for the next 30 seconds, and retries the plugin
after that.

## Configuration

| variable | meaning |
|---|---|
| `TRANSCRIPTOR_COMPUTE_PLUGIN` | executable (abs path or on `PATH`); unset → no plugin |
| `TRANSCRIPTOR_COMPUTE_PLUGIN_ARGS` | JSON array of arguments, e.g. `["C:\\plugins\\gpu.py"]` |
| `TRANSCRIPTOR_COMPUTE_PLUGIN_TIMEOUT_SEC` | per-answer deadline, default 120 |

## Rules

1. Local only: no network, no telemetry, no writes outside the plugin's own
   directory. The app hands over nothing but the WAV path and the parameters.
2. The plugin never reads the app's data directory; the app's data is not its
   business.
3. It must answer every request within the deadline even while another model
   loads — a cold start that blocks past it is a failed plugin, not a slow one.
4. It may exit when idle; the app will start it again.
5. The host's configuration is dictated in `hello` and is read-only: a plugin
   that needs different audio, other model ids or a longer deadline says so by
   refusing an id (`{"ok": false, "error": "…"}`) — it never rewrites what the
   host sent.
