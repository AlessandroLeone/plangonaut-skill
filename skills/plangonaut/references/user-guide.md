# Plangonaut User Guide

Plangonaut prepares a complete multidisciplinary project folder through the user's chosen AI host. The agent investigates, asks necessary questions, records decisions and specifies how to execute, verify, recover and finish the agreed outcome. No total cap on questions or documents limits applicable coverage.

## One method, two operating profiles

| Aspect | Semantic-only | Hybrid / programmatic |
|---|---|---|
| Method | Markdown skill/references or Portable Edition | The same method plus CLI |
| Meaning and questions | Host AI and human | Host AI and human |
| Project completeness | COV-001 and EXEC-001 | Identical COV-001 and EXEC-001 |
| Persistence | Approved host file tools or full documents delivered for manual saving | Supported engine operations plus host semantic work |
| Mechanical assurance | Host/manual review; no automatic engine guarantees | Implemented structural validation, versions, history and Resume |

Semantic-only is valid at any project size. Hybrid adds repeatable mechanics, not deeper thinking or more complete requirements. Neither profile proves completeness merely by creating files. Read [coverage-contract.md](coverage-contract.md) and [execution-package.md](execution-package.md).

Three things are distinct:
1. Plangonaut's distribution: source repository, Markdown skill, npm package or packaged CLI executable.
2. The user's project folder: specifications and operating instructions produced with Plangonaut. It need not be an npm project or Git repository.
3. Studio: optional desktop reader/editor and analysis app; its executable is not the CLI executable.

Installing only the skill makes it discoverable and does not activate Hybrid. npm/npx and verified CLI executables distribute programmatic capability, not a reasoning model. Check actual release availability and platform support; planned commands are not publication evidence.

## Start or resume

1. Provide the skill/references or Portable Edition and inspect existing project sources.
2. Establish missing collaboration decisions: interaction mode, persistence and owners. Reuse valid earlier answers.
3. Survey the outcome and disciplines; maintain the concern register. Ask unresolved questions in small turns without a total cap.
4. Save confirmed answers incrementally within authority. Build the EXEC-001 package and obtain outstanding consequential approvals.
5. Check the actual folder and issue a scoped readiness assessment. Manual delivery remains pending until saved files are checked.
6. When authorized, the same agent may continue or a different agent/runtime may consume the folder. No board review, Studio or model change is mandatory.

Guided asks one question per turn; Standard up to two related questions; Expert up to three with more technical discussion. Every mode covers applicable concerns and requires evidence appropriate to the risk.

## Resuming: what it looks like end to end

This is the whole point of the ledger, so here is the whole thing, with nothing
left out.

**1. Plangonaut asks.** Before the question reaches you, it is recorded:

```
plangonaut qa-ask --project-root . --id QNA-0007 \
  --question "Who approves a completed job, and before or after it syncs?" \
  --rationale "Module 2 cannot be recorded without the approval path." \
  --module 2 --owner Ada --agent codex/session-a --operation-id ask-7
```

**2. You answer.** Your words are recorded exactly, from a file so nothing is
reshaped by the shell:

```
plangonaut qa-answer --project-root . --id QNA-0007 \
  --answer-file answer.txt --owner Ada --operation-id answer-7
```

At this instant the answer is recorded and **not applied**. `plangonaut qa-log --open`
says so.

**3. Plangonaut records what it understood and what changed:**

```
plangonaut qa-settle --project-root . --id QNA-0007 \
  --interpretation "Supervisors approve after sync; offline jobs queue." \
  --reply-file reply.md \
  --consequences DEC-0007,REQ-0011 --documents docs/operating-model.md \
  --next-id QNA-0008 --next-question "What happens to a job rejected after sync?" \
  --owner Ada --operation-id settle-7
```

**4. The session ends.** A crash, a closed laptop, a context compaction, a
finished day. Nothing is saved on the way out because nothing needed saving: each
of the three steps was a transaction.

**5. A different agent opens the project.** Not the same tool, not the same
vendor, no access to the earlier conversation. It is handed the folder and one
sentence: *"use Plangonaut and resume this project"*.

