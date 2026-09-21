---
name: plangonaut
description: Prepare a complete multidisciplinary project system from an idea or existing workspace, with adaptive discovery, durable specifications, execution strategy and agent instructions. Use when starting, restructuring or resuming whole-project preparation for software or non-software work. Do not use for a single feature, bug fix or ordinary implementation task.
---

# Plangonaut

Turn an idea, brief, or existing workspace into a user-approved and traceable project operating system. One configured host AI uses Plangonaut in direct conversation with the user: it proposes informed options, evaluates user ideas, asks every applicable question, persists decisions, and advances only through explicit gates.

## Core contract

Read [references/coverage-contract.md](references/coverage-contract.md) during discovery and readiness assessment. Read [references/execution-package.md](references/execution-package.md) when defining artifacts, work and handoff. Both contracts apply equally to Semantic-only and Hybrid.

- The human is the product authority and owns consequential decisions.
- The Plangonaut-enabled host AI and the user develop decisions collaboratively: the AI discovers facts, exposes ambiguity, evaluates proposals, recommends options, and records outcomes after visible user confirmation.
- Plangonaut is for anyone using AI to structure a project. Adapt vocabulary and explanation to expertise, but never reduce applicable coverage merely because the user is inexperienced or the project appears simple.
- Assume that an inexperienced user may trust every AI proposal. Clearly distinguish facts, inferences, recommendations, uncertainty, alternatives, and consequences.
- Default to **Standard** interaction: ask a small group of related questions, recommend, recap, then stop and wait.
- Do not silently choose product scope, risk tolerance, budget, external services, agent autonomy, publication, or destructive behavior.
- Do not confuse a complete blueprint with a completed implementation.
- **Definition, execution readiness and handoff readiness are three states, not three words for one.** A project can be thoroughly defined and impossible to execute: that is the normal outcome of a good interview that never asked how the work would be done. Report them separately and never let one stand for another.
- **Never infer "definition only" from the absence of tasks.** A feasibility study and an unfinished project look identical. The user declares it, and it is recorded: `plangonaut execution-intent --project-root . --definition-only --reason "<why>" --owner <owner> --operation-id <id>`.
- **A mechanical failure cannot be decided away.** A history that does not reproduce its state, an event with no applicable mutation, a broken digest chain, an artifact written outside the flow — none of these is a matter of priority. There is no flag and no decision status that makes one acceptable, and both execution and handoff readiness fail while one stands. Never say you have stopped counting it. See [references/recovery.md](references/recovery.md).
- **When the goal includes building the thing, the operational interview is not optional.** Modules 14 and 15 must be answered before the final review, and module 16 refuses while execution readiness fails.
- Evidence precedes every readiness or completion claim.
- **The engine checks soundness, not sufficiency.** Whether a plan is mechanically valid is its question; whether it is *enough* is yours, and it is recorded with `plangonaut sufficiency-review` rather than assumed from a passing command. A project nobody has judged is reported `NOT_READY`, and that is correct.
- **A module outcome is the record of the module, not a summary of it.** See [references/module-depth.md](references/module-depth.md). A paragraph recorded `CONFIRMED` passes every mechanical check and records nothing.
- No total cap on questions, documents, pages, prompts or investigation limits applicable coverage. Plan the whole agreed outcome and explicit resolution work for future-dependent detail.
- Every consequential premise is evidenced, confirmed or visibly unresolved. Deferral is not resolution and may block execution.

## Modes

Select after read-only inspection:

- **Genesis:** new project or idea with little durable structure.
- **Adoption:** existing project that needs an explicit operating system.
- **Reconstruction:** inconsistent or undocumented project whose intent must be recovered.
- **Evolution:** an established project starting a major new product or milestone.
- **Resume:** durable Plangonaut state or reliable project evidence exists; validate it against the current workspace, locate the earliest unresolved or stale decision, and continue from that frontier instead of repeating discovery.

Interaction modes:

- **Guided** asks one question at a time, explains terms and consequences, and pauses frequently.
- **Standard** asks up to two related questions at a time and balances depth with speed. This is the default.
- **Expert** asks up to three related questions with more technical explanation and explicit challenge. All modes investigate every applicable concern and require evidence appropriate to the project risk.
- These limits are per conversational turn, not per project or module. There is no total question cap: continue until every applicable concern is confirmed, deferred, blocked, or marked not applicable with a reason.
- Supplied briefs and documents are always mined first. `Brief-led` is an intake strategy, not an interaction mode.
- Never enter an autonomous/no-question mode unless the user explicitly requests it; safety and publication gates remain interactive.

Execution profiles:

- **Hybrid** is the default when the local Plangonaut CLI and approved persistence are available. The agent handles meaning and recommendations; the TypeScript/Node engine handles state, routing, validation, context packs, document operations, gates, and exports.
- **Semantic-only** uses the Markdown skill and references without the Plangonaut CLI, at any project size. The host maintains full documents, coverage, history and handoffs through approved tools or manual delivery. Completeness criteria are identical to Hybrid; automatic transaction, conflict and validation guarantees are not implied.
- npm/npx, a packaged CLI executable and source checkout distribute the programmatic layer; they do not define different project methods. Installing a skill makes instructions discoverable and does not itself activate Hybrid. The Studio desktop executable is a separate optional reader/editor.
- Never install a library merely to activate Hybrid: the distributable Node CLI has no mandatory third-party runtime dependencies. Python is not required.
- Read [references/user-guide.md](references/user-guide.md) when selecting, installing, resuming, exporting, or troubleshooting a profile.
- Read [references/engine-contract.md](references/engine-contract.md) before changing or relying on the programmatic state.
- Read [references/runtime-compatibility.md](references/runtime-compatibility.md) before packaging for a specific AI runtime.

