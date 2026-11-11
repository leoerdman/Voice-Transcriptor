# Cowork mask — skeleton
Presumptive; the person running the app decides. Off is the default.
1.1 Mask, never separation: a non-target window is zeroed in the forwarded copy; the byte count stands.
1.2 No preference of its own: the mask is the profiles store read at send time — one knob in the Live pane, one switch per row in Settings, nothing else to keep.
1.3 The take is untouched; profiles and thresholds persist, audio does not; recovery re-processes.
1.4 A refused voice never reaches the provider; the local take still holds it.
1.5 Diarization loses "who was in the room", keeps "which of the allowed".
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
4.3 Close on a voiced boundary with a tail of half a window: 300 ms cut 20 of the owner's hops on the handover fixture, 1000 ms cut none. The frame test is pcm_has_voice.
4.4 A neighbour's word leaked beats a word cut: the asymmetry is the design, not a defect.
4.5 Two thresholds, not one: open at 0.65, close at 0.55 — measured on a held-out narrator (floor 0.611, median 0.726, strangers at most 0.116), not guessed.
4.6 A window with no voiced frame is silence already: the mask does not touch it.
4.7 A verdict labels its own window's head: the hop leaving is the first of the second just scored.
4.8 A flip to open relabels what is held; the first window is still held when its verdict lands.
5.1 Three profiles, a fourth refused; whichever is enabled is let through, the rest is a stranger.
5.2 A cold is one of the three, switched on like any other: no mark, no expiry, whoever runs it decides.
5.3 A closed mask is drawn: the refusal is visible, never silent.
5.4 Silence reads as lost speech; a line of state costs less than a lost utterance.
5.5 A profile is made in Settings, on the Voice mask card: six seconds are recorded by an act, never inferred from a take.
6.1 Tests: a word on the gate's edge, zeroing that keeps the timeline, off that changes nothing.
6.2 A new model is its own decision; the weights here are a file, and whoever runs it decides.
6.3 Never: a cut word, a dropped byte, a shifted timeline, a silent refusal, a fourth profile.
6.4 Off is proved by byte equality: same input, same output, same count, and no object to switch.
7.1 The gate, pure: a scorer injected, one hop out, the byte count kept — the tests are the first half.
7.2 The embedder and a profile store: MFCC as the floor, CAM++ as the shipped file — one ONNX, loaded lazily, dropped when the recording ends.
7.3 The call site: one line after the recovery chunk, and the flush on finalize, nothing else.
7.4 Settings: three slots, one switch each, one Forget per voice — a press on an empty slot records six seconds of the person pressing it, saying the printed line; the countdown, the row's "Learning…" and the window's red dot say it is running, and the capture is thrown away rather than saved as a take.
7.5 Smoke on real takes: the thresholds are measured there, and the tail is the number that sweep paid for.
