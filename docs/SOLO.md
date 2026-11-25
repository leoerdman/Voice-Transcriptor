# Solo — skeleton
Presumptive; the person running the app decides. Off is the default.
1.1 Solo, never separation: a non-target window is zeroed in the forwarded copy; the byte count stands.
1.2 No preference of its own: Solo is the profiles store read at send time — one button in the topbar beside Record, one switch per row in Settings, nothing else to keep.
1.3 The take is untouched; profiles and thresholds persist, audio does not; recovery re-processes.
1.4 A refused voice never reaches the provider; the local take still holds it.
1.5 Diarization loses "who was in the room", keeps "which of the allowed".
1.6 Nothing learned is no button: the topbar carries Solo only once a voice exists, and the feature is met once, by a line that opens the card.
2.1 voice_mask.py · voice_profiles.py · the gate sits in the receive loop; what it decided reaches the pane as voice-mask frames, and the renderer never decides who was refused.
2.2 Weights: one ONNX file beside them, loaded lazily, unloaded when idle.
2.3 Nothing new in requirements: onnxruntime already ships with faster-whisper.
2.4 No API and no per-call cost: the net runs here, and a provider labels a call, never a person.
2.5 Similarity is a cosine over embeddings, not a judgement: no text, no prompt, no model call.
2.6 Without a net: MFCC means and a cosine, worse but free — the floor a net must beat.
3.1 Where: the live receive loop, after the recovery chunk, before the queue and the dual fan-out.
3.2 Never inside the session's send: one socket, one byte count, one owner of time.
3.3 Before the send queue: the wedge clock starts at enqueue and must not see held audio.
3.4 One call site, after the recovery chunk; off is no object at all, never a filter that copies.
3.5 Nothing on the session, nothing in stats: with the switch off the loop runs the bytes it always ran.
4.1 Window 2 s of lookahead, the measured end of the 1-2 s range; a judgement each 50 ms — a 25 ms cadence cannot pay for a judgement that costs 25-38 ms — and a release is exactly one 1600-byte frame.
4.2 Silence, never dropped bytes: 1600-byte chunks, bytes_sent and the grid stand; no offset map.
4.3 Close on a voiced boundary with a tail of half a window: 300 ms cut 20 of the owner's hops on the handover fixture, 1000 ms cut none. The frame test is the session's own floor, not a constant: on 2026-11-19 this desk's speech sat at −23…−30 dBFS over a −53 dBFS room, the absolute floor called a quarter of the hops voiced, the 0.5 share a refusal needs was never reached, and a stranger's enabled profile forwarded the owner's every word.
4.4 A stranger's word must not reach the provider: Solo is on, so a window at or below close_at is zeroed even when it is mostly room. A blended window — two voices in one microphone — is a blend, not the kept voice, so it is refused like any other stranger. Measured 2026-11-19 on a two-voice take of 14.8 voiced seconds: 14.0 s withheld against the stranger's profile (95%), 0.55 s against the speaker's own. What survives is the handover tail (§4.3) and the hops still waiting for a verdict, never a window the gate called the kept voice.
4.5 Two thresholds, not one: open at 0.36, close at 0.30 - re-measured 2026-11-21 on the desk's own references with a six-second press (kept voice 0.32-0.53, median 0.39; the other 0.09-0.33, median 0.24). The pair 0.65/0.55 that §4.5 carried before came from a held-out narrator on another machine and refused BOTH voices here. Score normalisation against an impostor cohort (AS-Norm) was built and withdrawn: it held only while cohort, profile and thresholds were rebuilt together, and the first re-learned profile turned the kept voice into a refusal (z 0.27 against an open threshold of 0.7). These numbers move with the microphone: measure them again on any new desk before trusting them.
4.6 A window with no voiced frame is silence already: Solo does not touch it.
4.7 A verdict labels its own window's head: the hop leaving is the first of the second just scored.
4.8 A flip to open relabels what is held; the first window is still held when its verdict lands, and nothing voiced leaves before one exists: the opening window is spent learning who is speaking, so a stranger who talks first is never heard. The take keeps every byte; the live copy loses its first two seconds, and a press shorter than one window has no verdict to wait for and is released whole.
4.9 A word-side filter was built and withdrawn: judging each recognised segment by the median of the take's windows over it put the kept voice at 0.406 and every mixed segment at 0.236-0.339, so it cut the kept voice; the record sits here so the next sweep does not rebuild it expecting a different answer. A level-based overlap tracker went the same way: 6 dB above the tracked source flagged 8 frames of 291 on a two-voice take, and the frames it called "single source" scored 0.015-0.442 against the profile — two voices of similar loudness are not separated by energy, which is what an overlapped-speech model is for.
5.1 Three profiles, a fourth refused; whichever is enabled is let through, the rest is a stranger.
5.2 A cold is one of the three, switched on like any other: no mark, no expiry, whoever runs it decides.
5.3 A closed Solo is drawn: the refusal is visible, never silent.
5.4 Silence reads as lost speech; a line of state costs less than a lost utterance.
5.5 A profile is made in Settings, on the Solo card, two ways and both by an act: six seconds recorded on the spot, or a recording the owner points at ("From last recording"). The second is the stronger one for Solo's purpose — the sample then comes through the same microphone and room the desk judges, and measured 2026-11-21 the condition mattered as much as the speaker (0.528-0.734 across conditions against 0.447-0.495 between two voices). A take that cannot teach still refuses with its reason: two voices in it, or speech shorter than the window.
6.1 Tests: a word on the gate's edge, zeroing that keeps the timeline, off that changes nothing.
6.2 A new model is its own decision; the weights here are a file, and whoever runs it decides.
6.3 Never: a cut word, a dropped byte, a shifted timeline, a silent refusal, a fourth profile.
6.4 Off is proved by byte equality: same input, same output, same count, and no object to switch.
7.1 The gate, pure: a scorer injected, one hop out, the byte count kept — the tests are the first half.
7.2 The embedder and a profile store: MFCC as the floor, CAM++ as the shipped file — one ONNX, loaded lazily, dropped when the recording ends.
7.3 The call site: one line after the recovery chunk, and the flush on finalize, nothing else.
7.4 Settings: three slots, one switch each, one Forget per voice — a press on an empty slot asks whose voice it is, then records six seconds of the person pressing it, saying the printed line; the countdown, the row's "Learning…" and the window's red dot say it is running, and the capture is kept beside the profiles as the evidence the vector came from — never as a take, never in History, so a later sweep can tell whose voice landed in which slot.
7.5 Smoke on real takes: the thresholds are measured there, and the tail is the number that sweep paid for.

