# Quality and Governance Gates

Grade each applicable gate `PASS`, `WARN`, `BLOCKED`, or `NOT APPLICABLE`. Cite fresh evidence and the responsible owner.

## Genesis gates

### G0 — Authority

Workspace, instructions, decision owners, protected assets, persistence, external access, mutation, and publication authority are explicit.

### G1 — Intent

Problem, users, outcome, success, non-goals, project type, and first milestone are confirmed.

### G2 — Coverage

Review the COV-001 concern register, including domains beyond the initial catalog. Resolved concerns carry evidence and applicable confirmation. Deferrals/blockers retain consequences, owners, resolution work and blocking points. Contradictions affecting the proposed scope block readiness. Module status does not substitute for concern coverage.

### G3 — Evidence

Required research is complete, current sources are cited, experiments have criteria/results, and uncertainty remains visible.

### G4 — Blueprint

Requirements, architecture, UX, data, safety, quality, delivery, risks, and roadmap are internally consistent and user-approved.

### G5 — Agent system

Topology, roles, model/effort routing, permissions, context, ownership, dependencies, reviewers, budgets, escalation, and handoffs are approved.

### G6 — Foundation

Canonical sources, state, environment, repository baseline, safe configuration, contracts, tasks, and verification commands exist and are reproducible.

### G7 — Plan

The whole agreed outcome has an EXEC-001 route, work definitions, dependency order, resources, roles, verification, recovery and completion conditions. Future-dependent detail has resolution work and blocking points. Record approval and COV-001 readiness scope; the next milestone alone does not establish whole-project readiness.

## Delivery gates

### G8 — Task completion

Fresh targeted tests pass, actual diffs/artifacts match the task, important review findings are closed, and state/handoff are updated.

### G9 — Integration

Contracts and consumers agree, full relevant suites pass, migrations and rollback are tested, and cross-task conflicts are resolved.

### G10 — Human acceptance

The authorized user validates critical workflows, UX, content, and outcomes not provable by automation.

### G11 — Release

Security/safety, data, legal, operational, backup, migration, rollback, observability, support, version, and publication authority are satisfied.

### G12 — Operations

Outcome metrics, incidents, costs, dependencies, feedback, maintenance, and audit cadence have owners and thresholds.

## Evidence rule

Before any success claim:

1. name the command, artifact, review, or user confirmation that proves it;
2. obtain fresh complete evidence;
3. read failures, warnings, exit status, and skipped scope;
4. compare evidence to the requirement, not merely to tool success;
5. state the actual status.

An agent report is not independent evidence. A linter is not a build. Passing tests do not prove unmet product requirements.

A recorded gate is only as good as the file it was passed on. In Hybrid, `validate` re-verifies that file and names the gates for which it could re-verify nothing; attach the missing evidence rather than reading the pass as proof, and decide between restoring and superseding when a digest no longer matches ([engine-contract.md](engine-contract.md)).

## Repair and escalation

- Define maximum repair attempts before execution.
- Count the cycles out loud: repeated cycles on one defect family are a loop signal and are reported as one ([interview-protocol.md](interview-protocol.md)).
- Fix one causal layer at a time and rerun affected evidence.
- If failure reveals a wrong requirement or architecture, return to Blueprint or Plan.
- Never replace a failed dependency with a similarly named package without verification and approval.
- On exhaustion, mark `BLOCKED`, preserve evidence, identify the owner, and state the exact unblock condition.

## Final audit

Use [execution-package.md](execution-package.md) for folder acceptance. CLI structure checks, semantic review and execution evidence are distinct. Neither a gate flag nor a favorable review proves future implementation works. A paused interview or bounded-stage handoff is not whole-project completion.

Before declaring the project or milestone complete, verify:

- requirement-to-evidence coverage;
- unresolved decisions and accepted risks;
- documentation and implementation drift;
- agent/tool permission drift;
- recovery and rollback viability;
- reproducibility from a clean environment;
- user approval of the delivered outcome.

## Execution readiness

A deterministic check, separate from integrity and separate from the definition.
`plangonaut execution-readiness --project-root . [--json]` answers it, and
`status`, `resume`, `next`, `validate --strict`, the context pack, the forecast
and `handoff-check` all carry the same verdict, computed once so they cannot
disagree.

Four verdicts, and the difference between the last two matters:

| Verdict | Meaning |
|---|---|
| `PASSED` | the work can be picked up |
| `FAILED` | something named below stops anybody starting |
| `NOT REQUESTED` | the project is declared definition-only |
| `NOT ASSESSED` | nobody has declared whether it is to be built |

`NOT ASSESSED` never becomes `NOT REQUESTED` by inference. A project that is
merely unfinished is indistinguishable from a deliberate study, and guessing is
the original defect.

It fails when, for example:

- the project is to be built and no implementation work exists — a plan made
  entirely of administrative tasks arranges for work without being it;
- tasks record no kind, so nothing can tell whether any of them builds anything;
- approved requirements have no task;
- work cannot be picked up as written: no acceptance criterion, no requirement or
  decision of origin, no responsible role, no verification or evidence;
- the organisation of whoever executes has not been approved;
- several executors are approved with no integrator, or none with a reviewer;
- the approved organisation does not say how concurrent changes are prevented, or
  when work is handed over;
- dependencies contain a cycle;
- an open risk has no owner;
- no exact next action is recorded, so the folder does not say how to begin.

**It does not fail for being a one-person project, and does not fail for not
being software.** No check requires agents, Git, repositories or tests: a roofing
project with one executor, one requirement, one construction task with a witnessed
acceptance test and a named surveyor passes.

**There is no task-count threshold anywhere in it.** Three tasks can be a complete
plan for a small project; a hundred generic ones are a hundred restatements of an
intention. Coverage decides.

## Modules 14, 15 and 16

Enforced by refusal rather than warning, because these three labels are what a
recipient trusts most.

- **14** may be `NOT APPLICABLE` only when no team and no second executor are
  needed, and the single executor's responsibility must still be recorded first.
  `CONFIRMED` requires an approved organisation.
- **15** requires a work breakdown, a milestone or gate, dependencies where there
  is more than one task, at least one risk, acceptance criteria, verifications,
  and recorded responsibility.
- **16** is refused while the definition is incomplete, while execution readiness
  fails on a project that requested it, while the execution intent is undeclared,
  while decisions remain `PROPOSED`, or while an override is unreconciled.
