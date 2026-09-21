# What an applicable module has to record

A real pilot finished with fourteen module outcome documents. Each was a
heading, a blank line and one paragraph — between 37 and 77 words. One of them
covered authentication, one-time codes, rate limiting, sessions, server-side
authorisation and privacy tooling in sixty words, and ended by saying that
configuration and adequacy still had to be verified. It was recorded
`CONFIRMED`. Every check passed.

Nothing was wrong with the *engine*: a document existed, its digest matched, a
settled question pointed at it. What was wrong is that the document did not
record the module. It summarised the fact that the module had been discussed.

## The rule

**A module outcome is the record of the module, not a summary of it.** If a
reader who was not in the conversation cannot act on the document without
asking you a question, the module is not recorded.

## What an applicable module records, where each applies

Not a checklist to pad out. A module that genuinely has no error cases records
that it has none and why; a module that has twelve records twelve.

- **Purpose** — what this module was for, in this project.
- **Observed facts** — what you read in the folder, with the file and the line.
- **The user's answers** — in their words, not paraphrased into yours.
- **Decisions** — what was chosen, by whom, with the identifier.
- **Reasons** — why, so a successor can tell whether the reason still holds.
- **Alternatives rejected** — and what would make one of them right again.
- **Assumptions** — every premise nobody has verified, marked as one.
- **Requirements** — what the result must do, with identifiers.
- **Flows** — the sequences a user or a system actually goes through.
- **States and transitions** — what can be true, and what moves between them.
- **Errors and edge cases** — what goes wrong, and what is supposed to happen.
- **Dependencies** — on other modules, on external services, on facts not yet known.
- **Risks** — what could make this wrong.
- **Mitigations** — what is being done about each, or that nothing is.
- **Acceptance criteria** — how somebody decides this module's work is done.
- **Verifications required** — what has to be proven, and by whom.
- **Documents produced** — with paths and identifiers.
- **Consequences for other modules** — what this forces elsewhere.
- **Open points** — what is still unresolved, and what would resolve it.

## Length is not the measure, and never becomes one

A two-page document can record nothing. A short one can record a module that
genuinely had one decision and no error cases. Neither the engine nor this
skill counts words, and neither should you: a word count is the easiest thing
to satisfy without doing the work, and adding one would make a short honest
document fail while a long empty one passed.

The test is a question, and you answer it before you record:

> If I handed this document to a competent stranger and left the building,
> what would they have to ask me?

Every answer to that question is a gap in the document. Some of them are
legitimately open points — write them down as open points. The rest belong in
the document before it is recorded.

## When the module genuinely does not apply

Record `NOT_APPLICABLE` with the reason, or `DEFERRED` with what would reopen
it. Both are honest, both stay available, and both are better than a
`CONFIRMED` paragraph. An unexamined module is not an inapplicable one.

## How this is checked

It is not, and cannot be. No deterministic check can tell a thorough document
from a plausible one, and this skill will not pretend otherwise by counting
something. What the engine checks is that somebody has **attested** the depth:
`plangonaut sufficiency-review` records who read these documents, what they
looked at, what they found missing, and what they concluded. The engine
verifies that the attestation exists, is current and does not contradict the
ledger. It does not grade it.

That is the honest division. The judgement is yours and the user's; the record
of whose judgement it was, and against which version of the plan, is the
engine's.
