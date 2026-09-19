# Plangonaut Engine Contract

The CLI supplies deterministic mechanics for the same semantic method. The host AI interprets meaning, investigates and writes the project; humans retain consequential authority. Installing a CLI does not supply a reasoning model.

## Runtime and storage

The canonical CLI is TypeScript/Node without mandatory third-party runtime dependencies. Node 24 is the release target; other versions/platforms require compatibility evidence. Python is not required. A verified standalone CLI packages programmatic functionality; the optional Studio executable is separate.

Markdown remains descriptive truth. State JSON is operational state and JSONL logical history. Read-only inspection must not create state. No automatic migration, service, model call or installation is implied.

## Audited alpha command surface

Use `plangonaut help` or `node lib/bin/plangonaut.js help` from a built checkout. Check actual installed capabilities; command presence does not establish full contract enforcement.

| Commands | Purpose |
|---|---|
| capabilities, status, next, resume | Inspect state, propose the next work with the reason it comes first, and report where the interview has been digging |
| validate | Check that state, history and documents agree, and report Markdown the project looks like it should be governing; `--strict` makes that report a failure |
| handoff-check | Ask whether the folder is *enough* for somebody who was not in the conversation, which is a different question from whether it is intact |
| govern | Record that a file is deliberately outside the ledger, with the reason, or bring it back under it |
| migrate-backups | Move a `backups/` directory written by an earlier engine under `.plangonaut/backups/documents/`, verified and with a receipt |
| qa-ask, qa-answer, qa-settle | Open a question, record the answer verbatim, record what the answer changed |
| qa-close, qa-supersede, qa-log | Defer, skip or invalidate a question; replace one without erasing it; read or regenerate the history |
| init, record, override, reconcile, gate | Persist approved module outcomes, corrections and gate records |
| re-record | Re-point the source of an override or the evidence of a gate at the file that supersedes it |
| blocker-record, blocker-resolve, blocker-verify-none | Record a blocker, close one without erasing it, and record that somebody looked and found none open |
| decision, requirement, task, dependency, risk, evidence, agent, checkpoint | Create or revision-check updates to typed ledgers |
| context-pack | Produce restart context and evidence pointers |
| doc-diff, doc-save, doc-history, doc-restore, doc-finalize | Preview and apply governed document revisions and history |
| migrate | Explicit supported schema transition |
| project-export, project-verify, project-import | Create, verify and resume a digest-checked project handoff |
| install, verify-install | Host skill installation and content-drift checking |
| export | Portable Markdown/adapters, not the user project dossier |

## The blocker ledger (ALN-015)

`state.blockers` existed from the beginning, was read by `resume`, the forecast, the gate and
Studio, and **no command wrote it**. So an empty array meant "this project has no blockers" and
"nobody in this system can record one" at the same time, and `status` could only answer `UNKNOWN`.
Three commands write it now.

```
blocker-record --project-root . --id BLK-ID --title TEXT --reason TEXT --owner NAME
               [--evidence-file FILE] [--expected-revision N] --operation-id ID
blocker-resolve --project-root . --id BLK-ID --resolution TEXT --owner NAME
               --expected-revision N [--evidence-file FILE] --operation-id ID
blocker-verify-none --project-root . --owner NAME [--note TEXT] --operation-id ID
```

They are hyphenated rather than `blocker record` because the parser takes the first argument as the
whole command name and everything after it as options; every multi-word command already here is
hyphenated for the same reason.

A record carries `id` (`BLK-` prefixed), `title`, `reason`, `status` (`OPEN` or `RESOLVED`),
`owner`, `recorded_at`, an optional `evidence` pointer with its digest, `revision` and `updated_at`;
a resolved one also carries `resolution`, `resolved_by` and `resolved_at`. Every mutation takes
`--operation-id`, is idempotent under a retry of the same id, takes the project lock and writes one
event: `BLOCKER_RECORDED`, `BLOCKER_UPDATED`, `BLOCKER_RESOLVED`, `BLOCKERS_VERIFIED_NONE`. Touching
an existing record needs `--expected-revision`, as every other ledger does.

**Resolving keeps the record.** It gains how it ended and stops being counted; it is not removed.
A blocker that happened and was cleared is part of how the project went, and `resume` and the
context pack still list it, marked as resolved.

### The four answers, and why the third one is not the second

| `blockers_assurance` | When |
|---|---|
| `RECORDED` | at least one entry is open |
| `NONE_VERIFIED` | nothing is open **and** somebody recorded that they looked |
| `UNKNOWN` | nothing is open and nobody has said so |
| `UNTRUSTED` | the state does not agree with its history — see the error kinds below |

`status --json` also carries `open_blockers` and `blockers_verified_none`.

**Resolving the last blocker does not verify that none is open.** It is a statement about one
blocker; "there are none" is a statement about the project, and somebody has to make it. So any
blocker mutation clears the verification, and the path is `UNKNOWN → RECORDED → UNKNOWN`, with
`NONE_VERIFIED` only after `blocker-verify-none`. A ledger that slid from the first to the second
would be the empty array again under a better name. `verify-none` is refused while anything is open,
and names what is.

### Projects written before this ledger

Their `blockers` hold plain strings. **They stay strings.** They are valid, they are counted as
**open** — a blocker whose status was never recorded has not been recorded as resolved, and they
hold `verify-none` shut for that reason — and they are never rewritten into records, because that
would mean inventing the owner, the date and the status they never had. `resume` says so where it
prints them. They have no id, so they cannot be resolved by one; the refusal says to record the
blocker properly first, so that closing it leaves a trace. Reading is explicit and lossless in both
shapes and `migrate` converts nothing.

## Machine-readable refusals (ALN-016)

A folder with no Plangonaut project and a Plangonaut project whose records disagree were both exit 2 with an
English sentence. They call for opposite responses — offer to set one up, or offer to repair and
read nothing in it as fact — so a caller had to match the prose to tell them apart.