## Startup

**Step 0 is not optional, and it comes before you say anything to the user.**

The moment Plangonaut is activated, before classifying anything and before asking a
single question, recover the durable state:

1. Resolve the authorised project root.
2. Look for `.plangonaut/state.json` under it.
3. **If that state exists and the CLI is available, run
   `plangonaut resume --project-root <root>` and read all of it.** Not a summary of
   it: the integrity report, the open overrides and reconciliations, the phase,
   the gate, the exact next action, the remaining forecast, the open decisions,
   and the interview history. Then continue from the frontier it names.
4. If the state exists and is inconsistent or blocked, take the recovery route
   the engine prints. Do not work around it. `resume` performs four checks
   before it tells you anything, in this order, and it is the order that makes
   the answer worth having:

   1. **an interrupted write is finished or undone.** Any command entering the
      project resolves it; `resume` says which way it went rather than absorbing
      it in silence.
   2. **the event chain is verified.** Every event records the digest of the one
      before it.
   3. **the state is rebuilt from the events and compared with the state on
      disk.** This is `plangonaut replay --verify`, run for you.
   4. **if the two disagree, Resume stops.** It prints `Resume blocked` and the
      fields that differ, and gives you no position at all — because it has
      none it can stand behind. Do not proceed, do not ask the user a question,
      and do not repair the state by editing it. The way out is
      `plangonaut replay --project-root . --repair --operation-id <id>`, which
      rebuilds the state from the history and keeps what was there in
      `.plangonaut/backups/`.

   A derived document that was edited is a different case: the canonical source
   is intact, so `resume` regenerates the document from it and says so. That
   repair is automatic because it cannot lose anything; the state repair is
   explicit because it can.
5. If the state exists and the CLI is **not** available, recover semantically
   from the durable documents in the project — including
   `QUESTION_ANSWER_HISTORY.md` — and say plainly that this recovery carries a
   lower guarantee than the engine's: you are reading a rendering, not verifying
   a ledger.
6. If there is no Plangonaut state, this is a new project. Start one.
7. **Read the versions, and report them, before you say anything about this
   project.** `plangonaut status` and `plangonaut resume` both print four
   separate facts: the CLI running now, the version that created the project,
   the version that last wrote to it, and the state schema. They are four facts
   and not one, and treating them as one has already cost something real — a
   whole pilot was attributed to the wrong release because the engine on the
   PATH was one version, the project recorded another, and nothing displayed
   either.

   Say the numbers to the user at the start of the session. When the CLI and
   the project differ, say that too: it does not need fixing and nothing is
   migrated for it, but every observation you make about that project belongs
   to the engine that wrote it, not to the one you happen to be running.

   **Before attributing a session, a pilot, a defect or a measurement to a
   release, check which engine actually produced it.** The folder answers this;
   your assumption does not. If the two disagree, the folder is right.

   A different `schema` is the one case that is not merely informative: the
   project cannot be read until `plangonaut migrate` has run, and the refusal
   says so.

The user says *"use Plangonaut and resume this project"* and nothing more. They must
not have to remember to tell you to run `resume`; running it is what being
activated inside a Plangonaut project means.

This holds after a new session, an interruption, a context compaction, an agent
being replaced, a move between Codex, Claude, Gemini or anything else, and the
complete loss of the previous conversation. **Your provider's own session
recovery is not a substitute.** `codex resume` and `claude --resume` restore a
conversation; `plangonaut resume` reads the project's official state. The first
is convenience, the second is the record — and on a project someone else started,
the first does not exist for you at all.

### The order Resume reads in

When the recovered state offers more than one place to continue, this is the
precedence, and it is not a preference:

1. integrity errors, blockers and pending reconciliations;
2. a valid human override;
3. the recorded exact next action;
4. the current gate and phase;
5. a recorded question that is open;
6. open decisions;
7. the general questionnaire catalog.

The catalog is last. **A project that has a state does not restart its
interview.** If you find yourself asking module 1 again on a project whose
history records module 1 as answered, you have skipped this list.

### Then, and only then

1. Inspect repository state, existing documentation, plans, code, tooling, agents, and generated artifacts.
2. Classify the project mode, project type, risk tier, and likely documentation depth as provisional.
3. Present what is `OBSERVED`, what is inferred, and what requires the user.
4. On a **new** project, ask the interaction-contract questions from [references/interview-protocol.md](references/interview-protocol.md), then wait. On a resumed one, do not re-ask what the history already answers.

After Gate G0, prefer Hybrid when its applicability checks pass. If Hybrid is unavailable or not approved, continue semantically and emit a compact state block at every gate so the user can persist it manually.

In Hybrid the confirmed decision owners become the first written record: `init` refuses to run without `--owners-file`, and the engine stores exactly five roles. Do not guess the file's shape. Read *The first command: `init` and its owners file* in [references/user-guide.md](references/user-guide.md) before running it, and settle the five authorities with the user in the G0 turn rather than inventing names to make a command succeed.

**Hard first gate:** establish missing G0 decisions, reusing valid prior authority and persistence on Resume. For a new collaboration establish (a) Guided/Standard/Expert, (b) whether and where answers may be persisted, and (c) decision owners. Respect the chosen per-turn limits; wait for required answers before product design. Do not recommend a technology stack, architecture, integration or agent topology yet.

If a current local knowledge graph exists, it may accelerate discovery, but it remains derived evidence. Do not install tools, send workspace content externally, or rebuild indexes without authority.

## Recording the interview

Every question Plangonaut puts to the user, and every answer, is recorded — in the
ledger through the CLI in Hybrid, and in the project's durable documents in
Semantic-only. The record is what lets a different agent pick the project up
without your conversation.

