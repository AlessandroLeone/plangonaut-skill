/**
 * The second round of pilot corrections: facts are not decisions.
 *
 * Every test here fails against `0.3.0-alpha.5`. That release closed the ten
 * defects the pilot reported; these are the ones the pilot's *shape* implies and
 * that nobody had written down — the folder that reads as settled while nothing
 * has been settled, and the several small doors through which an agent's own
 * reading becomes somebody else's commitment.
 *
 * All fixtures are synthetic. Nothing here names a real project.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../lib/cli.js";

const OWNERS = JSON.stringify({ product: "Ada", technical: "Ada", budget: "Ada", safety: "Ada", release: "Ada" });

async function run(...argv) {
  const out = [];
  const err = [];
  const stdout = console.log;
  const stderr = console.error;
  console.log = (...parts) => out.push(parts.join(" "));
  console.error = (...parts) => err.push(parts.join(" "));
  let thrown = null;
  let code = 0;
  try {
    code = await main(argv);
  } catch (caught) {
    thrown = caught;
  } finally {
    console.log = stdout;
    console.error = stderr;
  }
  const printed = [...out, ...err].join("\n");
  const failed = thrown !== null || code !== 0;
  return {
    out: out.join("\n"),
    error: failed ? (thrown ?? new Error(printed)) : null,
    message: thrown?.message ?? (failed ? printed : ""),
  };
}

/** How many numbered questions one `next` laid out. */
const blockSize = (text) => text.split("\n").filter((line) => /^\s*\d+\.\s/.test(line)).length;

let sequence = 0;
const op = (label) => `op-${label}-${(sequence += 1)}`;

async function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plangonaut-post5-"));
  fs.writeFileSync(path.join(root, "owners.json"), OWNERS);
  for (const [relative, content] of Object.entries(files)) {
    const location = path.join(root, relative);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, content);
  }
  const result = await run("init", "--project-root", root, "--project-name", "X", "--project-mode", "Genesis",
    "--interaction-mode", "Standard", "--owners-file", path.join(root, "owners.json"), "--operation-id", op("init"));
  assert.equal(result.error, null, result.message);
  return root;
}

/**
 * Ask, answer, record what the answer produced, and settle naming it.
 *
 * The order matters and is the engine's, not mine: `qa-settle --consequences`
 * refuses a record last changed *before* the question was asked, because the
 * history says "created or changed by this answer" and has to mean it. So the
 * decision is written between the answer and the settlement. Writing this test
 * the other way round is how I found that guarantee.
 */
async function settled(root, id, { module = 1, decision = null } = {}) {
  const answer = path.join(root, `${id}.txt`);
  fs.writeFileSync(answer, `the user's own words for ${id}\n`);
  await run("qa-ask", "--project-root", root, "--id", id, "--question", `question ${id}`,
    "--rationale", "because", "--owner", "Ada", "--module", String(module), "--operation-id", op("ask"));
  await run("qa-answer", "--project-root", root, "--id", id, "--answer-file", answer,
    "--owner", "Ada", "--operation-id", op("answer"));
  if (decision) {
    const created = await run("decision", "--project-root", root, "--id", decision, "--title", "T",
      "--status", "PROPOSED", "--owner", "Ada", "--operation-id", op("decision"));
    assert.equal(created.error, null, created.message);
  }
  const argv = ["qa-settle", "--project-root", root, "--id", id, "--interpretation", "understood",
    "--reply-file", answer, "--owner", "Ada", "--operation-id", op("settle")];
  if (decision) argv.push("--consequences", decision);
  const result = await run(...argv);
  assert.equal(result.error, null, result.message);
}

/** The revision a decision is at, for optimistic concurrency. */
function decisionRevision(root, id) {
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  return String(state.decisions.find((item) => item.id === id).revision);
}

// ---------------------------------------------------------------------------
// A decision needs somebody who decided it
// ---------------------------------------------------------------------------