**On a command whose output is JSON**, a refusal is a JSON document on stdout:

```json
{
  "ok": false,
  "error": {
    "kind": "NOT_PLANGONAUT_PROJECT",
    "message": "…",
    "command": "status"
  }
}
```

`status` is always such a command; any other is when it is given `--json`. **Nothing else goes to
either stream in that mode** — not even the usual `PLANGONAUT ERROR:` line on stderr — because a caller
that merges the two must still be handed one parseable document. A human command is untouched: the
sentence, on stderr, exactly as before.

| `error.kind` | Means | What a caller should do |
|---|---|---|
| `NOT_PLANGONAUT_PROJECT` | there is no Plangonaut project at the root that was asked about | offering to initialise one is safe |
| `PROJECT_STATE_UNTRUSTED` | there is one, and its state, schema, events or replay do not agree | offer to repair; read nothing in it as fact; **never** offer to initialise |
| `COMMAND_FAILED` | anything else — a bad option, a stale revision, a refused precondition | the project is fine; the call was not |

A `PROJECT_STATE_UNTRUSTED` document also carries `blockers_assurance: "UNTRUSTED"` at the top
level. That is the fourth value of the vocabulary above, and it was unreachable until now: the one
command that could report it refused such a project outright.

**Three kinds, and the set is small on purpose.** Adding a fourth is a contract change. A caller
should switch on the three and treat anything it does not recognise as `COMMAND_FAILED`, so that it
keeps working when one is added.

The exit code stays **2**. `kind` is the new information; renumbering the exits would break every
caller that already handles the old ones to carry a distinction this field already carries. **The
`message` is for people** — it is not stable, it is not a contract, and a caller that parses it is a
caller this change did not help.

`init` is the first command that writes, and the only one whose input is a file the caller must author: `--owners-file`, naming the five decision authorities the engine stores. Its format, a complete example and the three refusals are in *The first command: `init` and its owners file* in [user-guide.md](user-guide.md); they are not repeated here.

Browser Studio and app/launch are retired. Native Studio document governance uses shared conformance requirements without running the CLI.

## Required checks versus current limits

The target validates fields/IDs, references, dependencies, declared gate prerequisites, evidence presence, revisions, operation identity and recovery. It never decides whether prose fully captures intent or grants approval for a human.

The audited alpha validates typed ledger items, unique IDs, required ownership/revisions, evidence hashes, dependency references and cycles, state/event alignment and declared structural gate prerequisites. It rejects stale ledger revisions without writing. A successful validate/gate command still does not establish COV-001 or EXEC-001 semantic readiness; the host AI and human reviewers decide whether the evidence is adequate.

Every project-state mutation requires a caller-supplied `--operation-id`. Reusing it for the **same operation** is a no-op; reusing it for a different one is refused, and the refusal says what the id already recorded.

*Same operation* is decided by a canonical, versioned digest of the input: the command and its options sorted by name, so the order you type them in does not matter; `--project-root` left out, so `.` and the full path are the same project; `--output-dir` and `--package-dir` resolved to one spelling; and every `--*-file` option digested by **the content of the file**. That last one matters in both directions — the same file under two names is one operation, and the same name holding different text is two, where it used to be silently accepted as a repeat. Lists inside a single value keep their order. Records written by an earlier engine are recognised by the earlier rule, so nothing already in a project stops working. Document operations preserve supported revisions, history and disk-hash checks. `doc-diff` returns a reviewable line diff and a confirmation token bound to the artifact, path, owner, current revision/hash and proposed hash. `doc-save` requires that token. Expected revision/hash inputs remain available for explicit optimistic-concurrency checks, and Studio passes its preview values into Rust. Both implementations validate the complete known state before filesystem mutation and use a recovery journal to roll back an interrupted multi-file operation on the next load. `doc-mark-deletion` records the approved target, reason digest, source revision/hash and candidate-content hash; only a matching save consumes and links it once. The semantic comparison of full genealogy against confirmed decisions remains host-AI work supported by those records. Report this boundary. Never edit governed ledgers directly to bypass APIs.

`project-export` includes every governed current document, published base document, state and available evidence/module files, and a **portable replay origin** in place of the exporting project's event log. The log recorded that project's absolute path on the machine that made it — the user's name, the drive, the folder layout — and a handoff does not carry the machine that made it. So the package holds one event: the moment it was made, carrying the whole state, with the recorded root replaced by `<packaged>`. It also records the digest, the length and the last event id of the history it was made from, so the two can be matched later without either being disclosed. The exporting project is untouched and keeps its full history. What the recipient gets is complete as a *project* — every decision, requirement, risk, question, answer and document — and is explicitly not the exporter's event-by-event log, which is attested by digest and not reproduced. Its manifest pins allowed namespaces, byte counts, SHA-256 digests, entrypoint and embedded state metadata. `project-verify` refuses missing, duplicate, changed or unexpected content — *unexpected* meaning a file on disk the manifest does not declare, wherever in the package it sits, which it walks the directory to find. It also refuses a directory carrying a staging marker that names somewhere else: that is an export nobody finished, and a package is not a thing you can be handed halfway. `project-import` stages and validates the whole package before promoting it into a new or empty directory, rewrites the recorded root, appends an import event and validates Resume. Import does not imply that the source project's semantic readiness was approved.

COV-001 concern fields and readiness categories are semantic records, not implemented schema extensions. Keep them in indexed Markdown until a compatible engine exists. Module IDs 0–16 aggregate progress and cannot limit discovery.

## Recorded sources and their re-verification

A recorded digest is a claim that a named file still says what the record was made from. `validate` re-hashes the claims it can prove something about: typed evidence items and governed documents inside the standard checks, and separately `modules[].evidence`, `human_overrides[].source` and `gates[].evidence`. Gate evidence was the one nothing re-read until ALN-008: a project could answer `Plangonaut state is valid.` for a whole interview while the file a gate was PASSED on had been deleted or rewritten. A gate is the record that says a phase may end, so its evidence is the last thing that may quietly disappear.

