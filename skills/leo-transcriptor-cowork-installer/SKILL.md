---
name: leo-transcriptor-cowork-installer
description: "Installer of the skill `leo-transcriptor-cowork`: the desk this workspace contributes Voice-Transcriptor from — one branch, one amended commit behind a draft request — and the two voice patterns the contribution exists for."
---

> **MUST on each edit → reinstall:** the rules are not this package's; they arrive through the dependency's ports, read whole before any edit, never restated here.
> **Stops:** halt after editing the specs, before the render (list the changed files), and after the render, before it replaces the installed skill (show the diff) — ask in chat, one line. One entry point, no script, no state of its own.

# leo-transcriptor-cowork-installer

## What it installs

The workspace skill `leo-transcriptor-cowork`: `SKILL.md` alone, rendered from `assets/template.SKILL.md` with every slot resolved on the install run.
No port and no data file: the owning workspace's chats read the skill directly, no other skill consumes it, and nothing is called or logged at runtime.

## Goal

What the contribution exists for: the on-demand voice pattern and the default voice pattern, both for coworking.
Each is one act — a speaker inviting a partner explicitly — where the alternative is a negotiation of who speaks when.
On demand, the partner is absent until summoned, and one summons buys one utterance.
By default, the partner stands in the session's channel, and the summons was that session's opening.
Dictation by hotkey is already the first: one press per utterance, and nothing listens between presses.
The second is absent, and its absence is the study — which state says who stands in the channel, which act admits a partner, which stop closes only its own utterance.
None of it is built here. This package installs the desk the study is run from, and the desk is the first contribution.

## Install

`references/install.md` is the algorithm: the slots, the calls the dependency answers, the render, the checks and the write.
Read it whole before the first step; never render from memory.

### Dependencies

| skill | port | requirement | consumed when |
| --- | --- | --- | --- |
| `workbuddy-modular-skills` | `gate` | required, install-time | the declaration check, the authoring pair and the echo check, before the render |
| `workbuddy-modular-skills` | `deps` | required, install-time | the rows in this table, re-read whenever one moves |
| `workbuddy-modular-skills` | `installer` | required, install-time | the rules this document is written under, while the specs are edited |
| `workbuddy-modular-skills` | `installed` | required, install-time | the surface the render leaves, before and after the write |
| `workbuddy-modular-skills` | `ports` | required, install-time | the absence of a port, which is this skill's declared surface |
| `workbuddy-modular-skills` | `handoff` | required, install-time | the paths the render writes into the frontmatter |

The dependency is taken whole, at install, and never at runtime: the installed skill calls nothing and reads nothing beside itself.
Its contract is the one its ports stand beside; no command, flag or answer of it is written here.
The authoring pair the rules name is presumed before the install, reaches no port, and is never a row.