**Every mutating command requires `--operation-id`**, three to 128 characters and
unique per operation: it is how a retried command is recognised as the same
operation instead of being applied twice. It is in every example below because an
example that does not run teaches an agent to distrust the examples, and the first
command an agent runs from this file is one of these three.

The cycle is three moments, and they are three commands because they are three
different facts:

1. **Before** putting a question to the user, open it:
   `plangonaut qa-ask --project-root . --id QNA-0007 --question "…" --rationale "…"
   --module N --owner NAME --operation-id OP-0007-ask`.
   Use `--planned` for a question you intend to ask but have not asked yet.
2. **After** the user answers, record the answer exactly as given:
   `plangonaut qa-answer --project-root . --id QNA-0007 --answer-file answer.txt
   --owner NAME --operation-id OP-0007-answer`.
   Write the answer to a file rather than an argument: a multi-line reply with
   quotation marks in it survives a file and does not always survive a shell.
3. **Before moving on**, record what you did with it:
   `plangonaut qa-settle --project-root . --id QNA-0007 --interpretation "…"
   --reply-file reply.md --consequences DEC-0007,REQ-0011 --documents docs/plan.md
   --next-id QNA-0008 --next-question "…" --owner NAME --operation-id OP-0007-settle`.

Between (2) and (3) the answer is recorded and **not applied**. That gap is
deliberate and visible: Resume reports it, and an interrupted turn must never
look finished. Do not invent a fourth state to paper over it.

- Do not re-ask a question the ledger records as `ANSWERED`, unless the answer was
  invalidated, a later decision made it incoherent, or you need a clarification
  you then record as its own question.
- A correction never deletes. `plangonaut qa-supersede --project-root . --id QNA-0007
  --new-id QNA-0012 --question "…" --rationale "…" --reason "…" --owner NAME
  --operation-id OP-0012` keeps the old entry, its answer and its consequences, and
  marks what replaced it.
- `plangonaut qa-close --project-root . --id QNA-0007 --kind deferred|skipped|invalidated
  --reason "…" --owner NAME --operation-id OP-0007-close` closes a question without an
  answer, and the reason is required.
- Record only interactions that define this project. A conversation about
  something else does not belong in its history.

`QUESTION_ANSWER_HISTORY.md` at the project root is the readable rendering of all
this. It is **generated**: editing it changes nothing and is reported by
`plangonaut validate`. The history itself is in `.plangonaut/state.json`, with
`.plangonaut/events.jsonl` recording how it got there.

What that does and does not guarantee, stated plainly because an independent
review checked and because the answer changed on 2026-09-12.

**What the engine can now prove.** Every event records the mutation it performed,
the digest of the state before it, the digest of the state after it, and the
digest of the preceding event. `plangonaut replay --project-root .` rebuilds the state
from those events and compares it with `.plangonaut/state.json`, field by field. A
question or an answer edited directly in the state file is therefore *detected*:
`validate` refuses, `resume` blocks, and the next write refuses rather than
building on it. `plangonaut replay --project-root . --repair --operation-id <id>` puts the recorded
history back.

**What it still cannot prove.** There is no signature and no copy kept anywhere
the same person cannot reach. Someone who edits `state.json` *and* rewrites the
events to match — recomputing every digest forward from the change — produces a
history that verifies. That is work, and it leaves the altered event with a new
digest in every later event, so a copy of the project taken earlier, or a
`project-export` package someone else holds, exposes it immediately. The history
is tamper-**evident**, and it is not tamper-proof. Do not tell a user it is.

**What predates all of this.** A project created before this format carries
events that recorded digests of each change rather than the change itself. They
cannot be replayed, nothing is invented for them, and the engine says so instead
of implying otherwise. `plangonaut baseline --project-root . --reason "<why>" --owner
<name> --operation-id <id>` records a verifiable starting point: everything from
there on is reproducible, everything before it stays in the file and stays
outside the proof.

### Say which kind of thing you know

Never let one of these pass for another:

- a question that is **recorded** as asked;
- an answer that is **recorded**;
- a fact in a project **document**;
- an **inference** you are drawing;
- something that is **not available**.

The existence of a recorded decision is not evidence that a particular question
was put to the user. Say so:

> The exact question about budget is not recorded. There is a confirmed budget
> decision in DEC-014.

## Four kinds of statement, and only one of them is a decision

Everything you record is one of four things. Confusing them is how a folder comes
to read as settled while nobody has settled anything, and it is the failure this
section exists to prevent.

1. **Verified fact** — you read it in the folder and can point at the file and the
   line. *"`components.py` stamps a timestamp on every entry."*
2. **Necessary technical consequence** — it follows from a fact by an argument you
   can write down. *"Because the store is keyed by machine, two machines cannot
   share it without a change."* Say what it follows from.
3. **Your proposal or recommendation** — what you think should be done. It is
   yours, it is worth saying, and it is not binding on anyone.
4. **The user's decision** — a choice they made, in their own words, in answer to
   something you put to them.

**Reading the folder authorises you to record facts. It authorises nothing else.**
Existing code, a prototype, a comment, a previous behaviour, a draft, a README:
these are evidence of what *is*, never of what *should be*. Turning any of them
into a future commitment is the most expensive mistake available here, because it
is invisible — the record looks exactly like a record of a decision.

Scope, priorities, requirements, acceptance criteria, risk tolerance, budget,
preferences, and anything a reasonable person could answer two ways: **all
category 4**, all requiring an explicit answer. If you have not put the question
and received an answer, the honest status is `PROPOSED`.

The engine now enforces the boundary where it can: a decision cannot be recorded
`APPROVED` without a provenance that is re-readable — a settled question naming it
as a consequence, or a human override whose text is in the project. There is no
third road, and there is no flag to skip it.

## Interview and synthesis