These checks belong to `validate` and deliberately not to the check that runs on every mutation. Drift of this kind is expected whenever a governed evidence document advances to a new `-vN`, and refusing every later operation over it would make a working project unusable. Drift blocks `validate`; it does not block recording a decision, a task or a gate.

**What is checked and what is skipped.** Only the live record in `state.json` is read, and only when it carries both a path and a 64-hex digest. A gate written before the record kept its evidence claims nothing, so nothing is refused, and no digest is ever reconstructed from the `GATE_UPDATED` events: an event records what was true when it was written, and re-checking it would turn every wanted later revision of an evidence document into a failure. The skip is reported rather than silent. After `Plangonaut state is valid.`, a project holding such gates also prints:

> `N of M gate record(s) carry no evidence digest, so validate re-verified nothing for them: <names>. They were recorded before the gate record kept its evidence; failing them would report a drift nobody can prove. Attach the file the gate was passed on with: plangonaut re-record --project-root . --kind gate --id <gate> --source-file <file> --owner <owner> --reason "<why>" --operation-id <id>`

Read that as an open item, not as a pass: those gates rest on evidence nothing has looked at since. Attaching the file with `re-record --kind gate` ends the gap, and from then on the gate is held to its evidence like any other.

The two refusals, verbatim, so they are recognisable before they are met:

> `<record> records evidence at <path>, which is missing. Restore the file, or point the record at the file that stands in its place: <remedy>`

> `<record> records evidence at <path>, which is outside the folder that travels with the project, so the record cannot be read by whoever receives it. Copy the file into the project first, then re-record against its path relative to the root: <remedy>`

The two used to be one sentence and one remedy, and the remedy was wrong for the
second of them: it offered `--source-file <path>` with the very path that had just
been refused, so an agent that pasted it re-recorded the same defect, `validate`
failed again, and `source_history` gained an entry documenting a repair that
repaired nothing. A path that was never portable cannot be repaired by pointing at
it again, so the remedy now carries the placeholder `<path-inside-the-project>` and
says to bring the file in first. A portable path whose file is merely missing keeps
its path, because there restoring it is exactly the fix.

> `<record> recorded <path> with a digest that no longer matches the file. Re-record it against the current file, or restore the recorded content. To re-record: <remedy>`

The remedy named for a module is `record`, with the module answer supplied again through `--answer-file` — a module answer is recorded again, not re-recorded. For an override and for a gate it is `re-record`.

## One rule for every file that enters a permanent record

A record that names a file is only worth as much as the recipient's ability to open
it. Every option that puts a path into permanent state therefore passes the same
check, in one place in the engine:

- `override --instruction-file`
- `reconcile --evidence-file`
- `gate --evidence-file`
- `evidence --file`
- `blocker-record --evidence-file`, `blocker-resolve --evidence-file`
- `re-record --source-file`

What is refused: an absolute path, and one climbing out of the root with `..` — which
covers a drive-qualified path and a UNC path, both being absolute; anything inside the
reserved state directories; a symbolic link that resolves outside the root, because
containment is decided on real paths and not on written ones; a file that does not
exist, is not a file, or is empty. Windows and POSIX spellings resolve identically:
the canonical separator is `/`, and `..\..\x` is one climb rather than one segment.

This was three copies of the check and one hole. `override` had no check at all, so it
accepted what `reconcile` refuses, and a pilot recorded an override against a file in a
temporary directory: accepted on the day, refused by `validate` days later, by which
time the file — and with it the override's own text — could have been gone. An override
records a change of direction. It is among the last things that may evaporate.

Every refusal ends with what was written, which in all these cases is nothing.

## Re-recording a governed source

`re-record --project-root . --kind override|gate --id OVR-ID|G2 --source-file FILE --owner NAME --reason TEXT --operation-id ID` re-points what an existing record stands on at the file that supersedes it. `--kind override` moves an override's `source` and `source_sha256`; an override may legitimately point inside `.plangonaut/`. `--kind gate` moves a gate's `evidence` and `evidence_sha256` under the containment rule `gate` already enforces: an existing, non-empty file inside the project and outside the reserved `.plangonaut` directory.

It changes provenance and only provenance. It cannot pass, reopen or re-authorise anything, does not move the lifecycle, and does not clear `needs_reconciliation`. It is deliberately permitted while the project is blocked on the very override whose source drifted, because otherwise the block would be the thing preventing its own removal. No stored digest is ever edited: the new one is computed from the file's bytes.

What it preserves: the previous path and digest, the owner, the reason and the event id are appended to `source_history` on the record and written to a `RECORDED_SOURCE_UPDATED` event carrying the same values and the new state revision. When there was nothing to supersede — a gate that never recorded a digest — the history entry stores `null` for path and digest, because "nothing was claimed" and "the previous digest matched" must never look alike.

It refuses a `--kind` other than `override` or `gate`, an unknown record, an empty `--reason`, an owner who is not a confirmed decision owner, a source outside the project, and a re-record that would change nothing (`<record> already records <path> at that digest. There is nothing to re-record; no changes written.`). A refused re-record writes no event and leaves no history entry. Idempotency is the same as every other mutation: an identical retry under the same `--operation-id` prints `Idempotent retry: re-record already applied.`, and the same id with different input is refused.

## Governed documents, and the ones only found

`state.document_governance` records what a project expects to govern: the directories,
the files deliberately excluded, and the Markdown that was already in the folder when
`init` ran. That last list is why it is written at `init` and cannot be computed later
— afterwards, a document that predates Plangonaut and one an agent wrote by hand are
both simply there.

