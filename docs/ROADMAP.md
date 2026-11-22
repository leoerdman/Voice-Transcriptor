# Roadmap

Dated tasks for the owner. Product vision lives in `docs/PRODUCT.md`; this file
holds only what has a date and a person to do it.

## Owner

- **2026-12-03 — live check of 1.6.29 (Bluetooth microphone waking).**
  After a pause of more than 5 minutes, dictate through the Bluetooth headset
  (Leo Liberty 5 BT) and confirm the first word is in the text.
  - If the take began with dead frames, the capsule shows "Microphone waking"
    (dimmed amber square) and a second, higher tone sounds when the first sound
    arrives; speak after that tone.
  - `main.log` has `microphone woke: <ms> of digital silence`.
  - Open question: is the second tone audible on the headset? The output should
    already be in the call profile by the first live frame, but it was never
    heard live. If it is not heard, the capsule state is the only signal.
  - Background: the first 0.2–2.2 s of a cold Bluetooth take is digital silence
    (int16 == 0) while the headset switches profile; that audio cannot be
    recovered. Code: `frontend/src/mic-wake.ts`; release 1.6.29 in `CHANGELOG.md`.
