import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "lib", "bin", "plangonaut.js");

/**
 * The pilot, reduced to the shape that fooled the engine.
 *
 * HOW THIS FIXTURE WAS DERIVED
 * ----------------------------
 * From a real pilot: a small booking site whose ledger said it was ready to
 * build. Nothing was copied. The project was read, the *shape* of its defects
 * was written down, and that shape is rebuilt here with the same commands a
 * user runs — so there is no sanitisation to get wrong, because there is no
 * pilot content in the file.
 *
 * WHAT WAS DELIBERATELY LEFT OUT
 * ------------------------------
 * The business, the trading name, the owners, the domains, the third-party
 * vendors by name, the prices, the credentials, every `.env`, and the
 * application code. None of it is needed: what made the pilot pass was
 * structural, and a structure has no personal data in it. The vendors appear
 * as *the channel API*, *the payment provider* and *the content system*,
 * which is also what keeps this a test of the engine rather than a rehearsal
 * of one domain — the engine must not know what a channel API is.
 *
 * WHAT WAS KEPT, BECAUSE IT IS THE DEFECT
 * ---------------------------------------
 *   - a mechanically valid ledger: replay clean, schema clean, references sound
 *   - every interview module CONFIRMED against a one-paragraph document
 *   - requirements, tasks and dependencies present, so coverage looks complete
 *   - acceptance criteria that are three words and verify nothing
 *   - an APPROVED decision naming a component the project no longer uses
 *   - an ACTIVE requirement for a job that was deleted
 *   - a HIGH risk with an owner and no treatment
 *   - an approved execution organisation
 *
 * Before the sufficiency gate this passed `execution-readiness`. It must not
 * pass now, it must say why, and it must not pretend to an opinion about
 * bookings.
 */