test("an APPROVED decision recording nobody is named at the write and refused at the handover", async () => {
  // alpha.5: accepted. An agent reads the code, infers what it implies, and
  // records the inference as a choice — with no question, no answer, no author.
  const root = await project();
  const result = await run("decision", "--project-root", root, "--id", "DEC-0001",
    "--title", "Ship the reader first", "--status", "APPROVED", "--owner", "Ada",
    "--operation-id", op("decision"));

  // The write says what it cannot see. It does not refuse: measuring showed a
  // refusal here breaks 87 call sites that use APPROVED as a fixture status,
  // and compatibility with what exists was a requirement. The rule is enforced
  // where it decides something — validate --strict, and handoff-check.
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /nothing records who approved it/);
  assert.match(result.out, /the interview/);
  assert.match(result.out, /provenance-override/);
  assert.match(result.out, /provenance-note/);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.decisions[0].provenance, undefined, "no provenance is invented");

  const plain = await run("validate", "--project-root", root);
  assert.equal(plain.error, null, "the state is mechanically valid; this is about what it says");
  assert.match(plain.out, /DEC-0001 is APPROVED and records no provenance/);

  const strict = await run("validate", "--project-root", root, "--strict");
  assert.notEqual(strict.error, null, "the warning promises --strict fails on this, so it must");
  assert.match(strict.message, /DEC-0001 is APPROVED and records no provenance/);

  const handoff = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(
    handoff.blocking.some((line) => line.includes("DEC-0001 is APPROVED and records no provenance")),
    "a folder is not handed over resting on an approval nobody can trace",
  );
});

test("a recorded statement is the third road, for decisions taken before Plangonaut", async () => {
  // Adoption and Reconstruction are real: a project arrives with decisions
  // already made. A rule satisfiable only by a Plangonaut interview would make
  // those modes unusable, so a person's own statement, in the folder and hashed,
  // counts. Its honest limit is the override's: the engine cannot tell who typed
  // a file, only that the record points at something a reader can go and read.
  const root = await project({ "docs/why.md": "We chose this in the design review on the 4th.\n" });
  const result = await run("decision", "--project-root", root, "--id", "DEC-0001", "--title", "T",
    "--status", "APPROVED", "--owner", "Ada", "--provenance-note", path.join(root, "docs", "why.md"),
    "--operation-id", op("decision"));
  assert.equal(result.error, null, result.message);
  assert.doesNotMatch(result.out, /nothing records who approved it/);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const provenance = state.decisions[0].provenance;
  assert.equal(provenance.kind, "statement");
  assert.equal(provenance.ref, "docs/why.md");
  assert.match(provenance.sha256, /^[a-f0-9]{64}$/);
});

test("a statement outside the folder is refused, like every other recorded source", async () => {
  const root = await project();
  const outside = path.join(os.tmpdir(), `note-${Date.now()}.md`);
  fs.writeFileSync(outside, "elsewhere\n");
  const result = await run("decision", "--project-root", root, "--id", "DEC-0001", "--title", "T",
    "--status", "APPROVED", "--owner", "Ada", "--provenance-note", outside, "--operation-id", op("decision"));
  assert.notEqual(result.error, null, "a provenance nobody can read is not a provenance");
  assert.match(result.message, /inside the project/);
});

test("PROPOSED is always available, because a proposal is a legitimate thing to record", async () => {
  const root = await project();
  const result = await run("decision", "--project-root", root, "--id", "DEC-0001",
    "--title", "Ship the reader first", "--status", "PROPOSED", "--owner", "Ada",
    "--operation-id", op("decision"));
  assert.equal(result.error, null, result.message);
});

test("a settled question naming the decision is provenance, and is recorded as such", async () => {
  const root = await project();
  await settled(root, "QNA-0001", { decision: "DEC-0001" });

  const approved = await run("decision", "--project-root", root, "--id", "DEC-0001",
    "--title", "Ship the reader first", "--status", "APPROVED", "--owner", "Ada",
    "--expected-revision", decisionRevision(root, "DEC-0001"), "--operation-id", op("decision"));
  assert.equal(approved.error, null, approved.message);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const decision = state.decisions.find((item) => item.id === "DEC-0001");
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.provenance.kind, "interview");
  assert.equal(decision.provenance.ref, "QNA-0001");
  assert.equal(decision.provenance.authority, "Ada");
});

