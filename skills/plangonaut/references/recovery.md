# Recovery, and what cannot be recovered by deciding

## The rule that has no exception

A human decision changes what a project does. It cannot change what happened.

An owner may decide that a risk is accepted, that a requirement is dropped, that
a date matters more than a feature. None of those is a statement about whether a
recorded history reproduces a recorded state. So no decision, override,
acceptance or priority call makes any of these valid:

- a state that cannot be rebuilt from its events;
- an event that records no applicable mutation;
- a broken digest chain;
- an incomplete transaction;
- a change nobody recorded;
- a schema violation;
- a governed artifact written outside the flow;
- an incompatible event format.

The engine has no flag for it, deliberately. Execution readiness and handoff
readiness both fail while one stands, and nothing may be written on top of a
history that cannot be replayed — a verifiable event appended to an unverifiable
one is how a small break becomes a large one.

**Never tell a user you have stopped counting a mechanical failure because they
asked you to.** Say what it is, what it blocks, and what the one safe way
forward is.

## What the diagnosis tells you

`plangonaut replay --verify --project-root .` reports, for the line that fails:
the event line and id, its type, the event format detected, the required fields
it does not carry, the current value, whether anything is reconstructible, the
last verifiable event, how many events follow it, the category of the defect,
which engines are implicated, the safe remedy, and the remedies that are
forbidden because they destroy.

`validate --strict`, `status` and `handoff-check` agree with it, because all four
read the same diagnosis.

## Why `replay --repair` is usually the wrong answer

`--repair` rebuilds the state from the events it can apply. When the defect is an
event it *cannot* apply, followed by events it can, rebuilding "what is
applicable" produces a state that is internally consistent, verifies cleanly, and
silently does not contain what those events recorded.

So it refuses, and says how many events would have gone. It is the right command
for a state that drifted from an intact history, and the wrong one for a history
with a hole in it.

## `baseline`, and the boundary of its proof

A baseline records a new starting point. From there on the history replays; before
it, the events stay in the file, readable and explicitly outside the proof.

Look before you take one:

```
plangonaut baseline --project-root . --dry-run --reason "<why>" --owner <name>
```

It prints how many events would be left outside the proof, the defect it steps
over, and a confirmation token derived from the state it described — so a
baseline confirmed against a project that has moved on is refused rather than
applied to something nobody read. Then:

```
plangonaut baseline --project-root . --reason "<why>" --owner <name> --operation-id <id> --confirm-token <token>
```

It backs up the state and the history first, is idempotent under the same
operation id, records which engine drew the boundary and what it stepped over,
and refuses while another writer holds the project.

**A baseline is not retroactive evidence.** It does not make the events before it
reproducible and it does not verify them. Anything resting on them rests on them
exactly as much as it did before. Say so when you report one.
