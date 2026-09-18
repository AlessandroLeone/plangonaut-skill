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

test("more questions cannot be ASKED at once than a turn can show", async () => {
  // alpha.5: an agent could record a dozen as ASKED and show none.
  const root = await project();
  for (const id of ["QNA-0001", "QNA-0002"]) {
    const result = await run("qa-ask", "--project-root", root, "--id", id, "--question", `q ${id}`,
      "--rationale", "r", "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
    assert.equal(result.error, null, result.message);
  }
  const third = await run("qa-ask", "--project-root", root, "--id", "QNA-0003", "--question", "q3",
    "--rationale", "r", "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  assert.notEqual(third.error, null, "Standard shows two questions in a turn, not three");
  assert.match(third.message, /already ASKED and unanswered/);
  assert.match(third.message, /--planned/);
});

test("a planned question is always allowed, however many are waiting", async () => {
  const root = await project();
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q1", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  await run("qa-ask", "--project-root", root, "--id", "QNA-0002", "--question", "q2", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const planned = await run("qa-ask", "--project-root", root, "--id", "QNA-0003", "--question", "q3",
    "--rationale", "r", "--owner", "Ada", "--module", "1", "--planned", "--operation-id", op("ask"));
  assert.equal(planned.error, null, planned.message);
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