test("a human override is the other road, and a made-up one is refused", async () => {
  const root = await project({ "docs/instruction.md": "Do it the other way.\n" });
  const recorded = await run("override", "--project-root", root,
    "--instruction-file", path.join(root, "docs", "instruction.md"),
    "--owner", "Ada", "--reason", "direction changed", "--operation-id", op("override"));
  assert.equal(recorded.error, null, recorded.message);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const overrideId = state.human_overrides[0].id;

  // An open override blocks every ledger write until it is reconciled, which is
  // right and is the engine's own rule: the project's direction is unsettled
  // until somebody has said what the change affected.
  fs.writeFileSync(path.join(root, "docs", "reconciliation.md"), "what the change touched\n");
  const reconciled = await run("reconcile", "--project-root", root, "--override-id", overrideId,
    "--evidence-file", path.join(root, "docs", "reconciliation.md"), "--owner", "Ada",
    "--operation-id", op("reconcile"));
  assert.equal(reconciled.error, null, reconciled.message);

  const invented = await run("decision", "--project-root", root, "--id", "DEC-0002", "--title", "T",
    "--status", "APPROVED", "--owner", "Ada", "--provenance-override", "OVR-doesnotexist",
    "--operation-id", op("decision"));
  assert.notEqual(invented.error, null);
  assert.match(invented.message, /not a recorded override/);

  const real = await run("decision", "--project-root", root, "--id", "DEC-0002", "--title", "T",
    "--status", "APPROVED", "--owner", "Ada", "--provenance-override", overrideId,
    "--operation-id", op("decision"));
  assert.equal(real.error, null, real.message);
  const after = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(after.decisions.find((d) => d.id === "DEC-0002").provenance.kind, "override");
});

test("an approval written by an older engine is reported, not refused", async () => {
  // Compatibility: a project that predates the rule stays readable and is told
  // what is missing. Refusing it would break every existing folder for a rule
  // that did not exist when it was written.
  const root = await project();
  await run("decision", "--project-root", root, "--id", "DEC-0001", "--title", "T",
    "--status", "PROPOSED", "--owner", "Ada", "--operation-id", op("decision"));
  const location = path.join(root, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(location, "utf8"));
  state.decisions[0].status = "APPROVED";
  fs.writeFileSync(location, `${JSON.stringify(state, null, 2)}\n`);

  const validated = await run("validate", "--project-root", root);
  // The hand-edit breaks the replay chain, which is a different complaint; what
  // matters is that the state itself is not refused for the missing provenance.
  const report = validated.message || validated.out;
  assert.doesNotMatch(report, /cannot be APPROVED/);
});

// ---------------------------------------------------------------------------
// ASKED means shown
// ---------------------------------------------------------------------------