`validate` reports Markdown that looks governed and is not, in two tiers. A
`*-v<N>.md` file that no artifact claims is reported always: the skill asks for exactly
that naming convention, so a file carrying it with no artifact behind it is almost
always an agent that followed the convention and skipped the command. Any other
Markdown inside a governed directory is reported only when it appeared after `init`,
and only on a project that recorded `preexisting`. Conventional repository files
(`README`, `CHANGELOG`, `LICENSE`, `CONTRIBUTING`, agent instruction files), dependency
and build directories, and the derived interview view are never reported.

It is a warning, and `--strict` turns it into a failure with exit 2. That order round
is deliberate: an anomaly that speaks only behind a flag is invisible to the person who
does not know the flag exists, which is everyone meeting it for the first time.

`plangonaut govern --exclude <path> --reason TEXT --owner NAME --operation-id ID`
records a deliberate exception, and `--include` withdraws it. It is a command rather
than a field to edit because `document_governance` is replayed and digested like the
rest of the state: hand-editing it would put the state out of step with its own
history and make `validate` refuse the project — punishing somebody for doing what the
warning asked.

**Adoption.** `doc-save` still refuses to overwrite a working file the ledger does not
know about, with one exception that is not an overwrite: when the bytes already on disk
are exactly what the save would write, the file is adopted into the ledger instead,
and the result says `adopted_existing_file: true`. Without it the warning would have
had no runnable remedy — an agent that wrote `docs/x-v1.md` by hand and passed that
same file as `--content-file`, which is the only sensible thing to pass, was refused
for overwriting a file with its own content.

## Modules, coverage and what `next` reads

`qa-ask`, `qa-answer` and `qa-settle` move a module from `NOT STARTED` to
`IN DISCUSSION` when work is recorded against it, and record it in the event as
`module_started`. That is the only automatic transition there is, and it only ever goes
forward: `CONFIRMED`, `NOT APPLICABLE`, `DEFERRED` and `BLOCKED` are judgements, none of
them is ever written by an automatism, and none of them is overwritten by activity
arriving afterwards. `owner` and `evidence` stay as they were — an interview interaction
is neither a sign-off nor an evidence file.

`IN DISCUSSION` is the schema's word for it. The vocabulary is fixed
(`NOT STARTED`, `IN DISCUSSION`, `CONFIRMED`, `PARTIAL`, `DEFERRED`, `NOT APPLICABLE`,
`BLOCKED`) and a value outside it is refused by the same validation that would have
written it.

`next` reads the interview ledger before the questionnaire, in this order: an answer
recorded and not applied, then a question asked and waiting, then a question already
`PLANNED`, and only then the catalogue. Each is printed with why it comes before the
rest. A catalogue question the history already answers — answered, settled or closed —
is marked rather than reprinted clean; matching is on exact text, which is crude and is
the only comparison that cannot claim more than it knows.

`status.module_progress` and `next` report the shape of the work rather than one
fraction: modules confirmed, in progress, never opened, not applicable; questions
planned, asked, answered-not-applied, settled, closed; and the ledger counts. `coverage`
keeps its old meaning and is no longer the only thing a reader has.

**Coverage imbalance.** When at least 6 interactions are concentrated in at most 3
modules while at least 10 modules have never been opened, `status` and `next` say so,
with the threshold that triggered it. It reports; it never refuses. A deliberate deep
dive is often right — what is not acceptable is that nobody stated it.

**Prerequisites.** `MODULE_PREREQUISITES` records which modules must be underway before
another module's answers can be trusted — identity and users before scope, project type
and technology before architecture, data and delivery. `next` names an unopened
prerequisite of the module it is proposing. It explains an ordering; it does not enforce
one.

## Which engine is running, and which one wrote this project

`status` reports four separate facts under `versions`, and `resume` and the context
pack print the same four:

    running     the CLI executing now
    created     what wrote the project's first state, or last migrated it
    last_wrote  what most recently committed to it
    schema      the shape of the state

`beave_version` is set by `init`, `migrate` and `baseline` and by nothing else, so it
answers *what created this* and was read for two releases as *what version this project
is on*. Those are different facts. `last_engine_version` is the second one, written
inside `commitState` — the single place every mutation passes through — so it rides the
state patch that each event already verifies against itself, and replay reproduces it
without any event format changing. It is optional: a project written before it existed
does not carry it and is not invalid, and the absence is reported as an absence.

`compatibility` is `SAME`, `CLI_NEWER`, `PROJECT_NEWER` or `UNKNOWN`. A difference in
version with the same schema changes nothing and migrates nothing; what it means is that
an observation about that project belongs to the engine that wrote it. `UNKNOWN` is
returned rather than a guessed ordering whenever either version cannot be parsed — a
wrong direction here would tell somebody to migrate a project that does not need it.

A different `schema` is the one case that blocks: the project is refused until
`plangonaut migrate` has run, and the refusal now names the command and states that
nothing was changed.

**None of this touches the network.** The running version comes from the package's own
`VERSION` and everything else from the project on disk. There is no registry lookup and
no "a newer one is available": that question has nothing to do with whether this project
can be opened.

## An approval names who approved it

`APPROVED` is the strongest word the decision ledger has: it says a person with
the authority chose this, and everything downstream is entitled to build on it.
The first real pilot showed how little it took to get that word written without
anybody having chosen anything -- an agent read a prototype, inferred what it
implied, and recorded the inference as a decision. Nothing in the engine was
wrong. Nothing in the engine could tell.

So an `APPROVED` decision now carries `provenance`, and there are three roads to
one and no fourth:

| road | how | what it rests on |
| --- | --- | --- |
| the interview | settle the question it came from: `qa-settle --consequences DEC-XXXX` | the user's own recorded answer, its authority and its timestamp |
| an override | `--provenance-override OVR-XXXX` | a recorded override, with its source file and digest |
| a statement | `--provenance-note <a file inside the project>` | the decider's own words, in the folder, hashed |