**6. It runs `plangonaut resume --project-root .`** — because that is what being
activated inside a Plangonaut project means, not because you remembered to ask — and
reads:

```
## Interview history

- Recorded interactions: 7 (history available since 2026-03-02T09:14:51.402Z)
- Readable at: QUESTION_ANSWER_HISTORY.md
- Last completed interaction: QNA-0007 — Who approves a completed job, and before or after it syncs?
  - Module: 2
  - Records changed: DEC-0007, REQ-0011
  - Documents changed: docs/operating-model.md
- Planned, not asked: QNA-0008 — What happens to a job rejected after sync?

## Where to continue

**Start here.** Exact next action, as recorded: Record module 2, then open G2.
```

**7. It continues from QNA-0008.** It does not ask you again who approves a
completed job: that question is `ANSWERED`, its answer is in the ledger, and its
consequences are recorded. If the session had died between steps 2 and 3, Resume
would instead have said *"answered and not applied"* and the new agent would have
finished that transaction before asking anything.

The recovery your own tool offers — `codex resume`, `claude --resume` — restores a
conversation you had. This restores the project, to an agent that never had one.

## Using the CLI

Inspect `plangonaut help` and the installed version. From a built checkout use `node lib/bin/plangonaut.js help`. Establish authority and persistence before init.

### The first command: `init` and its owners file

This is the canonical description of the first executable command. Other surfaces point here instead of restating it.

`init` is the first command that writes anything, and it will not run until it knows who decides. It requires `--owners-file`: a small JSON file naming the five decision authorities the engine stores. There are exactly five, the names of the keys are fixed, and a sixth key is refused rather than quietly dropped.

| Key | The authority it names |
|---|---|
| `product` | scope and priorities: what the outcome is, and what it is not |
| `technical` | architecture, stack, technical feasibility |
| `budget` | money, time and resources that may be spent |
| `safety` | data, privacy, security, destructive and irreversible actions |
| `release` | publication, deployment, what reaches real users |

One person may hold several roles: write the same name in each key. A value may name a role or a body rather than an individual when that is who actually decides. Every key must be present and non-empty. Authorities the project needs beyond these five — compliance, legal, clinical sign-off — are recorded in a governed document and referenced from there; the engine stores five and refuses what it cannot keep, so nothing is lost silently.

A complete minimal `owners.json`, saved in the project folder it describes:

```json
{
  "product": "Ada Moreau",
  "technical": "Ada Moreau",
  "budget": "Ada Moreau",
  "safety": "Dr. Chen (external safety reviewer)",
  "release": "Ada Moreau"
}
```

`--owners-file` takes a path, absolute or relative to the current directory, so `--owners-file owners.json` is enough when the command runs from the project folder. The file is read once, at `init`. The names are copied into the recorded state and nothing re-reads the file afterwards; keeping it beside the project documents its input, and deleting it breaks nothing.

The whole first command, run from a project folder that already exists — `init` does not create the directory:

```
plangonaut init --project-root . --project-name "My project" --project-mode Genesis --interaction-mode Standard --owners-file owners.json --operation-id first-init-2026-09-11
```

From a built checkout, `node lib/bin/plangonaut.js` replaces `plangonaut`. `--project-mode` is one of Genesis, Adoption, Reconstruction, Evolution or Resume, defined under Modes in the skill instructions; `--interaction-mode` is Guided, Standard or Expert. `--operation-id` is yours to choose and must be 3 to 128 letters, numbers, `.`, `_`, `:` or `-`; reuse it only to retry the identical command. On success `init` prints the state location and sets the next action to `plangonaut next --project-root .`.

The refusals, verbatim, so they are recognisable before they are met:

> `Missing required option --owners-file`

> `Owners file requires product, technical, budget, safety, release` — a key is absent or its value is empty.

> `Owners file declares roles Plangonaut cannot store: <keys>. Recognised roles are product, technical, budget, safety, release. Record the other authorities in a governed document and reference them there; nothing was written.`

None of them writes anything. Fix the file and run the same command again.