let counter = 0;
function fixtureRoot(name) {
  counter += 1;
  const root = path.join(os.tmpdir(), "plangonaut-sufficiency", `${name}-${process.pid}-${counter}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function invoke(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

const NEEDS_OPERATION = new Set([
  "init", "record", "decision", "requirement", "task", "dependency", "risk", "evidence", "agent",
  "checkpoint", "gate", "execution-intent", "execution-org", "read-record", "sufficiency-review",
  "qa-ask", "qa-answer", "qa-settle",
]);

function run(...args) {
  if (NEEDS_OPERATION.has(args[0]) && !args.includes("--operation-id")) {
    args = [...args, "--operation-id", `OP-${crypto.randomUUID()}`];
  }
  const result = invoke(...args);
  assert.equal(result.status, 0, `${args[0]} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result.stdout;
}

function readiness(project) {
  return JSON.parse(invoke("execution-readiness", "--project-root", project, "--json").stdout);
}

function handoff(project) {
  return JSON.parse(invoke("handoff-check", "--project-root", project, "--json").stdout);
}

/** A module outcome exactly as the pilot wrote them: a heading and a sentence. */
function thinModule(project, number, heading, sentence) {
  const file = path.join(project, "docs", `module-${number}-outcome.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${heading}\n\n${sentence}\n`);
  return file;
}

/**
 * The fixture.
 *
 * `defects` lets one test remove one thing and see one finding, which is the
 * difference between a suite that proves a rule and a suite that proves a
 * fixture.
 */
function pilotShaped(name, defects = {}) {
  const {
    acceptance = "Env ok",
    verification = "Env config",
    evidence = "Env ok",
    risk = "untreated",
    organisation = true,
  } = defects;

  const project = fixtureRoot(name);
  const owners = path.join(project, "owners.json");
  fs.writeFileSync(owners, JSON.stringify({ product: "Owner", technical: "Owner", budget: "Owner", safety: "Owner", release: "Owner" }));
  run("init", "--project-root", project, "--project-name", "Booking site", "--project-mode", "Resume",
      "--interaction-mode", "Standard", "--owners-file", owners);
  run("execution-intent", "--project-root", project, "--execution", "--reason", "The owner approved the build.", "--owner", "Owner");

  /*
   * Three modules, each CONFIRMED against a paragraph, each with a real
   * interview entry behind it.
   *
   * The entry matters: without it `validate --strict` objects that a CONFIRMED
   * module has no coverage, and the fixture would fail for a reason that is not
   * the one under test. The pilot had all of this — seventeen settled modules,
   * a full interview log, a clean replay — which is exactly why its documents
   * being one paragraph each went unnoticed.
   */
  const modules = [
    [1, "Identity and purpose", "A site for two units, aimed at direct bookings. Booking is not live yet.",
     "What is this site for?", "Direct bookings for two units"],
    [2, "Users and domain", "Guests browse and book; the owner manages availability. No other roles in the first release.",
     "Who uses it?", "Guests and the owner"],
    [3, "Scope", "Browsing, sign-in and a booking request. Payment and channel synchronisation come later.",
     "What is in the first release?", "Browsing, sign-in, a booking request"],
  ];
  for (const [number, heading, sentence, question, answer] of modules) {
    const qna = `QNA-${String(number).padStart(4, "0")}`;
    run("qa-ask", "--project-root", project, "--id", qna, "--question", question,
        "--rationale", "The module cannot be settled without it", "--module", String(number), "--owner", "Owner");
    /*
     * The decision is recorded between the question and its answer, because
     * that is the order the engine requires and the order that is true: a
     * decision a question produced cannot predate the question. `--consequences`
     * then links them, which is the provenance `validate --strict` asks of every
     * APPROVED decision — and which the pilot had.
     */
    const produced = { 1: ["DEC-0001", "Email one-time codes for guest sign-in"], 2: ["DEC-0002", "Use the hosted managed database and its ORM"] }[number];
    if (produced) {
      run("decision", "--project-root", project, "--id", produced[0], "--title", produced[1], "--status", "APPROVED", "--owner", "Owner");
    }
    run("qa-answer", "--project-root", project, "--id", qna, "--answer", answer, "--owner", "Owner");
    /*
     * The settled question names the decisions it produced.
     *
     * `validate --strict` already refuses an APPROVED decision with no
     * provenance, and the pilot's decisions had it: they came out of the
     * interview. A fixture without it would fail strict for a reason that is
     * not the one under test, and would make the gate look like the cause.
     */
    const consequences = produced?.[0];
    const settle = ["qa-settle", "--project-root", project, "--id", qna, "--interpretation", answer,
        "--reply", "Recorded.", "--owner", "Owner"];
    if (consequences) settle.push("--consequences", consequences);
    run(...settle);
    const file = thinModule(project, number, heading, sentence);
    run("record", "--project-root", project, "--module", String(number), "--status", "CONFIRMED",
        "--answer-file", file, "--owner", "Owner");
  }

  run("requirement", "--project-root", project, "--id", "REQ-0001", "--title", "Guests can hold and pay for a stay", "--status", "ACTIVE", "--owner", "Owner");
  // The requirement nobody withdrew when the thing it names was deleted.
  run("requirement", "--project-root", project, "--id", "REQ-0002", "--title", "A scheduled job keeps the hosted database awake", "--status", "ACTIVE", "--owner", "Owner");

  const task = [
    "task", "--project-root", project, "--id", "TSK-0001", "--title", "Sign-in and session handling",
    "--status", "READY", "--owner", "Owner", "--kind", "IMPLEMENTATION",
    "--requirements", "REQ-0001", "--decisions", "DEC-0001", "--role", "implementer",
  ];
  if (acceptance !== null) task.push("--acceptance", acceptance);
  if (verification !== null) task.push("--verification", verification);
  if (evidence !== null) task.push("--evidence-expected", evidence);
  run(...task);

  run("task", "--project-root", project, "--id", "TSK-0002", "--title", "Scheduled keep-awake job",
      "--status", "READY", "--owner", "Owner", "--kind", "IMPLEMENTATION",
      "--requirements", "REQ-0002", "--role", "implementer",
      "--acceptance", "Job runs", "--verification", "Log line", "--evidence-expected", "Log");

  run("dependency", "--project-root", project, "--id", "DEP-0001", "--from", "REQ-0001", "--to", "TSK-0001", "--type", "REQUIRES", "--owner", "Owner");
  run("dependency", "--project-root", project, "--id", "DEP-0002", "--from", "REQ-0002", "--to", "TSK-0002", "--type", "REQUIRES", "--owner", "Owner");

  if (risk === "untreated") {
    run("risk", "--project-root", project, "--id", "RSK-0001", "--title", "The channel API changes without notice",
        "--severity", "HIGH", "--status", "IDENTIFIED", "--owner", "Owner");
  }

  if (organisation) {
    run("execution-org", "--project-root", project, "--executors", "2", "--mode", "Agentic",
        "--reviewer", "Owner", "--integrator", "Owner", "--concurrency", "one component at a time",
        "--handoff", "review passes before the next task starts", "--owner", "Owner");
  }

  run("checkpoint", "--project-root", project, "--id", "CHK-0001", "--name", "Definition settled", "--owner", "Owner");
  return project;
}

function reviewFile(project, body) {
  const file = path.join(project, `review-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    checked: ["Requirements against the repository", "Acceptance criteria", "Error paths on payment"],
    sources: ["the ledger", "package manifest"],
    contradictions: [],
    missing_decisions: [],
    error_cases_examined: ["a payment that succeeds while the channel is unreachable"],
    limits: [],
    verifications_required: [],
    conclusion: "SUFFICIENT",
    author: "Reviewer",
    ...body,
  }, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// 1. The defect, and that it is gone
// ---------------------------------------------------------------------------

test("the pilot shape is refused, and the refusal says which kind of thing is wrong", () => {
  const project = pilotShaped("pilot");
  const verdict = readiness(project);

  assert.equal(verdict.level, "NOT_READY", verdict.execution.findings.join("\n"));
  assert.equal(invoke("execution-readiness", "--project-root", project).status, 2);

  // The causes are separated, and each one names something different to fix.
  assert.ok(verdict.execution.causes.structural.length > 0, "no structural finding");
  assert.ok(verdict.execution.causes.semantic.length > 0, "no semantic finding");
  assert.match(verdict.execution.causes.structural.join(" | "), /RSK-0001 is HIGH and has no recorded treatment/);
  assert.match(verdict.execution.causes.semantic.join(" | "), /no sufficiency review is recorded/);

  // And it does not invent an opinion about the domain.
  const everything = JSON.stringify(verdict).toLowerCase();
  for (const word of ["overbooking", "booking is unsafe", "payment is wrong", "should use"]) {
    assert.ok(!everything.includes(word), `the engine offered a domain judgement: ${word}`);
  }
});

test("mechanical integrity and readiness are different questions, and both are answered", () => {
  /*
   * Structurally clean on purpose.
   *
   * `validate --strict` already fails on structural readiness, which is a
   * decision this cycle did not change: a folder with a task nobody can verify
   * is not fit to leave. What must *not* reach it is the semantic gate, and
   * that is what this fixture isolates — remove the structural defects and the
   * only thing left standing between this project and READY is a judgement
   * nobody has made.
   */
  const project = pilotShaped("integrity", {
    acceptance: "A hold expires in 15 minutes and a second checkout is refused",
    verification: "Integration test", evidence: "Test output", risk: "none",
  });

  // Integrity is sound: the ledger replays, the schema holds, the digests match.
  const strict = invoke("validate", "--project-root", project, "--strict");
  assert.equal(strict.status, 0, `${strict.stdout}
${strict.stderr}`);

  // And the project is not ready. `validate --strict` did not become a judge.
  assert.equal(readiness(project).level, "NOT_READY");

  // Now break one document under the engine's feet. Integrity fails, and
  // readiness reports it as mechanical rather than as a planning defect.
  const document = path.join(project, "docs", "module-2-outcome.md");
  fs.appendFileSync(document, "\nAn edit nobody recorded.\n");
  assert.notEqual(invoke("validate", "--project-root", project, "--strict").status, 0);
  const after = readiness(project);
  assert.ok(after.execution.causes.mechanical.length > 0, "a changed document was not reported as mechanical");
  assert.match(after.execution.causes.mechanical.join(" "), /digest that no longer matches/);
});

test("a module document that exists is not a module that was answered", () => {
  const project = pilotShaped("modules");
  // Every module is CONFIRMED and every document is one paragraph. Nothing
  // structural objects — correctly, because the engine cannot read — and the
  // semantic gate is what stands in the way.
  const verdict = readiness(project);
  assert.equal(verdict.level, "NOT_READY");
  assert.equal(verdict.sufficiency.recorded, false);
  assert.match(
    verdict.execution.causes.semantic.join(" "),
    /whether it is \*enough\*/,
    "the refusal did not say what kind of judgement is missing",
  );
});

// ---------------------------------------------------------------------------
// 2. The gate opens, and only for what was actually attested
// ---------------------------------------------------------------------------

test("the same fixture is accepted once its defects are closed and somebody has judged it", () => {
  const project = pilotShaped("closed", { acceptance: "A hold is taken, expires in 15 minutes, and a second checkout for the same dates is refused", verification: "Integration test against the sandbox", evidence: "Test run output", risk: "none" });
  run("risk", "--project-root", project, "--id", "RSK-0001", "--title", "The channel API changes without notice",
      "--severity", "HIGH", "--status", "ACCEPTED", "--owner", "Owner");
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {}), "--owner", "Owner");

  const verdict = readiness(project);
  assert.equal(verdict.level, "READY", verdict.execution.findings.join("\n"));
  assert.equal(invoke("execution-readiness", "--project-root", project).status, 0);
  assert.equal(verdict.sufficiency.conclusion, "SUFFICIENT");
  assert.equal(verdict.sufficiency.author, "Reviewer");
});

test("a review with limits is conditionally ready, and says which limits", () => {
  const project = pilotShaped("limits", { acceptance: "A hold expires in 15 minutes and a second checkout is refused", verification: "Integration test", evidence: "Test output", risk: "none" });
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {
    conclusion: "SUFFICIENT_WITH_LIMITS",
    limits: ["Refund handling is out of scope for this release"],
    verifications_required: ["The hold must be proven against the sandbox before payments are enabled"],
  }), "--owner", "Owner");

  const verdict = readiness(project);
  assert.equal(verdict.level, "CONDITIONALLY_READY", verdict.execution.findings.join("\n"));
  assert.equal(invoke("execution-readiness", "--project-root", project).status, 1);
  assert.deepEqual(verdict.execution.causes.limits, ["Refund handling is out of scope for this release"]);
  assert.equal(verdict.execution.causes.verifications.length, 1);
  // Conditional is not a failure: nothing blocks.
  assert.equal(verdict.execution.causes.structural.length, 0);
  assert.equal(verdict.execution.causes.semantic.length, 0);
});

test("an unreconciled contradiction blocks, and a reconciled one does not", () => {
  const project = pilotShaped("contradiction", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  const open = reviewFile(project, {
    contradictions: [{
      description: "DEC-0002 approves a managed database and its ORM; the repository installs neither",
      sources: ["DEC-0002", "package manifest"],
      reconciled: false,
    }],
  });
  run("sufficiency-review", "--project-root", project, "--file", open, "--owner", "Owner");
  const blocked = readiness(project);
  assert.equal(blocked.level, "NOT_READY");
  assert.match(blocked.execution.causes.semantic.join(" "), /unreconciled contradiction/);
  assert.match(blocked.execution.causes.semantic.join(" "), /nobody has said which prevails/);

  const settled = reviewFile(project, {
    contradictions: [{
      description: "DEC-0002 approves a managed database and its ORM; the repository installs neither",
      sources: ["DEC-0002", "package manifest"],
      reconciled: true,
      resolution: "The repository prevails; DEC-0002 was superseded and the decision re-recorded",
    }],
  });
  run("sufficiency-review", "--project-root", project, "--file", settled, "--owner", "Owner");
  assert.equal(readiness(project).level, "READY");
});

test("a contradiction cannot be reconciled without saying what was decided", () => {
  const project = pilotShaped("resolution", { risk: "none" });
  const file = reviewFile(project, {
    contradictions: [{ description: "The plan and the repository disagree", sources: ["DEC-0002"], reconciled: true }],
  });
  const result = invoke("sufficiency-review", "--project-root", project, "--file", file, "--owner", "Owner", "--operation-id", "OP-X");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reconciled with no resolution/);
  assert.match(result.stderr, /Nothing was written/);
});

test("a missing operational decision blocks, and is named", () => {
  const project = pilotShaped("missing-decision", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {
    missing_decisions: [{ topic: "What happens to a payment that succeeds while the channel is unreachable", why_required: "Money is taken and no stay is held" }],
  }), "--owner", "Owner");

  const verdict = readiness(project);
  assert.equal(verdict.level, "NOT_READY");
  assert.match(verdict.execution.causes.semantic.join(" "), /an operational decision is missing: What happens to a payment/);
});

test("a review expires when the plan it judged changes, and says so", () => {
  const project = pilotShaped("stale", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {}), "--owner", "Owner");
  assert.equal(readiness(project).level, "READY");

  // Something the reviewer's conclusion rested on.
  run("decision", "--project-root", project, "--id", "DEC-0003", "--title", "Payments are captured on arrival, not at booking", "--status", "APPROVED", "--owner", "Owner");

  const verdict = readiness(project);
  assert.equal(verdict.level, "NOT_READY", "a review survived a change to the plan it judged");
  assert.equal(verdict.sufficiency.recorded, true);
  assert.equal(verdict.sufficiency.current, false);
  assert.match(verdict.execution.causes.semantic.join(" "), /out of date/);
});

test("a review does not expire because something unrelated was written", () => {
  const project = pilotShaped("not-stale", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {}), "--owner", "Owner");
  // A checkpoint bumps the revision and changes nothing a reviewer judged.
  run("checkpoint", "--project-root", project, "--id", "CHK-0002", "--name", "Sprint boundary", "--owner", "Owner");
  const verdict = readiness(project);
  assert.equal(verdict.sufficiency.current, true, "an unrelated write expired the review");
  assert.equal(verdict.level, "READY");
});

// ---------------------------------------------------------------------------
// 3. The structural findings, one at a time
// ---------------------------------------------------------------------------

test("a task with no acceptance criterion blocks, and says nothing tells you when it is done", () => {
  const project = pilotShaped("no-acceptance", { acceptance: null, risk: "none" });
  const findings = readiness(project).execution.causes.structural.join(" | ");
  assert.match(findings, /TSK-0001 has no acceptance criterion/);
  assert.match(findings, /nothing says when it is done/);
});

test("a task with no verification and no expected evidence blocks", () => {
  const project = pilotShaped("no-evidence", { verification: null, evidence: null, risk: "none" });
  const findings = readiness(project).execution.causes.structural.join(" | ");
  assert.match(findings, /neither a verification nor the evidence it should produce/);
});

test("a missing execution organisation blocks", () => {
  const project = pilotShaped("no-org", { organisation: false, risk: "none" });
  const findings = readiness(project).execution.causes.structural.join(" | ");
  assert.match(findings, /organisation of whoever executes this has not been approved/);
});

test("a proposed decision that work depends on blocks", () => {
  const project = pilotShaped("proposed", { risk: "none" });
  run("decision", "--project-root", project, "--id", "DEC-0004", "--title", "Which provider takes the payment", "--status", "PROPOSED", "--owner", "Owner");
  run("task", "--project-root", project, "--id", "TSK-0003", "--title", "Take the payment",
      "--status", "READY", "--owner", "Owner", "--kind", "IMPLEMENTATION",
      "--requirements", "REQ-0001", "--decisions", "DEC-0004", "--role", "implementer",
      "--acceptance", "A card is charged once and the receipt is stored", "--verification", "Sandbox run", "--evidence-expected", "Receipt");
  const findings = readiness(project).execution.causes.structural.join(" | ");
  assert.match(findings, /DEC-0004 is still PROPOSED and work depends on it/);
});

// ---------------------------------------------------------------------------
// 4. What the folder is worth to somebody who was not here
// ---------------------------------------------------------------------------

test("handoff-check reports the sufficiency gate rather than pretending the folder is complete", () => {
  const project = pilotShaped("handoff", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  const before = handoff(project);
  assert.equal(before.deliverable, false, "a folder nobody has judged was called deliverable");

  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {
    conclusion: "SUFFICIENT_WITH_LIMITS",
    limits: ["Refunds are out of scope for this release"],
  }), "--owner", "Owner");
  const after = handoff(project);
  assert.ok(JSON.stringify(after).includes("Refunds are out of scope"),
    "the accepted limits are not in the handoff package, so the receiver cannot know them");
});

// ---------------------------------------------------------------------------
// 5. Projects that predate all of this
// ---------------------------------------------------------------------------

test("a project recorded before the gate keeps its integrity and is told what is missing", () => {
  const project = pilotShaped("legacy", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });

  // Exactly what a pre-gate project looks like: everything else, no review.
  const statePath = path.join(project, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.sufficiency_review, undefined);

  // Integrity is untouched: nothing about the new contract makes an old
  // project invalid, and replay still reproduces it.
  assert.equal(invoke("validate", "--project-root", project, "--strict").status, 0);
  assert.equal(invoke("replay", "--project-root", project, "--verify").status, 0);

  // Readiness explains the new contract instead of inventing a verdict.
  const verdict = readiness(project);
  assert.equal(verdict.level, "NOT_READY");
  assert.equal(verdict.sufficiency.recorded, false);
  assert.equal(verdict.sufficiency.conclusion, null);
  assert.match(verdict.execution.causes.semantic.join(" "), /Record one with plangonaut sufficiency-review/);
  // And no earlier verdict is reinterpreted as if it had been one.
  assert.equal(verdict.execution.causes.semantic.length, 1);
});

test("the review survives a replay, because it is an event like everything else", () => {
  const project = pilotShaped("replay", { acceptance: "A hold expires in 15 minutes", verification: "Test", evidence: "Output", risk: "none" });
  run("sufficiency-review", "--project-root", project, "--file", reviewFile(project, {}), "--owner", "Owner");
  const verify = invoke("replay", "--project-root", project, "--verify");
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  assert.equal(readiness(project).sufficiency.conclusion, "SUFFICIENT");
});

// ---------------------------------------------------------------------------
// 6. The review has to be a review
// ---------------------------------------------------------------------------

test("a review that does not say what it looked at is refused", () => {
  const project = pilotShaped("empty-review", { risk: "none" });
  const file = reviewFile(project, { checked: [] });
  const result = invoke("sufficiency-review", "--project-root", project, "--file", file, "--owner", "Owner", "--operation-id", "OP-E");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checked is empty/);
  assert.match(result.stderr, /Nothing was written/);
});

test("limits and the conclusion have to agree", () => {
  const project = pilotShaped("conclusion", { risk: "none" });
  const hedged = reviewFile(project, { conclusion: "SUFFICIENT", limits: ["Refunds are out of scope"] });
  const first = invoke("sufficiency-review", "--project-root", project, "--file", hedged, "--owner", "Owner", "--operation-id", "OP-C1");
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /SUFFICIENT_WITH_LIMITS, which readiness reports as conditionally ready/);

  const empty = reviewFile(project, { conclusion: "SUFFICIENT_WITH_LIMITS", limits: [] });
  const second = invoke("sufficiency-review", "--project-root", project, "--file", empty, "--owner", "Owner", "--operation-id", "OP-C2");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /limits are the point of that conclusion/);
});

test("the template is a form somebody can fill in, not a shape to guess", () => {
  const template = JSON.parse(invoke("sufficiency-review", "--template").stdout);
  for (const field of ["checked", "sources", "contradictions", "missing_decisions", "error_cases_examined", "limits", "verifications_required", "conclusion", "author"]) {
    assert.ok(field in template, `the template omits ${field}`);
  }
  assert.ok(Array.isArray(template.$comment) && template.$comment.length > 5, "the template does not explain its own fields");
});