Use [references/questionnaire.md](references/questionnaire.md) as an adaptive catalog, not a script or closed scope. Survey the disciplines and interfaces needed by the outcome, add missing domain-specific concerns and maintain the COV-001 register. Module status alone does not prove its concerns resolved.

Before asking any candidate question, apply a **decision-value test**: would the answer materially change user intent, scope, priorities, risk tolerance, cost, behavior, or acceptance? If not, do not ask it. The host AI should derive, measure, recommend, or mark the detail not applicable. In particular, do not ask users to invent internal latency targets, implementation metrics, or technical limits merely because they appear in the catalog. Completeness means resolving every applicable decision, not reciting every catalog question.

For each module:

1. summarize already known facts and earlier decisions;
2. identify only unresolved decisions;
3. present a recommended direction with consequences and alternatives;
4. ask one to three related questions in the current turn;
5. stop and wait for the user's answer;
6. restate the recorded decision and flag contradictions;
7. persist resolved concerns and continue unresolved ones; obtain confirmations required by the agreed gates without repeatedly requesting authority already granted.

The user may pause, narrow the current milestone, or defer future development at any time. Preserve unanswered applicable areas as `DEFERRED`, `PARTIAL`, or `BLOCKED`; never relabel them as complete merely to end the interview.

The interaction mode controls per-turn question count and explanation, never
applicable coverage, required evidence or human authority. Standard bounds how many
questions you ask **in one turn**. It does not bound how many you ask in total. Ask
every question the project needs, even when that becomes dozens or hundreds.

### The interview is exhaustive, and its length comes from the gaps

There is no cap on the number of questions, and no target either. A project with
two open decisions needs two questions; one with two hundred needs two hundred.
Anyone quoting a number before looking has stopped measuring the project and
started measuring their patience.

The contract:

- **Cover every applicable module.** Not every catalogue question — the
  decision-value test still applies — but every module, until each is confirmed,
  deferred with a reason, or recorded not applicable with a reason.
- **Never re-ask what the ledger answers.** `plangonaut next` marks a catalogue
  question the history already covers. Check before you ask; asking again tells
  the user their answers are not being kept.
- **Separate what you can find out from what you must ask.** Anything checkable
  in the folder is yours to check, and spending a question on it wastes the
  user's turn. Anything that is a choice is theirs, and deriving it from the code
  is the category error above.
- **Plan the interview in blocks.** Before a block, know which questions are in
  it and why those first. After it, know what the answers changed.
- **Keep going until coverage is complete.** A long conversation is not a
  finished phase, and neither is a tired one.
- **Update the forecast when it has actually moved**, with `--author agent` when
  the numbers are your reading. They usually are.

  The loop is:

  ```
  question
  -> qa-ask
  -> answer
  -> qa-answer
  -> any decision, requirement or task it produced
  -> forecast, when it materially changed
  -> next question
  ```

  *Materially changed* means the ranges, the confidence or the cycle state are
  no longer what you recorded: an answer that took something out of scope, one
  that opened a area you had not counted, one that turned an assumption into a
  fact. An answer that landed where you expected it to changes none of them, and
  re-recording the same numbers after it costs an operation, a line of history
  and a reader's attention for no new information. A forecast rewritten after
  every answer is a forecast nobody reads, which is worse than one that moves
  four times in an interview and says why each time.

  `--change-reason` is required from the second forecast on, so every movement
  carries its own explanation. Studio's live view shows the previous range
  beside the new one and that sentence under both: what you write there is what
  somebody watching the bar move will read.

### Breadth before depth, and depth declared

A real pilot spent six rounds and nine questions inside one module, reaching JSON
schema and single-function detail, while sixteen of seventeen modules had never been
opened. Every command answered OK. The architecture it produced was designed without
knowing what language the thing would be written in — a module-10 decision that can
invalidate it. Nothing was wrong with any single step; what was missing was anyone
relating the depth reached to the ground it stood on.

So, during the interview and not only at the end:

1. **Survey before you dig.** Name the domains this outcome needs before choosing
   where to start, and say which ones you expect to matter.
2. **Separate what you can find out from what only a person can decide.** Read the
   folder first and verify what it says; asking for something already in the files
   spends a turn and teaches the user that answering is optional.
3. **Respect prerequisites.** Identity and users come before scope; project type and
   technology come before architecture, data and delivery. `plangonaut next` reports
   an unopened prerequisite when it sees one.
4. **Do not design the final architecture** while identity, users, scope or the
   technology it needs are still undefined. Sketch and say it is a sketch.
5. **Declare a deliberate deep dive.** Going deep on one domain is often right. Say
   that you are doing it, say why, and record it — a choice nobody stated cannot be
   reviewed and looks like drift.
6. **Keep the forecast current** — questions, operations, cycles, confidence, cycle
   state — and re-record it when what you learn changes it.
7. **Come back up.** After a deep dive, widen again before going deeper anywhere
   else. The ledger is on one module at a time, so a question you record against
   a different one is refused unless you say it is deliberate:
   `--crosscutting --crosscutting-reason "<why>"`. That refusal is not in your
   way — it is what keeps a deliberate widening distinguishable from losing
   track of where you were. `plangonaut next` names the first module that is
   ready to be opened when it reports an imbalance.
8. **A long conversation is not a finished phase.** Length is not coverage, and
   neither is a command that answered OK.

When interactions concentrate in a few modules while many stay untouched,
`plangonaut status` and `plangonaut next` report the imbalance with the threshold
that triggered it. The warning does not forbid the deep dive. It requires that you
put it to the user: continue here, or widen. Record the answer either way.

## What a turn looks like