test("a block is five questions, and nothing caps how many blocks an interview has", async () => {
  /*
   * The rule this replaces was mine, and it was wrong.
   *
   * It refused a third concurrent ASKED question in Standard, reasoning that a
   * turn can only show so many. That proved nothing -- the engine does not see
   * the conversation -- and it capped the size of an interview the contract
   * requires to be exhaustive. Here: five in one block, then five more, then a
   * sixth beyond the default, with nothing refusing any of it.
   */
  const root = await project();
  for (const id of ["QNA-0001", "QNA-0002", "QNA-0003", "QNA-0004", "QNA-0005"]) {
    const result = await run("qa-ask", "--project-root", root, "--id", id, "--question", `q ${id}`,
      "--rationale", "r", "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
    assert.equal(result.error, null, `${id}: ${result.message}`);
  }
  for (const id of ["QNA-0006", "QNA-0007", "QNA-0008", "QNA-0009", "QNA-0010"]) {
    const result = await run("qa-ask", "--project-root", root, "--id", id, "--question", `q ${id}`,
      "--rationale", "r", "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
    assert.equal(result.error, null, `second block, ${id}: ${result.message}`);
  }
  const eleventh = await run("qa-ask", "--project-root", root, "--id", "QNA-0011", "--question", "q11",
    "--rationale", "r", "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  assert.equal(eleventh.error, null, eleventh.message);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.interview_log.filter((entry) => entry.status === "ASKED").length, 11);
});

test("next lays out a block of five by default, and --count moves it", async () => {
  const root = await project();
  const byDefault = await run("next", "--project-root", root);
  assert.equal(byDefault.error, null, byDefault.message);
  assert.equal(blockSize(byDefault.out), 5, byDefault.out);

  const narrowed = await run("next", "--project-root", root, "--count", "3");
  assert.equal(blockSize(narrowed.out), 3, narrowed.out);

  const wide = await run("next", "--project-root", root, "--count", "8");
  assert.equal(wide.error, null, "eight in a block was refused by the old 1|2|3 rule");
  assert.ok(blockSize(wide.out) >= 5, wide.out);

  const nonsense = await run("next", "--project-root", root, "--count", "0");
  assert.notEqual(nonsense.error, null);
  assert.match(nonsense.message, /it does not limit how many blocks an interview has/);
});

test("the block size defaults to five, and a project that never set one is not changed", async () => {
  const root = await project();

  const reported = JSON.parse((await run("status", "--project-root", root)).out);
  assert.deepEqual(reported.question_block_size, { effective: 5, recorded: false },
    "absent is a fact of its own: nobody has said, which is not the same as choosing five");

  assert.equal(blockSize((await run("next", "--project-root", root)).out), 5);

  // An occasional --count is this block only. The engine does not learn a
  // preference from somebody asking for three questions once.
  assert.equal(blockSize((await run("next", "--project-root", root, "--count", "3")).out), 3);
  const after = JSON.parse((await run("status", "--project-root", root)).out);
  assert.deepEqual(after.question_block_size, { effective: 5, recorded: false });

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal("question_block_size" in state, false, "reading a project must not write a field into it");
});

test("--remember is how a block size becomes the project's own", async () => {
  const root = await project();

  const needsSize = await run("next", "--project-root", root, "--remember", "--owner", "Ada",
    "--operation-id", op("remember"));
  assert.notEqual(needsSize.error, null, "--remember with nothing to remember is not a preference");
  assert.match(needsSize.message, /needs the size to remember/);

  const tooBig = await run("next", "--project-root", root, "--count", "21", "--remember", "--owner", "Ada",
    "--operation-id", op("remember"));
  assert.notEqual(tooBig.error, null);
  assert.match(tooBig.message, /between 1 and 20/);

  const recorded = await run("next", "--project-root", root, "--count", "3", "--remember", "--owner", "Ada",
    "--operation-id", op("remember"));
  assert.equal(recorded.error, null, recorded.message);
  assert.match(recorded.out, /3 questions in a block/);

  const reported = JSON.parse((await run("status", "--project-root", root)).out);
  assert.deepEqual(reported.question_block_size, { effective: 3, recorded: true });
  assert.equal(blockSize((await run("next", "--project-root", root)).out), 3, "next uses what was recorded");
  assert.equal(blockSize((await run("next", "--project-root", root, "--count", "5")).out), 5,
    "--count still sizes one block");

  // The history says what it was, including that nothing was set before.
  const events = fs.readFileSync(path.join(root, ".plangonaut", "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const event = events.find((entry) => entry.type === "QUESTION_BLOCK_SIZE_SET");
  assert.equal(event.question_block_size, 3);
  assert.equal(event.previous_question_block_size, null);
  assert.equal(event.owner, "Ada");
});

test("a fresh agent reads the block size out of the folder, not out of the conversation", async () => {
  const root = await project();
  await run("next", "--project-root", root, "--count", "8", "--remember", "--owner", "Ada",
    "--operation-id", op("remember"));

  const resumed = await run("resume", "--project-root", root);
  assert.equal(resumed.error, null, resumed.message);
  assert.match(resumed.out, /- Question block: 8\n/);

  const pack = await run("context-pack", "--project-root", root);
  assert.match(pack.out, /- Question block: 8\n/);

  const untouched = await run("resume", "--project-root", await project());
  assert.match(untouched.out, /- Question block: 5 \(nobody has set one; this is the default\)/);
});

test("PLANNED, ASKED, ANSWERED and settled stay four different things", async () => {
  const root = await project();
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q1", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--planned", "--operation-id", op("ask"));
  await run("qa-ask", "--project-root", root, "--id", "QNA-0002", "--question", "q2", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const answer = path.join(root, "a.txt");
  fs.writeFileSync(answer, "the user's own words\n");
  await run("qa-answer", "--project-root", root, "--id", "QNA-0002", "--answer-file", answer,
    "--owner", "Ada", "--operation-id", op("answer"));

  let state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const entry = (id) => state.interview_log.find((item) => item.id === id);
  assert.equal(entry("QNA-0001").status, "PLANNED");
  assert.equal(entry("QNA-0001").asked_at, null, "planned means not put to anybody");
  assert.equal(entry("QNA-0002").status, "ANSWERED");
  assert.equal(entry("QNA-0002").consequences_recorded_at, null, "answered is not settled");

  await run("qa-settle", "--project-root", root, "--id", "QNA-0002", "--interpretation", "understood",
    "--reply", "recorded", "--owner", "Ada", "--operation-id", op("settle"));
  state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(entry("QNA-0002").status, "ANSWERED", "settled is a timestamp, not a fifth status word");
  assert.ok(entry("QNA-0002").consequences_recorded_at, "and only qa-settle writes it");
});

// ---------------------------------------------------------------------------
// A module is not confirmed by writing about it
// ---------------------------------------------------------------------------

test("a module CONFIRMED over its own unanswered question is named, and refused at the handover", async () => {
  // alpha.5: one command with an evidence file, and the evidence could be a
  // summary the agent had just written about its own reading.
  const root = await project();
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const evidence = path.join(root, "summary.md");
  fs.writeFileSync(evidence, "# what I read\n");

  const result = await run("record", "--project-root", root, "--module", "1", "--status", "CONFIRMED",
    "--answer-file", evidence, "--owner", "Ada", "--operation-id", op("record"));
  // Same layering as the approval above, and for the same measured reason.
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /module 1 is now CONFIRMED, and/);
  assert.match(result.out, /QNA-0001 is ASKED/);
  assert.match(result.out, /handoff-check refuses/);

  const handoff = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(
    handoff.blocking.some((line) => line.includes("module 1 is CONFIRMED") && line.includes("QNA-0001")),
    "a folder is not handed over with a module confirmed over its own open question",
  );
});

test("a module CONFIRMED while its own decision is still PROPOSED is named, and refused", async () => {
  const root = await project();
  await settled(root, "QNA-0001", { decision: "DEC-0001" });
  const evidence = path.join(root, "summary.md");
  fs.writeFileSync(evidence, "# module 1\n");

  const result = await run("record", "--project-root", root, "--module", "1", "--status", "CONFIRMED",
    "--answer-file", evidence, "--owner", "Ada", "--operation-id", op("record"));
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /DEC-0001 came out of this module's interview and is still PROPOSED/);

  const handoff = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(handoff.blocking.some((line) => line.includes("DEC-0001")), handoff.blocking.join("\n"));
});

test("a module is CONFIRMED once its own ledger is settled", async () => {
  const root = await project();
  await settled(root, "QNA-0001", { decision: "DEC-0001" });
  await run("decision", "--project-root", root, "--id", "DEC-0001", "--title", "T",
    "--status", "APPROVED", "--owner", "Ada", "--expected-revision", decisionRevision(root, "DEC-0001"), "--operation-id", op("decision"));
  const evidence = path.join(root, "summary.md");
  fs.writeFileSync(evidence, "# module 1\n");

  const result = await run("record", "--project-root", root, "--module", "1", "--status", "CONFIRMED",
    "--answer-file", evidence, "--owner", "Ada", "--operation-id", op("record"));
  assert.equal(result.error, null, result.message);
});

// ---------------------------------------------------------------------------
// The prose and the ledger
// ---------------------------------------------------------------------------

test("a governed document citing a record that does not exist is reported", async () => {
  const root = await project();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "plan-v1.md");
  fs.writeFileSync(document, "# Plan\n\nThe approach follows DEC-0007 and REQ-0011.\n");
  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-PLAN",
    "--base-path", "docs/plan.md", "--content-file", document, "--owner", "Ada");
  await run("doc-save", "--project-root", root, "--id", "ART-PLAN", "--base-path", "docs/plan.md",
    "--content-file", document, "--owner", "Ada",
    "--confirm-token", JSON.parse(preview.out).confirmation_token, "--operation-id", op("save"));

  const validated = await run("validate", "--project-root", root);
  assert.match(validated.out, /do(es)? not match the ledger/);
  assert.match(validated.out, /DEC-0007, REQ-0011/);
  assert.match(validated.out, /telling a reader to go and find it/);
});

// ---------------------------------------------------------------------------
// A forecast is somebody's
// ---------------------------------------------------------------------------

test("a forecast must say whether it is an estimate or a commitment", async () => {
  const root = await project();
  const argv = ["forecast", "--project-root", root, "--owner", "Ada", "--phase", "INTERVIEW",
    "--known-work", "k", "--conditional-work", "c", "--questions", "10-20", "--operations", "30-60",
    "--cycles", "2-4", "--confidence", "MEDIA", "--confidence-reason", "r",
    "--cycle-state", "REGOLARE", "--operation-id", op("forecast")];

  // This one stays a refusal: it is a new required argument, not a state rule,
  // and a forecast with no author is the defect itself. Cheap to supply, loud
  // when missing, and every call site says which kind of claim it is making.
  const without = await run(...argv);
  assert.notEqual(without.error, null, "alpha.5 recorded this as the owner's own numbers");
  assert.match(without.message, /--author is required/);

  const withAuthor = await run(...argv, "--author", "agent");
  assert.equal(withAuthor.error, null, withAuthor.message);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.progress_forecast.authored_by, "agent");
  assert.equal(state.progress_forecast.recorded_by, "Ada");

  const resumed = await run("resume", "--project-root", root);
  assert.match(resumed.out, /an agent's estimate\*\*, not a commitment anyone made/);
});

// ---------------------------------------------------------------------------
// Nothing advances over a contradiction the project already records
// ---------------------------------------------------------------------------

/** A module confirmed over its own open question: the folder's own contradiction. */
async function incoherentlyConfirmed() {
  const root = await project();
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const evidence = path.join(root, "summary.md");
  fs.writeFileSync(evidence, "# what I read\n");
  await run("record", "--project-root", root, "--module", "1", "--status", "CONFIRMED",
    "--answer-file", evidence, "--owner", "Ada", "--operation-id", op("record"));
  return root;
}

test("an incoherently confirmed module stops the next action advancing", async () => {
  /*
   * The synthetic pilot found this, and it is the defect of this whole cycle
   * committed by the engine rather than by an agent: module 1 was CONFIRMED over
   * two open questions, handoff-check refused the folder, validate --strict
   * failed, and the recorded next action said "Discuss module 2". Every part was
   * individually correct and together they invited an agent to build on a
   * foundation the same tool had just refused.
   */
  const root = await incoherentlyConfirmed();

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.doesNotMatch(state.exact_next_action, /Discuss module 2/,
    "the recorded sentence stepped over the project's own contradiction");
  assert.match(state.exact_next_action, /Resolve \d+ recorded contradictions? before continuing/);

  // next shows it before it offers anything.
  const offered = await run("next", "--project-root", root);
  assert.equal(offered.error, null, offered.message);
  const first = offered.out.split("\n").find((line) => line.trim());
  assert.match(first, /^FIRST: \d+ recorded contradictions? stands?|^FIRST: \d+ recorded contradictions stand/);
  assert.match(offered.out, /module 1 is CONFIRMED, and QNA-0001 is ASKED/);
  assert.match(offered.out, /NOT_APPLICABLE or DEFERRED|DEFERRED with its reason/);

  // status carries it as data, beside the recorded sentence.
  const reported = JSON.parse((await run("status", "--project-root", root)).out);
  assert.ok(Array.isArray(reported.advance_blocked_by));
  assert.ok(reported.advance_blocked_by.some((line) => line.includes("QNA-0001")), JSON.stringify(reported.advance_blocked_by));

  // resume says it above everything a reader would take for a plan.
  const resumed = await run("resume", "--project-root", root);
  assert.match(resumed.out, /## Resolve this before continuing/);
  assert.ok(
    resumed.out.indexOf("## Resolve this before continuing") < resumed.out.indexOf("## Catalog questions"),
    "the hold has to come before the catalogue, or a reader never reaches it",
  );

  // And the same findings are what validate --strict fails on.
  const strict = await run("validate", "--project-root", root, "--strict");
  assert.notEqual(strict.error, null);
  assert.match(strict.message, /module 1 is CONFIRMED/);
});

test("downgrading the claim clears the hold, which is the point of not refusing", async () => {
  const root = await incoherentlyConfirmed();
  const reason = path.join(root, "why.md");
  fs.writeFileSync(reason, "This module does not apply: the project has no external users.\n");

  const closed = await run("qa-close", "--project-root", root, "--id", "QNA-0001", "--kind", "skipped",
    "--reason", "not applicable to this project", "--owner", "Ada", "--operation-id", op("close"));
  assert.equal(closed.error, null, closed.message);

  // Closing the question is not enough, and the engine is right about that:
  // the module still claims CONFIRMED with nothing recorded against it. What
  // the hold asks for is the claim itself, downgraded.
  const stillHeld = JSON.parse((await run("status", "--project-root", root)).out);
  assert.match(stillHeld.advance_blocked_by.join("\n"), /nothing is recorded against it/);

  const downgraded = await run("record", "--project-root", root, "--module", "1", "--status", "NOT_APPLICABLE",
    "--answer-file", reason, "--owner", "Ada", "--operation-id", op("downgrade"));
  assert.equal(downgraded.error, null, downgraded.message);

  const reported = JSON.parse((await run("status", "--project-root", root)).out);
  assert.deepEqual(reported.advance_blocked_by, [], "with nothing contradicting it, nothing is held");

  const offered = await run("next", "--project-root", root);
  assert.doesNotMatch(offered.out, /recorded contradictions? stand/);
});

// ---------------------------------------------------------------------------
// handoff-check sees what it cannot govern
// ---------------------------------------------------------------------------

test("an ungoverned document is blocking, and its outside references are reported", async () => {
  const root = await project();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "notes-v1.md"),
    "# Notes\n\nIt builds on [the kit](/opt/sample-project/kit/state.py).\n");

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(report.blocking.some((line) => line.includes("docs/notes-v1.md")), report.blocking.join("\n"));
  assert.ok(report.blocking.some((line) => line.includes("plangonaut govern --exclude")));
  assert.ok(
    report.advisory.some((line) => line.includes("/opt/sample-project/kit/state.py")),
    "an ungoverned file's outside references are looked at and reported",
  );
  assert.ok(
    report.advisory.some((line) => line.includes("no digest")),
    "and the limit of that reading is stated rather than implied",
  );
});

test("a deliberately excluded file is neither blocking nor silently ignored", async () => {
  const root = await project();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "notes-v1.md"), "# Notes\n\nnothing outside here.\n");
  const governed = await run("govern", "--project-root", root, "--exclude", "docs/notes-v1.md",
    "--reason", "working notes", "--owner", "Ada", "--operation-id", op("govern"));
  assert.equal(governed.error, null, governed.message);

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(!report.blocking.some((line) => line.includes("notes-v1.md")), report.blocking.join("\n"));
});

