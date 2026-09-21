import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The pilot, reproduced, and the eleven shapes around it.
 *
 * WHAT THE PILOT WAS
 * ------------------
 * A real project folder with eighty-two decisions, thirty-three requirements,
 * sixteen modules of interview — and three tasks, every one of them
 * administrative. No implementation work. No organisation of whoever would
 * build it. No responsibilities, no acceptance criteria, no traceability from a
 * requirement to anything that would satisfy it. The interview had reached the
 * final review without once asking how the thing was to be made.
 *
 * Every command reported that project as healthy, and every command was right
 * about the question it was asking. The defect was that nobody was asking the
 * other one.
 *
 * WHY THE FIXTURE IS SANITISED AND BUILT HERE
 * -------------------------------------------
 * It is built by the engine's own commands, in a temporary directory, from
 * nothing. No content from the real pilot appears in it — the shape is what
 * reproduces the defect, not the words. And a fixture the test builds is
 * present everywhere the test runs, which a checked-in one under a gitignored
 * directory is not.
 *
 * WHAT THE SCALE IS
 * -----------------
 * Ten requirements rather than thirty-three, and three administrative tasks
 * rather than three. The ratio is what matters and the absolute count is not:
 * the check this file exercises is deliberately not a threshold, because three
 * tasks can be a complete plan for a small project and a hundred can be a
 * hundred restatements of the same intention.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "lib", "bin", "plangonaut.js");

