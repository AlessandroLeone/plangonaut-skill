import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The second real defect, reproduced from its shape rather than its contents.
 *
 * WHAT HAPPENED
 * -------------
 * A project was created with one CLI, continued with a later one, and somewhere
 * in the middle a desktop build appended a `DOCUMENT_SAVED` event of its own.
 * That event was perfectly well formed in the format its writer knew: an id, a
 * type, a revision, a timestamp, the artifact it touched. It carried none of
 * `format`, `state_patch`, `previous_revision`, `previous_state_sha256`,
 * `state_sha256`, `previous_event_sha256`, `payload_sha256`,
 * `operation_payload_hash`, `operation_payload_version` or `diff` — because the
 * writer that produced it predated all of them.
 *
 * The state contained the artifact. The events after it were valid. Nothing
 * compared the two writers, and the history stopped being reproducible at that
 * line without anything saying so.
 *
 * WHAT THIS FILE ASSERTS
 * ----------------------
 * That it is caught, that it is described well enough to act on, that a human
 * decision cannot make it acceptable, that `replay --repair` refuses rather
 * than quietly producing a state missing those events, and that `baseline` can
 * be looked at before it is taken and states the boundary of what it proves.
 *
 * Nothing here uses a name, a path or a byte from the real project.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "lib", "bin", "plangonaut.js");

