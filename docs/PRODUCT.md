# Product

## Register

product

## Users

People who need a reliable desktop transcription workstation: live microphone transcription, uploaded audio transcription, AI cleanup, local history, and fast reuse through global hotkeys, a single recording status capsule, and auto-paste.

People who give feedback about what is on their screen — reviewing a site, an app or a design, or briefing an AI agent — and need what they say tied to what they point at.

## Product Purpose

Transcriptor is a desktop voice transcription app for macOS, Windows, and Linux. It exists to turn speech and audio files into usable text with dependable local history, provider choice, clear runtime health, and packaging that can be rebuilt from a single source of truth.

Screen mode (macOS) extends the same recording to the screen: while dictating, the user draws over anything on screen without losing the ability to click through it, and takes screenshots with the drawings. The transcript is cut into one section per screenshot — its heading names the screenshot's file and time span, its strokes' frames follow on one line, and under them is what was said since the previous screenshot, with a numbered mark where each stroke began in speech (closed where it was released) — plus a last section for what was said after the last screenshot. A short header names the screenshots' folder once, says how to read the marks and states the file names once, by rule. It is written for the agent that acts on the feedback; the screenshots are kept with the recording itself — one archive entry, one retention rule, one place to find them.

Drawing has two tools, a rectangle (where every take starts) and a pen, and every stroke shows its number on the screen and in the picture. The rectangle is the default, so its marks name only colour and place; a rectangle dragged flat reads as a line. With the "record clicks" setting on (it is off by default), every plain click is a ring on the next screenshot and a click mark in the text. A screenshot is the window the user is looking at — not the menu bar, the Dock or the rest of the display — unless there is no such window or a stroke lies outside it, and the manifest says which. Beside each screenshot the app writes a downscaled copy and a close-up of each stroke, so the agent reading the feedback looks at a fraction of the pixels.

## Brand Personality

Precise, restrained, operational.

## Anti-references

Avoid decorative SaaS chrome, marketing-style hero layouts, noisy color, fragile temporary fixes, duplicated state sources, and UI patterns that obscure the transcription workflow.

## Design Principles

- Keep the transcription workflow first: recording, upload, cleanup, history, and recovery must remain immediately legible.
- Preserve SSOT for product facts, theme tokens, versions, runtime health, and provider configuration.
- Make states explicit: permissions, backend health, network mode, recording status, progress, errors, and completion need clear durable affordances.
- Prefer familiar desktop product patterns over novelty: dense, consistent, keyboard-friendly controls beat decorative invention.
- Keep fixes durable: changes should reduce future ambiguity rather than add local exceptions.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls, preserve keyboard access for core workflows, do not rely on color alone for status, and respect reduced-motion preferences for state transitions.