The audited alpha exposes capabilities, init, status, next, resume, record, the typed ledger commands, the blocker ledger (`blocker-record`, `blocker-resolve`, `blocker-verify-none`), override, reconcile, re-record, gate, context-pack, validate, govern, handoff-check, migrate, migrate-backups, document operations, project-export/project-verify/project-import, install, verify-install and skill export. Any command takes `--help` for its own options, and where there is a flow rather than a list of arguments — `doc-save` — it prints the whole of it. Read [engine-contract.md](engine-contract.md) for exact options and limitations. Structural gate checks do not replace semantic concern review.

### Writing a document so it counts

A document Plangonaut governs is written with two commands, never with an editor or a
file-writing tool. The first writes nothing:

```
plangonaut doc-diff --project-root . --id ART-ARCH --base-path docs/architecture.md \
  --content-file draft.md --owner Ada
```

It prints the diff that would be applied and a `confirmation_token`. Read the diff —
that reading is what the token attests to — then write it:

```
plangonaut doc-save --project-root . --id ART-ARCH --base-path docs/architecture.md \
  --content-file draft.md --owner Ada --confirm-token <token from doc-diff> \
  --operation-id OP-ARCH-1
```

The token has no expiry. It is a digest of six things — the artifact, the base path, the
owner, the artifact's current revision and digest, and the digest of what you are
proposing — so it stays usable until one of them changes, and stops the moment one does.
A `doc-diff` that reported blockers hands out an empty token, so a preview the engine
refused cannot confirm a save.

**If you already wrote the file by hand**, pass that same file as `--content-file`.
Identical bytes are adopted into the ledger rather than overwritten, and the result says
`adopted_existing_file: true`. Different bytes are still refused: the file may be
somebody else's.

`plangonaut validate` reports Markdown that looks like it should be governed and is not —
a `*-v<N>.md` file no artifact claims, or a new document inside a governed directory. It
is a warning; `--strict` makes it a failure. If a file is deliberately outside the
ledger, say so once instead of ignoring the warning forever:

```
plangonaut govern --project-root . --exclude docs/appunti-v1.md \
  --reason "working notes, not a project document" --owner Ada --operation-id OP-GOV-1
```

### Before you hand the folder to somebody else

```
plangonaut handoff-check --project-root .
```

`validate` asks whether the record is sound. This asks a different question: whether the
folder is *enough* for somebody who was not in the conversation. The two are not the
same, and a project can pass the first for months while failing the second.

It refuses on things that would stop a recipient: a path to something outside the folder
that no document qualifies, a module still `NOT STARTED`, an empty requirements,
decisions or tasks ledger, an answer recorded and never applied, an override left open,
a decision marked `APPROVED` that cannot name who approved it, a module marked
`CONFIRMED` over its own open questions, and a document sitting outside the ledger where
nothing can notice it changing.
It reports, without refusing, the things worth knowing: a deep dive that left most
modules untouched, a document outside the ledger, a blocker ledger nobody ever confirmed
was empty.

When a document genuinely has to point outside the folder, mark the line for what it is —
`(external dependency)`, `(historical reference)`, `(example)` or `(informative)` — so the
recipient learns that it is needed and absent, instead of finding a path that does not
resolve on their machine.

### Who decided it

An `APPROVED` decision is the strongest thing in the folder: everything after it
is entitled to assume somebody with the authority chose it. So Plangonaut wants
to know who, and there are three ways to tell it.

The usual one is free: answer the question the decision came from, and settle it
naming the decision.

```
plangonaut qa-settle --project-root . --id QNA-0004 --interpretation "..." --reply "..." --consequences DEC-0007 --owner Ada --operation-id op-settle-4
```

If the decision was taken outside an interview -- and on an existing project most
of them were -- point at where it was written down, in the decider's own words,
in a file inside the folder:

```
plangonaut decision --project-root . --id DEC-0007 --title "..." --status APPROVED --owner Ada --provenance-note docs/design-review.md --operation-id op-dec-7
```

The third way is a recorded override, with `--provenance-override OVR-0002`.

