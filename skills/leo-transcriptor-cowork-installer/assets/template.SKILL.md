---
name: leo-transcriptor-cowork
description: "The contribution desk for Voice-Transcriptor in this workspace: a request edits one branch by amending one commit and pushing it behind a single draft request, and the two voice patterns — on demand, by default — that let a partner be invited explicitly instead of negotiated with."
installer-path: <resolved at install — absolute directory of the one installer on this machine>
installer-files: <resolved at install — relative paths; their order is the digest's input>
installer-sha256: <resolved at install — digest over the package: each listed path, a line break, its bytes>
external-paths: <resolved at install — absolute path of every owned thing outside the workspace>
clone-path: <resolved at install — the working copy this desk pushes from>
remote: <resolved at install — the remote the branch is pushed to>
branch: <resolved at install — the one branch every request lands on>
pull-request: <resolved at install — the branch's draft request, empty until one opens>
---

> **MUST on each edit:**
> Never modify the installation; reinstall only.
> Reinstall only through the installer under `installer-path`, with `installer-files` matching `installer-sha256`.

# leo-transcriptor-cowork

The desk Voice-Transcriptor is contributed from, and the voice patterns the contribution serves.

## Requests

A request from the owner is work on `branch` in `clone-path`, pushed before the answer ends; work left only on a local branch reads as lost.
One commit, amended. A second commit is a request not folded into the first, and `branch` is never a diary.
`pull-request` is the branch's face: a draft from its first push, rewritten by every push, never opened twice.
`remote` is where the branch is pushed, and it is not the upstream: the upstream takes read and the request, nothing else.
The owner's own working copy is neither read nor written. This desk has one copy, and it is this one.
A push that cannot authenticate is reported in one line, with the command that finishes it — never reported as pushed.
Verification before a commit is the repository's own rule; it applies when the change is code, and this package is text.

## Voice

On demand is the pattern this desk runs by default: nothing listens between transcripts, so one arriving is one turn, addressed here.
Answer that turn whole. Never ask for it again, and never split an answer across a second listening.
Before asking for speech, say in one line what the utterance is for: an invitation names its reason.
Default voice is the owner's to open — the words «голос по умолчанию», or «открываю голос», open it.
Until he closes it, every transcript is addressed here and pays no summons: one opening, many utterances.
While it stands, answer each transcript without asking whether he is still there; that question is the cost this pattern removes.
Silence does not close it. One line asks, once, whether the channel still stands, and his word closes it.

## TODO

Best practices, still unshaped: the owner brings the material, and this block is where it lands.
Until then the baseline holds — no accumulation of commits, one commit amended and force-pushed on `branch`.
Nothing here claims the final shape: the material replaces this block, not the other way round.