8. The desk as it stands (2026-11-25, 1.6.42)
8.1 A track is made by a take, never in Settings: the owner presses "That is me"
    while recording, the gate keeps the audio it was handed, and the press
    claims that voice for the take (measured separation 0.82 against 0.41).
    A name is asked next and the vector is stored as a track
    (POST /api/voice/claim/save); the claim is dropped when the take ends.
8.2 Settings only switches and forgets: nine rows, no recording press, no
    script, no countdown. An empty row says how a track is made. The press it
    used to carry was removed for a measured reason, not for taste: a profile
    learned away from a take comes through another audio channel, and scored
    its own owner at 0.34 against a 0.42 close while the take's own channel
    separated him at 0.82.
8.3 Every tracked version counts: the gate compares a window with all learned
    tracks and passes it on the best match. No track is chosen in advance - a
    first-filled guess withheld the owner and let the neighbour through on a
    real take.
8.4 The card lights what matched: each verdict carries the score per track,
    and every row at or above open_at glows. A version that never lights is a
    version doing nothing.
8.5 Thresholds on the diarizer's own scale: open 0.50, close 0.42, where 0.5
    means "as close to this room's owner voice as to the other one". A
    hand-tuned pair on the profile still wins.
8.6 The press counts itself: two seconds of the take is the floor, counted in
    the window from the moment the take starts, not from gate reports - a
    quiet room sends none. The button says "speak (0.8 s of 2)" and then
    "keep my voice (2 s)".
8.7 A full store refuses the save instead of overwriting a track.