test("technical, build and dependency files never appear", async () => {
  const root = await project({
    "README.md": "# readme\n",
    "CHANGELOG.md": "# changelog\n",
    "node_modules/pkg/doc-v1.md": "# a dependency's\n",
    "dist/built-v1.md": "# build output\n",
  });
  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  const noise = [...report.blocking, ...report.advisory].filter((line) =>
    line.includes("README") || line.includes("CHANGELOG") || line.includes("node_modules") || line.includes("dist/"));
  assert.deepEqual(noise, [], noise.join("\n"));
});

test("POSITIVE CONTROL: an important document nobody is governing is reported", async () => {
  // The pilot's own failure, in one fixture: the architecture was written by
  // hand straight to a -vN file, and validate answered "state is valid" all
  // session. If this stops being reported, the check has been bounded into
  // uselessness and the negative control below would still pass.
  const root = await project();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "architecture-v1.md"),
    "# Architecture\n\nThe store is SQLite and the sync is one-way.\n");

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(
    report.blocking.some((line) => line.includes("docs/architecture-v1.md")),
    report.blocking.join("\n"),
  );

  const strict = await run("validate", "--project-root", root, "--strict");
  assert.notEqual(strict.error, null, "--strict is for the caller who has decided the project may not carry one");
});

test("NEGATIVE CONTROL: an ordinary software project is not reported file by file", async () => {
  /*
   * A check that reports a repository's own working files is a check somebody
   * turns off, which costs more than the documents it would have caught. So:
   * a realistic tree -- sources, dependencies, build output, caches, vendored
   * code, temporary files, notes beside the code -- and nothing in it is a
   * finding about governance.
   */
  const root = await project({
    "src/index.ts": "export const main = () => 0;\n",
    "src/store/sqlite.ts": "export class Store {}\n",
    "src/store/README-v2.md": "# working note\n\nMy own scratch notes about this module.\n",
    "src/components/Button.tsx": "export const Button = () => null;\n",
    "tests/store.test.ts": "test('it works', () => {});\n",
    "node_modules/left-pad/README.md": "# left-pad\n",
    "node_modules/left-pad/docs/usage-v1.md": "# usage\n",
    "vendor/libfoo/design-v3.md": "# somebody else's design\n",
    "third_party/bar/spec-v1.md": "# somebody else's spec\n",
    "dist/bundle.js": "console.log(1)\n",
    "dist/report-v1.md": "# generated\n",
    "build/output-v2.md": "# generated\n",
    "coverage/lcov-report/index.md": "# coverage\n",
    "tmp/scratch-v1.md": "# temporary\n",
    "README.md": "# The project\n",
    "CHANGELOG.md": "# Changelog\n",
    "LICENSE.md": "MIT\n",
    "CONTRIBUTING.md": "# How to help\n",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
  });

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  const governance = [...report.blocking, ...report.advisory].filter((line) => line.includes("claims it"));
  assert.deepEqual(governance, [], governance.join("\n"));

  const validated = await run("validate", "--project-root", root, "--strict");
  assert.equal(validated.error, null, validated.message);
  assert.doesNotMatch(validated.out, /outside the ledger/);
});