The third road exists because Adoption and Reconstruction are real: a project
arrives with decisions already taken, and a rule satisfiable only by a Plangonaut
interview would make those modes unusable. It carries the override's honest
limit -- the engine cannot tell who typed a file, only that the record points at
something a reader can go and read. A file outside the project is refused, like
every other recorded source.

**Where the rule is enforced, and why not at the write.** Refusing the write was
implemented and then measured: it broke eighty-seven call sites that use
`APPROVED` as a convenient fixture status, and compatibility with existing
projects was a requirement. A refusal there is not a guarantee, it is a
migration. So:

- the write records provenance when it exists and **names what is missing** when it does not, listing the three roads;
- `validate` reports every unprovenanced approval; **`--strict` fails** on it;
- `handoff-check` treats it as **blocking** -- a folder is not handed over resting on an approval nobody can trace;
- the skill carries the duty: if the user has not answered, the status is `PROPOSED`.

A decision written by an older engine has no provenance and is not retrofitted
with one. It is reported, which is the honest answer: nobody can now tell.

**A module is confirmed against its own ledger.** `CONFIRMED` means the project
may build on the module, and the same demotion applies for the same measured
reason. `record --status CONFIRMED` names, and `validate` and `handoff-check`
enforce, four conditions read from the module's own records: no question on it is
`ASKED` or `ANSWERED`-but-unapplied; no decision that came out of its interview
is still `PROPOSED`; no approval of its is unprovenanced; and something is
actually recorded against it -- a module with an empty ledger has no coverage to
confirm. Module 0 is exempt from the last one: `init` confirms it from the owners
file, which is the whole of its content. `NOT_APPLICABLE` and `DEFERRED` remain
available and say something true.

**Four interview states, and the engine keeps them four.** `PLANNED` is
written down and not put; `ASKED` is put to the user; `ANSWERED` has a recorded
answer; settled is `ANSWERED` with `consequences_recorded_at`, a timestamp only
the command that applies can write, which is why it is not a status word a caller
could set.

What the engine does **not** do is claim to know that a question reached
somebody. An earlier revision of this cycle inferred presentation from a per-turn
arithmetic -- one, two or three by interaction mode -- and refused past it. It was
wrong twice: it proved nothing it claimed to prove, since the engine does not see
the conversation, and it capped the total size of an interview the contract
requires to be exhaustive. It has been removed. The engine records the agent's
statement of intention and the order things happened in; the duty behind `ASKED`
belongs to the skill.

**A block is presentation, not a quota.** `next --count N` lays out one block of
questions, one to twenty. It does not bound the interview, which has as many
blocks as the gaps need and ends when every applicable module is `CONFIRMED`,
`DEFERRED` or `NOT APPLICABLE` with a reason. Interaction mode governs depth and
tone and has never governed how much interviewing a project is allowed.

The size is a project's own, and is recorded like everything else a person
decides. `next --count N --remember --owner NAME --operation-id ID` writes
`question_block_size`; `next --count N` alone sizes one block and records
nothing, so asking for three questions once never quietly becomes the way the
project works. `--remember` is what turns this read into a write, the shape
`replay --repair` and `recover --apply` already have, and `next` without it
writes nothing at all.

Absent is a state. A project that has never set one carries no field, which is a
different fact from having chosen five, and nothing backfills it — reading a
project must not write into it. Readers resolve an absent field to five, and
`status --json` reports both halves as `question_block_size: { effective,
recorded }`. `resume` and the context pack carry the effective value near the
top, above anything a fresh agent would take for a plan, because that is what
they are read instead of: the conversation the preference was stated in.

**Nothing advances over a contradiction the project already records.** The
findings `validate --strict` fails on -- a module `CONFIRMED` against its own
ledger, an unprovenanced approval, a document nobody is governing -- are shown
first by `next`, by `resume` and in `status --json` as `advance_blocked_by`, and
the recorded `exact_next_action` written after `record --status CONFIRMED` names
the contradiction instead of the next module. None of it refuses: the ways out
are to resolve the finding or to downgrade the claim, and `NOT_APPLICABLE`,
`DEFERRED` and `PROPOSED` are all honest and all available. A person's recorded
next action is still never overwritten.

**What counts as a document nobody is governing.** Only Markdown, so an ordinary
source file, a lockfile, an asset or a build artifact is never reported, whatever
it is named. Dependency, build and cache trees are not walked -- `node_modules`,
`vendor`, `third_party`, `dist`, `build`, `out`, `target`, `coverage`, temporary
directories, anything beginning with a dot -- and neither are recorded exclusions.
A document is looked for where documents live: the project root, the governed
directories, and directories whose name says what they hold (`docs`, `specs`,
`plans`, `decisions`, `adr`, `requirements` and their usual companions). A
working file inside application code is somebody's note, and reporting it as an
ungoverned deliverable is a guess dressed as a finding. Markdown that was in the
folder when the project was initialised belongs to the repository, not to the
plan, and the repository's own files -- README, CHANGELOG, LICENSE, CONTRIBUTING
and their companions -- are never reported at any depth. `plangonaut
handoff-check --help` states this scope.

**A forecast says whose numbers it is.** `forecast` requires `--author
agent|human` and records it as `authored_by`. `recorded_by` is the owner under
whose authority the command ran, which is a different fact and was being read as
though it were this one. `resume` renders an agent's forecast as an estimate, not
as a commitment anyone made. A forecast written before this distinction records
neither, and absent means unknown rather than human.

**Prose against the ledger.** `validate` also reports governed documents that
cite record identifiers no project holds, and, under `--strict`, fails on them
along with the findings above. The direction is deliberate: the documents are
checked against the ledger, never the other way round.

## Handoff: integrity is not sufficiency

`project-verify` proves a package arrived whole. It has never had anything to say about
whether it is enough, and cannot: a governed document resting its entire technical
foundation on files under an absolute path passes it without a remark, because that path
is not a file of the package and so is not in the manifest.

