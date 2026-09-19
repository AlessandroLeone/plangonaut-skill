import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The document lock, and the document that could not be unlocked.
 *
 * WHAT HAPPENED
 * -------------
 * Studio saved a governed document and recorded `lock_owner: "studio:Ale92"`.
 * The tab was closed. Studio was closed. On reopening there were no tabs, and
 * the value was still there. A second author could not finalize the document,
 * and `validate --strict` passed throughout — correctly, because nothing about
 * the state was invalid. It was a persistent field describing something that
 * had never been persistent.
 *
 * The advice in circulation was "reopen Studio, close the document and quit".
 * It could not have worked: no code path in either implementation ever assigned
 * an empty `lock_owner`, so closing a tab released nothing.
 *
 * WHAT THESE ASSERT
 * -----------------
 * That such a record is classified as legacy and unknown rather than as live or
 * dead; that nothing clears it silently; that an explicit recovery produces a
 * complete, reproducible event; that the document is then finalizable by
 * somebody else; that repeating the recovery applies no second mutation; and
 * that the whole lifecycle — acquire, hold, release, recover — behaves.
 *
 * No name, path or byte comes from the real project.
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
  const directory = path.join(os.tmpdir(), `plangonaut-doclock-${name}-${process.pid}-${counter++}`);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const owners = path.join(directory, "owners.json");
  // `studio:Ale92` is a recognised owner here so the fixture can reproduce a
  // save made under that name, exactly as the real project did.
  fs.writeFileSync(owners, JSON.stringify({
    product: "studio:Ale92", technical: "studio:Ale92", budget: "studio:Ale92",
    safety: "studio:Ale92", release: "Bruna",
  }));
  run("init", "--project-root", directory, "--project-name", "LockFixture", "--project-mode", "Resume",
      "--interaction-mode", "Standard", "--owners-file", owners, "--operation-id", `OP-init-${crypto.randomUUID()}`);
  return directory;
}

const statePath = (project) => path.join(project, ".plangonaut", "state.json");
const readState = (project) => JSON.parse(fs.readFileSync(statePath(project), "utf8"));
const artifactOf = (project, id) => readState(project).artifacts.find((item) => item.id === id);