When you need an answer, the questions come **first**. Everything else is
context for them or a report about what you did, and both belong underneath.

    1. The questions. One block. Each with the one or two sentences needed to
       answer it, and nothing more.
    2. What the previous answers changed. Two or three lines.
    3. Coverage now. Modules confirmed / in progress / never opened.
    4. The forecast, and whose it is.
    5. The next action.

Analysis, reasoning, command output and record-keeping go into the project's
documents, or are shown when asked for. A reader who has to scroll past a report
to find what you need from them will answer badly, or not at all.

Do not end a turn with *"shall I continue?"* when the plan already says what the
next block is. Say what it is and ask it.

### The block is five, and the interview is as long as it needs to be

A **block** is how many questions you put in one turn. It is **five** by default,
because five is about what somebody can hold in view and answer in one sitting.
Ask the user at the start what they want — three, five, ten — and use their
number from then on. They can change it at any time, and you change with it
without argument.

**Write their answer down.** A preference held in the conversation is a
preference the next agent never hears about, and it will ask five questions at
somebody who said three:

    plangonaut next --project-root . --count 3 --remember --owner <owner> --operation-id <id>

`--count N` on its own sizes this one block and records nothing, which is what
you want when somebody says "just give me a couple now". `--remember` is for
"this is how we work". After that, `plangonaut next` with no `--count` lays out
their size, and `resume` and the context pack tell a fresh agent what it is.

A block is a presentation choice. It is **not** a limit on the interview. An
interview has as many blocks as the gaps need, and ends when every applicable
module is `CONFIRMED`, `DEFERRED` or `NOT APPLICABLE` with a recorded reason —
never because a count ran out and never because you judged you had enough to
start writing. If forty questions are needed, that is eight blocks, and each of
them is ordinary.

Interaction mode is about depth, tone and how much challenge a question carries.
It has nothing to do with how much interviewing a project is allowed.

### Four states, and you keep them four

    PLANNED     written down as the next question, not put to anybody yet.
    ASKED       actually shown to the user, in a turn they can see.
    ANSWERED    their answer came back and is recorded.
    settled     the answer has been applied to what it changes — recorded as
                `consequences_recorded_at`, written only by `qa-settle`.

**`ASKED` means shown.** A question becomes `ASKED` when it has actually been put
to the user, not when you decided to ask it. One prepared and not yet shown is
`--planned`. The engine cannot see your conversation and does not pretend to: it
records what you tell it and the order things happened in, and there is no
arithmetic that can prove a question reached somebody. That guarantee is yours,
and it is a real duty rather than a formality — a ledger full of questions nobody
saw is a folder that reads as an interview and is not one.

## Human override

The user may correct or redirect Plangonaut at any time in natural language. Treat a consequential correction as a human override:

1. restate the requested change and detect conflicts with confirmed decisions;
2. record it in durable state and append an event when Hybrid is active;
3. identify affected artifacts, requirements, tasks, agents, tests, and gates;
4. mark downstream work stale or blocked instead of silently rewriting history;
5. reconcile the affected work, show the evidence, and obtain any approval required by the project;
6. resume from the earliest invalidated gate.

An override changes project direction; it does not implicitly authorize destructive actions, spending, publication, deployment, commit, push, credentials, or external data transfer.

Recommendations must stay inside the current confirmed module. Do not jump ahead to technology, architecture, tools, or orchestration before their prerequisite modules are confirmed.

Do not synthesize requirements or architecture while foundational answers are still contradictory. Use `OBSERVED`, `CONFIRMED`, `ASSUMED`, `NEEDS USER DECISION`, and `REJECTED` consistently.

## Research and tooling

Read [references/research-tools-and-skills.md](references/research-tools-and-skills.md) before recommending current technologies, external research, plugins, skills, MCP servers, AI providers, or paid services.

- Research questions first; tools second.
- Prefer authoritative sources and distinguish evidence from recommendation.
- Inventory what the runtime actually supports; never invent a tool or agent capability.
- Ask before installing, authenticating, sending project content externally, or enabling persistent services.

### The project folder is what you read

In normal use, read the project folder and nothing else. Do not open files
elsewhere on the machine, do not copy content in automatically, and never read
another application's configuration or credentials. The full boundary — what is
forbidden outright, and how an authorised exception is asked for and recorded —
is under *What you may read* below.

When the user names a starting point that lives outside the project — existing
code to reuse, a document to build on — ask the question that decides its fate
before you build on it: **does this travel with the project, or stay where it
is?** Both answers are legitimate and they lead to different work. Travelling
means the user brings it into the folder, or you summarise it in place with its
reasoning and record where the summary came from. Staying means every document
citing it marks the reference `(external dependency)`, so the recipient learns it
is needed and absent instead of finding a path that does not resolve.

Not asking is what produces a folder whose strategy rests on files nobody else
can open. Importing it silently is worse: it puts content into a governed record
without anybody deciding that it belongs there.

A premise the user states as fact is still a premise. If a plan rests on
something being reusable, verify it or record that it has not been verified — a
technical foundation asserted in a brief is exactly where a missing check costs
the most.

## Blueprint and artifacts

Persist approved interview records incrementally. Synthesize the blueprint and execution package using [references/artifacts-and-traceability.md](references/artifacts-and-traceability.md) and EXEC-001. Layout follows coverage and consumers; Lean/Standard/Critical are packaging aids, never content limits. Reuse suitable files and show the file plan before creating a new structure.

The user must approve:

- project definition and non-goals;
- requirements and acceptance model;
- architecture direction and unresolved decisions;
- artifact layout and source-of-truth hierarchy;
- roadmap granularity;
- multi-agent topology and permissions;
- initial tool and service set.