`handoff-check --project-root . [--json]` asks the other question. It reports **blocking**
findings — things that would stop somebody who was not in the conversation — separately
from advisory ones, and refuses (exit 2) on the first kind.

It reads path references out of the **ledger's own path fields** and out of governed
documents, and classifies them by how they are marked.

Where each kind of path is looked for is deliberately not the same. `C:\...`, a UNC
share and a `..` climb are unmistakable -- nothing in ordinary English looks like one --
so they are recognised anywhere they appear. A POSIX absolute path is not: English is
full of things a permissive pattern reads as one, from a route in a sentence to a
fraction to an option written `--in/--out`, and a check that flags those is a check
somebody turns off, which costs more than the paths it would have caught. So
`/opt/project/lib` is recognised only where something has already declared that what
follows is a location: a Markdown link or image target, a Markdown reference
definition, a line that qualifies its own reference, and a field of the ledger that
holds a path. Everywhere else it is prose, and prose is left alone. A line carrying `(external dependency)`, `(historical reference)`,
`(example)` or `(informative)` is a declaration and travels as one. An unqualified path
out of the folder is treated as a dependency and blocks, because that is the reading
that costs something if it is wrong the other way. A temporary location blocks whatever
it is marked with: it will not exist on the recipient's machine and may not exist here
tomorrow.

It also blocks on a module left `NOT STARTED` (unexamined is not the same as not
applicable), on an empty requirements, decisions or tasks ledger, on an answer recorded
and never applied, on an unreconciled override, and on an artifact declared `SUPERSEDED`
that names nothing that replaced it.

`validate` says nothing about any of this, on purpose. A project in the middle of an
interview is entitled to be sound and nowhere near deliverable, and merging the two
questions would weaken both.

## Backups, and notices that are right to give and wrong to repeat

Backups of project files go under `.plangonaut/backups/documents/`, keeping their
project-relative path in the name so two files with the same basename cannot collide.
The ledger's own files keep backing up to `.plangonaut/backups/` as before. Earlier
engines wrote `backups/` next to the file, which on a clean project meant a `backups/`
directory in the root and, for anyone running `git status`, the first thing they saw.

Existing ones are **found and left alone**: `validate` reports them, and only
`plangonaut migrate-backups --project-root . --apply` moves them — copying and verifying
each by digest before removing the original, and writing a receipt that records where
each came from. Without `--apply` it reports what it would do and writes nothing. They
are backups, and one of them may hold the only copy of a revision.

`init` adds exactly two lines to `.gitignore`: `.plangonaut/backups/` and
`.plangonaut/lock.json`. Nothing else. The state, the events, the interview history and
the evidence are the record the folder exists to carry, and ignoring any of them would
defeat the product.

A standing condition — one that has not changed since it was last reported — is stated
in full the first time and abbreviated afterwards, with the count. What shrinks is the
unchanging explanation; anything that varies, such as the action the engine would have
suggested, is repeated every time. The counts live in `.plangonaut/notices.json`, which
is machine-local bookkeeping about what has already been printed rather than project
state: it is excluded from `stateDigest` for the same reason `lock.json` is, it is not
replayed, and it does not travel in a package. `status.standing_notices` reports it.

## Recorded progress forecast

The forecast the agent states in conversation ([interview-protocol.md](interview-protocol.md)) has a recorded counterpart so a fresh agent reads it instead of the chat. The contracted surface is `forecast --project-root . --owner NAME --phase TEXT --known-work TEXT --conditional-work TEXT --questions MIN-MAX --operations MIN-MAX --cycles MIN-MAX --confidence ALTA|MEDIA|BASSA --confidence-reason TEXT --cycle-state REGOLARE|IN_ESPANSIONE|RISCHIO_LOOP|BLOCCATO --author agent|human`, with `--change-reason` required once a previous forecast exists, and `forecast --project-root .` alone reading the current one instead of writing a new one. Check `plangonaut help` and `capabilities` for the installed surface before relying on it; the semantic protocol does not depend on it and never waits for it.

What the engine owns: a typed current forecast and an ordered history of the previous ones, each carrying phase, known work, conditional work, the ranges for questions, operations and cycles, confidence and its reason, cycle state, the reason it changed, who recorded it, when, and at which state revision, under the event `PROGRESS_FORECAST_RECORDED`. A single number is stored as a range whose ends are equal and means the quantity is known, not that it was guessed precisely. **No percentage is stored anywhere.** Counts the ledgers already hold — open blockers, open overrides, tasks by status, gates remaining, unresolved modules — are derived by the engine, so the caller describes the work and does not retype what can be counted.

What the engine can derive, and returns beside the forecast, is limited to what recorded history shows: the residual growing across two consecutive forecasts without a phase closing; two consecutive forecasts carrying the same phase and a wider range; the same defect family reopening after two correction cycles; operations recorded without a blocker or finding count falling. It never overwrites the cycle state the caller recorded — a derived signal that contradicts it is recorded beside it and said on stdout, because silently correcting a person's judgement and silently accepting a wrong one are both wrong. Conditions about the conversation rather than the ledger are outside its reach and stay the agent's; they are in [interview-protocol.md](interview-protocol.md).

Where it surfaces: `resume` with its provenance, `context-pack` with the last history entries, `status` in compact form, Studio as a discreet summary and a timeline of recorded values only. A project that never recorded a forecast says so and names the command that records one; it never shows a zero, a default or an empty range that reads like a measurement.

## Durable state, and what can be rebuilt from what

Four different things live under `.plangonaut/`, and confusing any two of them is how
a recovery goes wrong.

