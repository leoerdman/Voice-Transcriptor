# A desk for the cowork contribution, and the two voice patterns it serves

## What

`skills/leo-transcriptor-cowork-installer/` — an installer package, no code: a specification, one
reference holding the algorithm, a template, and this text.

## Why

The contribution this branch exists for is a study of two voice patterns for coworking:
on demand, where a partner is absent until summoned and one summons buys one utterance;
by default, where the partner stands in the session's channel and the summons was its opening.

Both are one act — a speaker inviting a partner explicitly — where the alternative is a negotiation
of who speaks when. Dictation by hotkey is already the first pattern: one press per utterance,
nothing listening between presses. The second is what the app does not have, and its absence is the
study: which state says who stands in the channel, which act admits a partner, which stop closes
only its own utterance.

## Not here

No backend, no window, no hotkey, no contract changes. This branch lands the desk the study is run
from, and the desk is the first contribution; the study follows on its own branch.

## TODO

Best practices, to arrive with the owner's material: how a branch is shaped, what one request may
fold into a commit, when a draft becomes ready. The baseline stands until then — one commit,
amended, force-pushed on one branch, with a draft request as the branch's face.

## Verifying

The package is read as text. The gate it depends on answers its declarations, its authoring pair and
its echo check; the render is diffed against a second render of the same package.
