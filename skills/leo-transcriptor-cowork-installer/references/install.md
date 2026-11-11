# Install — pseudocode

Five steps, in this order. A step that cannot answer halts the run, and nothing is written before the last one.
Every call carries `--client leo-transcriptor-cowork`, which is the skill's own name: it is the consumed party, not a consumer.

## 1. Slots

The run resolves, in this order, and keeps them for the render:

```
installer-path      absolute directory holding SKILL.md, assets/ and references/
installer-files     every file of that package, relative, ascending, one per line
installer-sha256    digest over that list: each path, a line break, its bytes, line breaks normalised
external-paths      every owned thing outside the workspace — the working copy, alone
clone-path          the working copy this desk pushes from
remote              that copy's origin
branch              the one branch every request lands on
pull-request        the branch's draft request; empty until one opens
```

A slot the run cannot resolve to one value halts it; a second candidate is a question for the owner, not a choice.

## 2. Probe

Before any write, the dependency answers, each call carrying the client above:

1. `gate --deps --installer <package>` — every row above is declared, stands among the rows of the table, and its port is present.
2. `gate --preflight --installer <package>` — the authoring pair is installed, its checks run through the port the frontmatter comes through, and the vetter's list is scanned.
3. The five groups, in parallel: `deps`, `installer`, `installed`, `ports`, `handoff` — every rule read whole, none summarised.
4. `gate --rules <the rules file its own README names> --target <this document>`, then again against the template — no line of either restates a rule.
5. `gate --budget --installer <package>` — no file and no line past what the rules allow.

A refused call, or one reporting a hit, halts the install at that step, naming the step.

## 3. Render

The template is copied whole. Each slot line keeps its key and takes one value from step 1.
The body below the frontmatter is copied unchanged: the render adds nothing, removes nothing, and reorders nothing.
A slot left as text, or a value written into the body, halts the render.

## 4. Check

The rendered file is read back from disk, never from memory:

```
every slot resolved, and every other frontmatter key intact
no path in the body: each one is a frontmatter fact
the file and line budget
the echo check against the rules
the installed surface, its own pass
```

## 5. Write

The render goes to a staging file beside the installed skill, and one replace puts it in place; the installed file loses its write bit.
The previous build is rendered a second time from the same package and diffed against the new one: the same bytes, or the difference is explained before the write.
A diff nobody can explain is a bug in the render, and the install halts on it rather than shipping it.
