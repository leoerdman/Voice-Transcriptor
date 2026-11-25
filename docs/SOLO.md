# Solo — the contract as it stands

Solo keeps only the owner's voice and withholds the rest. This file is the
contract the code is checked against; the design that came before it — three
settings slots with a six-second press, a room-derived scale, hand-picked
threshold pairs — is kept in `docs/archive/SOLO_FIRST_DESIGN.md` for the record
and is **not** a description of what runs. Read it as history, never as spec.

## 1. What Solo promises

1.1 **Only the owner's voice reaches the provider.** A window that is not his is
zeroed in the forwarded copy; the take on disk keeps every byte, and the byte
count stands.
1.2 **The take is untouched.** Solo never edits, trims or re-encodes a
recording. What it refused is still there, and History still has it.
1.3 **A refusal is never silent.** The pane says what was withheld and how much.
1.4 **Off is no object at all** — not a filter that copies. With Solo off the
receive loop runs exactly the bytes it always ran.
1.5 **No API call, no cost, no text.** The decision is a cosine between
embeddings computed here.
1.6 **Nothing is inferred about a person.** A track is created by an act of the
owner's, and by nothing else.

## 2. How a track is made

2.1 A track comes from **one take**: the owner presses *That is me* while
recording, the press keeps the seconds the gate itself was handed, and a name is
asked straight after. Measured 2026-11-25: the same voice through the take's
channel scores 0.65–0.87 against itself across twenty takes, while a reference
learned away from a take separated its own owner at only 0.34.
2.2 **Two seconds is the floor** (`CLAIM_MIN_SECONDS`). The button counts them
itself, from the moment the take starts, and says how many it has.
2.3 **Settings records nothing.** Seven rows, one switch and one Remove each. An
empty row says where a track comes from.
2.4 **A full store refuses the save** (409) instead of overwriting a track.
2.5 A track is stored with **the numbers its own take measured**: `self_floor`
(how alike the voice's own windows are) and `level_db` (the level it spoke at).
A track written without them cannot be switched on, so the press never writes
zeros.

## 3. How the gate decides

3.1 **The thresholds are derived, never chosen.** `open_at` and `close_at` are
shares of the track's own floor (`voice_profiles.thresholds_from_floor`:
0.62 and 0.50 — a pair, not two separate picks). A voice learned on a worse
microphone gets a lower pair, and nobody, owner or developer, types a number.
Measured on this desk 2026-11-25 (floor 0.845 → open 0.524, close 0.422): the
owner's windows sit at 0.50–0.87, the other voice's at 0.15–0.40.
3.2 **The room may not choose the owner.** A window must sit within the track's
own close threshold before the session's clustering is allowed to say anything
about it. Without that floor the gate simply made whoever dominated the room the
owner: a take of a voice scoring 0.21 against the owner's track was held open
for 27.7 of its 34.5 seconds.
3.3 **Every track counts.** A window that matches any learned version is the
owner's; no version is picked in advance.
3.4 **The card shows what matched.** Each verdict carries the score per track.
Every row at or above `open_at` lights — filled, with the word *catching* —
because a row that lights by a shade of the colour it already had is a row that
does not light.
3.5 **The pane names the catching tracks**, by slot, where the take is being
read.

## 4. Measured, on this desk

4.1 His own twenty takes, against a track built from one of them: 88–100% of
windows above the derived open threshold; two short takes (3–7 s) below it.
4.2 A voice that is not his (takes of 25.11 10:42 and 10:43): 0.0 s and 0.6 s of
9.0 s open — withheld, as intended.
4.3 These numbers move with the microphone. They are the record of one desk on
one day, not constants: re-derive the pair and measure again before trusting
them elsewhere.