Nothing refuses the write. What happens instead is that Plangonaut says out loud
that it cannot see who approved it, `validate` repeats it, `validate --strict`
fails, and `handoff-check` will not let the folder go out like that. If the
answer really has not come back yet, the honest status is `PROPOSED`, and it is
always available.

The same goes for a module: `CONFIRMED` means the project may build on it, and
Plangonaut will tell you when the module's own records say otherwise -- an open
question, a proposal nobody accepted, or nothing recorded against it at all. A
module that does not apply is `NOT_APPLICABLE` with the reason; one for later is
`DEFERRED`.

### How many questions at a time

Five, unless you say otherwise. Say so at the start — three if five is too many,
ten if you would rather work in longer stretches — and Plangonaut will keep to
your number. You can change it whenever you like.

Your answer is written into the project, not just remembered for the afternoon:

```
plangonaut next --project-root . --count 3 --remember --owner Ada --operation-id op-block-3
```

After that, `plangonaut next` gives you three at a time, and so does whoever
picks the project up next month. Asking for a different number just once —
`--count 8` with no `--remember` — is a one-off and changes nothing.

That number is about one turn, not about the whole interview. There are as many
turns as the project needs, and the interview finishes when every part of the
questionnaire has been confirmed, deferred or recorded as not applying — never
because a counter ran out.

### Recording what is holding the project up

Write a blocker down and it counts; leave it in your head and Plangonaut will say it does not know.

```
plangonaut blocker-record --project-root . --id BLK-HALL --title "The hall is not booked" \
  --reason "The venue has not answered in three weeks" --owner Ada --operation-id OP-1
```

When it is cleared, **resolve** it rather than deleting it — the record stays and gains how it
ended, because a blocker that happened and was cleared is part of the story of the project:

```
plangonaut blocker-resolve --project-root . --id BLK-HALL --resolution "Booked for 12 June" \
  --owner Ada --expected-revision 1 --operation-id OP-2
```

And there is a third command, which exists because of a distinction that is easy to lose. Resolving
the last blocker says something about *that blocker*. It does not say the project has none — nobody
looked. So after resolving, Plangonaut goes back to answering `UNKNOWN`, and if you have looked and there
is genuinely nothing open, say so and put your name to it:

```
plangonaut blocker-verify-none --project-root . --owner Ada --note "checked the venue thread" \
  --operation-id OP-3
```

Only then does `status` answer `NONE_VERIFIED`. It is refused while anything is still open, and it
names what. An empty list is not an answer, which is the whole reason these three commands exist.

If your project was created by an earlier alpha and has blockers written as plain sentences, they
stay exactly as they are. Plangonaut counts them as open — nothing ever recorded them as resolved — and
will not invent an owner or a date for them. To close one, record it properly first, so that closing
it leaves a trace.

Maintain COV-001 detail in indexed Markdown and link its confirmed records through the supported ledgers. `export` generates the Plangonaut skill or adapters; `project-export` creates the user's verified handoff package.

Give every mutating command a new caller-generated `--operation-id`; an exact retry is safe, while different inputs under the same ID are refused. Before `doc-save`, run `doc-diff` and pass its returned `confirmation_token` as `--confirm-token`. The token binds the approved preview to the actual save. Keep the complete project directory available during work; `project-export` creates a verified transfer package containing governed drafts, published documents, evidence, state and event history.

## If something was interrupted, or looks wrong

Three commands, and the differences between them matter.

**`plangonaut replay --project-root .`** rebuilds your project's state from its
recorded history and compares the two. It changes nothing. On a healthy project
it says so in one line:

```text
History replay: the state matches its history exactly (14 events from PROJECT_INITIALIZED, through revision 14).
```

On a project whose `state.json` was edited outside Plangonaut it names the fields:

```text
History replay: DIVERGED. The state on disk is not what its own events produce.
  decisions.0.title: rebuilt as "Bake weekly"
Repair it with: plangonaut replay --project-root . --repair --operation-id <id>
```

