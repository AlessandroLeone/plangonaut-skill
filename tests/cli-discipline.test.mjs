import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.join(process.cwd(), "lib", "bin", "plangonaut.js");
const SKILL = path.join(process.cwd(), "skills", "plangonaut", "SKILL.md");

/**
 * What an agent has to be able to find out before it guesses.
 *
 * Every test here comes from one real session. An agent was told to run
 * `capabilities` before its first mutation, learned nothing about the command
 * surface from it, invented `plangonaut coverage`, was refused without a
 * suggestion, asked `task --help` because the general help promises it works,
 * was refused again, ran `task` without `--status`, and was told only that the
 * option was missing.
 *
 * None of that is a failure of instruction. The instruction was impossible to
 * follow, and these check that it no longer is — by running the commands, not
 * by looking for sentences in a file.
 */

function invoke(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function project(name) {
  const root = path.join(os.tmpdir(), "plangonaut-discipline", `${name}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const owners = path.join(root, "owners.json");
  fs.writeFileSync(owners, JSON.stringify({ product: "Owner", technical: "Owner", budget: "Owner", safety: "Owner", release: "Owner" }));
  const result = invoke("init", "--project-root", root, "--project-name", "Discipline", "--project-mode", "Resume",
    "--interaction-mode", "Standard", "--owners-file", owners, "--operation-id", "OP-INIT");
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function revision(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8")).revision;
}

// ---------------------------------------------------------------------------
// 1. Finding out, before guessing
// ---------------------------------------------------------------------------

test("capabilities is enough to drive the engine without guessing", () => {
  const result = invoke("capabilities");
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);

  // The four things an agent needs and used not to get.
  assert.ok(payload.commands, "capabilities lists no commands at all");
  assert.ok(Object.keys(payload.commands).length > 40, "the command list is not the command surface");
  for (const name of ["task", "dependency", "decision", "requirement", "execution-readiness", "sufficiency-review"]) {
    assert.ok(payload.commands[name], `capabilities omits ${name}`);
  }
  assert.deepEqual(payload.commands.task.values.status,
    ["BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"],
    "an agent cannot learn the accepted statuses from capabilities");
  assert.ok(payload.commands.task.required.includes("status"));
  assert.ok(payload.commands.task.example.includes("--status"));
  assert.equal(payload.commands.task.mutating, true);
  assert.equal(payload.commands.capabilities.mutating, false);

  // And the four rules that were broken in the session.
  const notes = payload.grammar_notes.join(" ");
  assert.match(notes, /Do not chain mutations/);
  assert.match(notes, /unique, stable --operation-id/);
  assert.match(notes, /There is no coverage command/);
});

test("every command answers --help, because the general help says every command does", () => {
  const general = invoke("help").stdout;
  assert.match(general, /Any command takes --help/, "the promise moved; this test guards the promise");

  const commands = Object.keys(JSON.parse(invoke("capabilities").stdout).commands);
  const refused = [];
  for (const command of commands) {
    const result = invoke(command, "--help");
    if (result.status !== 0 || !result.stdout.trim()) refused.push(command);
  }
  assert.deepEqual(refused, [], `these commands refuse --help although the help promises it: ${refused.join(", ")}`);
});

test("task --help names the option the session guessed at, and its values", () => {
  const help = invoke("task", "--help").stdout;
  assert.match(help, /--status/);
  assert.match(help, /BACKLOG, READY, IN_PROGRESS, REVIEW, DONE, BLOCKED/);
  assert.match(help, /required/);
  assert.match(help, /Example:/);
});

test("a missing required option answers with the values and a line that works", () => {
  const root = project("missing-status");
  const result = invoke("task", "--project-root", root, "--id", "TSK-0001", "--title", "A task",
    "--owner", "Owner", "--operation-id", "OP-T");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required option --status/);
  assert.match(result.stderr, /Accepted values: BACKLOG, READY, IN_PROGRESS, REVIEW, DONE, BLOCKED/);
  assert.match(result.stderr, /A correct call:/);
  assert.match(result.stderr, /--status READY/);
  assert.match(result.stderr, /Nothing was written/);
  assert.equal(revision(root), revision(root), "a refused command must not move the ledger");
});

test("an invented command is answered with the real one and why", () => {
  const result = invoke("coverage");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command: coverage/);
  assert.match(result.stderr, /Nothing was read and nothing was written/);
  // The real command, not a new one built to match the invention.
  assert.match(result.stderr, /plangonaut dependency/);
  assert.match(result.stderr, /one relation at a time/);
  assert.match(result.stderr, /Several relations are several commands/);
  assert.match(result.stderr, /There is no bulk coverage command/);

  // And it was not quietly added.
  const commands = Object.keys(JSON.parse(invoke("capabilities").stdout).commands);
  assert.ok(!commands.includes("coverage"), "an invented command was added to satisfy the invention");
});

test("a mistyped command suggests, rather than stopping at unknown", () => {
  const result = invoke("dependancy");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Did you mean: dependency/);
});

// ---------------------------------------------------------------------------
// 2. One mutation at a time, and stopping at the first error
// ---------------------------------------------------------------------------

test("a refused mutation writes nothing, and the next command sees the ledger it left", () => {
  const root = project("first-error");
  const before = revision(root);

  // The shape of the session's failure: a guess, refused.
  const refused = invoke("task", "--project-root", root, "--id", "TSK-0001", "--title", "A task",
    "--status", "TODO", "--owner", "Owner", "--operation-id", "OP-A");
  assert.notEqual(refused.status, 0);
  assert.equal(revision(root), before, "a refused command moved the ledger");

  // Carrying on regardless is what the skill forbids; the engine makes the
  // consequence visible rather than hiding it, so the second command lands on
  // an unchanged project rather than on a half-applied one.
  const dependent = invoke("dependency", "--project-root", root, "--id", "DEP-0001",
    "--from", "REQ-0001", "--to", "TSK-0001", "--type", "REQUIRES", "--owner", "Owner", "--operation-id", "OP-B");
  assert.notEqual(dependent.status, 0, "a dependency on a task that was never written was accepted");
  assert.equal(revision(root), before);
});

test("the same operation id twice is one operation; two ids are two", () => {
  const root = project("operations");
  const write = (id) => invoke("requirement", "--project-root", root, "--id", "REQ-0001",
    "--title", "A requirement", "--status", "ACTIVE", "--owner", "Owner", "--operation-id", id);

  assert.equal(write("OP-SAME").status, 0);
  const afterFirst = revision(root);
  const retry = write("OP-SAME");
  assert.equal(retry.status, 0);
  assert.match(retry.stdout, /Idempotent retry/);
  assert.equal(revision(root), afterFirst, "a retry under the same id was applied twice");
});

test("an unknown option is refused rather than dropped, and says nothing was written", () => {
  const root = project("unknown-option");
  const before = revision(root);
  const result = invoke("task", "--project-root", root, "--id", "TSK-0001", "--title", "A task",
    "--status", "READY", "--owner", "Owner", "--priority", "high", "--operation-id", "OP-U");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option for task: --priority/);
  assert.match(result.stderr, /Nothing was written/);
  assert.equal(revision(root), before);
});

// ---------------------------------------------------------------------------
// 3. The reading boundary, as a contract rather than a sentence
// ---------------------------------------------------------------------------

test("the skill forbids each class of source the boundary is about", () => {
  /*
   * Deliberately not a search for one phrase. Each entry below is a class of
   * thing a host AI has access to and must not read, and the test fails if any
   * class stops being named — which is what would actually go wrong, rather
   * than a wording changing.
   */
  const skill = fs.readFileSync(SKILL, "utf8").toLowerCase();
  const classes = {
    "provider transcripts or private memory": /transcripts?, session logs or private memory/,
    "provider state directories": /\.gemini|\.claude|\.codex/,
    "credentials and secrets": /credentials, tokens, keys, certificates/,
    "environment files": /`\.env`/,
    "other applications' configuration": /another application's configuration or profile/,
    "user profile and application data": /user profile or application-data directory/,
    "anything outside the root": /outside the project root/,
  };
  for (const [name, pattern] of Object.entries(classes)) {
    assert.match(skill, pattern, `the reading boundary no longer covers ${name}`);
  }
});

test("an authorised external read has a command that records it, with a digest", () => {
  const root = project("read-record");
  const outside = path.join(root, "manifest.json");
  fs.writeFileSync(outside, JSON.stringify({ name: "a thing", version: "4.0.0" }));

  const result = invoke("read-record", "--project-root", root, "--path", outside,
    "--purpose", "Confirm the installed major version against the plan",
    "--owner", "Owner", "--operation-id", "OP-R");
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const recorded = (state.recorded_reads ?? state.reads ?? []).concat(
    Object.values(state).filter(Array.isArray).flat().filter((item) => item && item.sha256 && item.purpose));
  assert.ok(recorded.length > 0, "an authorised read left no record");
  assert.ok(recorded.some((item) => typeof item.sha256 === "string" && item.sha256.length === 64),
    "the record carries no digest, so nobody can tell whether the file has changed since");
});

// ---------------------------------------------------------------------------
// 4. No error implies a write that did not happen
// ---------------------------------------------------------------------------

test("every refusal this suite can provoke says what did not happen", () => {
  const root = project("silence");
  const refusals = [
    ["task", "--project-root", root, "--id", "TSK-1", "--title", "T", "--status", "NOPE", "--owner", "Owner", "--operation-id", "OP-1"],
    ["task", "--project-root", root, "--id", "TSK-1", "--title", "T", "--owner", "Owner", "--operation-id", "OP-2"],
    ["task", "--project-root", root, "--id", "TSK-1", "--title", "T", "--status", "READY", "--owner", "Nobody", "--operation-id", "OP-3"],
    ["risk", "--project-root", root, "--id", "RSK-1", "--title", "R", "--severity", "SEVERE", "--status", "IDENTIFIED", "--owner", "Owner", "--operation-id", "OP-5"],
    ["dependency", "--project-root", root, "--id", "DEP-1", "--from", "REQ-1", "--to", "TSK-1", "--type", "CAUSES", "--owner", "Owner", "--operation-id", "OP-6"],
    ["decision", "--project-root", root, "--id", "DEC-1", "--title", "D", "--status", "MAYBE", "--owner", "Owner", "--operation-id", "OP-4"],
  ];
  for (const argv of refusals) {
    const result = invoke(...argv);
    assert.notEqual(result.status, 0, `expected a refusal from ${argv.join(" ")}`);
    const said = `${result.stdout}\n${result.stderr}`;
    assert.ok(/Nothing was written|Nothing was read/.test(said),
      `a refusal left the caller unable to tell whether anything happened:\n${said}`);
    assert.ok(!/recorded|updated|saved/i.test(result.stdout),
      `a refusal's own output suggests a write:\n${result.stdout}`);
  }
});