test("a document directory is where a document is looked for, whatever it is called", async () => {
  // The bound is the place, not the word "docs": a plan in plans/ counts, and
  // the same file name under application code does not.
  // Written after init, deliberately: Markdown that was in the folder when the
  // project was initialised belongs to the repository and not to the plan, and
  // the engine already records which. Creating these before init is how I first
  // got this test to pass for the wrong reason.
  const root = await project();
  fs.mkdirSync(path.join(root, "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "internal"), { recursive: true });
  fs.writeFileSync(path.join(root, "plans", "rollout-v1.md"), "# Rollout\n\nThe plan for the first release.\n");
  fs.writeFileSync(path.join(root, "src", "internal", "rollout-v1.md"), "# my notes\n\nScratch, beside the code it is about.\n");

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  const lines = [...report.blocking, ...report.advisory].join("\n");
  assert.match(lines, /plans\/rollout-v1\.md/);
  assert.doesNotMatch(lines, /src\/internal\/rollout-v1\.md/);
});

test("the help says what the check looks at, so a reader can tell what its silence means", async () => {
  const printed = await run("handoff-check", "--help");
  assert.equal(printed.error, null, printed.message);
  assert.match(printed.out, /only Markdown/);
  assert.match(printed.out, /node_modules/);
  assert.match(printed.out, /where documents live/);
  assert.match(printed.out, /not what you excluded/);
});

test("every blocking finding says how it can be closed", async () => {
  const root = await project();
  const result = await run("handoff-check", "--project-root", root);
  assert.notEqual(result.error, null);
  const printed = result.message;
  assert.match(printed, /record it/);
  assert.match(printed, /qualify it/);
  assert.match(printed, /accept it/);
  assert.match(printed, /no flag for accepting a finding, on purpose/);
  assert.match(printed, /Re-run plangonaut handoff-check/);
});

// ---------------------------------------------------------------------------
// re-record
// ---------------------------------------------------------------------------

test("re-record refuses an unusable file without echoing it back", async () => {
  const root = await project({ "docs/instruction.md": "instruction\n" });
  await run("override", "--project-root", root, "--instruction-file", path.join(root, "docs", "instruction.md"),
    "--owner", "Ada", "--reason", "r", "--operation-id", op("override"));
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const id = state.human_overrides[0].id;
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "elsewhere\n");

  const result = await run("re-record", "--project-root", root, "--kind", "override", "--id", id,
    "--source-file", outside, "--owner", "Ada", "--reason", "moved", "--operation-id", op("rerecord"));
  assert.notEqual(result.error, null);
  assert.match(result.message, /beyond the folder that travels with it/);
  assert.match(result.message, /--source-file <path-inside-the-project>/);
  assert.match(result.message, /still stands on docs\/instruction\.md/, "the previous source is preserved and said");
  assert.doesNotMatch(result.message, new RegExp(`--source-file ${outside.replace(/[\\/.]/g, "\\$&")}`));
});