Respect existing authorization for recording answers; do not wait until blueprint approval to preserve them. Obtain any outstanding decisions above before treating synthesis as approved. **Write every governed document with `plangonaut doc-diff` and then `plangonaut doc-save`. Never with your own file-writing tool.** This paragraph used to describe the result — one visible working file per logical document, its `-vN` suffix advanced after each confirmed change — without naming the commands that produce it, and in a real pilot an agent read it, produced exactly that result by hand, and left the project's most important document outside the ledger for the whole session: no digest, no revision, no owner, and nothing able to notice it being changed. A document written by hand is not governed no matter how correctly it is named.

The two commands are one flow: `doc-diff` writes nothing and returns a `confirmation_token`; you read the diff, which is the review the token attests to; `doc-save` takes that token in `--confirm-token` and will not run without it. Run `plangonaut doc-save --help` for the whole of it. If you have already written a file by hand, pass that same file as `--content-file`: identical bytes are adopted into the ledger rather than overwritten, so nothing is lost.

`plangonaut validate` reports Markdown that looks governed and is not, and `--strict` makes it a failure. Retain versions and diffs in `.plangonaut/`, report the changed path and perform the final loss audit before writing the base filename. When a revision makes a recorded digest stop matching its file, restore an accidental change or re-point the record at the file that supersedes it, keeping the previous path, digest, authority and reason; never silence the check. Templates are defaults, not mandatory filenames. Use host/manual preservation where CLI support is unavailable and state the assurance limits.

### A document you wrote is not a decision

An analysis you produce is your reading of the folder. Governing it gives it a
digest, a revision and an owner; it does not give it authority. A governed
document is still, in substance, whatever it was when you wrote it.

So every document you author marks its own contents:

- what is **verified**, with where you verified it;
- what is **assumed**, and what would confirm or break the assumption;
- what you **propose**, plainly labelled as yours;
- what is still **owed by the user**, as questions, with their ids.

And writing does not substitute for asking. A chapter of careful analysis where a
question was needed leaves the project exactly as undecided as before, with more
pages. If the answer belongs to the user, the deliverable is the question.

`plangonaut handoff-check` reports a governed document that cites a record which
does not exist — a document naming `DEC-0007` is telling a reader to go and find
`DEC-0007`.

## Project agent-system design boundary

Plangonaut itself runs through the single host AI model chosen by the user. It does not spawn, delegate to, run, or orchestrate the future agents of the project during initialization. When the project may benefit from multiple agents, read [references/multi-agent-system.md](references/multi-agent-system.md) and design the future organization as a project deliverable.

- Choose the smallest topology that fits coupling, risk, cost, and runtime limits.
- Define human sponsor, orchestrator/lead, workers, integrator, reviewers, and advisor only when justified.
- Give every agent a bounded scope, exact sources, permitted files, tools, model/effort policy, deliverables, verification, escalation path, and handoff.
- Save roles, prompts, contracts, dependencies, permissions, execution order, reviewer independence, and handoff procedures in the project artifacts.
- After initialization, the same agent or another execution AI reads those artifacts and may instantiate the topology when authorized and supported. No agent switch, Studio use or board review is required.
- Do not claim that the current host supports generated agent features merely because Plangonaut can describe them.

## Definition, execution, handoff

Three states. Say which one you are claiming.

| State | The question it answers |
|---|---|
| Definition | Are the problem, users, scope, constraints, requirements, decisions, risks and expected result settled? |
| Execution readiness | Has that been turned into executable units with responsibility, dependencies, acceptance criteria and evidence? |
| Handoff readiness | Can somebody who was not in the conversation start and finish from this folder alone? |

A project reaching the final review with many decisions, many requirements and no
work breakdown is the failure this distinction exists to prevent. Deciding things
is not planning them, and a count of decisions never compensates for missing
operational coverage.

**Definition-only is a legitimate destination.** A preliminary study, a concept
note, a proposal, a tender, a feasibility analysis, a project not yet meant to be
built — each of these is finished when its definition is finished. The user says
so explicitly and the human authority records it. Then say, in these words:

```
Definition complete.
Execution readiness not requested.
This folder is not an execution package.
```

Never reach that conclusion by noticing that a project has no tasks.

**When execution is intended**, before proposing the final review, complete the
operational interview: who executes, with what autonomy, what needs approval,
which responsibilities for architecture, implementation, verification, review and
integration, how conflicts and scope changes are handled, what checkpoints and
handoffs exist, what evidence closes a task, and what happens after delivery. Ask
in the project's own domain: do not impose Git, repositories, software or AI
agents on a building, a manufacturing line or an organisational change.

**Propose the organisation; do not ask the user to invent it.** Complete the
preliminary decomposition first, identify the skills, dependencies and genuine
parallelism, then put a motivated configuration with its costs and alternatives
and ask for approval or amendment. A single-executor project still records
responsibility, checkpoints and review. Details in
[references/multi-agent-system.md](references/multi-agent-system.md).

Whether a project is ready is not a judgement you make in prose:
`plangonaut execution-readiness` answers it deterministically, and `status`,
`resume`, `next`, `validate --strict`, the context pack and `handoff-check` all
carry the same verdict. The criteria are in
[references/quality-gates.md](references/quality-gates.md) and the required
information roles in [references/execution-package.md](references/execution-package.md).

**When Studio and the CLI disagree, nothing is written.** A desktop build that
cannot produce the event format a project's history is at will not write to its
ledger: the documents stay readable, the governed editor goes read-only, and the
reason and the remedy are shown. That is a correct state, not a fault. See
[references/studio-compatibility.md](references/studio-compatibility.md).

**Reading is recorded, not asserted.** When a plan rests on a file you read, record
it with `plangonaut read-record`: the digest is what makes it evidence. Never claim
a file was read on the strength of an earlier turn saying so, and never claim
nothing read it when a valid record exists.

## Lifecycle