While that is true, Plangonaut refuses to write anything on top of it and `resume`
gives you no position rather than a position it cannot stand behind.

**`plangonaut replay --project-root . --repair --operation-id <id>`** puts the rebuilt
state back. It copies what was there into `.plangonaut/backups/` first — a repair
never means a loss — records the repair as an event, and regenerates the derived
documents. Run it when the state was damaged. If the edit was something you meant
to do, make the same change through the command that records it instead.

**`plangonaut recover --project-root .`** tells you whether an operation was
interrupted, and what finishing it would do. It changes nothing until you add
`--apply`, and you usually do not need to: recovery happens automatically on the
way into any command that touches the project, and it says so rather than passing
in silence.

It also names three kinds of damage that are *not* an interrupted write, and none
of them is resolved behind your back: a journal that cannot be read, a leftover
directory with no journal in it, and a last line of the history that was cut off
mid-write. Only the last has an automatic remedy — `--apply` removes that line
after copying the whole file into `.plangonaut/backups/` — because an append is the
last durable write of an operation, so a partial final line cannot be one that
finished.

**If `.plangonaut/state.json` has gone missing** and the history is still there, every
command says so and names the repair. That is the case the replay exists for:
`plangonaut replay --project-root . --repair --operation-id <id>` rebuilds the file.

### If Plangonaut says the project is in use

One project, one writer. Plangonaut takes a lock before it touches anything, so a
second command on the same project waits a few seconds and then tells you what it
is waiting behind — the command, the process, the machine and the moment it
started. Wait for the first one to finish and run yours again.

If a Plangonaut command was killed, the lock it was holding stays on disk. The next
command on the same machine sees that the process is gone, takes the lock over
and carries on: there is nothing for you to do. Three cases are never resolved for
you, because guessing would be how work gets lost — a lock held by a process that
is **still running**, a lock from **another machine**, and a lock Plangonaut **cannot
read**. `plangonaut unlock --project-root .` tells you which of those you are looking
at and changes nothing.

`--force` is for two of them and not the third. It releases a lock whose process
is **known to be gone**, and it releases a lock from **another machine** —
somebody has to be able to break a lock left on a shared folder by a laptop that
is not coming back, and this engine cannot ask that laptop anything. It refuses a
lock held by a live process here, a lock it cannot read, and a lock that does not
say which machine holds it: Plangonaut will not guess about a file it cannot reason
about, and a wrong guess there is somebody's work. For those, make sure no Plangonaut
command is running and delete the file yourself.

*An independent review released, with `--force`, a lock naming a process that was
running at that moment: the record had no `host` field, and "not this machine"
was being read as "another machine".*

### Projects older than this release's sufficiency gate

A project recorded before `0.3.0-alpha.7` has no sufficiency review, and nothing
about that makes it invalid. `plangonaut validate` still confirms its integrity
and `plangonaut replay --verify` still reproduces it from its own history.

What changes is `execution-readiness`: it reports `NOT_READY` and says the review
is missing, naming the command that records one. Nothing is migrated and no field
is invented — recording the first review *is* the migration, and it is a
deliberate act rather than something a tool does on your behalf. An earlier
`passed` is not reinterpreted as a semantic judgement, because it never was one.

If a project of yours read `passed` before this release and reads `NOT_READY`
after it, nothing has gone backwards. The question changed, and the old answer was
to a question nobody had asked.

### Projects older than this

A project created by an earlier Plangonaut has a history that records *digests* of
what changed rather than the changes themselves, so it cannot be replayed. That
project is not damaged — everything works, and `validate` still says
`Plangonaut state is valid.` — but it is told, every time, what it cannot prove:

```text
This project's history has no point the state can be rebuilt from.
Record a starting point with `plangonaut baseline …`
```

`plangonaut baseline --project-root . --reason "<why>" --owner <name> --operation-id
<id>` records that starting point. From there on the project is reproducible.
Everything before it stays in the file, exactly as it was, and is reported as
outside the proof. Nothing is invented to fill the gap, because a history nobody
recorded is not a history Plangonaut is willing to make up.

## Installation, history and recovery

