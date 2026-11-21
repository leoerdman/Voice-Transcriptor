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
4.5 Two thresholds, not one: open at 0.65, close at 0.55 — measured on a held-out narrator (floor 0.611, median 0.726, strangers at most 0.116). They hold only while the profile and the audio come from the same conditions: measured 2026-11-21 on the owner's desk, one voice across two conditions scored 0.528-0.734 while two voices under one condition scored 0.447-0.495, i.e. the condition shift is as wide as the speaker gap and no single absolute threshold crosses both. A profile learned in the conditions it judges works (Leo 0.00 s withheld, the other voice refused whole); a profile learned anywhere else needs score normalisation against an impostor cohort (AS-Norm), which the desk now carries: with a cohort of 99 impostor windows (never the enrolled voice's own — a window of the kept voice normalising its own trial is how AS-Norm crushes the person it exists to keep) the same four trials scored z 4.54 and 1.57 for the kept voice in two conditions against 0.56 and 0.31 for the other, so the gate opens at 1.5 and closes at 1.0 when a cohort sits beside the store and keeps raw cosines when none does.
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