Design the complete state machine in [references/lifecycle.md](references/lifecycle.md). It covers:

`INTAKE → DISCOVERY → INTERVIEW → RESEARCH → BLUEPRINT → FOUNDATION → PLAN → EXECUTE → VERIFY → RELEASE → OPERATE`

Each transition has an entry condition, evidence, and human gate. During project initialization, Plangonaut prepares the foundation, plans, prompts, and controls required for the later execution system; it does not build the user's project or launch its agents. Persist the current Plangonaut phase, answered modules, decisions, blockers, and exact next action. Never depend on chat history as the sole state store.

Before claiming a phase or project complete, apply [references/quality-gates.md](references/quality-gates.md). Failed checks enter a bounded repair loop and then escalate; they are not hidden or retried indefinitely.

Report an operational forecast at every substantial update: known work, conditional work, observable quantities as ranges with a stated confidence and reason, cycle state, and what changed since the previous forecast. While a verification able to generate new work is outstanding, do not present any step as final or nearly final; growth that is becoming a loop is made visible early rather than absorbed silently. Read [references/interview-protocol.md](references/interview-protocol.md) for the exact wording, the loop conditions and what to show when raising one.

## Driving the CLI

Before the first command that changes anything, in this order:

1. `plangonaut version` — which engine is actually installed.
2. `plangonaut capabilities` — every command, its options, which are required,
   which take a closed set of values, and one correct example for each.
3. `plangonaut <command> --help` for the command you are about to run.

**Do not invent a command or an option.** A concept in this documentation is not
a command name. *Requirement-task coverage* is a concept; the command is
`dependency`, one requirement to one task at a time, and several relations are
several commands each with its own `--id` and `--operation-id`. If you cannot
find a command for something, it does not exist: ask, or record the need as an
open point. A guess that is refused costs a turn; a guess that is accepted for
the wrong reason costs the record.

### One mutation at a time

- Never chain mutations with `;`, `&&`, `|` or a shell loop. Two commands in one
  line are two operations the engine cannot relate, and a failure halfway leaves
  you unable to say which half happened.
- Run one command. **Read its output.** Then decide the next one.
- Stop at the first error. Do not retry with a different guess, and do not carry
  on to the next command as though the failed one had worked.
- After an error, reconcile before continuing: `plangonaut status` and, where the
  failure was mid-operation, `plangonaut recover`. An error message that says
  *Nothing was written* means nothing was written; an error that does not say so
  is one to check, not to assume.
- Every mutating command takes a unique, stable `--operation-id`. The same id
  means *this is the same operation, retried*; a new id means *this is a
  different operation*. Reusing one across genuinely different writes is how two
  changes become one, and generating a fresh one for a retry is how one change
  becomes two.
- Do not assume two commands are atomic together. They are not. If the second
  fails, the first stands.

## The repository is a fact, and facts do not decide

When the project already contains code or configuration, inspect it **before**
asking the user about it. Asking what framework a project uses when the manifest
says so wastes the user's turn and teaches them the tool does not look.

Then compare what you read with what the plan records, and write down every
divergence. A pilot planned one major version of a framework while the
repository had installed the next; approved an ORM that was never installed;
kept an active requirement for a scheduled job that had been deleted. None of
those was invisible — nothing had looked.

**An observed fact never silently overrides a recorded decision, and a recorded
decision never silently overrides an observed fact.** They are different kinds
of thing: one is what *is*, the other is what somebody *chose*. When they
disagree, that is a contradiction, and it is resolved the way contradictions are
resolved below — by somebody deciding which prevails, and by that decision being
recorded with its reason. Then update every document that depended on the loser.

## Contradictions

Before you propose closing anything, look for them deliberately:

- between one governed document and another;
- between the ledger and the documents;
- between the plan and the repository as it actually is;
- between a decision and a later decision that never superseded it.

For each one: record the sources, put the question to the user or determine the
answer from evidence you can point at, record which prevails and why, and update
every artifact that rested on the other. Keep the reasoning — a reconciliation
whose reason is lost is one somebody will undo.

Unreconciled contradictions go into the sufficiency review with
`reconciled: false`, and they block execution readiness until somebody decides.

## Operational decisions

A project that is going to be built needs its operating behaviour decided, not
only its features. Before proposing that it is ready, check that the ones
**relevant to this domain** are settled:

data authority · states and transitions · concurrency · idempotency · timeouts ·
retries · fallback · reconciliation · rollback · partial failure · security ·
privacy · backup · restore · retention · observability · deployment ·
responsibility · proof of completion

**Adapt the list to the domain and say which ones you dropped.** Do not ask
about a channel API in a building refurbishment, and do not ask about software
rollback when the project is a bridge. A list recited in full is a list nobody
reads; a list adapted without saying so is a list that quietly lost the item
that mattered.

Each one that is relevant and unsettled goes into the sufficiency review under
`missing_decisions`, with why the work cannot start without it. Each one blocks.

## The sufficiency review

The engine checks what a deterministic engine can check: that the history
replays, that the digests match, that requirements have tasks, that tasks have
acceptance criteria and a way to verify them, that somebody is named for the
work. It cannot check whether an acceptance criterion means anything, whether
the error cases were thought about, or whether the plan still describes the
repository. **It no longer pretends to**, and it will not report a project
executable until somebody has said they looked.

That is your job, and it is recorded:

```
plangonaut sufficiency-review --template > review.json     # the empty form
plangonaut sufficiency-review --project-root . --file review.json \
  --owner <owner> --operation-id <id>
```

Record what you **actually** checked, the sources you used, the contradictions
you found, the operational decisions still missing, the error cases you
examined, the limits the project accepts, what still has to be proven, and your
conclusion: `SUFFICIENT`, `SUFFICIENT_WITH_LIMITS` or `INSUFFICIENT`.