| | What it is | Who writes it | What happens if it is lost |
|---|---|---|---|
| `state.json` | The **canonical current state**. Every command loads it; `validate` checks it. | Only `commitState`, inside a transaction. | Rebuilt from the events by `plangonaut replay --project-root . --repair --operation-id <id>`, back to the last replay origin. |
| `events.jsonl` | The **append-only history**. Each event carries the mutation it performed, the digest of the state before and after it, and the digest of the event before it. | Only `commitState`, inside the same transaction. | Not rebuildable. It is the thing everything else is checked against. |
| `transactions/` | The **journal** of an operation in flight. Deleted the moment the operation finishes. | Every mutating command. | An operation interrupted with no journal cannot be resolved automatically; the engine says so and stops rather than guessing. |
| `backups/` | Copies of what a file said before it was replaced. | `atomicWrite`, and `replay --repair` / `baseline` explicitly. | Nothing current depends on them; they exist so a repair never means a loss. |

`QUESTION_ANSWER_HISTORY.md` and every other derived document sit outside that
table on purpose: they are a pure function of the state, they are regenerated
rather than repaired, and nothing reads them back.

### Replay

`plangonaut replay --project-root .` rebuilds the state from the events and compares
it with the state on disk. It is deterministic: it reads `events.jsonl` and
nothing else — no clock, no other file, and no field copied across from
`state.json`, which is the failure this mechanism exists to avoid rather than to
imitate. Running it twice produces the same answer, and it writes nothing.

It refuses, naming the line, on: a line that is not JSON, a duplicated event, a
break in the chain of digests, an event whose recorded predecessor revision does
not follow, a revision that does not advance, a patch that does not apply, and a
patch that applies but does not reproduce the digest the event recorded. Each of
those is a history that was edited outside Plangonaut -- or, in the case of a revision
that stands still, one written by two processes at once, which is what the
project lock exists to make impossible.

**Where a replay starts.** At the most recent event marked as a replay origin,
which is one of three:

- `PROJECT_INITIALIZED` — a project created by this engine is reproducible from
  its first minute;
- `PROJECT_PACKAGE_IMPORTED` — a delivered folder is reproducible from the moment
  it came into existence. The exporter's own history travels with it, is
  readable, and is outside the proof: the import rewrites the recorded root, a
  change to the copy that no event in that file describes;
- `BASELINE_RECORDED` — written by `plangonaut baseline`, for a project whose earlier
  events predate the format.

Everything before the origin stays in the file, unchanged and unreinterpreted,
and `replay`, `validate` and `resume` all say how many events that is. Nothing is
reconstructed for them.

**Repair.** `plangonaut replay --project-root . --repair --operation-id <id>` copies `state.json` and
`events.jsonl` into `.plangonaut/backups/` first, puts the rebuilt state back, records
the repair as an event, and regenerates the derived documents. It refuses to run
when there is nothing to repair, and a retry with the same operation id applies
once. It is deliberately explicit: a state somebody edited on purpose is not
overwritten by a command nobody asked for.

### Writes that survive an interruption

`atomicWrite` makes one file replacement atomic. It never made a *mutation*
atomic: an operation touches a document, a history entry, the event log, the
state and a derived view, and a sequence of atomic renames is still a sequence.

Every mutating command now runs inside a journal under
`.plangonaut/transactions/<event id>/`, which records the command, the operation id,
the revisions, every file it is about to change with the digest each had, and a
phase. The phases are `PREPARED`, `COMMITTING`, `COMMITTED` — three, because
three is how many the engine writes. A fourth was declared here and never set;
an independent review ran all eight fault points and saw only these.

The **point of no return is the move to `COMMITTING`**, which happens after the
operation has been validated and after its exact result has been staged in the
journal — the new state, and the line to append to the event log. Before it, an
interruption is undone from the backups the journal took. After it, the operation
is *completed* from the staged content: the result was already decided and
written down, and completing it is the only outcome that cannot lose it.
Rolling back would be a decision to discard validated work; rolling forward is a
decision to finish it.

Recovery runs on the way into **any** command that reads or writes the project,
so it is never something a user has to remember — including before a command
decides whether it is a retry, which is where the same review found it was not:
seventeen commands asked "has this already happened?" against a history the
project had not yet caught up with, and a retry after an interrupted write
reported success over a state `replay` called diverged in the same second.
`plangonaut replay --verify` is the one exception and says so out loud: it reports a
pending operation rather than resolving it, because a command that reports must
not be the command that alters. It leaves a receipt under
`.plangonaut/recovery/` saying which way it went, and it says so on stderr rather than
passing in silence. `plangonaut recover --project-root .` reports what is outstanding
and changes nothing; `--apply` carries it out. A journal that passed the point of
no return with nothing staged is the one case the engine will not resolve: it
stops, names the directory, and changes nothing.

### Damage that is not an interrupted write

Three cases, and none of them guesses.

- **`.plangonaut/state.json` is missing and the history is intact.** Every command
  says so and names `plangonaut replay --project-root . --repair --operation-id <id>`, which rebuilds it. This is what the
  replay is *for*, and it was the one case it could not handle until a review
  deleted the file and asked.
- **The last line of `events.jsonl` was cut off mid-write.** `plangonaut recover`
  reports it and `--apply` removes it, after copying the whole file into
  `.plangonaut/backups/`. An append is the last durable write of an operation, so a
  partial final line cannot be a completed one: dropping it can only discard an
  operation that never finished. A malformed line with complete lines after it is
  damage nobody can undo and stays a refusal.
- **A journal that cannot be read, or a directory with no journal.** Both are
  named by `plangonaut recover` and neither is resolved automatically. The first stops
  every command with a sentence instead of a raw JSON error; the second used to
  be skipped for ever while `recover` said everything had finished.

**The limit, stated rather than implied.** Node offers no portable way to flush a
*directory* entry, so on a power loss the operating system may lose the rename of
a file whose contents were flushed. The journal survives that — it is written and
flushed before anything moves, and recovery re-applies from it — but Plangonaut cannot
claim the stronger guarantee a database with its own storage layer makes.

### One project, one writer

