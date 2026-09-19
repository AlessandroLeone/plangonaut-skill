# Studio and the CLI

## Capabilities, not version numbers

`alpha.4 < alpha.5` says nothing about whether the older writer produces events
the newer reader can replay. It might, for a release that changed nothing about
the format; it might not, for a patch that changed everything. Reasoning from the
version string is what let a desktop build append an event that broke a project's
history.

So each side declares what it can do, and the project declares what it needs:

| Declared | Meaning |
|---|---|
| schema version | the state shape it speaks |
| event formats read | histories it can replay |
| event format written | the single shape it produces |
| replay | whether it can rebuild a state from events |
| governed operations | the mutations it implements |
| minimum writer format | what the project's history requires of an appender |
| last engine version | what wrote the project's last event |

Ask on behalf of any writer:

```
plangonaut compat-check --project-root . --json \
  --writer-engine plangonaut-studio --writer-version 0.3.0-alpha.4 \
  --writer-event-format 1 --writer-reads-formats 1
```

## The canonical writer

Studio does not maintain a second implementation of the event format. A format
with two implementations has two behaviours the moment one of them changes.

Of the three available shapes — delegate governed mutations to a compatible CLI,
ship a versioned copy of the engine, or be read-only for governed documents when
the canonical writer cannot be reached — the third is implemented. It is the
smallest and it makes the guarantee true now: the CLI is the only thing that
writes governed events.

Delegation is the intended next step and needs a channel that does not exist yet.
Bundling the engine is a distribution change larger than the defect.

## What Studio does when it cannot write

Before the idempotency key, before the lock, before a byte, every governed
mutation asks whether this build may append to this history. When it may not:

- the document stays open, readable, searchable and indexable;
- the governed editor is read-only, and says why;
- no event is written, not even a partial one;
- no lock is taken, and none is left behind;
- the user is shown both event formats, the engine that wrote the last event, and
  a command they can copy that does what Studio will not.

This is a correct, expected state for a project governed by an engine the build
does not match. It is not an error and should not be reported as one.

**Ungoverned Markdown is unaffected.** It has no ledger, no digest chain and no
event format, so nothing about writer compatibility applies to it, and it stays
editable.

## Reading is always safe

Opening, previewing, indexing, searching, asking the assistant, navigating,
checking compatibility and closing without saving change no byte of the project
and leave no lock. That is asserted by a byte-for-byte snapshot rather than
claimed.
