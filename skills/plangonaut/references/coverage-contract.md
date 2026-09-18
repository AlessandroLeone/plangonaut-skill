# Complete project coverage

**Contract:** COV-001, version 1.0.0. Semantic contract; not a claim that the current CLI enforces these fields.

Read during discovery, throughout the interview, after changes and before readiness assessment. Use the same contract in Semantic-only and Hybrid.

## Derive coverage from the outcome

Name the agreed outcome and completion boundary first. Survey the disciplines needed to achieve it, their interfaces, resources and verification responsibilities. The questionnaire is a starting catalog, not a closed list of disciplines or a limit on inquiry. Add concerns whenever an answer, source, experiment or reviewer reveals them.

For every applicable discipline consider intent, existing conditions, requirements, technical/domain design, resources and procurement, responsibilities, interfaces, execution sequence, acceptance, failure/recovery, delivery and ongoing operation. This is a coverage lens, not a demand to ask a fixed question list or to create one document per cell. Record reasoned exclusions. A single model may prepare several disciplines; that does not turn it into a qualified human authority or a physical executor.

Use existing sources before questioning. Distinguish observed facts, confirmed decisions, recommendations, assumptions and unresolved questions. Trace consequential premises to evidence or a decision owner. Derive or research facts within authority; ask the human for intent, priorities, constraints and consequential choices that evidence cannot settle. Never invent an answer to close a row.

There is no total question, document, page, prompt or investigation cap. Presentation can be concise while project coverage remains exhaustive for the agreed outcome. Do not add repetitive documents to simulate completeness.

## Coverage record

Maintain a durable coverage register with stable IDs and these information roles, using project conventions. A Markdown table with linked detail is sufficient; neither JSON nor the CLI is required.

| Field | Meaning |
|---|---|
| Concern ID and discipline | Stable identity and domain of responsibility |
| Question or obligation | The issue that must be settled, or work that must be specified |
| Applicability and rationale | Why it matters, or why it does not apply |
| Status | OPEN, IN_PROGRESS, RESOLVED, DEFERRED, BLOCKED, or NOT_APPLICABLE |
| Provenance | Source, observation or human confirmation; distinguish assumptions |
| Decision and owner | Recorded conclusion and accountable decision authority |
| Artifacts and verification | Where the conclusion is implemented in the dossier and how adequacy is assessed |
| Dependencies and impact | Prerequisite concerns and downstream requirements/tasks/contracts |
| Next action / blocking point | What happens next and what cannot proceed meanwhile |

These are coverage statuses, not new values to insert into an existing CLI module/schema enum. Until a compatible engine schema exists, keep this register in governed Markdown and point to it from the project index. Do not patch state.json by hand to simulate support.

RESOLVED requires an answer or fulfilled obligation, applicable confirmation, accessible evidence and propagation to the relevant artifacts. A module label, filled heading or passing file validator is insufficient. NOT_APPLICABLE requires a reason; it is not completed work. DEFERRED requires owner, consequence, prerequisite/trigger, resolution procedure, acceptance and the exact point it blocks. BLOCKED identifies what is missing and who can unblock it.

When a premise changes, preserve the old decision, reopen affected concerns and invalidate dependent readiness claims. A timestamp or file revision does not perform semantic reconciliation. If a relation is uncertain, record that uncertainty rather than claiming a complete impact map.

## Interview progression

Survey breadth before deep design so an early technical choice does not hide a necessary discipline. Then resolve dependencies in a sensible order. Respect per-turn question limits, but continue as many turns as needed. Reuse valid earlier confirmations; do not restart the authority interview on Resume unless authority or scope changed.

**Coverage is a navigation criterion, not only a completion one.** This contract used to be read only at the end, to decide whether enough had been done. Read that way it says nothing during the work, and a pilot showed what that costs: six rounds and nine questions inside one module, down to JSON schema and single-function detail, while sixteen of seventeen modules had never been opened — and every command answered OK. The architecture produced there was designed without knowing what language it would be written in, which is a decision in another module and can invalidate it.

So, while the interview is running and not only at its end:

- compare the depth reached against the breadth reached, and say so when they diverge;
- do not design a final architecture while identity, users, scope or the technology it needs are   undefined; sketch, and say it is a sketch;
- when you choose to go deep on one domain, **declare the choice and record it** — a deep dive nobody   stated cannot be reviewed and is indistinguishable from drift;
- return to breadth afterwards, before going deep anywhere else;
- keep the recorded forecast current, and re-record it when what you learn changes it;
- treat a premise the user states as fact as a premise: a technical foundation asserted in a brief is   exactly where a missing check costs the most.

In Hybrid, `plangonaut status` and `plangonaut next` report the imbalance and the threshold that triggered it. The report never refuses the deep dive; it requires that the choice be put to the user and the answer recorded. In Semantic-only the same discipline applies without the reminder.

At each checkpoint report the unresolved frontier, important new discoveries and the next question or investigation. Totals help navigation, but no percentage or module count establishes readiness. A user's request to pause ends the session with unfinished work preserved, not a false completion claim.

## When a module may be confirmed

`CONFIRMED` means the project may build on the module. It is a claim about the
module's own ledger, and four things in that ledger contradict it:

- a question on the module is `ASKED`, or `ANSWERED` with its consequences not yet applied;
- a decision that came out of the module's interview is still `PROPOSED`;
- an `APPROVED` decision of the module's records no provenance;
- nothing at all is recorded against it -- no coverage exists to confirm.

`record --status CONFIRMED` names any of these at the write; `validate --strict`
fails on them and `handoff-check` refuses the handover. A module that genuinely
does not apply is `NOT_APPLICABLE` with its reason; one being left for later is
`DEFERRED`. Both are honest, and both are available at any moment.

Module 0 is exempt from the last condition: `init` confirms it from the owners
file, which is the whole of its content.

## Readiness assessment

Record one of these human-readable outcomes with scope, evidence, authority and remaining restrictions. They are report labels, not new CLI gate values.

- **Not ready:** design prerequisites or required artifacts are missing or contradictory.
- **Ready for a named bounded stage:** that stage has no unresolved prerequisites; later uncertainties have explicit resolution work and blocking points. This is not whole-project readiness.
- **Prepared for the agreed outcome:** the full execution path and all currently decidable prerequisites are specified; unavoidable future-dependent decisions have executable resolution procedures before dependent work. Explicit human/physical/capability gates still apply.

Deferred product choices that could be resolved now do not become a complete project by attaching a generic “ask later” instruction. If the user intentionally narrows the outcome, record the changed boundary and preserve the excluded work. Do not silently narrow the outcome to pass readiness.

Apply [execution-package.md](execution-package.md) to test whether the folder actually supplies what the executor needs. Readiness of a dossier never claims that the future implementation has already passed its tests.

**Sufficiency is not integrity.** A folder can be internally consistent, digest-verified and complete by every structural check, and still be unusable because what its documents rest on is not in it. Every reference a document makes to something outside the folder is either brought in, summarised in place with its reasoning, or marked as what it is — `(external dependency)`, `(historical reference)`, `(example)`, `(informative)`. Only the first kind, left unqualified, blocks delivery. In Hybrid, `plangonaut handoff-check` reports them.