`.plangonaut/lock.json` is created with an exclusive filesystem create, so which of two
processes wins is decided by the filesystem rather than by a check in either of
them. It is taken before recovery, before the idempotency question, before the
revision is read and before anything is written, and it carries the PID, the
host, the command, the operation id and the revision its holder observed.

A second process waits, briefly, and is then told what it is waiting behind. A
lock left by a process on this host that is gone is taken over, and the takeover
is recorded. A lock held by a **live** process is never taken — not by waiting,
not by `--force`.

A lock this engine cannot reason about is never taken either, and `--force` does
not change that: one whose file will not parse, one whose `pid` is not a process
id, and one that does not say which machine holds it. Liveness has three answers,
not two, and *unknown* is not *dead* — one independent review demonstrated the
cost of folding them together by having `--force` take a lock from a running
process, and a second did it again through a record with no `host` field, where
"not this machine" was being read as "another machine". In those cases `plangonaut
unlock` says which one you are looking at and tells you to make sure no Plangonaut
command is running and delete the file yourself.

`--force` releases exactly two: a lock whose process is known to be gone, and a
lock that names **another machine**. The second is deliberate — this engine
cannot ask a host it cannot see whether a process is alive, and a lock left on a
shared folder by a laptop that is not coming back has to be breakable by
somebody. It is the one case where `--force` acts on a judgement Plangonaut cannot
make for you.

A lock read in the microsecond between its creation and its content is not an
unreadable lock: the read is patient, briefly, before it says so.

`plangonaut replay --verify` is deliberately outside the lock: it never recovers and
never writes, so it reports a pending operation instead of waiting for one.

## The interview ledger

Questions and answers are recorded in `state.interview_log[]` like every other
fact the engine holds, appended to `.plangonaut/events.jsonl`, and rendered as
`QUESTION_ANSWER_HISTORY.md` at the project root.

**One canonical source.** The ledger is the record. The document is a pure
function of the state — regenerating it twice produces the same bytes — and the
engine never reads it back. Its digest is recorded in `state.interview_view`, so
a hand edit is detected by `plangonaut validate` and repaired by
`plangonaut qa-log --regenerate`. Resume reports the divergence and continues from the
ledger, because the ledger is what it is for.

**Three commands for three moments.** `qa-ask` opens a question, `qa-answer`
records the answer, `qa-settle` records the interpretation, the reply, the
records and documents it changed, and the question that follows. Between the
second and the third the entry is `ANSWERED` with `consequences_recorded_at`
still null: the answer exists and has not been applied. That is a state Resume
must be able to see, which is why "applied" is a timestamp written by the command
that applies, not a word a caller can set.

`qa-settle` opens the next question inside the same transaction when
`--next-id` names one that does not exist yet. Recording the proposal and opening
the entry separately would leave a pointer to nothing if the turn were
interrupted between them.

**Nothing is deleted.** `qa-supersede` marks the old entry `SUPERSEDED`, points it
at its replacement and leaves its question, its answer and its consequences where
they are. `qa-close --kind deferred|skipped|invalidated` requires a reason.

**Nothing is invented.** An entry carries `reconstructed: true` only when it was
rebuilt from durable evidence. A project that predates the ledger has no
`interview_log` at all, which is a different fact from an empty one: absent means
nothing was recorded, empty means recording is on and nothing has been asked.
`plangonaut migrate` opens the ledger on such a project and records the instant from
which the history exists; it reconstructs nothing.

## Resume and overrides

Resume emits current position, module, blockers, evidence pointers and next action after supported checks. Read the actual canonical sources. Context packs do not replace the complete documents, work definitions or role contracts.

Resume also emits the interview history: the last completed interaction, a
question asked and still unanswered, an answer recorded and not yet applied, the
next question, the module, the documents the last answer changed, and any
conflict between the history and the project. When a question is `ASKED` with no
answer, Resume restates its context and does not pretend it was answered. When an
answer exists and its consequences do not, Resume settles that transaction before
anything new is asked.

Overrides record changed intent and require semantic reconciliation. Reconciliation evidence must describe work actually performed, not merely be an arbitrary file. Preserve superseded decisions, affected work and authority. The same agent may continue or a new one may resume.

State/event divergence and unsupported versions remain visible. Back up before explicit migration or recovery. Structural checks, semantic review and actual execution establish distinct kinds of evidence.

## Execution readiness, intent, organisation and readings

Four commands, all additive. A project written before them carries none of their
data and stays valid; its readiness reports `NOT ASSESSED` rather than a guess.

```
execution-readiness --project-root . [--json]
execution-intent    --project-root . --execution|--definition-only --reason TEXT --owner NAME --operation-id ID
execution-org       --project-root . --executors N --mode TEXT --reviewer NAME --concurrency TEXT --handoff TEXT
                                     [--integrator NAME] --owner NAME --operation-id ID
read-record         --project-root . --path FILE --purpose TEXT [--agent NAME] [--conclusions TEXT]
                                     [--used-by IDS] --owner NAME --operation-id ID
```

`task` accepts, all optional: `--kind`, `--requirements`, `--decisions`,
`--component`, `--role`, `--acceptance`, `--verification`, `--evidence-expected`,
`--parallelizable`, `--handoff`, `--estimate`, `--inputs`, `--outputs`, `--risks`.
An id given to `--requirements`, `--decisions` or `--risks` that no record answers
to is refused: an origin naming nothing reads as coverage and is worse than none.

`agent` accepts `--role`, `--skills`, `--owns`, `--authority`, `--is-integrator`,
`--is-reviewer`.

`execution-org` refuses an organisation with no reviewer, and one with more than
one executor and no integrator. Neither refusal is about size.

State fields added, all optional: `execution_intent`, `execution_organization`,
`reads`, and the task and agent fields above. Nothing became required, no existing
field changed meaning, and no migration is needed.

**Reading commands never write.** `status`, `resume`, `validate` and
`handoff-check` compute readiness on every call and store nothing: a readiness
written into the state would be a claim that ages, which is the defect this
closes.