function invoke(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function run(...args) {
  const needsOperation = [
    "record", "decision", "requirement", "task", "dependency", "risk", "evidence", "agent",
    "checkpoint", "gate", "execution-intent", "execution-org", "read-record", "doc-save", "doc-finalize",
    "sufficiency-review",
  ].includes(args[0]);
  if (needsOperation && !args.includes("--operation-id")) args = [...args, "--operation-id", `OP-${crypto.randomUUID()}`];
  const result = invoke(...args);
  assert.equal(result.status, 0, `${args[0]} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result.stdout;
}

/** Runs a command that is expected to fail, and hands back what it said. */
function refuse(...args) {
  const needsOperation = ["record", "task", "execution-org", "execution-intent", "read-record"].includes(args[0]);
  if (needsOperation && !args.includes("--operation-id")) args = [...args, "--operation-id", `OP-${crypto.randomUUID()}`];
  const result = invoke(...args);
  assert.notEqual(result.status, 0, `expected a refusal from ${args[0]}, got success:\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
}

let counter = 0;
function fixture(name) {
  const directory = path.join(os.tmpdir(), `plangonaut-readiness-${name}-${process.pid}-${counter++}`);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function initialise(project, name = "Fixture") {
  const owners = path.join(project, "owners.json");
  fs.writeFileSync(owners, JSON.stringify({ product: "User", technical: "User", budget: "User", safety: "User", release: "User" }));
  run("init", "--project-root", project, "--project-name", name, "--project-mode", "Resume",
      "--interaction-mode", "Standard", "--owners-file", owners, "--operation-id", `OP-init-${crypto.randomUUID()}`);
  return project;
}

function answerFile(project, text) {
  const file = path.join(project, `answer-${crypto.randomUUID()}.md`);
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

/** The shape that defeated every command: much definition, no plan. */
function pilotShaped(project, { tasks = true } = {}) {
  for (let index = 1; index <= 10; index += 1) {
    run("requirement", "--project-root", project, "--id", `REQ-${String(index).padStart(4, "0")}`,
        "--title", `The result has to satisfy condition ${index}`, "--status", "ACTIVE", "--owner", "User");
  }
  for (let index = 1; index <= 12; index += 1) {
    run("decision", "--project-root", project, "--id", `DEC-${String(index).padStart(4, "0")}`,
        "--title", `Chosen approach ${index}`, "--status", "PROPOSED", "--owner", "User");
  }
  if (tasks) {
    // Administrative, every one of them, and each one honest work.
    run("task", "--project-root", project, "--id", "TSK-0001", "--title", "Create the repository", "--status", "DONE", "--owner", "User", "--kind", "ADMINISTRATIVE");
    run("task", "--project-root", project, "--id", "TSK-0002", "--title", "Agree the meeting schedule", "--status", "DONE", "--owner", "User", "--kind", "ADMINISTRATIVE");
    run("task", "--project-root", project, "--id", "TSK-0003", "--title", "Set up the shared folder", "--status", "DONE", "--owner", "User", "--kind", "ADMINISTRATIVE");
  }
  return project;
}

function readiness(project) {
  const result = invoke("execution-readiness", "--project-root", project, "--json");
  return JSON.parse(result.stdout);
}

/**
 * Record a sufficiency review, so a test can say what the *rest* of readiness
 * does once the semantic gate is satisfied.
 *
 * Deliberately minimal and deliberately real: it writes the same JSON a person
 * would write and passes it to the same command, so a test cannot pass by
 * agreeing with an internal shape nobody uses.
 */
function reviewed(project, { author = "User", conclusion = "SUFFICIENT", limits = [], contradictions = [], missing = [], verifications = [] } = {}) {
  const file = path.join(project, `review-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    checked: ["Requirements against tasks", "Acceptance criteria", "Error paths"],
    sources: ["the ledger"],
    contradictions,
    missing_decisions: missing,
    error_cases_examined: ["the one the domain has"],
    limits,
    verifications_required: verifications,
    conclusion,
    author,
  }, null, 2));
  run("sufficiency-review", "--project-root", project, "--file", file, "--owner", "User");
  return file;
}

function handoff(project) {
  const result = invoke("handoff-check", "--project-root", project, "--json");
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// 0. The pilot itself
// ---------------------------------------------------------------------------

test("the pilot shape: much definition, no plan, and every command says so", () => {
  const project = pilotShaped(initialise(fixture("pilot"), "Pilot"));
  run("execution-intent", "--project-root", project, "--execution", "--reason", "The product is to be built.", "--owner", "User");

  const verdict = readiness(project);
  assert.equal(verdict.intent, "YES");
  assert.equal(verdict.execution.verdict, "FAILED");

  const findings = verdict.execution.findings.join(" | ");
  assert.match(findings, /administrative/i, `nothing said the plan was entirely administrative:\n${findings}`);
  assert.match(findings, /approved requirement/i, `nothing said requirements were uncovered:\n${findings}`);
  assert.match(findings, /organisation/i, `nothing said the organisation was unapproved:\n${findings}`);

  const handed = handoff(project);
  assert.equal(handed.deliverable, false);
  assert.equal(handed.execution_readiness, "FAILED");
  assert.equal(handed.handoff_readiness, "FAILED");

  // And the three states are distinguishable rather than one verdict.
  const shown = invoke("handoff-check", "--project-root", project).stdout;
  assert.match(shown, /definition: /);
  assert.match(shown, /execution readiness: failed/);
  assert.match(shown, /handoff readiness: failed/);
});

test("next sends the pilot to the operational interview, not to code or to the final review", () => {
  const project = pilotShaped(initialise(fixture("pilot-next"), "Pilot"));
  run("execution-intent", "--project-root", project, "--execution", "--reason", "The product is to be built.", "--owner", "User");

  const output = invoke("next", "--project-root", project).stdout;
  assert.match(output, /BEFORE THE FINAL REVIEW/, `next did not raise the operational gap:\n${output}`);
  assert.match(output, /Modules 14 and 15/, `next did not name where the answers belong:\n${output}`);
  assert.match(output, /proposed, not invented by the user/, `next did not say the organisation is proposed:\n${output}`);
  assert.doesNotMatch(output, /write the code|start implementing/i);
});

// ---------------------------------------------------------------------------
// 1. Deliberately definition-only
// ---------------------------------------------------------------------------

test("a definition-only project is complete, and says it is not an execution package", () => {
  const project = pilotShaped(initialise(fixture("definition-only"), "Feasibility"), { tasks: false });
  const output = run("execution-intent", "--project-root", project, "--definition-only",
                     "--reason", "The deliverable is the feasibility study itself.", "--owner", "User");

  assert.match(output, /Definition complete\./);
  assert.match(output, /Execution readiness not requested\./);
  assert.match(output, /This folder is not an execution package\./);

  const verdict = readiness(project);
  assert.equal(verdict.intent, "NO");
  assert.equal(verdict.execution.verdict, "NOT REQUESTED");
  assert.deepEqual(verdict.execution.findings, []);

  // And handoff does not demand a plan it was told not to expect.
  const handed = handoff(project);
  assert.equal(handed.execution_readiness, "NOT REQUESTED");
  assert.ok(
    handed.blocking.every((line) => !/administrative|organisation of whoever/i.test(line)),
    `handoff still demanded an execution plan:\n${handed.blocking.join("\n")}`
  );
});

test("definition-only is never inferred from the absence of tasks", () => {
  const project = pilotShaped(initialise(fixture("undeclared"), "Undeclared"), { tasks: false });
  const verdict = readiness(project);

  // The one thing the engine must not do: conclude that a project with no tasks
  // was never meant to have any, and declare it finished.
  assert.equal(verdict.intent, "UNDECLARED");
  assert.equal(verdict.execution.verdict, "NOT ASSESSED");
  assert.notEqual(verdict.execution.verdict, "NOT REQUESTED");
  assert.match(verdict.execution.findings.join(" "), /nobody has declared/i);
});

// ---------------------------------------------------------------------------
// 2, 3. One executor, and several
// ---------------------------------------------------------------------------

test("a single executor still needs a reviewer, a handoff and a concurrency rule", () => {
  const project = initialise(fixture("solo"), "Solo");
  const refusal = refuse("execution-org", "--project-root", project, "--executors", "1",
                         "--mode", "human", "--concurrency", "one person, one file at a time",
                         "--handoff", "at each milestone", "--owner", "User");
  assert.match(refusal, /--reviewer is missing/);

  run("execution-org", "--project-root", project, "--executors", "1", "--mode", "human",
      "--reviewer", "User", "--concurrency", "one person, one file at a time",
      "--handoff", "at each milestone", "--owner", "User");

  const output = invoke("status", "--project-root", project).stdout;
  assert.ok(JSON.parse(output).readiness, "status does not carry the readiness block");
});

test("more than one executor and no integrator is refused", () => {
  const project = initialise(fixture("multi"), "Multi");
  const refusal = refuse("execution-org", "--project-root", project, "--executors", "3",
                         "--mode", "agents", "--reviewer", "User",
                         "--concurrency", "one component per agent",
                         "--handoff", "on green tests", "--owner", "User");
  assert.match(refusal, /no --integrator/);
  assert.match(refusal, /correct halves is not one working thing/);

  run("execution-org", "--project-root", project, "--executors", "3", "--mode", "agents",
      "--integrator", "AGT-LEAD", "--reviewer", "User",
      "--concurrency", "one component per agent", "--handoff", "on green tests", "--owner", "User");
});

// ---------------------------------------------------------------------------
// 4. Not software
// ---------------------------------------------------------------------------

test("a non-software project passes without agents, repositories or tests", () => {
  const project = initialise(fixture("building"), "Refurbishment");
  run("execution-intent", "--project-root", project, "--execution", "--reason", "The building is to be refurbished.", "--owner", "User");
  run("requirement", "--project-root", project, "--id", "REQ-0001", "--title", "The roof does not leak", "--status", "ACTIVE", "--owner", "User");
  run("decision", "--project-root", project, "--id", "DEC-0001", "--title", "Slate, not tile", "--status", "APPROVED", "--owner", "User");
  run("task", "--project-root", project, "--id", "TSK-0001", "--title", "Strip and re-lay the north slope",
      "--status", "READY", "--owner", "User", "--kind", "CONSTRUCTION",
      "--requirements", "REQ-0001", "--decisions", "DEC-0001",
      "--role", "roofer", "--acceptance", "No ingress after a two-hour hose test",
      "--verification", "Hose test witnessed by the surveyor", "--evidence-expected", "Signed surveyor note");
  run("risk", "--project-root", project, "--id", "RSK-0001", "--title", "Weather delays the strip", "--status", "IDENTIFIED", "--severity", "MEDIUM", "--owner", "User");
  run("execution-org", "--project-root", project, "--executors", "1", "--mode", "human",
      "--reviewer", "Surveyor", "--concurrency", "one trade on the roof at a time",
      "--handoff", "at the witnessed hose test", "--owner", "User");
  run("checkpoint", "--project-root", project, "--id", "CHK-0001", "--name", "North slope complete", "--owner", "User");

  /*
   * Structurally complete, and not yet ready — because nobody has judged it.
   *
   * This used to assert PASSED, and it was right to: every structural part of
   * a roofing plan is here. What changed is that structural completeness
   * stopped being the whole answer. A plan nobody has read for sufficiency is
   * NOT_READY, and the finding says so in those words rather than inventing a
   * structural complaint.
   */
  const before = readiness(project);
  assert.equal(before.execution.level, "NOT_READY", before.execution.findings.join("\n"));
  assert.deepEqual(before.execution.causes.structural, [],
    `a roofing project has a structural defect it should not have:\n${before.execution.causes.structural.join("\n")}`);
  assert.equal(before.execution.causes.semantic.length, 1);
  assert.match(before.execution.causes.semantic[0], /no sufficiency review is recorded/);

  // And ready once somebody has. The engine does not grade the review; it
  // records that one was made, by whom, and against which version of the plan.
  reviewed(project, { author: "Surveyor", conclusion: "SUFFICIENT" });
  const after = readiness(project);
  assert.equal(after.execution.level, "READY", after.execution.findings.join("\n"));
  assert.equal(after.execution.verdict, "PASSED");
});

// ---------------------------------------------------------------------------
// 5, 6. Coverage, and the number that does not prove it
// ---------------------------------------------------------------------------

test("requirements covered by verifiable tasks pass", () => {
  const project = initialise(fixture("covered"), "Covered");
  run("execution-intent", "--project-root", project, "--execution", "--reason", "To be built.", "--owner", "User");
  run("requirement", "--project-root", project, "--id", "REQ-0001", "--title", "Imports a CSV", "--status", "ACTIVE", "--owner", "User");
  run("requirement", "--project-root", project, "--id", "REQ-0002", "--title", "Rejects a malformed row", "--status", "ACTIVE", "--owner", "User");
  run("decision", "--project-root", project, "--id", "DEC-0001", "--title", "Streaming parser", "--status", "APPROVED", "--owner", "User");
  run("task", "--project-root", project, "--id", "TSK-0001", "--title", "Streaming CSV reader",
      "--status", "READY", "--owner", "User", "--kind", "IMPLEMENTATION",
      "--requirements", "REQ-0001,REQ-0002", "--decisions", "DEC-0001", "--role", "implementer",
      "--acceptance", "A 2 GB file imports under 60 s and a malformed row is rejected with its line number",
      "--verification", "Fixture suite", "--evidence-expected", "Test report");
  run("risk", "--project-root", project, "--id", "RSK-0001", "--title", "Encoding surprises", "--status", "IDENTIFIED", "--severity", "LOW", "--owner", "User");
  run("execution-org", "--project-root", project, "--executors", "1", "--mode", "agent",
      "--reviewer", "User", "--concurrency", "single writer", "--handoff", "on a green suite", "--owner", "User");

  const before = readiness(project);
  assert.equal(before.execution.level, "NOT_READY", "the semantic gate should be the only thing left");
  assert.deepEqual(before.execution.causes.structural, [], before.execution.causes.structural.join("\n"));

  // A LOW risk with an owner and no mitigation is not a blocker. Severity is
  // the project's own statement of how much something matters, and a check
  // that ignores it teaches people to record everything as LOW.
  assert.ok(!before.execution.findings.join(" ").includes("RSK-0001"), "a LOW risk blocked readiness");

  reviewed(project, { author: "User", conclusion: "SUFFICIENT" });
  const after = readiness(project);
  assert.equal(after.execution.verdict, "PASSED", after.execution.findings.join("\n"));
  assert.equal(after.execution.level, "READY");
});

test("many generic tasks do not make coverage: the check is not a count", () => {
  const project = initialise(fixture("generic"), "Generic");
  run("execution-intent", "--project-root", project, "--execution", "--reason", "To be built.", "--owner", "User");
  for (let index = 1; index <= 5; index += 1) {
    run("requirement", "--project-root", project, "--id", `REQ-${String(index).padStart(4, "0")}`,
        "--title", `Condition ${index}`, "--status", "ACTIVE", "--owner", "User");
  }
  // Twenty tasks, all implementation-kinded, none of them sayable.
  for (let index = 1; index <= 20; index += 1) {
    run("task", "--project-root", project, "--id", `TSK-${String(index).padStart(4, "0")}`,
        "--title", `Build part ${index}`, "--status", "BACKLOG", "--owner", "User", "--kind", "IMPLEMENTATION");
  }
  run("execution-org", "--project-root", project, "--executors", "1", "--mode", "agent",
      "--reviewer", "User", "--concurrency", "single writer", "--handoff", "per part", "--owner", "User");

  const verdict = readiness(project);
  assert.equal(verdict.execution.verdict, "FAILED", "twenty empty tasks passed as a plan");
  const findings = verdict.execution.findings.join(" | ");
  assert.match(findings, /cannot be picked up as written/);
  assert.match(findings, /approved requirement/);
});

// ---------------------------------------------------------------------------
// 7, 8. Modules 14 and 16
// ---------------------------------------------------------------------------

test("module 14 cannot go NOT APPLICABLE while nobody is responsible", () => {
  const project = initialise(fixture("module14"), "Module14");
  const file = answerFile(project, "One person does everything here.");
  const refusal = refuse("record", "--project-root", project, "--module", "14",
                         "--status", "NOT_APPLICABLE", "--answer-file", file, "--owner", "User",
                         "--summary", "No team needed");
  assert.match(refusal, /module 14 can be NOT APPLICABLE/);
  assert.match(refusal, /single executor's responsibility still has to exist/);

  run("execution-org", "--project-root", project, "--executors", "1", "--mode", "human",
      "--reviewer", "User", "--concurrency", "one person", "--handoff", "at the end", "--owner", "User");
  run("record", "--project-root", project, "--module", "14", "--status", "NOT_APPLICABLE",
      "--answer-file", answerFile(project, "One person does everything here."), "--owner", "User",
      "--summary", "No team needed");
});

test("module 16 cannot be confirmed before execution readiness passes", () => {
  const project = pilotShaped(initialise(fixture("module16"), "Module16"));
  run("execution-intent", "--project-root", project, "--execution", "--reason", "To be built.", "--owner", "User");
  const refusal = refuse("record", "--project-root", project, "--module", "16",
                         "--status", "CONFIRMED", "--answer-file", answerFile(project, "Looks right to me."),
                         "--owner", "User", "--summary", "Final review");
  assert.match(refusal, /Module 16 cannot be recorded CONFIRMED/);
  assert.match(refusal, /execution readiness fails/);
  assert.match(refusal, /still PROPOSED/, "a blueprint resting on untaken decisions was not named");
});

// ---------------------------------------------------------------------------
// 9, 10. What was read
// ---------------------------------------------------------------------------

test("a recorded read is proved by its digest", () => {
  const project = initialise(fixture("read-proved"), "Reads");
  const source = path.join(project, "source.md");
  fs.writeFileSync(source, "# Source\n\nThe thing this plan rests on.\n");
  run("read-record", "--project-root", project, "--path", "source.md",
      "--purpose", "the basis of the architecture", "--agent", "agent-a",
      "--conclusions", "It constrains the storage choice.", "--owner", "User");

  const status = JSON.parse(invoke("status", "--project-root", project).stdout);
  assert.equal(status.readiness.reads.recorded, 1);
  assert.equal(status.readiness.reads.proved, 1);
  assert.equal(status.readiness.reads.changed_since, 0);

  const resumed = invoke("resume", "--project-root", project).stdout;
  assert.match(resumed, /source\.md — read and proved/);
  // And the thing the pilot did: a later denial does not unmake the evidence.
  assert.doesNotMatch(resumed, /No read is recorded/);
});

test("a file changed after it was read is neither proved nor forgotten", () => {
  const project = initialise(fixture("read-changed"), "Reads");
  const source = path.join(project, "source.md");
  fs.writeFileSync(source, "# Source\n\nOriginal.\n");
  run("read-record", "--project-root", project, "--path", "source.md",
      "--purpose", "the basis of the architecture", "--agent", "agent-a", "--owner", "User");
  fs.writeFileSync(source, "# Source\n\nRewritten after the plan was made.\n");

  const status = JSON.parse(invoke("status", "--project-root", project).stdout);
  assert.equal(status.readiness.reads.changed_since, 1);
  assert.equal(status.readiness.reads.proved, 0);

  const resumed = invoke("resume", "--project-root", project).stdout;
  assert.match(resumed, /changed since it was read/);

  const handed = handoff(project);
  assert.ok(
    handed.blocking.some((line) => /has changed since/.test(line)),
    `handoff did not block on an expired reading:\n${handed.blocking.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 11. Two documents, one record
// ---------------------------------------------------------------------------

test("a governed document and an ungoverned copy of it are reported, and the ledger decides", () => {
  const project = initialise(fixture("duplicate"), "Duplicate");
  const content = "# Architecture\n\nThe registry is append-only.\n";
  const governed = path.join(project, "architecture.md");
  fs.writeFileSync(governed, content);
  const diff = run("doc-diff", "--project-root", project, "--id", "ART-ARCH",
                   "--base-path", "architecture.md", "--content-file", governed, "--owner", "User");
  const token = /confirmation_token"?\s*[:=]\s*"?([A-Za-z0-9._-]+)/.exec(diff)?.[1];
  assert.ok(token, `no confirmation token in doc-diff output:\n${diff}`);
  run("doc-save", "--project-root", project, "--id", "ART-ARCH", "--base-path", "architecture.md",
      "--content-file", governed, "--owner", "User", "--confirm-token", token);

  // The copy somebody left beside it, taken from the governed file as it now
  // stands rather than from the string we started with: `doc-save` owns that
  // file's content, and a fixture that assumes otherwise tests nothing.
  fs.writeFileSync(path.join(project, "architecture-copy.md"), fs.readFileSync(governed));

  const handed = handoff(project);
  const duplicate = handed.blocking.find((line) => /byte-for-byte cop/.test(line));
  assert.ok(duplicate, `the duplicate was not reported:\n${handed.blocking.join("\n")}`);
  assert.match(duplicate, /ART-ARCH/, "the governed record was not identified");
  assert.match(duplicate, /does not delete a governed document/);
});

test("build output is not a duplicate", () => {
  const project = initialise(fixture("derived"), "Derived");
  const content = "# Readme\n\nSame bytes on purpose.\n";
  fs.writeFileSync(path.join(project, "readme.md"), content);
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.writeFileSync(path.join(project, "dist", "readme.md"), content);

  const handed = handoff(project);
  assert.ok(
    !handed.blocking.some((line) => /byte-for-byte cop/.test(line)),
    `a build copy was reported as a duplicate:\n${handed.blocking.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

test("an alpha.5 project is not promoted, not migrated, and not guessed at", () => {
  const project = pilotShaped(initialise(fixture("legacy"), "Legacy"));
  const before = fs.readFileSync(path.join(project, ".plangonaut", "state.json"), "utf8");

  // Four readers, none of which may write.
  invoke("status", "--project-root", project);
  invoke("resume", "--project-root", project);
  invoke("validate", "--project-root", project);
  invoke("handoff-check", "--project-root", project);

  const after = fs.readFileSync(path.join(project, ".plangonaut", "state.json"), "utf8");
  assert.equal(after, before, "a read-only command modified the project");

  const status = JSON.parse(invoke("status", "--project-root", project).stdout);
  assert.equal(status.readiness.execution_intent, "NOT DECLARED");
  assert.equal(status.readiness.execution, "NOT ASSESSED");
});