Use a reviewed compatible package or source build. Preview installation destinations with --dry-run and preserve existing installed skills. See [runtime-compatibility.md](runtime-compatibility.md). A source repository does not prove a published npm package or built executable exists.

Semantic-only retains full canonical documents, coverage, decision history and next action through approved host/manual operations. Hybrid adds supported ledgers/events. Unsupported schema requires an explicit backed-up migration; never edit the version number to simulate one. Neither profile relies solely on chat memory.

After consequential changes, record the override, inspect affected work and reconcile meaning. Paid Studio assistance is optional and does not remove free semantic/CLI responsibilities. Preserve superseded decisions and unresolved discrepancies.

## Optional Studio

Base Studio is a local desktop app with clean IDE-style navigation, manual Markdown editing and faithful tree/graph/timeline analysis. File integrity and existing relationship views do not certify semantic consistency. Assisted cross-document review, change-impact analysis and reconciliation are future subscription workflows, not prerequisites for Plangonaut or execution.

Initialization does not launch future project agents. Execution authority, capabilities, physical actors, professional approvals and completion evidence remain explicit in the package.

## Is it defined, or is it ready?

Plangonaut keeps these apart, because they are different questions and a project
routinely passes the first while failing the second.

**Definition** — is the project understood? Problem, users, scope, constraints,
requirements, decisions, risks, expected result.

**Execution readiness** — has that been turned into work somebody can pick up?
Units with an owner, an order, an acceptance criterion and evidence.

**Handoff readiness** — can somebody who was not in the conversation start and
finish from this folder alone?

Ask at any time:

```
plangonaut execution-readiness --project-root .
```

`status`, `resume`, `next`, `validate`, the context pack and `handoff-check` all
carry the same answer.

### The three checks, and what each one is for

| | question | fails on |
| --- | --- | --- |
| `validate --strict` | is the record sound? | schema, replay, references, digests, documents outside the record, structural gaps in the plan |
| `handoff-check` | can somebody who was not here pick this up? | anything the folder needs and does not contain |
| `execution-readiness` | is the work executable, or only defined? | mechanical, structural and semantic blockers, reported apart |

None of them answers another's question, and `validate --strict` in particular is
not a judge of whether a plan is any good. It checks that the record holds
together. An integrity check that failed for want of a human opinion would be
useless for the thing integrity checks are for.

### Ready, conditionally ready, not ready

`execution-readiness` gives one of three answers, and the exit code matches:

- **`NOT_READY`** (exit 2) — something blocks. The output separates what kind:
  mechanical, structural, or a judgement nobody has made.
- **`CONDITIONALLY_READY`** (exit 1) — nothing blocks. The sufficiency review
  recorded limits the project accepts, or verifications still owed, and both are
  listed. This is the honest answer for most real projects.
- **`READY`** (exit 0) — nothing blocks and nothing was set aside.

It also prints what it did **not** judge. A verdict with no statement of its own
scope is how a passing command became "validated in every respect" in a report.

### The sufficiency gate

Plangonaut checks that the record is sound. It cannot check whether an acceptance
criterion means anything, whether the error cases were thought about, or whether
the plan still describes the repository — and it no longer behaves as though it
could. Until somebody records a judgement, `execution-readiness` says `NOT_READY`
and names what is missing.

```
plangonaut sufficiency-review --template > review.json
```

Fill it in: what you checked, the sources you used, the contradictions you found,
the operational decisions still missing, the error cases you examined, the limits
the project accepts, what still has to be proven, and your conclusion —
`SUFFICIENT`, `SUFFICIENT_WITH_LIMITS` or `INSUFFICIENT`. Then:

```
plangonaut sufficiency-review --project-root . --file review.json --owner Ada --operation-id op-review-1
```

Plangonaut does not grade the review. It records **whose** judgement it was, what
they looked at, and **which version of the plan** they looked at — and it expires
the review when the requirements, decisions, tasks, dependencies, risks, module
documents or execution organisation change. A judgement about one plan is not a
judgement about the plan that replaced it. Writing something unrelated, like a
checkpoint, does not expire it.