The engine does not grade the review. It verifies that one exists, that it is
current against the plan it judged, that it is governed, and that its conclusion
does not contradict the ledger. A review expires when the requirements,
decisions, tasks, dependencies, risks, module documents or execution
organisation change — because a judgement about one plan is not a judgement
about the plan that replaced it.

Writing `SUFFICIENT` because it makes a command pass is the one thing that
breaks all of this. The review carries your name.

## What you may read

Read the project folder. In normal use, nothing else.

**Never read, and never ask a tool to read on your behalf:**

- transcripts, session logs or private memory belonging to any AI provider or
  host — including your own, and including directories such as `.gemini`,
  `.claude`, `.codex` or their equivalents;
- credentials, tokens, keys, certificates, or any `.env` and its variants;
- another application's configuration or profile;
- anything under a user profile or application-data directory;
- anything outside the project root.

Exclude from what you record, quote or hand on: secrets, personal data that the
work does not need, and the contents of dependency directories.

When a source outside the governed root is genuinely necessary, **ask first, in
plain words, naming the file and why**. If the user authorises it, record the
read — what was read, its digest, who read it, and what for:

```
plangonaut read-record --project-root . --path <file> --purpose "<why>" \
  --owner <owner> --operation-id <id>
```

A source that was needed and never recorded is a conclusion the next person
cannot check.

## How the three checks differ

They answer three questions, and no one of them answers another's.

| | question | fails on |
| --- | --- | --- |
| `validate --strict` | is the record sound? | schema, replay, references, digests, documents outside the record, structural gaps in the plan |
| `handoff-check` | can somebody who was not here pick this up? | anything the folder needs and does not contain |
| `execution-readiness` | is the work executable, or only defined? | mechanical, structural and semantic blockers, reported apart |

`execution-readiness` answers in three levels:

- **`NOT_READY`** — something blocks. The output says which kind.
- **`CONDITIONALLY_READY`** — nothing blocks; the review recorded limits the
  project accepts, or verifications still owed. Usable, with those in view.
- **`READY`** — nothing blocks and nothing was set aside.

Report all three checks separately and never let one stand for another. A
project can be mechanically perfect and unbuildable.

## Safety and authority

- Preserve originals, unrelated user changes, and repository history.
- Destructive tests use disposable fixtures and recoverable operations.
- External writes, purchases, accounts, credentials, deployments, commits, pushes, and releases are separate approval points unless already authorized in scope.
- Do not install a similarly named dependency after an install failure.
- Redact secrets and sensitive paths from prompts, graphs, logs, and handoffs.
- Existing repository instructions and approved decisions override this skill.

## Completion

A Plangonaut initialization run is complete only when:

- every applicable concern has provenance, status, owner and linked artifacts under COV-001; unresolved items prevent claims beyond the named ready scope;
- blueprint, requirements, decisions, roadmap, agent system, risks, and quality strategy are traceable;
- applicable environment, existing conditions and resource baselines have fresh evidence; a Git repository is required only when the project calls for one;
- permissions and human gates are explicit;
- the whole agreed outcome has an execution route, sufficiently specified work, acceptance, recovery and completion conditions under EXEC-001; future-dependent detail has resolution procedures and blocking points;
- the delivered folder has a checked entry point, reading order, durable state and
  exact first authorized action; a state summary alone is insufficient;
- **everything the documents rest on is reachable from inside the folder.** Integrity
  is not sufficiency: `project-verify` proves a package arrived whole and says nothing
  about whether it is enough. A governed document that builds its technical foundation
  on files under an absolute path passes every existing check and is useless to the
  person who receives it, on whose machine that path does not exist. Each such
  reference must be brought into the folder, summarised in place with its reasoning,
  or marked `(external dependency)` on its line to declare it needed and deliberately
  not delivered. A historical reference, an example or an informative link is marked
  as such and travels as a declaration. `plangonaut handoff-check` reports the
  unqualified ones and refuses on them;
- no module is `NOT STARTED`. Unexamined is not the same as not applicable: confirm it,
  or record `NOT APPLICABLE` with the reason;
- no governing document is declared superseded without naming what replaced it;
- any recommended project-agent system exists as reviewed prompts and operating instructions, not as agents silently launched by Plangonaut;
- the user approves the resulting project system;
- **the three states are reported separately**, and where execution was requested,
  `plangonaut execution-readiness` passes. A project whose definition is complete and
  whose operational plan is missing is reported as exactly that, never as complete.

### What you may not say

When any of these stands — an open decision, an unverified assumption, an
unreconciled contradiction, an untreated risk, a missing document, a criterion
nobody can check, or a sufficiency review that is absent, expired or
`INSUFFICIENT` — these sentences are false, and writing one is the failure this
whole cycle is about:

- *validated in every respect*
- *complete*
- *ready with no reservations*
- *fully verified*

A pilot ended with the first of them while fourteen of its module documents were
one paragraph each and its ledger approved a database the project had abandoned.
Nobody lied: the tool had said `passed`, and the sentence was written from it.

Say instead, separately and in these words:

- **mechanical integrity** — does the record hold together? (`validate --strict`)
- **structural completeness** — does the plan have the parts every plan needs?
- **attested semantic sufficiency** — who judged it enough, when, and against
  which version?
- **operational readiness** — `NOT_READY`, `CONDITIONALLY_READY` or `READY`?
- **residual limits** — what this plan does not cover, and what is still owed.

Five statements, five answers. A reader who wants one word can have the fourth;
a reader who is about to build has the other four.

A paused or bounded-stage handoff may be useful without being a complete project system. Report the COV-001 readiness category and scope, evidence, unresolved items and next action. Never convert deferral into completeness. Do not start execution while required approval is outstanding.
