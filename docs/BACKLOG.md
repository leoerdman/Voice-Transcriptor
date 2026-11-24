# Backlog

Work that is written down and **not planned**. Nothing here has a date, an
owner, or a byte of implementation in this tree; a line leaves this file only
when it is picked up, and then it is planned like any other change.

## Partners while paused

- **The want.** Connect the people in the room to a take that is held, so a
  conversation is joined instead of started over.
- **State.** Not planned. Nothing of it exists: the live socket takes one
  client (`backend/main.py`, `/ws/transcribe`), there is no join, invite, room
  or participant route anywhere, and `docs/SOLO.md` decides which voices are
  *let through* — never who may connect.
- **Would touch.** The recording FSM (`desktop/recording-status.js`), the live
  socket contract, and Solo's single call site.

## Recording pause

- **The want.** Hold a take instead of stopping it: one recording, resumed
  where it was left.
- **State.** Not planned. The FSM has no `PAUSED` member
  (`desktop/recording-status.js`); auto-stop on silence ends a take
  (`README.md:25`), and nothing suspends one.
- **Would touch.** The FSM, the final envelope
  (`contracts/live-final-envelope.json`), and the renderer's one recording
  state line.