An unreconciled contradiction or a missing operational decision recorded in the
review blocks readiness until somebody decides. That is deliberate: the point of
writing them down is that they stop being forgettable.

### Resuming after an interruption

The review, like everything else, is an event. `plangonaut resume` picks up where
you left off, `plangonaut replay --verify` proves the state still follows from
its history, and a review recorded before the interruption is still there and
still current unless the plan moved under it.

### If you only want the definition

A study, a proposal, a concept note, a tender, a feasibility analysis — these are
finished when the definition is finished, and Plangonaut will not nag you for a
plan you never wanted. Say so once:

```
plangonaut execution-intent --project-root . --definition-only --reason "The deliverable is the study" --owner Ada --operation-id op-intent-1
```

It will then say, and keep saying:

```
Definition complete.
Execution readiness not requested.
This folder is not an execution package.
```

Plangonaut will never conclude this on its own from the fact that you have no
tasks: a project that is merely unfinished looks exactly the same.

### If it is to be built

```
plangonaut execution-intent --project-root . --execution --reason "The product is to be built" --owner Ada --operation-id op-intent-1
```

Now the operational questions have to be answered before the final review: who
does the work, with what autonomy, in what order, who reviews it, and how anyone
knows a piece is done. Plangonaut proposes the shape of the team — you approve or
change it, you do not invent it from nothing — and the approved answer is recorded:

```
plangonaut execution-org --project-root . --executors 1 --mode human --reviewer Ada --concurrency "one person, one file at a time" --handoff "at each milestone" --owner Ada --operation-id op-org-1
```

One person is a complete answer to "how many". It does not make the rest
optional: you still have a reviewer, a handoff and a point at which work stops.

### Recording what you read

When a plan rests on a document you read, record the reading. The digest is what
turns "I read it" into something checkable later:

```
plangonaut read-record --project-root . --path docs/survey.md --purpose "the basis of the layout" --agent claude --conclusions "The south wall cannot carry load" --owner Ada --operation-id op-read-1
```

`resume` then tells you which files were read and still match, which changed
after they were read, which are only cited, and where there is no evidence at all.

## When Studio will not let you edit

A project's ledger records every governed change with a digest, and each entry is
chained to the one before it. Appending an entry in an older shape breaks that
chain at that line, and everything after it stops being verifiable.

So Studio checks, when it opens a project, whether it can produce the shape that
project's history is at. When it cannot, governed documents open read-only and
say so. You can still read them, search them and ask the assistant about them —
only the governed editor is withheld, and ordinary Markdown stays editable.

Studio shows you both versions and a command you can copy. Running it with the
CLI that governs the project makes the change properly.

Nothing is written when this happens. No lock is taken, no half-finished entry is
left behind, and the project is exactly as you found it.

## When a project's history is broken

If a project has been written by two tools that disagree, `plangonaut replay
--verify --project-root .` will tell you so, and will tell you which line, what
is missing from it, how much history comes after it, and what is safe to do.

Two things are worth knowing.

**You cannot decide your way past it.** Plangonaut has no setting for accepting a
broken history, on purpose. A decision can change what your project builds; it
cannot change whether the record of what happened adds up. Until it is settled,
the project will not report itself ready to execute or ready to hand over.

**`replay --repair` is usually not the answer.** It rebuilds your state from the
entries it can read, and when the problem is an entry it *cannot* read, that
means quietly dropping it and everything after it. It refuses, and tells you how
much would have gone.

## Recovering with a baseline

A baseline draws a line and says: from here on, this history is provable.

Look at it first:

```
plangonaut baseline --project-root . --dry-run --reason "Written by two tools" --owner Ada
```

It tells you how many entries would be left outside the proof and what it is
stepping over, then gives you a confirmation token. Pass that token to record it.
Your old history stays in the file and your documents are untouched.

**What a baseline does not do:** it does not make the earlier entries provable and
it is not evidence that what they say happened. They remain exactly as
trustworthy as they were. That boundary is printed both times, so it is a
decision you made rather than something you discover later.