function invoke(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function run(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, `${args[0]} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return result.stdout;
}

function refuse(...args) {
  const result = invoke(...args);
  assert.notEqual(result.status, 0, `expected a refusal from ${args[0]}:\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
}

let counter = 0;
function fixture(name) {
  const directory = path.join(os.tmpdir(), `plangonaut-integrity-${name}-${process.pid}-${counter++}`);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const owners = path.join(directory, "owners.json");
  fs.writeFileSync(owners, JSON.stringify({ product: "User", technical: "User", budget: "User", safety: "User", release: "User" }));
  run("init", "--project-root", directory, "--project-name", "Fixture", "--project-mode", "Resume",
      "--interaction-mode", "Standard", "--owners-file", owners, "--operation-id", `OP-init-${crypto.randomUUID()}`);
  return directory;
}

const stateDir = (project) => path.join(project, ".plangonaut");
const eventsPath = (project) => path.join(stateDir(project), "events.jsonl");
const statePath = (project) => path.join(stateDir(project), "state.json");

function readEvents(project) {
  return fs.readFileSync(eventsPath(project), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * The foreign event, written the way a writer that does not know the format
 * writes one.
 *
 * Built by subtraction from a real event so it cannot drift: every field the
 * current format requires is removed, and what is left is what the older writer
 * knew about. Inventing the shape from memory would produce a fixture that
 * stops resembling the defect the first time the format changes.
 */
const FORMAT_FIELDS = [
  "format", "state_patch", "previous_revision", "previous_state_sha256",
  "state_sha256", "previous_event_sha256", "payload_sha256",
  "operation_payload_hash", "operation_payload_version", "diff",
];

/** The bytes on disk and the digest in the ledger have to be the same bytes. */
const NOTE = "note\n";

function appendForeignDocumentSaved(project) {
  const events = readEvents(project);
  const last = events[events.length - 1];
  const state = JSON.parse(fs.readFileSync(statePath(project), "utf8"));

  const foreign = {
    event_id: crypto.randomUUID(),
    type: "DOCUMENT_SAVED",
    state_revision: Number(state.revision) + 1,
    at: new Date().toISOString(),
    idempotency_key: `studio-${crypto.randomUUID()}`,
    operation_id: `OP-studio-${crypto.randomUUID()}`,
    artifact_id: "ART-NOTE",
    revision: 1,
    hash: crypto.createHash("sha256").update(NOTE).digest("hex"),
    owner: "User",
    sources: [],
    deletion_intent_ids: [],
  };
  for (const field of FORMAT_FIELDS) {
    assert.equal(foreign[field], undefined, `the fixture would carry ${field}, which the defect's writer did not produce`);
  }
  // The chain the newer writer maintains is still intact around it: this is a
  // foreign event in a good history, not a corrupted file.
  assert.ok(last.state_sha256, "the fixture needs a format-2 event before the foreign one");

  // The state contains the artifact, exactly as the real project's did.
  state.artifacts = [...(state.artifacts ?? []), {
    id: "ART-NOTE",
    base_path: "note.md",
    working_path: "note-v1.md",
    status: "DRAFT",
    revision: 1,
    content_hash: foreign.hash,
    lock_owner: "User",
    provenance: [],
  }];
  state.revision = foreign.state_revision;
  state.last_event_id = foreign.event_id;
  fs.writeFileSync(statePath(project), `${JSON.stringify(state, null, 2)}\n`);
  fs.appendFileSync(eventsPath(project), `${JSON.stringify(foreign)}\n`);
  fs.writeFileSync(path.join(project, "note.md"), NOTE);
  // The working file too: an artifact naming one that is not there is a
  // different defect, and a fixture must reproduce one thing at a time.
  fs.writeFileSync(path.join(project, "note-v1.md"), NOTE);
  return foreign;
}

// ---------------------------------------------------------------------------
// B2 — the defect, and everything that must be true about it
// ---------------------------------------------------------------------------

test("an event written by an incompatible writer is not replayable, and is named", () => {
  const project = fixture("foreign");
  const foreign = appendForeignDocumentSaved(project);

  const verify = invoke("replay", "--verify", "--project-root", project);
  assert.notEqual(verify.status, 0, "replay --verify passed over a foreign event");

  const output = `${verify.stdout}\n${verify.stderr}`;
  // B3: every field a person needs in order to act.
  assert.match(output, /Mechanical integrity: FAILED/);
  assert.match(output, /event line\s+\d+/, "no event line");
  assert.match(output, new RegExp(foreign.event_id), "the event id is not reported");
  assert.match(output, /DOCUMENT_SAVED/, "the type is not reported");
  assert.match(output, /detected event format\s+1/, "the detected format is not reported");
  assert.match(output, /missing required fields.*state_patch/, "the missing fields are not listed");
  assert.match(output, /last verifiable event\s+line \d+/, "the last verifiable event is not reported");
  assert.match(output, /events after it\s+\d+/, "the count of later events is not reported");
  assert.match(output, /reconstructible value\s+none/, "it claimed something could be rebuilt");
  assert.match(output, /baseline/, "no safe remedy is offered");
  assert.match(output, /Do not:/, "no forbidden remedy is named");
});

test("strict validation is red, and every command agrees", () => {
  const project = fixture("agree");
  appendForeignDocumentSaved(project);

  for (const args of [["validate", "--project-root", project], ["validate", "--project-root", project, "--strict"],
                      ["status", "--project-root", project], ["handoff-check", "--project-root", project],
                      ["replay", "--verify", "--project-root", project]]) {
    const result = invoke(...args);
    assert.notEqual(result.status, 0, `${args[0]} reported success over a broken history:\n${result.stdout}`);
  }
});

test("a human decision cannot make an integrity failure acceptable", () => {
  const project = fixture("decision");
  appendForeignDocumentSaved(project);

  // The project records, in the strongest form it has, that integrity is not a
  // priority. Every command still refuses.
  const refusal = refuse("decision", "--project-root", project, "--id", "DEC-0001",
                         "--title", "Integrity is not a priority for this project", "--status", "APPROVED",
                         "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /does not agree with its history|not valid|Validation failed|untrusted|cannot be/i,
    `the engine accepted a write onto a broken history:\n${refusal}`);

  const verify = invoke("replay", "--verify", "--project-root", project);
  const output = `${verify.stdout}\n${verify.stderr}`;
  assert.match(output, /cannot be accepted, deferred or overridden/);
  assert.match(output, /has no flag for it/);
});

test("execution and handoff readiness both fail on a broken history", () => {
  const project = fixture("readiness");
  run("execution-intent", "--project-root", project, "--execution", "--reason", "To be built.",
      "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  appendForeignDocumentSaved(project);

  const readiness = invoke("execution-readiness", "--project-root", project, "--json");
  const parsed = JSON.parse(readiness.stdout);
  assert.equal(parsed.execution.verdict, "FAILED");
  assert.ok(
    parsed.execution.findings.some((line) => /mechanical integrity has failed/.test(line)),
    `execution readiness did not name the integrity failure:\n${parsed.execution.findings.join("\n")}`
  );

  const handoff = invoke("handoff-check", "--project-root", project, "--json");
  const handed = JSON.parse(handoff.stdout);
  assert.equal(handed.deliverable, false);
  assert.ok(handed.blocking.some((line) => /mechanical integrity has failed/.test(line)));
});

test("replay --repair refuses rather than dropping the events it cannot apply", () => {
  const project = fixture("repair");
  appendForeignDocumentSaved(project);
  const before = fs.readFileSync(statePath(project), "utf8");
  const eventsBefore = fs.readFileSync(eventsPath(project), "utf8");

  const refusal = refuse("replay", "--project-root", project, "--repair", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /Nothing can be rebuilt/);
  assert.match(refusal, /would drop event line \d+/, "the refusal did not say what would be lost");
  assert.match(refusal, /baseline/, "the refusal did not offer the road that keeps them");
  assert.match(refusal, /Nothing was changed/);

  assert.equal(fs.readFileSync(statePath(project), "utf8"), before, "the state was modified by a refused repair");
  assert.equal(fs.readFileSync(eventsPath(project), "utf8"), eventsBefore, "the history was modified by a refused repair");
});

test("nothing proposes replay --repair for this defect", () => {
  const project = fixture("norepair");
  appendForeignDocumentSaved(project);
  const output = `${invoke("replay", "--verify", "--project-root", project).stdout}`;
  // The diagnosis names it as forbidden; it must not also be offered.
  const offered = output.split("\n").filter((line) => /--repair/.test(line) && !/Do not|refuses|will not/.test(line));
  assert.deepEqual(offered, [], `replay --repair was proposed for a defect it cannot fix:\n${offered.join("\n")}`);
});

// ---------------------------------------------------------------------------
// B4 — baseline
// ---------------------------------------------------------------------------

test("baseline previews without writing, and states the boundary of its proof", () => {
  const project = fixture("preview");
  appendForeignDocumentSaved(project);
  const before = fs.readFileSync(eventsPath(project), "utf8");

  const preview = run("baseline", "--project-root", project, "--dry-run",
                      "--reason", "The history predates this format", "--owner", "User",
                      "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(preview, /events left outside the proof\s+\d+/);
  assert.match(preview, /not retroactive evidence/);
  assert.match(preview, /the defect it steps over\s+line \d+/);
  assert.match(preview, /Nothing was written/);
  assert.match(preview, /--confirm-token [a-f0-9]{12}/, "no confirmation token was offered");

  assert.equal(fs.readFileSync(eventsPath(project), "utf8"), before, "the preview wrote to the history");
});

test("baseline refuses without confirmation, and accepts the token it printed", () => {
  const project = fixture("confirm");
  appendForeignDocumentSaved(project);

  const refusal = refuse("baseline", "--project-root", project, "--reason", "Predates the format",
                         "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /needs confirming/);

  const preview = run("baseline", "--project-root", project, "--dry-run", "--reason", "Predates the format",
                      "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  const token = /--confirm-token ([a-f0-9]{12})/.exec(preview)[1];

  const bad = refuse("baseline", "--project-root", project, "--reason", "Predates the format",
                     "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`, "--confirm-token", "0".repeat(12));
  assert.match(bad, /does not match this project/);

  const recorded = run("baseline", "--project-root", project, "--reason", "Predates the format",
                       "--owner", "User", "--operation-id", `OP-baseline-1`, "--confirm-token", token);
  assert.match(recorded, /Recorded a replay baseline/);
  assert.match(recorded, /not retroactive evidence/);
  assert.match(recorded, /events 1-\d+ are readable and unproven/);
});

test("after a baseline the project verifies, the old history is still there, and it is idempotent", () => {
  const project = fixture("after");
  appendForeignDocumentSaved(project);
  const eventsBefore = readEvents(project).length;

  const preview = run("baseline", "--project-root", project, "--dry-run", "--reason", "Predates the format",
                      "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  const token = /--confirm-token ([a-f0-9]{12})/.exec(preview)[1];
  run("baseline", "--project-root", project, "--reason", "Predates the format", "--owner", "User",
      "--operation-id", "OP-baseline-2", "--confirm-token", token);

  run("replay", "--verify", "--project-root", project);
  run("validate", "--project-root", project, "--strict");

  const after = readEvents(project);
  assert.equal(after.length, eventsBefore + 1, "the baseline rewrote history instead of appending to it");
  assert.ok(after.some((event) => event.type === "DOCUMENT_SAVED" && event.format === undefined),
    "the foreign event was removed rather than left in the file");
  const boundary = after.find((event) => event.type === "BASELINE_RECORDED");
  assert.equal(boundary.events_before, eventsBefore);
  assert.equal(boundary.writer, "plangonaut-cli");
  assert.ok(boundary.engine_version, "the baseline did not record which engine drew the boundary");
  assert.ok(boundary.defect_category, "the baseline did not record what it stepped over");

  // Idempotent: the same operation id does not record a second baseline.
  const again = run("baseline", "--project-root", project, "--reason", "Predates the format", "--owner", "User",
                    "--operation-id", "OP-baseline-2", "--confirm-token", token);
  assert.match(again, /Idempotent retry/);
  assert.equal(readEvents(project).length, after.length);
});

test("baseline will not run while another writer holds the project", () => {
  const project = fixture("locked");
  appendForeignDocumentSaved(project);
  fs.writeFileSync(path.join(stateDir(project), "lock.json"), JSON.stringify({
    pid: 999999, host: os.hostname(), owner: "User", writer: "plangonaut-studio", at: new Date().toISOString(),
  }));

  const refusal = refuse("baseline", "--project-root", project, "--reason", "Predates the format",
                         "--owner", "User", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /holding this project/);
  assert.match(refusal, /Nothing was written/);
});

// ---------------------------------------------------------------------------
// C1 — the compatibility contract
// ---------------------------------------------------------------------------

test("a writer is judged by what it can do, not by its version number", () => {
  const project = fixture("compat");

  // The CLI itself.
  const mine = JSON.parse(run("compat-check", "--project-root", project, "--json"));
  assert.equal(mine.verdict.compatible, true);
  assert.equal(mine.project.event_format, 2);
  assert.equal(mine.writer.writes_event_format, 2);

  // The writer that caused the defect.
  const studio = invoke("compat-check", "--project-root", project, "--json",
                        "--writer-engine", "plangonaut-studio", "--writer-version", "0.3.0-alpha.4",
                        "--writer-event-format", "1", "--writer-reads-formats", "1");
  assert.equal(studio.status, 2, "an incompatible writer was reported compatible");
  const verdict = JSON.parse(studio.stdout);
  assert.equal(verdict.verdict.compatible, false);
  assert.match(verdict.verdict.reasons.join(" "), /breaks the digest chain/);

  // A newer writer that still produces what this history needs is allowed:
  // "newer" is not by itself a reason to refuse.
  const newer = JSON.parse(run("compat-check", "--project-root", project, "--json",
                               "--writer-engine", "plangonaut-cli", "--writer-version", "0.4.0",
                               "--writer-event-format", "2", "--writer-reads-formats", "1,2"));
  assert.equal(newer.verdict.compatible, true);
});

test("a history holding a foreign event refuses every writer until it is settled", () => {
  const project = fixture("compat-broken");
  appendForeignDocumentSaved(project);
  const result = invoke("compat-check", "--project-root", project, "--json");
  assert.equal(result.status, 2);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.verdict.compatible, false);
  assert.match(verdict.verdict.reasons.join(" "), /unverifiable history|required fields/);
});

// ---------------------------------------------------------------------------
// E4 — negative controls
// ---------------------------------------------------------------------------

test("the fixture really is the defect: without the foreign event everything passes", () => {
  /*
   * The control for every assertion above.
   *
   * If this project — built the same way, minus the one appended line — also
   * failed, the tests above would be measuring something other than the defect
   * they name. It is the cheapest possible proof that the fixture is doing the
   * work.
   */
  const project = fixture("control");
  run("replay", "--verify", "--project-root", project);
  run("validate", "--project-root", project, "--strict");
  const handed = JSON.parse(invoke("handoff-check", "--project-root", project, "--json").stdout);
  assert.ok(!handed.blocking.some((line) => /mechanical integrity/.test(line)),
    "a sound project was reported as mechanically broken");
});

test("the integrity check is what refuses: removing the foreign event clears it", () => {
  const project = fixture("control-removal");
  appendForeignDocumentSaved(project);
  assert.notEqual(invoke("replay", "--verify", "--project-root", project).status, 0);

  // Put the history and the state back to what they were before the append.
  const events = readEvents(project);
  const kept = events.slice(0, -1);
  fs.writeFileSync(eventsPath(project), `${kept.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const state = JSON.parse(fs.readFileSync(statePath(project), "utf8"));
  state.artifacts = [];
  state.revision = kept[kept.length - 1].state_revision;
  state.last_event_id = kept[kept.length - 1].event_id;
  fs.writeFileSync(statePath(project), `${JSON.stringify(state, null, 2)}\n`);

  run("replay", "--verify", "--project-root", project);
});