function readEvents(project) {
  return fs.readFileSync(path.join(project, ".plangonaut", "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function token(output) {
  const match = /"confirmation_token":\s*"([a-f0-9]+)"/.exec(output);
  assert.ok(match, `no confirmation token in:\n${output}`);
  return match[1];
}

/** Save a governed document the way the CLI does. */
function save(project, id, basePath, content, owner, extra = []) {
  const file = path.join(project, basePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const preview = run("doc-diff", "--project-root", project, "--id", id,
                      "--base-path", basePath, "--content-file", file, "--owner", owner);
  return run("doc-save", "--project-root", project, "--id", id, "--base-path", basePath,
             "--content-file", file, "--owner", owner, "--confirm-token", token(preview),
             "--operation-id", `OP-save-${crypto.randomUUID()}`, ...extra);
}

/**
 * A project as the older engine left it: a bare holder name, and no digests.
 *
 * Two things have to be true together for this to reproduce the defect rather
 * than a different one. The artifact carries `lock_owner` and no `lock`, which
 * is what the old writer produced; and the events carry none of the replay
 * fields, which is what that era's engine wrote. Setting only the first is a
 * *hand-edited current* project, and the engine refuses it — correctly, and
 * loudly — which is how this fixture was found to be lying the first time.
 *
 * The events are aged, never rewritten in content: fields are removed, none is
 * added, and nothing is invented.
 */
const REPLAY_FIELDS = [
  "format", "state_patch", "previous_revision", "previous_state_sha256",
  "state_sha256", "previous_event_sha256", "payload_sha256",
];

function ageProjectWithLock(project, id, mutate) {
  const events = readEvents(project).map((event) => {
    for (const field of REPLAY_FIELDS) delete event[field];
    return JSON.stringify(event);
  });
  fs.writeFileSync(path.join(project, ".plangonaut", "events.jsonl"), `${events.join("\n")}\n`);

  const state = readState(project);
  mutate(state.artifacts.find((item) => item.id === id));
  fs.writeFileSync(statePath(project), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

test("a save no longer takes a lock nobody will release", () => {
  const project = fixture("save");
  save(project, "ART-DOCS-REQUISITI", "docs/requisiti.md", "requisiti\nda rivedere\n", "studio:Ale92");

  const artifact = artifactOf(project, "ART-DOCS-REQUISITI");
  assert.equal(artifact.lock_owner, "", "a plain save still took a lock");
  assert.ok(!artifact.lock, "a plain save recorded an editing session");

  // And the author of the revision is still recorded, on the event where it belongs.
  const saved = readEvents(project).find((event) => event.type === "DOCUMENT_SAVED");
  assert.equal(saved.owner, "studio:Ale92", "the author of the revision was lost");
});

test("a save that is part of an editing session records the session, not a bare name", () => {
  const project = fixture("session");
  save(project, "ART-DOCS-REQUISITI", "docs/requisiti.md", "requisiti\n", "studio:Ale92",
       ["--session", "studio-9f1c"]);

  const artifact = artifactOf(project, "ART-DOCS-REQUISITI");
  assert.equal(artifact.lock.session, "studio-9f1c");
  assert.equal(artifact.lock.host, os.hostname());
  /*
   * `null`, and that is the correct answer.
   *
   * The pid of a lock taken through the CLI is the *session's* process, which
   * only the session can supply with `--pid`. Recording the CLI's own would
   * make every lock stale the instant the command returned, which is what the
   * first version of this did.
   */
  assert.equal(artifact.lock.pid, null);
  assert.ok(artifact.lock.acquired_at, "the lock records no acquisition time");
});

// ---------------------------------------------------------------------------
// The mandated regression case
// ---------------------------------------------------------------------------

test("the stranded document: legacy lock, green validate, refused finalize, explicit recovery", () => {
  const project = fixture("legacy");

  // 1. A governed document saved by studio:Ale92, and two files whose text is
  //    identical and whose line endings are not.
  save(project, "ART-DOCS-REQUISITI-DA-RIVEDERE", "docs/requisiti-da-rivedere.md",
       "requisiti\nda rivedere\n", "studio:Ale92");
  fs.writeFileSync(path.join(project, "docs", "requisiti-crlf.md"), "requisiti\r\nda rivedere\r\n");
  // Declared rather than left stray: an ungoverned Markdown file inside a
  // governed directory is a finding of its own, and a fixture carrying one
  // would fail `--strict` for a reason that has nothing to do with locks.
  run("govern", "--project-root", project, "--exclude", "docs/requisiti-crlf.md",
      "--reason", "A second copy with the other line endings, kept for comparison",
      "--owner", "studio:Ale92", "--operation-id", `OP-gov-${crypto.randomUUID()}`);

  // 2. lock_owner persists, with no session behind it.
  ageProjectWithLock(project, "ART-DOCS-REQUISITI-DA-RIVEDERE", (artifact) => {
    artifact.lock_owner = "studio:Ale92";
    delete artifact.lock;
  });
  assert.equal(artifactOf(project, "ART-DOCS-REQUISITI-DA-RIVEDERE").lock_owner, "studio:Ale92");

  // 3. No Studio session is running. 5. validate --strict is green.
  run("validate", "--project-root", project, "--strict");

  // 6. A different owner cannot finalize, and is told why and what to do.
  const refusal = refuse("doc-finalize", "--project-root", project,
                         "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE", "--owner", "Bruna",
                         "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /locked by studio:Ale92/);
  assert.match(refusal, /no session, host, process or time/);
  assert.match(refusal, /doc-lock-force-release/);
  assert.match(refusal, /not the project lock/, "the refusal did not distinguish the two locks");
  assert.doesNotMatch(refusal, /plangonaut unlock --project-root \.\s*$/m);

  // The lock is classified, not guessed.
  const status = JSON.parse(run("doc-lock", "--project-root", project,
                                "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE", "--json"));
  assert.equal(status.locks[0].state, "LEGACY_UNKNOWN");
  assert.equal(status.locks[0].owner, "studio:Ale92");
  assert.equal(status.locks[0].session, null);
  assert.equal(status.locks[0].host, null);

  // It is not demonstrably over, so recovery refuses and says so.
  const notStale = refuse("doc-lock-recover", "--project-root", project,
                          "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE", "--owner", "Bruna",
                          "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(notStale, /not demonstrably over/);
  assert.match(notStale, /force-release/);
  assert.equal(artifactOf(project, "ART-DOCS-REQUISITI-DA-RIVEDERE").lock_owner, "studio:Ale92",
    "a refused recovery cleared the lock");

  // An explicit release, with a reason, produces a complete event.
  const released = run("doc-lock-force-release", "--project-root", project,
                       "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE", "--owner", "Bruna",
                       "--reason", "Studio session ended weeks ago; confirmed with the holder",
                       "--operation-id", "OP-force-1");
  assert.match(released, /held by\s+studio:Ale92/);
  assert.match(released, /state\s+LEGACY_UNKNOWN/);
  assert.match(released, /reason\s+Studio session ended/);

  const event = readEvents(project).find((item) => item.type === "DOCUMENT_LOCK_FORCE_RELEASED");
  assert.ok(event, "no event was recorded for the release");
  assert.equal(event.artifact_id, "ART-DOCS-REQUISITI-DA-RIVEDERE");
  assert.equal(event.owner, "Bruna");
  assert.equal(event.previous_owner, "studio:Ale92", "the event did not record who held it");
  assert.equal(event.previous_state, "LEGACY_UNKNOWN");
  assert.match(event.reason, /Studio session ended/);
  assert.ok(event.state_patch, "the release did not go through the canonical writer");
  assert.equal(event.format, 2);

  // The document is now finalizable by the new owner.
  run("doc-finalize", "--project-root", project, "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE",
      "--owner", "Bruna", "--operation-id", `OP-fin-${crypto.randomUUID()}`);
  assert.equal(artifactOf(project, "ART-DOCS-REQUISITI-DA-RIVEDERE").status, "PUBLISHED");

  /*
   * Everything still verifies — after the one step a legacy history needs.
   *
   * This project's events predate the replay format, so `replay --verify`
   * cannot pass until a starting point is recorded. That is not a consequence
   * of the lock work and it is not something the lock work should paper over:
   * it is the documented route for a project of this age, and running it here
   * shows the whole recovery rather than the half that is about locks.
   */
  const baselinePreview = run("baseline", "--project-root", project, "--dry-run",
                              "--reason", "History predates the replay format", "--owner", "Bruna",
                              "--operation-id", `OP-bp-${crypto.randomUUID()}`);
  run("baseline", "--project-root", project, "--reason", "History predates the replay format",
      "--owner", "Bruna", "--operation-id", `OP-b-${crypto.randomUUID()}`,
      "--confirm-token", /--confirm-token ([a-f0-9]{12})/.exec(baselinePreview)[1]);
  run("replay", "--verify", "--project-root", project);
  run("validate", "--project-root", project, "--strict");
  const handoff = invoke("handoff-check", "--project-root", project, "--json");
  const handed = JSON.parse(handoff.stdout);
  assert.ok(!handed.blocking.some((line) => /lock/i.test(line)),
    `handoff still complains about a lock:\n${handed.blocking.join("\n")}`);

  // Repeating the recovery applies no second mutation.
  const before = readEvents(project).length;
  const again = run("doc-lock-force-release", "--project-root", project,
                    "--id", "ART-DOCS-REQUISITI-DA-RIVEDERE", "--owner", "Bruna",
                    "--reason", "Studio session ended weeks ago; confirmed with the holder",
                    "--operation-id", "OP-force-1");
  assert.match(again, /Idempotent retry|is not locked/);
  assert.equal(readEvents(project).length, before, "a repeated recovery wrote a second event");
});

test("the line endings differ and the diff says so", () => {
  const project = fixture("eol");
  save(project, "ART-EOL", "docs/eol.md", "requisiti\nda rivedere\n", "studio:Ale92");

  // The same text with the other line endings is a real change to the bytes,
  // and the engine must present it as one rather than as an identical file.
  const file = path.join(project, "docs", "eol.md");
  fs.writeFileSync(file, "requisiti\r\nda rivedere\r\n");
  const preview = run("doc-diff", "--project-root", project, "--id", "ART-EOL",
                      "--base-path", "docs/eol.md", "--content-file", file, "--owner", "studio:Ale92");
  const parsed = JSON.parse(preview.slice(preview.indexOf("{"), preview.lastIndexOf("}") + 1));
  assert.notEqual(parsed.content_hash, artifactOf(project, "ART-EOL").content_hash,
    "a line-ending change produced the same digest");
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

test("acquire, hold against another owner, release by the holder", () => {
  const project = fixture("lifecycle");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92");

  run("doc-lock-acquire", "--project-root", project, "--id", "ART-DOC",
      "--owner", "studio:Ale92", "--session", "studio-1", "--operation-id", "OP-acq-1");

  const held = JSON.parse(run("doc-lock", "--project-root", project, "--id", "ART-DOC", "--json"));
  assert.equal(held.locks[0].state, "HELD");
  assert.equal(held.locks[0].owner, "studio:Ale92");
  assert.equal(held.locks[0].session, "studio-1");

  // Another owner cannot take it, and cannot release it either.
  const taken = refuse("doc-lock-acquire", "--project-root", project, "--id", "ART-DOC",
                       "--owner", "Bruna", "--session", "other-1", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(taken, /locked by studio:Ale92/);
  const wrongRelease = refuse("doc-lock-release", "--project-root", project, "--id", "ART-DOC",
                              "--owner", "Bruna", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(wrongRelease, /held by studio:Ale92, not by Bruna/);
  assert.equal(artifactOf(project, "ART-DOC").lock_owner, "studio:Ale92",
    "a refused release cleared the lock");

  // The holder releases it, and the event records what was released.
  run("doc-lock-release", "--project-root", project, "--id", "ART-DOC",
      "--owner", "studio:Ale92", "--operation-id", "OP-rel-1");
  assert.equal(artifactOf(project, "ART-DOC").lock_owner, "");
  assert.equal(artifactOf(project, "ART-DOC").lock, null);
  const event = readEvents(project).find((item) => item.type === "DOCUMENT_LOCK_RELEASED");
  assert.equal(event.previous_owner, "studio:Ale92");
  assert.equal(event.previous_session, "studio-1");

  // Bruna can now take it.
  run("doc-lock-acquire", "--project-root", project, "--id", "ART-DOC",
      "--owner", "Bruna", "--session", "other-1", "--operation-id", "OP-acq-2");
});

test("a lock from a process that has ended is recoverable; one from another host is not", () => {
  const project = fixture("stale");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92", ["--session", "studio-dead"]);

  // A pid that is not running, on this host: demonstrably over.
  ageProjectWithLock(project, "ART-DOC", (artifact) => {
    artifact.lock = {
      owner: "studio:Ale92", session: "studio-dead", host: os.hostname(),
      pid: 999_999, acquired_at: new Date().toISOString(),
    };
    artifact.lock_owner = "studio:Ale92";
  });

  const stale = JSON.parse(run("doc-lock", "--project-root", project, "--id", "ART-DOC", "--json"));
  assert.equal(stale.locks[0].state, "STALE");
  assert.match(stale.locks[0].because, /no longer running/);

  run("doc-lock-recover", "--project-root", project, "--id", "ART-DOC",
      "--owner", "Bruna", "--operation-id", "OP-rec-1");
  assert.equal(artifactOf(project, "ART-DOC").lock, null);
  const event = readEvents(project).find((item) => item.type === "DOCUMENT_LOCK_RECOVERED");
  assert.equal(event.previous_pid, 999_999);
  assert.match(event.reason, /no longer running/);
});

test("a lock held on another host is never taken automatically", () => {
  const project = fixture("otherhost");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92", ["--session", "studio-far"]);

  ageProjectWithLock(project, "ART-DOC", (artifact) => {
    artifact.lock = {
      owner: "studio:Ale92", session: "studio-far", host: "some-other-machine",
      pid: process.pid, acquired_at: new Date().toISOString(),
    };
    artifact.lock_owner = "studio:Ale92";
  });

  const reading = JSON.parse(run("doc-lock", "--project-root", project, "--id", "ART-DOC", "--json"));
  assert.equal(reading.locks[0].state, "HELD");
  assert.match(reading.locks[0].because, /not this machine/);

  // Even though the pid happens to be alive here, it is another host's pid.
  const refusal = refuse("doc-lock-recover", "--project-root", project, "--id", "ART-DOC",
                         "--owner", "Bruna", "--operation-id", `OP-${crypto.randomUUID()}`);
  assert.match(refusal, /not demonstrably over/);
  assert.equal(artifactOf(project, "ART-DOC").lock.host, "some-other-machine");
});

test("finalizing ends the editing session it was holding", () => {
  const project = fixture("finalize");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92", ["--session", "studio-1"]);
  assert.equal(artifactOf(project, "ART-DOC").lock.session, "studio-1");

  run("doc-finalize", "--project-root", project, "--id", "ART-DOC",
      "--owner", "studio:Ale92", "--operation-id", "OP-fin-1");

  const artifact = artifactOf(project, "ART-DOC");
  assert.equal(artifact.status, "PUBLISHED");
  assert.equal(artifact.lock, null, "a published document is still marked as being edited");
  assert.equal(artifact.lock_owner, "");
  const event = readEvents(project).find((item) => item.type === "DOCUMENT_FINALIZED");
  assert.equal(event.released_lock_owner, "studio:Ale92", "the finalize did not record what it released");
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

test("the project lock is a different mechanism and is untouched", () => {
  const project = fixture("project-lock");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92", ["--session", "studio-1"]);

  // Nothing in the document-lock family writes .plangonaut/lock.json, and the
  // help says so, because reaching for `unlock` was the obvious wrong move.
  run("doc-lock-release", "--project-root", project, "--id", "ART-DOC",
      "--owner", "studio:Ale92", "--operation-id", "OP-rel-1");
  assert.ok(!fs.existsSync(path.join(project, ".plangonaut", "lock.json")),
    "a document-lock command left a project lock behind");

  const help = run("help");
  assert.match(help, /doc-lock --project-root/);
  assert.match(help, /unlock --project-root \. \[--force\]/);
});

test("the classification is what refuses: a free document finalizes without ceremony", () => {
  /*
   * The control for the whole file.
   *
   * If a document with no lock also refused, every refusal above would be
   * measuring something other than the lock. It is the cheapest proof that the
   * classification is doing the work.
   */
  const project = fixture("control");
  save(project, "ART-DOC", "docs/doc.md", "text\n", "studio:Ale92");
  run("doc-finalize", "--project-root", project, "--id", "ART-DOC",
      "--owner", "Bruna", "--operation-id", "OP-fin-1");
  assert.equal(artifactOf(project, "ART-DOC").status, "PUBLISHED");
});
